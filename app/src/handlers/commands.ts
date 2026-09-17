import type { AgentConfig, EventBus, ParsedCommand, PlatformAdapter } from '@opencode-pr-agent/lib';
import {
  Logger,
  configureGit,
  createPlatformAdapter,
  getErrorStatus,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import { runWithConcurrencyLimit } from '../utils/concurrency.js';
import { execGit } from '../utils/git.js';
import {
  type RepoFilter,
  repoFilter as defaultRepoFilter,
  isRepoAllowed,
} from '../utils/repo-filter.js';
import { createAskpassScript, createTempDir, removeDir } from '../utils/temp.js';
import { handleAnalyzeCommand } from './analyze.js';
import { handleAudit } from './audit.js';
import { createAutofixPR, findExistingAutofixPR } from './autofix-pr.js';
import { handleAutofixLoop } from './autofix.js';
import { handleChangelogCommand } from './changelog.js';
import { isAbortError, isValidRepoSlug } from './command-helpers.js';
import { handleDescribeCommand } from './describe.js';
import { handleDocsCommand } from './docs.js';
import { handleExplainCommand } from './explain.js';
import { handlePRReview } from './pr-review.js';
import { handleSetup } from './setup.js';

// Re-export the per-command handlers and shared helpers so existing importers
// of the former god-file (`handlers/commands.ts`) keep working. New code
// should import from the focused modules directly.
export { isAbortError, isValidRepoSlug } from './command-helpers.js';
export { handleAnalyzeCommand } from './analyze.js';
export { handleExplainCommand } from './explain.js';
export { handleDescribeCommand } from './describe.js';
export { handleDocsCommand } from './docs.js';
export { handleSetup } from './setup.js';
export { createAutofixPR, findExistingAutofixPR } from './autofix-pr.js';

/**
 * Handle a slash command (fix/review/audit/analyze): clone the repo, execute
 * the appropriate handler (PR review, autofix loop, audit, or analyze) in a
 * temp workspace, and clean up.
 * @param command - The command to execute.
 * @param issueNumber - The issue or PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param parsed - Optional parsed command (for flags like --force).
 * @param signal - Optional abort signal
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 * @param repoFilter - Optional repo allowlist/denylist; defaults to the shared
 * process-wide filter built from ALLOWED_REPOS / DENIED_REPOS env.
 */
export async function handleCommand(
  command:
    | 'fix'
    | 'review'
    | 'audit'
    | 'analyze'
    | 'explain'
    | 'setup'
    | 'docs'
    | 'describe'
    | 'changelog',
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  parsed?: ParsedCommand,
  signal?: AbortSignal,
  eventBus?: EventBus,
  correlationId?: string,
  repoFilter?: RepoFilter,
): Promise<void> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber, correlationId });

  // Repository allowlist/denylist gate: never run slash-command workloads on
  // repos the operator excluded. Opt-in via ALLOWED_REPOS / DENIED_REPOS env.
  const effectiveRepoFilter = repoFilter ?? defaultRepoFilter;
  if (!isRepoAllowed(repo, effectiveRepoFilter)) {
    logger.info(`Skipping /${command} — repository ${repo} is filtered out`);
    return;
  }

  // Validate the webhook-supplied repo slug before interpolating it into the
  // clone URL. GitHub normally sends a well-formed owner/repo, but failing
  // closed here avoids attempting a git operation on a malformed value.
  if (!isValidRepoSlug(repo)) {
    logger.warn(`Skipping /${command} — invalid repository slug "${repo}"`);
    return;
  }

  const gh: PlatformAdapter = createPlatformAdapter(token, repo, config.platform);

  // Async temp-dir setup (fs/promises via utils/temp.ts): sync fs would block
  // the Node event loop during clone/setup work, hurting webhook throughput
  // under concurrency.
  const tempDir = await createTempDir('opencode-workspace-');

  // Create GIT_ASKPASS helper for clone so the token never appears in argv or .git/config
  const { dir: askPassDir, scriptPath: askPassPath } = await createAskpassScript();
  const cloneEnv: Record<string, string> = {
    GIT_ASKPASS: askPassPath,
    OPENCODE_CREDENTIAL_TOKEN: token,
  };

  try {
    if (signal?.aborted) return;

    try {
      await execGit(['clone', '--depth', '1', `https://github.com/${repo}.git`, tempDir], {
        env: cloneEnv,
        timeout: 120_000,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      logger.error(`Git clone failed for ${repo}: ${sanitizeErrorMessage(err)}`);
      if (command === 'setup') {
        // Setup must still produce a diagnostic report even when the repo
        // cannot be cloned (e.g. missing/read-only token): run the checks
        // against the empty temp dir so token-independent checks still run.
        logger.info(
          `Running setup validation against an empty workspace because ${repo} could not be cloned`,
        );
        await handleSetup(issueNumber, repo, token, config, tempDir);
        return;
      }
      throw err;
    }

    // Configure git identity AFTER cloning so `git config --local` runs inside
    // a real repository (calling it on an empty temp dir throws and would
    // leave gitEnv unset, breaking every downstream commit).
    const gitEnv = configureGit(
      'opencode-pr-agent[bot]',
      'opencode-pr-agent[bot]@users.noreply.github.com',
      token,
      tempDir,
    );

    if (signal?.aborted) return;

    // Global concurrency gate: reviews/fixes/audits each spawn a heavy
    // `opencode` subprocess. The semaphore caps how many run simultaneously
    // across ALL repos/PRs so a busy instance never oversubscribes CPU/RAM.
    // A command that cannot get a slot within the wait window is skipped
    // (logged + a short "busy" notice) rather than blocking the webhook.
    const commandLabel = `/${command} ${repo}#${issueNumber}`;
    let executed = false;
    await runWithConcurrencyLimit(async () => {
      executed = true;
      await dispatchCommand();
    }, commandLabel);
    if (!executed) {
      logger.warn(`Skipped ${commandLabel} — global concurrency limit reached`);
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- command-busy -->',
          '⏳ **Another run is already active — this command is queued.** Re-trigger with `/review` shortly.',
        );
      } catch (err) {
        logger.warn(
          `Failed to post busy comment: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    async function dispatchCommand(): Promise<void> {
      // Classify an issue number as MR/PR, failing closed on transient API
      // errors. Returns null (after logging a sanitized warning) when the
      // probe itself fails so callers skip just this command via `break`.
      async function classifyAsMr(commandName: string): Promise<boolean | null> {
        try {
          return await gh.isMR(issueNumber);
        } catch (err) {
          const status = getErrorStatus(err);
          logger.warn(
            `Skipping /${commandName} on #${issueNumber}: failed to classify PR/issue${status !== undefined ? ` (status ${status})` : ''}: ${sanitizeErrorMessage(err)}`,
          );
          return null;
        }
      }
      switch (command) {
        case 'analyze': {
          await handleAnalyzeCommand(
            issueNumber,
            repo,
            token,
            config,
            tempDir,
            eventBus,
            correlationId,
          );
          break;
        }

        case 'explain': {
          await handleExplainCommand(
            issueNumber,
            repo,
            token,
            config,
            tempDir,
            eventBus,
            correlationId,
          );
          break;
        }

        case 'describe': {
          const probed = await classifyAsMr('describe');
          if (probed === null) break;
          const isMr: boolean = probed;
          if (!isMr) {
            logger.info(`Ignoring /describe on #${issueNumber}: not a pull request`);
            break;
          }
          await handleDescribeCommand(
            issueNumber,
            repo,
            token,
            config,
            tempDir,
            eventBus,
            correlationId,
          );
          break;
        }

        case 'review': {
          const probed = await classifyAsMr('review');
          if (probed === null) break;
          const isMr: boolean = probed;
          if (isMr) {
            await handlePRReview(
              issueNumber,
              repo,
              token,
              config,
              undefined,
              tempDir,
              undefined,
              eventBus,
              correlationId,
              { forceReview: true },
            );
          }
          break;
        }

        case 'fix': {
          if (signal?.aborted) return;
          const force = parsed?.flags?.force === true;
          const probedFix = await classifyAsMr('fix');
          if (probedFix === null) break;
          const isPR: boolean = probedFix;
          if (isPR) {
            await handleAutofixLoop({
              prNumber: issueNumber,
              repo,
              token,
              config,
              tempDir,
              initialGitEnv: gitEnv,
              signal,
              eventBus,
              correlationId,
            });
          } else {
            const issue = await gh.getIssue(issueNumber);
            const existingPR = await findExistingAutofixPR(issueNumber, issue);
            if (existingPR) {
              await handleAutofixLoop({
                prNumber: existingPR,
                repo,
                token,
                config,
                tempDir,
                initialGitEnv: gitEnv,
                signal,
                eventBus,
                correlationId,
              });
            } else {
              const newPR = await createAutofixPR(
                gh,
                issueNumber,
                repo,
                config,
                tempDir,
                gitEnv,
                signal,
                force,
                eventBus,
                correlationId,
                issue,
              );
              if (newPR) {
                await handleAutofixLoop({
                  prNumber: newPR,
                  repo,
                  token,
                  config,
                  tempDir,
                  initialGitEnv: gitEnv,
                  signal,
                  eventBus,
                  correlationId,
                });
              }
            }
          }
          break;
        }

        case 'audit': {
          await handleAudit(
            repo,
            token,
            config,
            undefined,
            undefined,
            tempDir,
            undefined,
            issueNumber,
            eventBus,
            correlationId,
          );
          break;
        }

        case 'docs': {
          const probed = await classifyAsMr('docs');
          if (probed === null) break;
          const isMr: boolean = probed;
          if (!isMr) {
            logger.info(`Ignoring /docs on #${issueNumber}: not a pull request`);
            break;
          }
          await handleDocsCommand(
            gh,
            issueNumber,
            repo,
            config,
            tempDir,
            gitEnv,
            signal,
            eventBus,
            correlationId,
            parsed,
          );
          break;
        }

        case 'setup': {
          await handleSetup(issueNumber, repo, token, config, tempDir);
          break;
        }

        case 'changelog': {
          await handleChangelogCommand(gh, issueNumber, repo, config, tempDir, gitEnv, signal);
          break;
        }
      }
    }
  } catch (err) {
    if (isAbortError(err, signal)) {
      logger.info(`Command ${command} aborted for issue ${issueNumber} in ${repo}`);
    } else {
      logger.error(
        `Command ${command} failed for issue ${issueNumber} in ${repo}: ${err instanceof Error ? err.message : err}`,
      );
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- command-error -->',
          `❌ **/${command} failed**: ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post command-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        );
      }
    }
  } finally {
    // Best-effort async cleanup of both temp dirs; one failing must not skip
    // the other.
    await Promise.allSettled([removeDir(tempDir), removeDir(askPassDir)]);
  }
}
