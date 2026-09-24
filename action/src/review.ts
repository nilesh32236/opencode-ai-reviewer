import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PRContext, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import {
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
  sanitizeMarkdown,
  sendNotification,
  shouldFailOnSeverity,
  shouldPostFingerprint,
  withFingerprintMarker,
} from '@opencode-pr-agent/lib';
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
    previousBotThreads = threads
      .filter((t) => t.firstComment)
      .map((t) => ({
        threadId: t.threadId,
        isResolved: t.isResolved,
        body: t.firstComment!.body,
      }));
    previousComments = threads
      .filter((t) => t.firstComment)
      .map((t) => ({
        file: t.firstComment!.filePath,
        line: t.firstComment!.lineNumber,
        body: t.firstComment!.body,
        commentId: t.firstComment!.databaseId,
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
  // still match the already-posted inline comments.
  const finalResult: typeof result = {
    ...streamedFiltered,
    summary: redactSecrets(streamedFiltered.summary),
    issues: streamedFiltered.issues.map((i) => ({
      ...i,
      message: redactSecrets(i.message),
      ...(i.suggestion ? { suggestion: redactSecrets(i.suggestion) } : {}),
    })),
  };

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

  if (!reviewResult.success) {
    core.warning('Failed to post review to GitHub');
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
  // its own errors and is additionally guarded against unexpected throws here.
  // Only notify about a review that actually reached the pull request; the
  // message links to the PR, so a link to a PR without a review is misleading.
  if (reviewResult.success) {
    try {
      await sendNotification(result, config.notifications, {
        number: prNumber,
        title: pr.title,
        repo,
        platform: gh instanceof GitLabAdapter ? 'gitlab' : 'github',
      });
    } catch (err) {
      new Logger('Review').warn(
        `Failed to send review notification: ${err instanceof Error ? err.message : String(err)}`,
        { operation: 'review.notify', prNumber },
      );
    }
  }

  // Best-effort conventional-commit title & label suggestion. Only posts when
  // enabled; read-only, never modifies the PR. Non-critical: a failure must
  // not fail the action.
  if (config.review.suggestTitleAndLabels && reviewResult.success) {
    try {
      await postSuggestionComment(gh, prNumber, pr, result, config.review);
    } catch (err) {
      new Logger('Review').warn(
        `Failed to post title/label suggestion: ${err instanceof Error ? err.message : String(err)}`,
        { operation: 'review.suggestion', prNumber },
      );
    }
  }

  core.setOutput('review_summary', finalResult.summary);
  core.setOutput('verdict', String(result.verdict.ready));
  core.setOutput('critical_count', String(result.stats.critical));
  core.setOutput('important_count', String(result.stats.important));
  core.setOutput('minor_count', String(result.stats.minor));
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
