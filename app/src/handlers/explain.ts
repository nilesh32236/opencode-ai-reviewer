import type { AgentConfig, EventBus } from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  ReviewEngine,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { isAbortError } from './command-helpers.js';

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
