import type {
  AgentConfig,
  EventBus,
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
  postSuggestionComment,
  sanitizeErrorMessage,
  sendNotification,
  shouldFailOnSeverity,
} from '@opencode-pr-agent/lib';
import { mergeRepoConfig } from '../utils/config.js';
import { handleAutofixLoop } from './autofix.js';
/** Marker identifying the "review in progress" status comment on a PR. */
const REVIEW_IN_PROGRESS_MARKER = '<!-- review-in-progress -->';

/** Safety bound for check-run output text (GitHub caps it at 65535 bytes). */
const MAX_CHECK_TEXT_BYTES = 60_000;

/**
 * Truncate a string so its UTF-8 encoding fits within `maxBytes` while keeping
 * the result valid UTF-8 (never splits a multi-byte character). The Checks API
 * limits output text in bytes, so code-unit length alone is insufficient.
 * @param text - The text to truncate.
 * @param maxBytes - Maximum UTF-8 byte length (defaults to the check limit).
 * @returns The truncated text, or the original when it already fits.
 */
function truncateToUtf8Bytes(text: string, maxBytes: number = MAX_CHECK_TEXT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let truncated = '';
  for (const ch of text) {
    if (Buffer.byteLength(truncated + ch, 'utf8') > maxBytes) break;
    truncated += ch;
  }
  return truncated;
}

