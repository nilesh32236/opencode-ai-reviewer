import type { AgentConfig, PRContext, ReviewResult } from '@opencode-pr-agent/lib';
import { GitHubHelper, Logger, ReviewEngine } from '@opencode-pr-agent/lib';

export async function handlePRReview(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<void> {
  const logger = new Logger('PRReview', { prNumber, repo });
  logger.info(`Starting review for PR #${prNumber}`);

  const gh = new GitHubHelper(token, repo);

  let pr: PRContext;
  try {
    pr = await gh.getPR(prNumber);
  } catch (err) {
    logger.error(`Failed to get PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const hasSkipLabel = pr.labels.some((l) => config.review.skipLabels.includes(l));
  if (hasSkipLabel) {
    logger.info(`PR #${prNumber} has skip label — skipping`);
    return;
  }

  const engine = new ReviewEngine(config, token, repo);

  try {
    let _contextMd = `## PR #${prNumber}\n\n**Title:** ${pr.title}\n\n${pr.body}`;

    if (pr.linkedIssue) {
      try {
        const issue = await gh.getIssue(pr.linkedIssue);
        _contextMd += `\n\n## Issue #${pr.linkedIssue}\n\n**Title:** ${issue.title}\n\n${issue.body}`;
      } catch {
        logger.debug('Failed to fetch linked issue', { prNumber });
      }
    }

    let result: ReviewResult;
    try {
      result = await engine.reviewPR(pr);
    } catch (err) {
      logger.error(
        `Review engine failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    let reviewResult: { success: boolean; method: string };
    try {
      reviewResult = await gh.postReview(prNumber, pr.headSha, result);
    } catch (err) {
      logger.error(
        `Failed to post review for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (reviewResult.success) {
      logger.info(`Review posted to PR #${prNumber} (${reviewResult.method})`);
    } else {
      logger.warn(`Failed to post review to PR #${prNumber}`, { prNumber, repo });
    }

    if (
      !result.verdict.ready &&
      result.verdict.autoFixable &&
      result.verdict.confidence === 'high'
    ) {
      logger.info(
        `Review agent confirmed issues are auto-fixable with high confidence. Launching handleAutofixLoop...`,
      );
      try {
        const { handleAutofixLoop } = await import('./autofix.js');
        await handleAutofixLoop(prNumber, repo, token, config);
      } catch (err) {
        logger.error(
          `Autofix loop failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (err) {
      logger.error(
        `Engine cleanup failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
