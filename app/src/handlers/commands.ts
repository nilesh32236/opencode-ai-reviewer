import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type {
  AgentConfig,
  DocStyle,
  EventBus,
  IssueContext,
  PRContext,
  ParsedCommand,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  ReviewEngine,
  SetupEngine,
  buildAutofixPRBody,
  buildDocsPRBody,
  configureGit,
  ensureWorkspaceDeps,
  findLinkedPRByMarker,
  findLinkedPRNumberByMarker,
  getErrorStatus,
  isDocStyle,
  isValidRepoSlug,
  markAnalysisReady,
  mergeDescribeBody,
  parseAnalysisPlan,
  postBlockingQuestions,
  prepareBranchWorkspace,
  pushBranchWithLease,
  sanitizeErrorMessage,
  sanitizeMarkdown,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { isBotLogin } from '../utils/bot.js';
import { runWithConcurrencyLimit } from '../utils/concurrency.js';
import { execProcess } from '../utils/exec.js';
import { execGit } from '../utils/git.js';
import type { ExecGitOptions } from '../utils/git.js';
import {
  type RepoFilter,
  repoFilter as defaultRepoFilter,
  isRepoAllowed,
} from '../utils/repo-filter.js';
import { handleAudit } from './audit.js';
import { handleAutofixLoop } from './autofix.js';
import { handleChangelogCommand } from './changelog.js';
import { handlePRReview } from './pr-review.js';

/** Module-scope logger for helper functions that have no per-call context. */
const logger = new Logger('Command');

/**
 * Whether a repository slug is safe to interpolate into a clone/remote URL.
 * Single owner lives in `lib/src/utils/validation.ts`; re-exported here for
 * backward compatibility with existing importers and unit tests.
 * @param repo - Repository string in "owner/repo" (or GitLab nested-group) form.
 * @returns True when the slug matches slash-separated segments with no traversal.
 */
export { isValidRepoSlug };

/**
 * Return true when an error represents cancellation: an aborted signal or an
 * `AbortError` (e.g. `signal.throwIfAborted()` thrown inside a try).
 * @param err - Error value to classify.
 * @param signal - Optional abort signal that marks cancellation when aborted.
 * @returns True when the error represents cancellation.
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

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

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-workspace-'));

  // Create GIT_ASKPASS helper for clone so the token never appears in argv or .git/config
  const askPassDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-askpass-'));
  const askPassPath = path.join(askPassDir, 'credential.sh');
  writeFileSync(
    askPassPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*) echo "x-access-token" ;;',
      '  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o700 },
  );
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
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(askPassDir, { recursive: true, force: true });
  }
}

/**
 * Handle an analyze command: gather issue context, run the analysis engine,
 * and post the implementation plan as a comment on the issue.
 * @param issueNumber - The issue number to analyze.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleAnalyzeCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command:Analyze', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Analyzing issue #${issueNumber}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);

  try {
    const issueContext = await gh.gatherContext({ issueNumber });

    const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);
    const parsed = parseAnalysisPlan(planMarkdown);

    await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

    if (parsed.hasBlockingQuestions) {
      await postBlockingQuestions(gh, issueNumber, parsed);
    } else {
      await markAnalysisReady(gh, issueNumber);
    }

    logger.info(`Posted analysis plan for issue #${issueNumber}`);
  } catch (err) {
    if (isAbortError(err)) {
      logger.info(`Analyze aborted for issue #${issueNumber}`);
      return;
    }
    logger.error(
      `Failed to analyze issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- issue-analysis-error -->',
        `❌ **Analysis Failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post analysis-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for analyze #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Handle an explain command: gather PR context, run the explain engine,
 * and post the PR explanation as a comment on the PR.
 * @param issueNumber - The PR number to explain.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleExplainCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command:Explain', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Explaining PR #${issueNumber}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);

  try {
    const pr = await gh.getMR(issueNumber);
    const explanation = await engine.runExplain(pr, tempDir);

    await gh.postOrUpdateComment(issueNumber, '<!-- pr-explanation -->', explanation);

    logger.info(`Posted explanation for PR #${issueNumber}`);
  } catch (err) {
    if (isAbortError(err)) {
      logger.info(`Explain aborted for PR #${issueNumber}`);
      return;
    }
    logger.error(
      `Failed to explain PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- pr-explanation-error -->',
        `❌ **Explanation Failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post explanation-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for explain #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Handle a describe command: gather PR context, run the describe engine,
 * and post the generated PR description as a comment on the PR.
 * @param issueNumber - The PR number to describe.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 */
export async function handleDescribeCommand(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
  eventBus?: EventBus,
  correlationId?: string,
): Promise<void> {
  const logger = new Logger('Command:Describe', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Describing PR #${issueNumber}`);

  if (config.describe?.enabled === false) {
    logger.info('PR description generation is disabled (describe.enabled: false) — skipping');
    return;
  }

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);

  try {
    const publishAsComment = config.describe?.publishAsComment ?? true;
    const useMarkers = config.describe?.useMarkers ?? false;

    if (publishAsComment === false && useMarkers !== true) {
      logger.warn(
        'Both describe outputs are disabled (publishAsComment=false, useMarkers=false) — skipping output',
      );
      return;
    }

    const pr = await gh.getMR(issueNumber);
    const description = await engine.runDescribe(pr, tempDir);

    let commentPosted = false;
    let bodyMerged = false;

    if (publishAsComment !== false) {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- pr-description -->',
        sanitizeMarkdown(description),
      );
      commentPosted = true;
    }

    if (useMarkers === true) {
      try {
        // Re-fetch so the merge base is fresh — pr.body was read before the
        // long LLM call and may have been edited concurrently.
        const fresh = await gh.getMR(issueNumber);
        const current = fresh.body ?? '';
        const merged = mergeDescribeBody(current, sanitizeMarkdown(description));
        if (merged !== current) {
          await gh.updateMR(issueNumber, { body: merged });
          bodyMerged = true;
        }
      } catch (updateErr) {
        logger.warn(
          `PR body merge failed, kept comment output: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
        );
      }
    }

    logger.info(
      `Describe output for PR #${issueNumber}: comment ${commentPosted ? 'posted' : 'skipped'}, PR-body merge ${bodyMerged ? 'applied' : useMarkers === true ? 'skipped (unchanged or failed)' : 'skipped (disabled)'}`,
    );
  } catch (err) {
    if (isAbortError(err)) {
      logger.info(`Describe aborted for PR #${issueNumber}`);
      return;
    }
    logger.error(
      `Failed to describe PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- pr-description-error -->',
        `❌ **Description Generation Failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post describe-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for describe #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Handle a docs command: generate documentation for the code changed in a PR
 * and open a dedicated documentation PR from a `docs/issue-N` branch (mirrors
 * the autofix flow — the source PR's branch is left untouched). Posts
 * in-progress, no-changes, docs-PR-link, and error comments to the source PR.
 * @param gh - Platform adapter.
 * @param issueNumber - The PR number to document.
 * @param repo - Repository string (owner/repo).
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 * @param gitEnv - Git environment variables for authenticated git commands.
 * @param signal - Optional abort signal.
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 * @param parsed - Optional parsed command (for flags like --style=tsdoc).
 * @returns A promise that resolves once docs generation, branch setup, and PR
 * creation (or an error comment) complete.
 */
export async function handleDocsCommand(
  gh: PlatformAdapter,
  issueNumber: number,
  repo: string,
  config: AgentConfig,
  tempDir: string,
  gitEnv?: Record<string, string>,
  signal?: AbortSignal,
  eventBus?: EventBus,
  correlationId?: string,
  parsed?: ParsedCommand,
): Promise<void> {
  const logger = new Logger('Command:Docs', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Docs triggered for PR #${issueNumber}`);

  const gitOpts: ExecGitOptions = {
    cwd: tempDir,
    timeout: 120_000,
    ...(gitEnv ? { env: gitEnv } : {}),
    ...(signal ? { signal } : {}),
  };
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);
  const branchName = `docs/issue-${issueNumber}`;
  validateRefName(branchName);

  try {
    if (signal?.aborted) return;

    await gh.postOrUpdateComment(
      issueNumber,
      '<!-- docs-in-progress -->',
      '📝 **Docs generation in progress...** The docs agent is identifying changed code that lacks documentation and generating comments. This may take a few minutes.',
    );

    const defaultBranch = await gh.getDefaultBranch();
    validateRefName(defaultBranch);
    // Base the docs branch on the source PR's head so the changed code the PR
    // adds or modifies is on disk before the docs engine runs. Creating it from
    // the default branch would document pre-PR revisions and miss newly-added
    // files entirely. The source PR's own branch is left untouched.
    const pr = await gh.getMR(issueNumber);
    if (pr.headRef) {
      validateRefName(pr.headRef);
    }
    const baseRef = pr.headRef || defaultBranch;

    if (signal?.aborted) return;

    // Single owner for fetch → fork-aware checkout → rebase (lib/branch-workspace).
    await prepareBranchWorkspace(execGit, {
      branchName,
      defaultBranch,
      baseRef,
      ...(pr.headRepoFullName ? { headRepoFullName: pr.headRepoFullName } : {}),
      repo,
      cwd: tempDir,
      ...(gitEnv ? { env: gitEnv } : {}),
      ...(signal ? { signal } : {}),
      logger,
    });

    const contextMarkdown = await gh.gatherContext({ prNumber: issueNumber });

    if (signal?.aborted) return;

    const styleFlag = typeof parsed?.flags?.style === 'string' ? parsed.flags.style : undefined;
    const styleIsValid = styleFlag !== undefined && isDocStyle(styleFlag);
    if (styleFlag !== undefined && !styleIsValid) {
      logger.warn(`Ignoring invalid docs style flag "${styleFlag}" — using configured style`);
    }
    const docStyle: DocStyle | undefined = styleIsValid ? styleFlag : config.docs?.style;
    signal?.throwIfAborted();
    const docsResult = await engine.runDocs(pr, contextMarkdown, tempDir, undefined, docStyle);

    if (signal?.aborted) return;

    if (!docsResult?.changesMade) {
      logger.info('No documentation changes made by docs agent');
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-no-changes -->',
        '🔍 No documentation changes were needed — the changed code is already documented.',
      );
      return;
    }

    await execGit(['add', '-A'], gitOpts);
    await execGit(['commit', '-m', `docs: add API documentation for #${issueNumber}`], gitOpts);

    try {
      await pushBranchWithLease(execGit, {
        branchName,
        cwd: tempDir,
        ...(gitEnv ? { env: gitEnv } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      logger.error(`Git push failed: ${sanitizeErrorMessage(err)}`);
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- docs-error -->',
          `❌ Docs push failed: ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post docs push-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        );
      }
      return;
    }

    if (signal?.aborted) return;

    const prTitle = `[Docs] ${pr.title}`;
    const prBody = buildDocsPRBody({
      prNumber: issueNumber,
      prTitle: pr.title,
      docsSummary: docsResult.summary,
      filesChanged: docsResult.filesChanged ?? [],
      branchName,
      docStyle,
    });

    await gh.ensureLabels(['docs']);

    const newPR = await gh.createPR(prTitle, prBody, branchName, defaultBranch);
    if (newPR) {
      logger.info(`Created docs PR #${newPR.number}: ${newPR.url}`);
      try {
        await gh.addLabels(newPR.number, ['docs']);
      } catch (err) {
        logger.warn(
          `Failed to label docs PR #${newPR.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- docs-pr-link -->',
          `📝 Docs PR created: ${newPR.url}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to post docs PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    // A re-run of /docs pushes new changes to the existing docs/issue-N branch
    // before we reach this point, so createPR fails because a PR already exists
    // for that branch. Reuse the previously-linked docs PR instead of reporting
    // an error to the source PR.
    const existingPR = await findExistingDocsPR(gh, issueNumber);
    if (existingPR) {
      logger.info(`Reusing existing docs PR #${existingPR.number}: ${existingPR.url}`);
      try {
        await gh.addLabels(existingPR.number, ['docs']);
      } catch (err) {
        logger.warn(
          `Failed to label docs PR #${existingPR.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- docs-pr-link -->',
          `📝 Docs PR: ${existingPR.url}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to post docs PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    logger.error('Failed to create PR via GitHub API');
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-error -->',
        `❌ Failed to create docs PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post docs-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } catch (err) {
    if (isAbortError(err, signal)) {
      logger.info(`Docs aborted for PR #${issueNumber}`);
      return;
    }
    logger.error(
      `Docs PR creation failed for PR #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- docs-error -->',
        `❌ **Docs generation failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post docs-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for docs #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Handle a setup command: run the pre-flight validation checks against the
 * cloned workspace and post the markdown report as a comment on the issue.
 * @param issueNumber - The issue/PR number that triggered the setup.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 */
export async function handleSetup(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
): Promise<void> {
  const logger = new Logger('Command:Setup', { repo, prNumber: issueNumber });
  logger.info(`Running setup validation for issue #${issueNumber}`);

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
  const engine = new SetupEngine(config, {
    workingDirectory: tempDir,
    platform: config.platform,
    githubToken: token,
    repo: config.platform === 'github' ? repo : undefined,
  });

  try {
    const result = await engine.runAll();
    const report = engine.formatReport(result);

    await gh.postOrUpdateComment(issueNumber, '<!-- setup-report -->', report);

    logger.info(
      `Posted setup validation report for issue #${issueNumber} (overall: ${result.overall})`,
    );
  } catch (err) {
    logger.error(
      `Failed to run setup validation for issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- setup-report -->',
        `❌ **Setup Validation Failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post setup-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  }
}

/**
 * Find a previously-created autofix PR by scanning the issue body and comments
 * for the `<!-- autofix-pr-link -->` marker (single owner:
 * `lib/src/utils/linked-pr.ts#findLinkedPRNumberByMarker`).
 * @param issueNumber - Issue number that triggered the fix.
 * @param issue - Issue context with body and comments to scan.
 * @returns The linked PR number, or null.
 */
async function findExistingAutofixPR(
  issueNumber: number,
  issue: IssueContext,
): Promise<number | null> {
  const logger = new Logger('Command', { prNumber: issueNumber });
  try {
    return findLinkedPRNumberByMarker(
      { body: issue.body, comments: issue.comments },
      '<!-- autofix-pr-link -->',
    );
  } catch (err) {
    logger.debug(
      `Failed to find existing autofix PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

/**
 * Find a previously-created docs PR by scanning the source PR's comments for
 * the `<!-- docs-pr-link -->` marker (single owner:
 * `lib/src/utils/linked-pr.ts#findLinkedPRByMarker`).
 * @param gh - Platform adapter.
 * @param issueNumber - PR/issue number that triggered the command.
 * @returns The existing docs PR number/URL, or null.
 */
async function findExistingDocsPR(
  gh: PlatformAdapter,
  issueNumber: number,
): Promise<{ number: number; url: string } | null> {
  const logger = new Logger('Command', { prNumber: issueNumber });
  try {
    const issue = await gh.getIssue(issueNumber);
    return findLinkedPRByMarker(issue.comments, '<!-- docs-pr-link -->');
  } catch (err) {
    logger.debug(
      `Failed to find existing docs PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

/**
 * Create an autofix PR for an issue: set up the `autofix/issue-N` branch
 * workspace (single owner: `lib/src/utils/branch-workspace.ts`), ensure
 * workspace dependencies (single owner: `lib/src/utils/workspace-deps.ts`),
 * run the fix engine, and push with `--force-with-lease`.
 * @param gh - Platform adapter.
 * @param issueNumber - Issue number that triggered the fix.
 * @param repo - Repository string (owner/repo).
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 * @param gitEnv - Optional git environment variables for authenticated commands.
 * @param signal - Optional abort signal.
 * @param force - Auto-answer blocking analysis questions.
 * @param eventBus - Optional event bus for pipeline events.
 * @param correlationId - Optional correlation ID for tracing.
 * @param initialIssue - Optional pre-fetched issue context.
 * @returns The created PR number, or null.
 */
async function createAutofixPR(
  gh: PlatformAdapter,
  issueNumber: number,
  repo: string,
  config: AgentConfig,
  tempDir: string,
  gitEnv?: Record<string, string>,
  signal?: AbortSignal,
  force = false,
  eventBus?: EventBus,
  correlationId?: string,
  initialIssue?: IssueContext,
): Promise<number | null> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber, correlationId });
  logger.info(`Fix triggered for issue #${issueNumber}`);

  if (signal?.aborted) return null;

  await gh.postOrUpdateComment(
    issueNumber,
    '<!-- autofix-in-progress -->',
    '🤖 **Autofix in progress...** The fix agent is analyzing the codebase and implementing changes. This may take a few minutes.',
  );

  const gitOpts: ExecGitOptions = {
    cwd: tempDir,
    timeout: 120_000,
    ...(gitEnv ? { env: gitEnv } : {}),
    ...(signal ? { signal } : {}),
  };
  const engine = new ReviewEngine(config, gh, undefined, eventBus, repo, correlationId);
  const branchName = `autofix/issue-${issueNumber}`;
  validateRefName(branchName);

  try {
    const defaultBranch = await gh.getDefaultBranch();
    validateRefName(defaultBranch);

    if (signal?.aborted) return null;

    // Single owner for fetch → checkout → rebase (lib/branch-workspace).
    await prepareBranchWorkspace(execGit, {
      branchName,
      defaultBranch,
      repo,
      cwd: tempDir,
      ...(gitEnv ? { env: gitEnv } : {}),
      ...(signal ? { signal } : {}),
      logger,
    });

    // The fix workspace is a fresh clone with no node_modules, so the AI agent's
    // verification commands (pnpm build/typecheck/lint) would fail with
    // "tsc: not found". Install dependencies once up front (single matrix in
    // lib/workspace-deps, incl. lockfileVersion 9 handling).
    try {
      signal?.throwIfAborted();
      await ensureWorkspaceDeps({
        cwd: tempDir,
        ...(signal ? { signal } : {}),
        ...(gitEnv ? { env: { GIT_ASKPASS: 'echo', GIT_TERMINAL_PROMPT: '0' } } : {}),
        run: (program, args, opts) =>
          execProcess(program, args, {
            cwd: opts.cwd,
            ...(opts.env ? { env: opts.env } : {}),
            timeout: opts.timeout,
            ...(opts.signal ? { signal: opts.signal } : {}),
          }),
        logger,
      });
    } catch (installErr) {
      if (signal?.aborted) return null;
      logger.warn(
        `Autofix dependency install failed: ${
          installErr instanceof Error ? installErr.message : String(installErr)
        } — continuing without dependencies`,
      );
    }

    let issue = initialIssue ?? (await gh.getIssue(issueNumber));
    let issueContext = await gh.gatherContext({ issueNumber });

    if (signal?.aborted) return null;

    // Auto-analyze if no implementation plan exists yet
    // gatherContext() strips the marker and replaces it with the header below,
    // so check both.
    const hasPlan =
      issueContext.includes('<!-- issue-analysis-plan -->') ||
      issueContext.includes('### Implementation Plan (from analysis)');
    if (!hasPlan) {
      logger.info('No implementation plan found — running analyze first');
      signal?.throwIfAborted();
      const planMarkdown = await engine.runAnalyze(issueNumber, issueContext, undefined, tempDir);
      const parsed = parseAnalysisPlan(planMarkdown);
      await gh.postOrUpdateComment(issueNumber, '<!-- issue-analysis-plan -->', planMarkdown);

      if (parsed.hasBlockingQuestions) {
        if (force) {
          logger.info('Force mode — auto-answering blocking questions');
          await autoAnswerBlockingQuestions(gh, issueNumber, parsed.blockingQuestions);
        } else {
          await postBlockingQuestions(gh, issueNumber, parsed);
          await gh.postOrUpdateComment(
            issueNumber,
            '<!-- autofix-deferred -->',
            [
              '⏸️ **Fix Deferred — Questions Pending**',
              '',
              'I cannot start the fix yet because there are unanswered questions in the analysis.',
              'Please answer the questions above, then comment `/fix` again.',
            ].join('\n'),
          );
          return null;
        }
      } else {
        await markAnalysisReady(gh, issueNumber);
      }
    }

    if (signal?.aborted) return null;

    // The analysis above may have posted a plan/questions/force-answers comment
    // and swapped labels, and the clone/fetch/checkout branch setup can take
    // minutes. Re-fetch right before the pending-question checks so a user's
    // answer comment that landed meanwhile is observed — otherwise an
    // answerable fix is wrongly deferred on a stale issue.
    issue = await gh.getIssue(issueNumber);
    issueContext = await gh.gatherContext({ issueNumber });

    const hasQuestionsPending = await checkForUnansweredQuestions(issue, issueContext);
    if (hasQuestionsPending) {
      if (force) {
        logger.info('Force mode — auto-answering pending questions from previous analysis');
        const pendingQuestions = await extractBlockingQuestions(issue);
        await autoAnswerBlockingQuestions(gh, issueNumber, pendingQuestions);
      } else {
        logger.info(`Issue #${issueNumber} has unanswered blocking questions — fix deferred`);
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-deferred -->',
          [
            '⏸️ **Fix Deferred — Questions Pending**',
            '',
            'I cannot start the fix yet because there are unanswered questions in the analysis.',
            'Please answer the questions above, then comment `/fix` again.',
          ].join('\n'),
        );
        return null;
      }
    }

    const qa = buildQAContext(issue.comments);
    if (qa) {
      issueContext += '\n\n' + qa;
    }

    const stubPR: PRContext = {
      number: issueNumber,
      title: issue.title,
      body: issue.body || '',
      headRef: branchName,
      headSha: '',
      baseRef: defaultBranch,
      author: 'opencode-pr-agent[bot]',
      labels: [],
      changedFiles: [],
    };
    signal?.throwIfAborted();
    const fixResult = await engine.runFix(
      issueNumber,
      0,
      issueContext,
      stubPR,
      undefined,
      undefined,
      undefined,
      tempDir,
    );

    if (signal?.aborted) return null;

    if (!fixResult?.changesMade) {
      logger.info('No changes made by fix agent');
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-no-changes -->',
        '🔍 No changes were needed — the fix agent found nothing to fix.',
      );
      return null;
    }

    await execGit(['add', '-A'], gitOpts);
    await execGit(['commit', '-m', `fix: address issue #${issueNumber}`], gitOpts);

    try {
      await pushBranchWithLease(execGit, {
        branchName,
        cwd: tempDir,
        ...(gitEnv ? { env: gitEnv } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      logger.error(`Git push failed: ${sanitizeErrorMessage(err)}`);
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-error -->',
          `❌ Autofix push failed: ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post autofix push-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        );
      }
      return null;
    }

    if (signal?.aborted) return null;

    const prTitle = `[Autofix] ${issue.title}`;
    const prBody = buildAutofixPRBody({
      issueNumber,
      issueTitle: issue.title,
      fixSummary: fixResult.summary,
      filesChanged: fixResult.filesChanged ?? [],
      branchName,
      hasTests: false,
    });

    await gh.ensureLabels(['autofix']);

    const pr = await gh.createPR(prTitle, prBody, branchName, defaultBranch);
    if (pr) {
      logger.info(`Created PR #${pr.number}: ${pr.url}`);
      try {
        await gh.addLabels(pr.number, ['autofix']);
      } catch (err) {
        logger.warn(
          `Failed to label autofix PR #${pr.number}: ${err instanceof Error ? err.message : err}`,
        );
      }
      try {
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- autofix-pr-link -->',
          `🔧 Autofix PR created: ${pr.url}`,
        );
      } catch (err) {
        logger.warn(
          `Failed to post autofix PR link comment: ${err instanceof Error ? err.message : err}`,
        );
      }
      return pr.number;
    }

    logger.error('Failed to create PR via GitHub API');
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-error -->',
        `❌ Failed to create autofix PR from branch \`${branchName}\`. A PR may already exist from this branch or the API rejected the request.`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post autofix-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
    return null;
  } catch (err) {
    if (isAbortError(err, signal)) {
      logger.info(`Autofix PR creation aborted for issue #${issueNumber}`);
      return null;
    }
    logger.error(
      `Autofix PR creation failed for issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- autofix-error -->',
        `❌ **Autofix failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post autofix-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
    return null;
  } finally {
    try {
      await engine.cleanup();
    } catch (cleanupErr) {
      logger.warn(
        `Engine cleanup failed for autofix #${issueNumber}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }
}

/**
 * Check whether an issue has unanswered blocking analysis questions: the
 * `<!-- issue-analysis-questions -->` marker is present, the
 * `analysis:needs-input` label is set, and no human replied after the
 * questions comment. Fails closed (true) on unexpected errors.
 * @param issue - Issue context with labels and comments.
 * @param issueContext - Gathered markdown context containing analysis markers.
 * @returns True when blocking questions are still unanswered.
 */
async function checkForUnansweredQuestions(
  issue: IssueContext,
  issueContext: string,
): Promise<boolean> {
  if (!issueContext.includes('<!-- issue-analysis-questions -->')) {
    return false;
  }
  try {
    if (!issue.labels.includes('analysis:needs-input')) {
      return false;
    }
    const questionsCommentIdx = issue.comments.findIndex((c) =>
      c.body.startsWith('<!-- issue-analysis-questions -->'),
    );
    if (questionsCommentIdx === -1) return true;

    const repliesAfter = issue.comments
      .slice(questionsCommentIdx + 1)
      .filter((c) => !isBotLogin(c.author));

    return repliesAfter.length === 0;
  } catch (err) {
    logger.warn(
      `Failed to check unanswered questions for #${issue.number}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

/**
 * Build Q&A context from human replies posted after the
 * `<!-- issue-analysis-questions -->` comment, so the fix engine observes
 * answers given after analysis.
 * @param comments - Issue comments in chronological order.
 * @returns Markdown Q&A section, or empty string when no answers exist.
 */
function buildQAContext(comments: Array<{ author: string; body: string }>): string {
  const questionsIdx = comments.findIndex((c) =>
    c.body.startsWith('<!-- issue-analysis-questions -->'),
  );
  if (questionsIdx === -1) return '';

  const answers = comments.slice(questionsIdx + 1).filter((c) => !isBotLogin(c.author));
  if (answers.length === 0) return '';

  const lines = ['### Q&A Context (from issue discussion)'];
  for (const answer of answers) {
    lines.push(`**@${answer.author}:** ${answer.body}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Auto-answer blocking questions on an issue when --force is used.
 * Posts a comment with default answers and swaps labels to analysis:ready.
 * @param gh - Platform adapter
 * @param issueNumber - Issue number
 * @param questions - Blocking questions to answer
 */
async function autoAnswerBlockingQuestions(
  gh: PlatformAdapter,
  issueNumber: number,
  questions: string[],
): Promise<void> {
  const answers = questions.map(
    (q, i) => `**Q${i + 1}:** ${q}\n\n**A${i + 1}:** Yes, proceed with the recommended approach.`,
  );

  const body = [
    '<!-- autofix-force-answers -->',
    '## ✅ Auto-Answers (Force Mode)',
    '',
    'The `/fix --force` command was used. Automatically answering the following questions to proceed:',
    '',
    ...answers,
    '',
    '---',
    '*Proceeding with implementation.*',
  ].join('\n');

  await gh.postOrUpdateComment(issueNumber, '<!-- autofix-force-answers -->', body);
  await gh.setLabels(issueNumber, ['analysis:ready'], ['analysis:needs-input']);
}

/**
 * Extract blocking questions from the issue's questions comment.
 * @param issue - The issue context, already fetched by the caller.
 * @returns Array of blocking question strings
 */
async function extractBlockingQuestions(issue: IssueContext): Promise<string[]> {
  try {
    const questionsComment = issue.comments.find((c) =>
      c.body.startsWith('<!-- issue-analysis-questions -->'),
    );
    if (!questionsComment) return [];

    const questions: string[] = [];
    const qRegex = /(?:\*\*Q\d+:\*\*|\*\*Question \d+:\*\*)\s*(.+?)(?=\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = qRegex.exec(questionsComment.body)) !== null) {
      const qText = match[1]?.trim();
      if (qText) questions.push(qText);
    }
    return questions;
  } catch {
    return [];
  }
}
