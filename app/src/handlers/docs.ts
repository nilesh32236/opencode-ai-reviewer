import type {
  AgentConfig,
  DocStyle,
  EventBus,
  ParsedCommand,
  PlatformAdapter,
} from '@opencode-pr-agent/lib';
import {
  Logger,
  ReviewEngine,
  buildDocsPRBody,
  commitAndPushWithLease,
  findLinkedPRByMarker,
  isDocStyle,
  prepareBranchWorkspace,
  sanitizeErrorMessage,
  validateRefName,
} from '@opencode-pr-agent/lib';
import { execGit } from '../utils/git.js';
import { isAbortError } from './command-helpers.js';

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
    // adds or modifies is on disk before the docs engine runs.
    const pr = await gh.getMR(issueNumber);
    if (signal?.aborted) return;

    try {
      await prepareBranchWorkspace(execGit, {
        branchName,
        defaultBranch,
        baseRef: pr.headRef || undefined,
        headRepoFullName: pr.headRepoFullName ?? undefined,
        repo,
        cwd: tempDir,
        ...(gitEnv ? { env: gitEnv } : {}),
        ...(signal ? { signal } : {}),
        logger,
      });
    } catch (err) {
      logger.warn(
        `Docs branch workspace setup failed: ${err instanceof Error ? err.message : String(err)} — continuing with local state`,
      );
    }

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

    try {
      await commitAndPushWithLease(execGit, {
        message: `docs: add API documentation for #${issueNumber}`,
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
 * Find a previously-linked docs PR for an issue by scanning for the
 * docs-PR-link comment (single owner:
 * `lib/src/utils/linked-pr.ts#findLinkedPRByMarker`, mirroring changelog).
 * @param gh - Platform adapter.
 * @param issueNumber - The source issue/PR number.
 * @returns The linked PR number and URL, or null when none is found.
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
      `Failed to find existing docs PR for issue ${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}