/**
 * Handle a PR review: fetch the PR, check skip conditions, run the review
 * engine, post the review to GitHub, optionally trigger autofix, and
 * store findings in the learning store.
 *
 * When `config.review.failOnSeverity` is enabled on GitHub, an
 * "OpenCode AI Reviewer" check run is reported on every terminal path where the
 * head SHA is known (neutral/failure on skip/errors, success/failure on the
 * completed review) so branch protection never waits on a pending check.
 * @param prNumber - The PR number.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param learningStore - Optional learning store for recording findings.
 * @param tempDir - Optional temporary working directory.
 * @param previousHeadSha - Optional previous HEAD sha
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param correlationId - Optional correlation ID for tracing this request.
 * @param options - Optional behavior flags:
 *   - `forceReview`: bypass the dedup cache so an explicit `/review` always runs.
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
  eventBus?: EventBus,
  correlationId?: string,
  options?: { forceReview?: boolean },
): Promise<ReviewResult | null> {
  const logger = new Logger('PRReview', { prNumber, repo, correlationId });
  logger.info(
    `Starting review for PR #${prNumber}${previousHeadSha ? ` (delta from ${previousHeadSha.slice(0, 7)})` : ''}`,
  );

  const gh: PlatformAdapter =
    config.platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);

  // Resolve the effective configuration once: per-repo `.opencode-reviewer.yml`
  // overrides (including `review.failOnSeverity`) must drive both the engine and
  // the check-run gate so a repo value can enable/select the gate, not only
  // review processing.
  const effectiveConfig = mergeRepoConfig(config, tempDir);

  // Report a check run so branch protection can consume the review outcome as
  // a required status check. It is emitted on every terminal path where the
  // head SHA is known (skip, engine failure, empty result, post failure) with a
  // 'neutral'/'failure' conclusion so a required check never hangs pending.
  // `failOnSeverity: 'off'` disables check runs entirely, preserving the
  // pre-integration behavior.
  const reportCheckRun = async (
    headSha: string,
    conclusion: 'success' | 'failure' | 'neutral',
    title: string,
    summary: string,
    text?: string,
  ): Promise<void> => {
    if (config.platform !== 'github' || effectiveConfig.review.failOnSeverity === 'off') return;
    try {
      // The Checks API rejects output text over 65535 bytes (not code units), so
      // an oversized model-generated summary must never prevent the check from
      // appearing. Truncate by UTF-8 byte length while preserving valid UTF-8.
      const safeText = truncateToUtf8Bytes(text ?? '', MAX_CHECK_TEXT_BYTES) || undefined;
      await gh.createCheckRun('OpenCode AI Reviewer', headSha, conclusion, {
        title,
        summary,
        ...(safeText ? { text: safeText } : {}),
      });
      logger.info(`Created check run for PR #${prNumber} with conclusion: ${conclusion}`);
    } catch (err) {
      // Surface failures (e.g. 403 missing checks permission, 422 oversized
      // payload) as errors so the feature never fails silently under branch
      // protection.
      logger.error(`Failed to create check run: ${err instanceof Error ? err.message : err}`);
    }
  };

  let pr: PRContext;
  try {
    pr = await gh.getMR(prNumber);
  } catch (err) {
    logger.error(`Failed to get PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
    // No head SHA is available here, so a check run cannot be attached to a commit.
    return null;
  }

  const hasSkipLabel = pr.labels.some((l) => config.review.skipLabels.includes(l));
  if (hasSkipLabel) {
    logger.info(`PR #${prNumber} has skip label — skipping`);
    await reportCheckRun(
      pr.headSha,
      'neutral',
      'Review skipped',
      `PR #${prNumber} carries a configured skip label — no review was performed.`,
    );
    return null;
  }

  const engine = new ReviewEngine(
    effectiveConfig,
    gh,
    learningStore,
    eventBus,
    repo,
    correlationId,
  );

  try {
    const reviewWorkingDir = tempDir || process.cwd();
    let previousBotComments:
      | Array<{ file: string; line: number | null; body: string; commentId: number }>
      | undefined;
    try {
      const threads = await gh.getBotReviewThreads(prNumber);
      previousBotComments = threads.map((t) => ({
        file: t.firstComment.filePath,
        line: t.firstComment.lineNumber,
        body: t.firstComment.body,
        commentId: t.firstComment.databaseId,
      }));
    } catch (err) {
      logger.warn(
        `Failed to fetch previous bot comments: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let result: ReviewResult;
    const streamedIssueKeys = new Set<string>();
    let streamedFindingCount = 0;
    const streamEnabled = effectiveConfig.review.streamComments === true;
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
        streamEnabled
          ? async (batchIndex, totalBatches, batchResult) => {
              for (const issue of batchResult.issues) {
                if (issue.inline && issue.file && issue.line) {
                  const key = `${issue.file}:${issue.line}`;
                  // Never post the same file:line twice across batches, and
                  // only mark a finding as streamed when the inline post
                  // actually succeeded — otherwise the final-result filter
                  // below would drop it entirely (neither inline nor body).
                  if (streamedIssueKeys.has(key)) continue;
                  const posted = await gh.postInlineComment(prNumber, pr.headSha, {
                    path: issue.file,
                    line: issue.line,
                    body: `**${issue.severity.toUpperCase()}**: ${issue.message}`,
                  });
                  if (posted) {
                    streamedIssueKeys.add(key);
                    streamedFindingCount++;
                  } else {
                    logger.warn(
                      `Inline comment post failed for ${key} — will retry in final review body`,
                      { prNumber, repo },
                    );
                  }
                }
              }
              await gh
                .postStreamingProgress(
                  prNumber,
                  batchIndex + 1,
                  totalBatches,
                  streamedFindingCount,
                  batchResult.issues[batchResult.issues.length - 1]?.file,
                )
                .catch((err) => {
                  logger.warn(
                    `Failed to post streaming progress: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
            }
          : undefined,
        { forceReview: options?.forceReview ?? false },
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
      await reportCheckRun(
        pr.headSha,
        'failure',
        'Review failed',
        'The review engine could not complete the review for this commit.',
      );
      return null;
    }

    if (result.skipped) {
      // Dedup short-circuit: this PR+head was already reviewed (or an in-flight
      // run is doing it). Treat as an informational no-op — clear the
      // in-progress marker and do NOT post a duplicate review or check run.
      logger.info(`Review deduplicated for PR #${prNumber} — skipping duplicate post`);
      try {
        await gh.postOrUpdateComment(
          prNumber,
          REVIEW_IN_PROGRESS_MARKER,
          '✅ **Review already completed** for this commit — see the existing review above.',
        );
      } catch (err) {
        logger.warn(
          `Failed to update review-in-progress marker: ${err instanceof Error ? err.message : err}`,
        );
      }
      return null;
    }

    if (!result.summary && result.issues.length === 0 && result.strengths.length === 0) {
      logger.warn(`Review returned no meaningful content for PR #${prNumber}`, { prNumber, repo });
      await reportCheckRun(
        pr.headSha,
        'neutral',
        'No meaningful content',
        'The review returned no meaningful findings, so no conclusion is reported.',
      );
      return null;
    }

    let reviewResult: Awaited<ReturnType<typeof gh.postReview>>;
    try {
      // When streaming was enabled, inline findings were already posted as
      // batches completed, so the final review posts only the summary +
      // non-inline findings to avoid duplicate comments.
      const streamEnabled = effectiveConfig.review.streamComments === true;
      const finalResult =
        streamEnabled && streamedIssueKeys.size > 0
          ? {
              ...result,
              issues: result.issues.filter(
                (i) =>
                  !i.inline || !i.file || !i.line || !streamedIssueKeys.has(`${i.file}:${i.line}`),
              ),
            }
          : result;
      reviewResult = await gh.postReview(prNumber, pr.headSha, finalResult, config.review.inline);
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
      await reportCheckRun(
        pr.headSha,
        'failure',
        'Review could not be posted',
        'The review could not be posted to the pull request.',
      );
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
      if (streamEnabled) {
        try {
          await gh.postOrUpdateComment(
            prNumber,
            '<!-- review-stream-progress -->',
            '## ✅ Review In Progress\n\n**Streaming complete** — all findings posted. See the review above.',
          );
        } catch (err) {
          logger.warn(
            `Failed to update stream-progress marker: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Best-effort Slack/Teams notification with the review summary.
      // Intentionally fire-and-forget: it is a non-critical side channel, so
      // the check run that branch protection consumes must never wait on
      // Slack/Teams delivery. sendNotification swallows its own errors; the
      // defensive catch keeps an unexpected throw from surfacing as an
      // unhandled rejection on the handler path.
      void sendNotification(result, effectiveConfig.notifications, {
        number: prNumber,
        title: pr.title,
        repo,
        platform: gh instanceof GitLabAdapter ? 'gitlab' : 'github',
      }).catch((err) => {
        logger.warn(
          `Failed to send review notification: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // Best-effort conventional-commit title & label suggestion. Only posts
      // when enabled; read-only, never modifies the PR. Non-critical: a
      // failure must never fail the review flow. Uses `effectiveConfig` so a
      // repository-level override can enable or disable the suggestion.
      if (effectiveConfig.review.suggestTitleAndLabels) {
        void postSuggestionComment(gh, prNumber, pr, result, effectiveConfig.review).catch(
          (err) => {
            logger.warn(
              `Failed to post title/label suggestion: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
      }
    } else {
      logger.warn(`Failed to post review to PR #${prNumber}`, { prNumber, repo });
      // A review that was not actually posted must not gate merges as a
      // 'success'/'failure'; report neutral so branch protection does not block.
      await reportCheckRun(
        pr.headSha,
        'neutral',
        'Review could not be posted',
        'The review could not be posted to the pull request; conclusion is neutral.',
      );
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
        await handleAutofixLoop({
          prNumber,
          repo,
          token,
          config,
          tempDir,
          eventBus,
          correlationId,
        });
      } catch (err) {
        logger.error(
          `Autofix loop failed for PR #${prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Report the review-outcome check run AFTER the autofix loop, attached to
    // the SHA that was actually reviewed (`pr.headSha`). If autofix pushes a new
    // commit, never attach this pre-fix result to the new head — the subsequent
    // push event triggers a fresh review that reports a check for that SHA.
    if (reviewResult.success) {
      const threshold = effectiveConfig.review.failOnSeverity;
      const failed = shouldFailOnSeverity(result.stats, threshold);
      const summary = failed
        ? `Found ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor issue(s)`
        : 'No issues above the fail-on-severity threshold found';
      await reportCheckRun(
        pr.headSha,
        failed ? 'failure' : 'success',
        failed ? 'Issues found' : 'All clear',
        summary,
        result.summary,
      );
    }

    if (learningStore) {
      try {
        // Correlate each posted inline comment back to its finding by file:line
        // so dismissal feedback can use the exact comment_id instead of brittle
        // file/line matching. Falls back to undefined (no correlation) when a
        // finding had no inline comment.
        const commentIdByAnchor = new Map<string, number>();
        for (const c of reviewResult.commentIds ?? []) {
          if (c.file && c.line) commentIdByAnchor.set(`${c.file}:${c.line}`, c.commentId);
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
            commentId: i.file && i.line ? commentIdByAnchor.get(`${i.file}:${i.line}`) : undefined,
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
