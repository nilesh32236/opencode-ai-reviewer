import type { AgentConfig, EventBus } from '@opencode-pr-agent/lib';
import {
  Logger,
  ReviewEngine,
  createPlatformAdapter,
  mergeDescribeBody,
  sanitizeErrorMessage,
  sanitizeMarkdown,
} from '@opencode-pr-agent/lib';
import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { isAbortError } from './command-helpers.js';

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

  const gh: PlatformAdapter = createPlatformAdapter(token, repo, config.platform);
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
