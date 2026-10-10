import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PRContext, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import {
  GITHUB_REVIEW_BODY_LIMIT,
  GitLabAdapter,
  Logger,
  buildFunctionScoreOptions,
  collectFingerprintsFromBodies,
  countAtOrAboveSeverity,
  fingerprintForIssueFull,
  getErrorStatus,
  legacyInlineKey,
  mapFingerprintsToCommentIds,
  postSuggestionComment,
  redactReviewResult,
  sanitizeMarkdown,
  sendNotification,
  shouldFailOnSeverity,
  shouldPostFingerprint,
  withFingerprintMarker,
} from '@opencode-pr-agent/lib';
import { applyAnchorResolution } from './anchor-resolution.js';
import { extractCommentCommand } from './comment-commands.js';
import type { ActionInputs } from './inputs.js';
import { describeAbortKind, redactSecrets, resolvePrNumber, sanitize } from './utils.js';

/**
 * Stable key for a streamed finding: file, line, and normalized message
 * content. Distinct findings on the same line stay independent (each is
 * posted inline), while identical findings still deduplicate. Shared between
 * the inline-post loop and the final-result filter so both sides agree.
 * @param file - Finding file path.
 * @param line - Finding line number.
 * @param message - Finding message text.
 * @returns The deduplication key.
 */
