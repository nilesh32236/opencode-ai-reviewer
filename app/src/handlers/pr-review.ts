import type {
  AgentConfig,
  LearningStore,
  PRContext,
  PlatformAdapter,
  ReviewResult,
} from '@opencode-pr-agent/lib';
import {
  GitHubHelper,
  GitLabAdapter,
  Logger,
  ReviewEngine,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import { handleAutofixLoop } from './autofix.js';

/** Marker identifying the "review in progress" status comment on a PR. */
const REVIEW_IN_PROGRESS_MARKER = '<!-- review-in-progress -->';

/**
 * Handle a PR review: fetch the PR, check skip conditions, run the review
 * engine, post the review to GitHub, optionally trigger autofix, and
 * store findings in the learning store.
 * @param prNumber - The PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param learningStore - Optional learning store for recording findings.
 * @param tempDir - Optional temporary working directory.
 * @param previousHeadSha - Optional previous HEAD sha
 * @returns The review result or null if review was skipped or failed.
 */
export async function handlePRReview(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  learningStore?: LearningStore,
  tempDir?: string,
  previousHeadSha?: string,
): Promise<ReviewResult | null> {
  const logger = new Logger('PRReview', { prNumber, repo });
  logger.info(
    `Starting review for PR #${prNumber}${previousHeadSha ? ` (delta from ${previousHeadSha.slice(0, 7)})` : ''}`,
  );

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);

  let pr: PRContext;
  try {
    pr = await gh.getMR(prNumber);
  } catch (err) {
    logger.error(`Failed to get PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const hasSkipLabel = pr.labels.some((l) => config.review.skipLabels.includes(l));
  if (hasSkipLabel) {
    logger.info(`PR #${prNumber} has skip label — skipping`);
    return null;
  }

  const engine = new ReviewEngine(config, gh, learningStore);

  try {
    const reviewWorkingDir = tempDir || process.cwd();
    let previousBotComments:
      | Array<{ file: string; line: number | null; body: string; commentId: number }>
      | undefined;
    try {
      const threads = await gh.getBotReviewThreads(prNumber);
      previousBotComments = threads
        .filter((t) => t.firstComment)
        .map((t) => ({
          file: t.firstComment!.filePath,
          line: t.firstComment!.lineNumber,
          body: t.firstComment!.body,
          commentId: t.firstComment!.databaseId,
        }));
    } catch (err) {
      logger.warn(`Failed to fetch previous bot comments: ${err}`);
    }

    let result: ReviewResult;
    try {
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_IN_PROGRESS_MARKER,
          '⏳ **Reviewing this PR...** The review engine is analyzing the changes. This may take a few minutes.',
        );
      } catch (err) {
        logger.warn(
          `Failed to post review-in-progress comment: ${err instanceof Error ? err.message : err}`,
        );
      }

      result = await engine.reviewPR(
        pr,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reviewWorkingDir,
        previousHeadSha,
        previousBotComments,
      );
    } catch (err) {
      logger.error(
        `Review engine failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_IN_PROGRESS_MARKER,
          `❌ **Review failed.** ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post review-failure comment: ${commentErr instanceof Error ? commentErr.message : commentErr}`,
        );
      }
      return null;
    }

    if (!result.summary && result.issues.length === 0 && result.strengths.length === 0) {
      logger.warn(`Review returned no meaningful content for PR #${prNumber}`, { prNumber, repo });
      return null;
    }

    let reviewResult: Awaited<ReturnType<typeof gh.postReview>>;
    try {
      reviewResult = await gh.postReview(prNumber, pr.headSha, result, config.review.inline);
    } catch (err) {
      logger.error(
        `Failed to post review for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
      );
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_IN_PROGRESS_MARKER,
          `❌ **Review failed.** Could not post the review: ${sanitizeErrorMessage(err)}`,
        );
      } catch (commentErr) {
        logger.warn(
          `Failed to post review-failure comment: ${commentErr instanceof Error ? commentErr.message : commentErr}`,
        );
      }
      return null;
    }

    if (reviewResult.success) {
      logger.info(`Review posted to PR #${prNumber} (${reviewResult.method})`);
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_IN_PROGRESS_MARKER,
          '✅ **Review complete** — see the review above.',
        );
      } catch (err) {
        logger.warn(
          `Failed to post review-complete comment: ${err instanceof Error ? err.message : err}`,
        );
      }
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
        await handleAutofixLoop(prNumber, repo, token, config, undefined, tempDir);
      } catch (err) {
        logger.error(
          `Autofix loop failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (learningStore) {
      try {
        // Correlate posted inline comments back to their findings so a later
        // /dismiss on a bot comment can match by exact comment id.
        const commentIdByKey = new Map<string, number>();
        for (const c of reviewResult.commentIds ?? []) {
          commentIdByKey.set(`${c.file.replace(/^\//, '')}:${c.line}`, c.commentId);
        }

        const findingsToStore = [
          ...result.issues.map((i) => ({
            prNumber,
            type: 'issue' as const,
            severity: i.severity,
            file: i.file,
            line: i.line,
            message: i.message,
            suggestion: i.suggestion,
            commentId:
              i.file && i.line !== undefined
                ? commentIdByKey.get(`${i.file.replace(/^\//, '')}:${i.line}`)
                : undefined,
          })),
          ...result.strengths.map((s) => ({
            prNumber,
            type: 'strength' as const,
            file: s.file,
            message: s.message,
          })),
        ];
        if (findingsToStore.length > 0) {
          await learningStore.recordFindings(findingsToStore);
          logger.info(
            `Stored ${findingsToStore.length} findings in LearningStore for PR #${prNumber}`,
          );
        }
      } catch (err) {
        logger.error(
          `Failed to store findings in LearningStore: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return result;
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
