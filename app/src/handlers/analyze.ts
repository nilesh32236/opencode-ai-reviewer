import type { AgentConfig, EventBus } from '@opencode-pr-agent/lib';
import {
  Logger,
  ReviewEngine,
  createPlatformAdapter,
  markAnalysisReady,
  parseAnalysisPlan,
  postBlockingQuestions,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { isAbortError } from './command-helpers.js';

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

  const gh: PlatformAdapter = createPlatformAdapter(token, repo, config.platform);
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