function streamedFindingKey(file: string, line: number, message: string): string {
  return `${file}:${line}:${message.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/**
 * Execute a code review on a pull request and post results.
 * Determines the PR number from input or event context, fetches the PR,
 * checks skip-labels/actors, runs the review engine, and posts
 * the review to GitHub.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param repo - Repository string (owner/repo).
 * @param signal - Optional per-run AbortSignal; it is threaded into the
 *   engine's OpenCode child ownership and pre-checks.
 */
export async function runReview(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  repo: string,
  signal?: AbortSignal,
): Promise<void> {
  let prNumber = await resolvePrNumber();

  if (
    prNumber !== null &&
    !core.getInput('pr-number') &&
    !github.context.payload.pull_request?.number
  ) {
    const issueNum = github.context.payload.issue?.number;
    if (issueNum === prNumber) {
      let isMr = true;
      try {
        isMr = await gh.isMR(issueNum);
      } catch (err) {
        const status = getErrorStatus(err);
        const suffix = status !== undefined ? ` (status ${status})` : '';
        core.setFailed(
          sanitize(
            `Failed to classify #${issueNum} as PR/issue${suffix}: ${err instanceof Error ? err.message : err}`,
          ),
        );
        return;
      }
      if (!isMr) {
        prNumber = null;
      }
    }
  }

  if (prNumber === null) {
    core.setFailed('Could not determine PR number from event or input');
    return;
  }

  // Early abort pre-check before any platform fetches: a cancelled/timed-out
  // run must not pay for hot-loop getMR/threads work before bailing. A second
  // guard sits right before the engine call in case the signal fired mid-fetch.
  // The same signal is also passed to the engine, so an abort can terminate
  // an in-flight OpenCode child as well as short-circuit later API work.
  if (signal?.aborted) {
    // Default to 'cancelled' when aborted without a reason: describeAbortKind
    // returns 'error' for undefined, which would read as 'cancelled (error)'.
    const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
    core.warning(sanitize(`Review cancelled before fetch (${kind}) — skipping`));
    core.setFailed(sanitize(`Review cancelled (${kind}) before fetching the PR`));
    return;
  }

  let pr: PRContext;
  try {
    pr = await gh.getMR(prNumber);
  } catch (err) {
    core.setFailed(
      sanitize(`Failed to get PR #${prNumber}: ${err instanceof Error ? err.message : err}`),
    );
    return;
  }

  // Only an authorized slash-command comment bypasses skipLabels/skipActors:
  // any non-command issue_comment must not force an expensive LLM re-review
  // (cost/spam bypass for read-only commenters). The index.ts permission gate
  // already fails closed on unauthorized commands before this runs, so a
  // recognized command here implies an authorized trigger; non-command
  // comments, review bodies without commands, and automatic events keep skip
  // controls. workflow_dispatch and an explicit pr-number input remain manual
  // (explicit operator actions).
  const commentCommandBody =
    github.context.eventName === 'issue_comment' ||
    github.context.eventName === 'pull_request_review_comment' ||
    github.context.eventName === 'pull_request_review'
      ? ((): string | undefined => {
          const c = github.context.payload.comment as { body?: unknown } | undefined;
          if (c && typeof c.body === 'string') return c.body;
          const r = github.context.payload.review as { body?: unknown } | undefined;
          return r && typeof r.body === 'string' ? r.body : undefined;
        })()
      : undefined;
  const isManualTrigger =
    (commentCommandBody !== undefined && extractCommentCommand(commentCommandBody) !== null) ||
    github.context.eventName === 'workflow_dispatch' ||
    Boolean(core.getInput('pr-number'));

  const hasSkipLabel = pr.labels.some((l: string) => config.review.skipLabels.includes(l));
  const isSkippedActor = config.review.skipActors.includes(pr.author);

  if (hasSkipLabel && !isManualTrigger) {
    core.info(`PR has skip label — skipping review`);
    return;
  }
  if (isSkippedActor) {
    core.info(`PR author ${pr.author} is in skip list — skipping`);
    return;
  }

  let previousComments:
    | Array<{ file: string; line: number | null; body: string; commentId: number }>
    | undefined;
  let previousBotThreads:
    | Array<{ threadId: string; isResolved: boolean; body: string }>
    | undefined;
  try {
    const threads = await gh.getBotReviewThreads(prNumber);
    // Single pass over threads: each body string is stored once in the
    // thread record and both views reference it, so large review histories
    // do not duplicate every body into two parallel arrays.
    const records = threads
      .filter((t) => t.firstComment)
      .map((t) => ({
        threadId: t.threadId,
        isResolved: t.isResolved,
        file: t.firstComment!.filePath,
        line: t.firstComment!.lineNumber,
        body: t.firstComment!.body,
        commentId: t.firstComment!.databaseId,
      }));
    previousBotThreads = records.map(({ threadId, isResolved, body }) => ({
      threadId,
      isResolved,
      body,
    }));
    previousComments = records.map(({ file, line, body, commentId }) => ({
      file,
      line,
      body,
      commentId,
    }));
  } catch (err) {
    const message = `Failed to fetch previous review comments: ${err}`;
    core.warning(sanitize(message));
    new Logger('Review').warn('Failed to fetch previous review comments', {
      operation: 'review.threads',
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Persistent fingerprint store: previously posted bot threads. Identical
  // findings (same fingerprint) are skipped on re-push; changed line/snippet
  // yields a new fingerprint and posts. Fail-open: absent history posts as
  // today. Matches the postReview gate below so streaming and final post agree.
  const dedupEnabled = config.review.dedupFingerprints ?? true;
  let previousFingerprints = new Set<string>();
  let previousLegacyKeys = new Set<string>();
  try {
    if (dedupEnabled && previousComments && previousComments.length > 0) {
      previousFingerprints = collectFingerprintsFromBodies(
        previousComments.map((c) => c.body ?? ''),
      );
      previousLegacyKeys = new Set(
        previousComments.map((c) => legacyInlineKey(c.file ?? '', c.line ?? null, c.body ?? '')),
      );
    }
  } catch {
    previousFingerprints = new Set<string>();
    previousLegacyKeys = new Set<string>();
  }

  // The reviews-array path bundles all inline findings into a single
  // POST /pulls/{n}/reviews request. Streaming would fan out N per-comment
  // postInlineComment requests first, defeating that single-request goal, so
  // the reviews-array flag takes precedence and disables streaming.
  const reviewsArrayEnabled = config.review.enableReviewsArrayInline === true;
  const streamEnabled = inputs.streamComments && !reviewsArrayEnabled;

  // Track findings posted via streaming so the final summary avoids duplicates.
  const streamedIssueKeys = new Set<string>();
  const streamedFingerprints = new Set<string>();
  let streamedFindingCount = 0;

  if (signal?.aborted) {
    // The signal is also owned by the engine, so this pre-check and any
    // in-flight child termination use the same Action-wide deadline.
    // Default to 'cancelled' when aborted without a reason: describeAbortKind
    // returns 'error' for undefined, which would read as 'cancelled (error)'.
    const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
    core.warning(sanitize(`Review cancelled before engine call (${kind}) — skipping`));
    core.setFailed(sanitize(`Review cancelled (${kind}) before the engine call`));
    return;
  }

  let result: Awaited<ReturnType<typeof engine.reviewPR>>;
  try {
    result = await engine.reviewPR(
      pr,
      undefined,
      inputs.reviewPromptFile,
      inputs.reviewPromptExtra,
      undefined,
      undefined,
      undefined,
      undefined,
      previousComments,
      streamEnabled
        ? async (batchIndex, totalBatches, batchResult) => {
            // Collect postable findings first (dedup gates stay synchronous so
            // duplicates within the same batch are filtered before dispatch),
            // then post with bounded concurrency (5) instead of serial awaits.
            const pending: Array<{
              issue: (typeof batchResult.issues)[number];
              key: string;
              fingerprint: string | undefined;
              body: string;
            }> = [];
            const batchSeen = new Set<string>();
            for (const issue of batchResult.issues) {
              if (issue.inline && issue.file && issue.line) {
                // Guard the inline-comment API against model-generated garbage:
                // only positive integer lines within a sane range are posted.
                if (!Number.isInteger(issue.line) || issue.line < 1) continue;
                // Cross-run fingerprint gate: skip findings already posted in a
                // previous run (quiet debug log, no new comment). Fail-open:
                // fingerprint errors never drop a finding here — the final
                // postReview gate re-checks with the same store.
                let issueFingerprint: string | undefined;
                if (dedupEnabled) {
                  try {
                    issueFingerprint = fingerprintForIssueFull(issue);
                    if (
                      (previousFingerprints.size > 0 &&
                        !shouldPostFingerprint(issueFingerprint, previousFingerprints)) ||
                      streamedFingerprints.has(issueFingerprint)
                    ) {
                      core.debug(
                        `Skipping duplicate inline finding (fp ${issueFingerprint}) at ${issue.file}:${issue.line}`,
                      );
                      continue;
                    }
                  } catch {
                    issueFingerprint = undefined;
                  }
                }
                const key = streamedFindingKey(issue.file, issue.line, issue.message);
                // Never post the same finding twice across batches (distinct
                // findings on one line have distinct keys and stay independent),
                // and only mark a finding as streamed when the inline post
                // actually succeeded — otherwise the final-result filter below
                // would drop it entirely (neither inline nor body).
                if (streamedIssueKeys.has(key) || batchSeen.has(key)) continue;
                batchSeen.add(key);
                pending.push({
                  issue,
                  key,
                  fingerprint: issueFingerprint,
                  // A finding may quote a hardcoded credential from the diff —
                  // redact secrets before posting so the value never lands in
                  // a PR comment visible to all repo readers.
                  body: issueFingerprint
                    ? withFingerprintMarker(
                        `**${issue.severity.toUpperCase()}**: ${sanitizeMarkdown(redactSecrets(issue.message))}`,
                        issueFingerprint,
                      )
                    : `**${issue.severity.toUpperCase()}**: ${sanitizeMarkdown(redactSecrets(issue.message))}`,
                });
              }
            }
            const STREAM_POST_CONCURRENCY = 5;
            for (let i = 0; i < pending.length; i += STREAM_POST_CONCURRENCY) {
              const chunk = pending.slice(i, i + STREAM_POST_CONCURRENCY);
              const results = await Promise.all(
                chunk.map(async ({ issue, key, fingerprint, body }) => {
                  try {
                    const posted = await gh.postInlineComment(prNumber, pr.headSha, {
                      path: issue.file as string,
                      line: issue.line as number,
                      body,
                    });
                    return { key, fingerprint, posted };
                  } catch {
                    return { key, fingerprint, posted: false };
                  }
                }),
              );
              for (const { key, fingerprint, posted } of results) {
                if (posted) {
                  streamedIssueKeys.add(key);
                  if (fingerprint) streamedFingerprints.add(fingerprint);
                  streamedFindingCount++;
                } else {
                  core.warning(
                    sanitize(
                      `Inline comment post failed for ${key} — will retry in final review body`,
                    ),
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
              .catch((err: unknown) => {
                new Logger('Review').warn(
                  `Failed to post streaming progress: ${err instanceof Error ? err.message : String(err)}`,
                  { operation: 'review.stream', prNumber },
                );
              });
          }
        : undefined,
      // A manual trigger (issue comment / workflow dispatch / explicit PR number)
      // must bypass the dedup cache so it always re-reviews the current head;
      // automatic events keep dedup to avoid redundant re-review work.
      { forceReview: isManualTrigger },
    );
  } catch (err) {
    // Error boundary mirroring analyze.ts/describe.ts: an LLM/transient
    // failure must post a visible marker comment (best-effort, guarded)
    // before failing, so the PR never goes silent on the highest-traffic path.
    const kind = signal?.aborted
      ? signal.reason === undefined
        ? 'cancelled'
        : describeAbortKind(signal.reason)
      : describeAbortKind(err);
    core.warning(
      sanitize(
        `Review engine failed for PR #${prNumber} (${kind}): ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    new Logger('Review').warn('Review engine failed', {
      operation: 'review.run',
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await gh.postOrUpdateComment(
        prNumber,
        '<!-- review-error -->',
        `❌ **Review Failed**: Review failed for PR #${prNumber} (${kind}). See the action logs for details.`,
      );
    } catch (commentErr) {
      core.warning(
        sanitize(
          `Failed to post review error comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        ),
      );
    }
    core.setFailed(sanitize(`Review failed for PR #${prNumber} (${kind})`));
    return;
  }

  if (signal?.aborted) {
    const kind = signal.reason === undefined ? 'cancelled' : describeAbortKind(signal.reason);
    core.setFailed(
      sanitize(`Review ${kind === 'timeout' ? 'timed out' : 'cancelled'} before posting results`),
    );
    return;
  }

  if (result?.skipped) {
    core.info('Review deduplicated — this PR/commit was already reviewed. Skipping.');
    return;
  }

  if (!result || (!result.summary && result.issues.length === 0 && result.strengths.length === 0)) {
    core.setFailed('Review returned no meaningful content - AI model may have failed silently');
    return;
  }

  // When streaming is enabled, inline findings were already posted as batches
  // completed, so the final review posts only the summary + non-inline findings
  // (and any inline issue whose streaming post failed). Avoids duplicate comments.
  const streamedFiltered: typeof result = streamEnabled
    ? {
        ...result,
        issues: result.issues.filter(
          (i) =>
            !i.inline ||
            !i.file ||
            !i.line ||
            !streamedIssueKeys.has(streamedFindingKey(i.file, i.line, i.message)),
        ),
      }
    : result;

  // Redact secrets from the result before anything is posted: findings may
  // quote hardcoded credentials from the diff, and the summary, review body,
  // notifications, and step outputs all derive from these fields. Applied
  // after the streamed-filter above so streamed dedup keys (raw messages)
  // still match the already-posted inline comments. Uses the shared lib
  // owner so verdict.reasoning, strengths[].message and suggestionCode are
  // covered exactly as in the app wrapper.
  let finalResult: typeof result = redactReviewResult(streamedFiltered);

  // Publication-time anchor resolution. Every finding's file/line is checked
  // against the content this review was computed from, and anything that does
  // not resolve is labelled a stale anchor rather than published as if it
  // described this head. Fail-open by design: if resolution cannot run at all
  // the findings post unchanged and the trust block reports zero anchors
  // verified, which is honest. Silently dropping unresolvable findings would
  // hide real defects; silently publishing them as current would misattribute
  // them to a revision they do not describe.
  finalResult = await applyAnchorResolution(finalResult, pr.headSha, process.cwd());

  const scoreOptions = buildFunctionScoreOptions(config.review.showFunctionScores, pr.changedFiles);
  // Persistent inline update-in-place (opt-in, default false): match new
  // findings to previously posted bot threads by fingerprint so re-pushes
  // edit the existing thread instead of re-posting. Fail-open: an empty or
  // unmatchable map posts as today.
  const updateInPlaceEnabled = config.review.updateInPlace === true;
  let previousFingerprintCommentIds: Map<string, number> | undefined;
  try {
    if (updateInPlaceEnabled && previousComments && previousComments.length > 0) {
      previousFingerprintCommentIds = mapFingerprintsToCommentIds(
        previousComments.map((c) => ({ body: c.body ?? '', commentId: c.commentId })),
      );
    }
  } catch {
    previousFingerprintCommentIds = undefined;
  }
  const dedupOptions =
    dedupEnabled && (previousFingerprints.size > 0 || previousLegacyKeys.size > 0)
      ? {
          dedupFingerprints: true as const,
          previousFingerprints,
          previousInlineKeys: previousLegacyKeys,
        }
      : { dedupFingerprints: dedupEnabled };
  let reviewResult: Awaited<ReturnType<typeof gh.postReview>>;
  try {
    // Auto-resolve addressed threads (default true, fail-open): pass prior
    // bot threads so postReview can resolve fingerprinted threads whose
    // finding no longer reproduces on the new head.
    const autoResolveEnabled = config.review.autoResolveAddressed ?? true;
    reviewResult = await gh.postReview(
      prNumber,
      pr.headSha,
      finalResult,
      config.review.inline,
      undefined,
      {
        ...(scoreOptions ?? {}),
        ...dedupOptions,
        ...(autoResolveEnabled && previousBotThreads && previousBotThreads.length > 0
          ? { previousBotThreads }
          : {}),
        ...(!autoResolveEnabled ? { autoResolveAddressed: false as const } : {}),
        ...(updateInPlaceEnabled
          ? {
              updateInPlace: true as const,
              ...(previousFingerprintCommentIds && previousFingerprintCommentIds.size > 0
                ? { previousFingerprintCommentIds }
                : {}),
            }
          : {}),
        ...(config.review.emitChecksSummary === true ? { emitChecksSummary: true as const } : {}),
        ...(config.review.enableReviewsArrayInline === true
          ? { enableReviewsArrayInline: true as const }
          : {}),
        ...(config.review.verdictMode !== undefined
          ? { verdictMode: config.review.verdictMode }
          : {}),
        ...(config.review.sensitivity?.noiseBudget !== undefined
          ? { maxVisibleFindings: config.review.sensitivity.noiseBudget }
          : {}),
        // Review-effort estimate + self-review checklist (default on):
        // forward resolved flags plus churn stats for the estimator.
        // Fail-open: estimate failures omit the line inside buildReviewBody.
        ...(config.review.showEffortEstimate === false
          ? { showEffortEstimate: false as const }
          : {
              showEffortEstimate: true as const,
              ...(pr.changedFiles && pr.changedFiles.length > 0
                ? { changedFilesForEffort: pr.changedFiles }
                : {}),
            }),
        ...(config.review.showSelfReviewChecklist === false
          ? { showSelfReviewChecklist: false as const }
          : { showSelfReviewChecklist: true as const }),
      },
    );
  } catch (err) {
    // A postReview throw must not surface as the generic index.ts failure
    // with no PR marker: post the review-error marker (best-effort, guarded)
    // before failing, mirroring the engine boundary above.
    core.warning(
      sanitize(
        `Failed to post review for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    new Logger('Review').warn('Failed to post review', {
      operation: 'review.post',
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await gh.postOrUpdateComment(
        prNumber,
        '<!-- review-error -->',
        `❌ **Review Failed**: Review failed for PR #${prNumber}. See the action logs for details.`,
      );
    } catch (commentErr) {
      core.warning(
        sanitize(
          `Failed to post review error comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        ),
      );
    }
    core.setFailed(sanitize(`Failed to post review for PR #${prNumber}`));
    return;
  }

  // L-054: a verdict that never reached the pull request is NOT a review.
  //
  // `postReview` resolves `{ success: false, method: 'failed' }` when every
  // createReview attempt was rejected (lib/src/utils/github.ts:1959 for the
  // legacy path, :2166 for the reviews-array path). This is a resolved value,
  // not a throw, so the boundary above never fires and the old code fell
  // through to a bare `core.warning` — the job exited 0, emitted
  // `verdict=<ready>` and `<n>_count` outputs for a PR with zero reviews, and
  // a maintainer reading green checks would merge a "No" with 22 issues.
  //
  // A job that cannot post its verdict has reviewed nothing. Fail loudly,
  // leave a marker on the PR so the gap is visible without opening logs, and
  // return BEFORE the setOutput block below: those outputs are the
  // machine-readable claim "this PR was reviewed", and emitting them for an
  // undelivered verdict is the same lie in a different channel.
  if (!reviewResult.success) {
    const detail =
      reviewResult.error ??
      `GitHub rejected every review-create attempt for PR #${prNumber} (method: ${reviewResult.method})`;
    core.warning(sanitize(`Failed to deliver review verdict for PR #${prNumber}: ${detail}`));
    new Logger('Review').warn('Review verdict was never delivered to the pull request', {
      operation: 'review.post',
      prNumber,
      method: reviewResult.method,
      error: detail,
    });
    try {
      await gh.postOrUpdateComment(
        prNumber,
        '<!-- review-error -->',
        `❌ **Review Failed**: the review for PR #${prNumber} could not be posted (${detail}). This PR has NOT been reviewed — no verdict was delivered.`,
      );
    } catch (commentErr) {
      core.warning(
        sanitize(
          `Failed to post review error comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
        ),
      );
    }
    core.setFailed(sanitize(`Failed to deliver review verdict for PR #${prNumber}: ${detail}`));
    return;
  }

  // Flip the streaming progress marker to a terminal state so a "Batches x/y
  // complete" comment does not stay on the PR indefinitely after the review.
  if (streamEnabled) {
    try {
      await gh.postOrUpdateComment(
        prNumber,
        '<!-- review-stream-progress -->',
        '## ✅ Review In Progress\n\n**Streaming complete** — all findings posted. See the review above.',
      );
    } catch (err: unknown) {
      new Logger('Review').warn(
        `Failed to update stream-progress marker: ${err instanceof Error ? err.message : String(err)}`,
        { operation: 'review.stream-finalize', prNumber },
      );
    }
  }

  // Attach comment IDs to issues for future tracking
  if (reviewResult.commentIds) {
    for (const issue of result.issues) {
      const comment = reviewResult.commentIds.find(
        (c) => c.file === issue.file && c.line === issue.line,
      );
      if (comment) {
        issue.commentId = comment.commentId;
      }
    }
  }

  // Best-effort Slack/Teams notification with the review summary. Non-critical:
  // a webhook failure must never fail the action, so sendNotification swallows
  // its own errors and the `.catch` below additionally guards against an
  // unexpected rejection surfacing as an unhandled one.
  //
  // FIRE-AND-FORGET, deliberately. `postToWebhook` wraps its POST in
  // `withRetryAndTimeout(..., 15_000, { maxRetries: 3 })`, so awaiting here adds
  // up to ~45-50s of per-attempt timeouts plus backoff to the job's wall clock —
  // AFTER the review is already posted and BEFORE the `core.setOutput` /
  // `core.setFailed` calls a downstream consumer reads. A webhook outage
  // inflated wall-clock for zero user value.
  //
  // The Probot app already treats this the same way
  // (`void sendNotification(...)` at app/src/handlers/pr-review.ts:608); this
  // mirrors it so the two wrappers agree.
  //
  // NOTE on passing the RAW `result`: that is safe and is not changed here.
  // `sendNotification` redacts at its own boundary (`redactReviewResult`) and
  // the formatters `escapeInlineCode` the PR-controlled `issue.file`, so nothing
  // model-derived reaches Slack/Teams unescaped. Asserted as an attack in
  // lib/tests/egress-redaction.test.ts.
  //
  // The `success` guard above already returned on an undelivered verdict, so
  // this block only runs for a review that actually reached the pull request —
  // the message links to the PR, and a link to a PR with no review misleads.
  void sendNotification(result, config.notifications, {
    number: prNumber,
    title: pr.title,
    repo,
    platform: gh instanceof GitLabAdapter ? 'gitlab' : 'github',
  }).catch((err: unknown) => {
    new Logger('Review').warn(
      `Failed to send review notification: ${err instanceof Error ? err.message : String(err)}`,
      { operation: 'review.notify', prNumber },
    );
  });

  // Best-effort conventional-commit title & label suggestion. Only posts when
  // enabled; read-only, never modifies the PR. Non-critical: a failure must
  // not fail the action.
  if (config.review.suggestTitleAndLabels) {
    try {
      await postSuggestionComment(gh, prNumber, pr, result, config.review);
    } catch (err) {
      new Logger('Review').warn(
        `Failed to post title/label suggestion: ${err instanceof Error ? err.message : String(err)}`,
        { operation: 'review.suggestion', prNumber },
      );
    }
  }

  // A truncated review IS a degradation and must be visible as one. The verdict
  // was delivered, so this is deliberately NOT a failure — the job fails only
  // when delivery itself failed (the L-054 branch above). But a capped review
  // that reports plain success is indistinguishable from a complete one, so it
  // is named here and exposed as an output for the workflow summary.
  if (reviewResult.bodyTruncated === true) {
    const original = reviewResult.bodyOriginalLength;
    core.warning(
      sanitize(
        `Review body was TRUNCATED to fit GitHub's limit (${original} -> ${GITHUB_REVIEW_BODY_LIMIT} chars). ` +
          `The verdict, readiness line and risk rating are complete; the findings listing is INCOMPLETE.`,
      ),
    );
    new Logger('Review').warn('Review body truncated', {
      operation: 'review.post',
      prNumber,
      originalLength: original,
    });
    core.setOutput('review_truncated', 'true');
    core.setOutput('review_original_length', String(original ?? ''));
    // Summary rendering is best-effort and MUST NOT be able to fail the review:
    // `core.summary` is absent on older @actions/core and throws on some
    // runners. The warning and the outputs above already carry the signal.
    try {
      core.summary
        .addHeading('Review truncated', 3)
        .addRaw(
          sanitize(
            `This review body was **truncated** from ${original} characters to fit GitHub's ` +
              `${GITHUB_REVIEW_BODY_LIMIT}-character limit, so the findings listing is ` +
              `**INCOMPLETE**. The verdict, readiness line and risk rating are complete and ` +
              `unaffected. The full untruncated review is in the job log.`,
          ),
          true,
        );
    } catch {
      new Logger('Review').warn('Could not write truncation notice to the job summary', {
        operation: 'review.post',
        prNumber,
      });
    }
  }

  core.setOutput('review_summary', finalResult.summary);
  core.setOutput('verdict', String(result.verdict.ready));
  core.setOutput('critical_count', String(result.stats.critical));
  core.setOutput('important_count', String(result.stats.important));
  core.setOutput('minor_count', String(result.stats.minor));
  // Coverage outputs. These exist so "I did not look" is a number a workflow
  // can gate on, not only a sentence in a comment nobody reads. A consumer
  // that wants to refuse a verdict produced by a pass that could not read its
  // input now has something concrete to check.
  const trust = finalResult.trust;
  core.setOutput('review_exhaustive', String(trust?.exhaustive ?? false));
  core.setOutput('unreadable_inputs', String(trust?.unreadableInputs ?? 0));
  core.setOutput('failed_closed', String(trust?.failedClosed ?? false));
  core.setOutput('stale_anchors', String(trust?.staleAnchors ?? 0));
  core.setOutput('candidates_considered', String(trust?.candidatesConsidered ?? 0));
  core.setOutput('finding_retention', String(trust?.findingRetention ?? 'unknown'));
  // Additive observability outputs (always set; independent of cost tracking).
  core.setOutput('model_used', config.reviewModel);
  const runTelemetry = engine.getLastTelemetry();
  if (runTelemetry) {
    core.setOutput('duration_ms', String(runTelemetry.durationMs));
  }

  // Fail the action when the severity threshold is exceeded. This is what makes
  // the job usable as a required status check in branch protection rules.
  if (shouldFailOnSeverity(result.stats, config.review.failOnSeverity)) {
    const threshold = config.review.failOnSeverity;
    if (threshold !== 'off') {
      const totalAtOrAbove = countAtOrAboveSeverity(result.stats, threshold);
      core.setFailed(
        `Found ${totalAtOrAbove} issue(s) at or above severity "${threshold}" threshold — action failed`,
      );
    }
  }

  // Optional dedicated gate: fail the action whenever the deterministic secret
  // scanner flagged a hardcoded credential, independent of failOnSeverity.
  // Secrets are reported as critical findings, so `failOnSeverity: critical`
  // also covers this without the dedicated toggle. The gate stays
  // secret-specific by requiring the secret message prefix
  // (see isHardcodedSecretFinding): matching on structured
  // category/severity alone would also fire for non-secret critical findings
  // (SQLi, XSS, auth bypass) with a misleading 'Hardcoded secrets' message.
  if (config.secrets?.failCI && result.issues.some(isHardcodedSecretFinding)) {
    core.setFailed('Hardcoded secrets detected in PR. See review comments for details.');
  }

  const costTracking = config.review.costTracking;
  const telemetry = engine.getLastTelemetry();
  // Mirror the lib's guard (attachUsage): only expose state/outputs when
  // something meaningful was actually measured. With the default free model the
  // CLI often emits no parseable usage, in which case totalTokens is 0 and
  // estimatedCost is undefined — surfacing a '0' here would make post.ts post a
  // misleading 'Total Tokens 0' PR comment (the string '0' is truthy).
  if (
    costTracking?.enabled === true &&
    costTracking.verbosity !== 'off' &&
    telemetry &&
    (telemetry.totalTokens > 0 || telemetry.estimatedCost !== undefined)
  ) {
    const totalTokens = String(telemetry.totalTokens);
    core.setOutput('token_usage', totalTokens);
    core.saveState('token_usage', totalTokens);
    core.saveState('token_usage_duration', String(telemetry.durationMs));
    if (telemetry.estimatedCost !== undefined) {
      // Normalize to the same fixed-decimal format used by the post comment
      // and review-body renderer so automation consumers see stable output.
      const cost = telemetry.estimatedCost.toFixed(4);
      core.setOutput('cost', cost);
      core.saveState('cost', cost);
    }
    // Save the prompt/completion breakdown for the post-step comment when the
    // 'detailed' verbosity is requested.
    if (costTracking.verbosity === 'detailed') {
      if (telemetry.promptTokens !== undefined) {
        core.saveState('token_usage_prompt', String(telemetry.promptTokens));
      }
      if (telemetry.completionTokens !== undefined) {
        core.saveState('token_usage_completion', String(telemetry.completionTokens));
      }
    }
  }
}

/**
 * Secret-specific predicate for the `secrets.failCI` gate: a finding only
 * counts when its message carries the hardcoded-secret prefix (emitted by
 * mergeSecretFindings). Structured `category`/`severity` fields are
 * intentionally not required here so findings produced by older lib versions
 * (without structured fields) stay covered and the gate never fires on
 * unrelated critical security findings (SQLi, XSS, auth bypass).
 * @param issue - A review finding with optional structured fields and a message.
 * @param issue.category - Optional finding category (e.g. `security`).
 * @param issue.severity - Optional finding severity (e.g. `critical`).
 * @param issue.message - The finding message; secret findings start with `Hardcoded`.
 * @returns True when the finding is a hardcoded-secret finding.
 */
export function isHardcodedSecretFinding(issue: {
  category?: string;
  severity?: string;
  message: string;
}): boolean {
  return issue.message.startsWith('Hardcoded');
}
