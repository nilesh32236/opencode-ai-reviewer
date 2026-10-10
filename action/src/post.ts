import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type { PlatformAdapter, TokenUsage } from '@opencode-pr-agent/lib';
import {
  LearningStore,
  buildTokenUsageSection,
  parseRunChecksCommands,
  withRetry,
} from '@opencode-pr-agent/lib';
import { sanitizeMarkdown } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import {
  execWithTimeout,
  formatVerificationCommandForLog,
  redactSecrets,
  resolveGitLabMrIid,
  sanitize,
  scrubVerificationOutput,
  truncateToCodePoints,
} from './utils.js';

/**
 * State key written by the main fix step (`core.saveState` in fix.ts) and
 * exposed to this post process as `STATE_fix_exit_reason`. Must stay in sync
 * with `FIX_EXIT_REASON_STATE_KEY` in fix.ts (duplicated here to keep the
 * post bundle free of the fix module's engine/exec dependency chain).
 */
export const FIX_EXIT_REASON_STATE_KEY = 'fix_exit_reason';

/**
 * True when a fix exit reason means no clean fix landed, so verification
 * would measure the agent's mutated working tree rather than the base branch
 * or PR head (issue #942). Such runs must skip `run_checks_after_fix`.
 *
 * Mirrors `isMutatedTreeExitReason` in fix.ts (duplicated here to keep the
 * post bundle free of the fix module's engine/exec dependency chain): both
 * the state-key string above and this predicate must stay in sync — covered
 * by the fix-exit-reason sync test.
 * @param reason - Fix exit reason from `core.getState`, when any.
 * @returns True for 'no-changes' and 'git-failure' (case-insensitive).
 */
export function shouldSkipPostVerification(reason: string | undefined | null): boolean {
  if (!reason) return false;
  const normalized = reason.trim().toLowerCase();
  return normalized === 'no-changes' || normalized === 'git-failure';
}

/**
 * Best-effort check for uncommitted working-tree changes. When the fix step
 * failed after editing files, the tree is dirty and verification would
 * measure those agent edits — not the base. Scoped to tracked modifications
 * only (`--untracked-files=no`) so stray untracked artifacts (coverage
 * output, downloaded assets, tool caches) cannot silently disable a
 * configured verification gate. A probe failure fails open to
 * running verification (preserving today's behavior) rather than silently
 * skipping a configured gate.
 * @returns True when `git status --porcelain` reports tracked modifications.
 */
export async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const result = await exec.getExecOutput(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      {
        silent: true,
        ignoreReturnCode: true,
      },
    );
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort check for locally committed but unpushed fix commits. Covers
 * the committed-but-unpushed git-failure shape (`runFix`/`runFixIssue`
 * commit locally then fail push): the tree is clean, so
 * `hasUncommittedChanges` misses it, but verification would still measure a
 * stale tree rather than the base. Fails open to running verification on
 * probe error (or when no upstream exists) rather than silently skipping a
 * configured gate.
 * @returns True when HEAD is ahead of its upstream.
 */
export async function hasUnpushedCommits(): Promise<boolean> {
  try {
    const result = await exec.getExecOutput('git', ['rev-list', '--count', '@{u}..HEAD'], {
      silent: true,
      ignoreReturnCode: true,
    });
    if (result.exitCode !== 0) return false;
    const count = Number(result.stdout.trim());
    return Number.isFinite(count) && count > 0;
  } catch {
    return false;
  }
}

/**
 * Run post-processing after a review/fix action: optionally run a
 * verification command, and post a review summary comment to the PR.
 * @param inputs - Parsed action inputs.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 * @param signal - Optional per-run AbortSignal; races verification timeouts.
 *   Advisory-only: no engine calls run on this path.
 */
export async function runPost(
  inputs: ActionInputs,
  gh: PlatformAdapter,
  _repo: string,
  _token: string,
  signal?: AbortSignal,
): Promise<void> {
  const gitlabMrIid = resolveGitLabMrIid();
  const prNumber =
    gitlabMrIid ??
    (github.context.payload.pull_request?.number || github.context.payload.issue?.number);
  if (!prNumber) {
    // Audit / scheduled / changelog runs have no PR or issue context. Posting a
    // review-summary or token-usage comment is meaningless there, but the job
    // must not be failed just because there is nothing to post to. Log a notice
    // and skip the PR-specific post-processing instead of failing the run.
    core.info('No PR or issue context for post-processing — skipping PR-specific post steps');
  }

  if (inputs.runChecksAfterFix) {
    // Issue #942: the post step runs as a separate process after the main
    // fix step on the same runner/workspace. When the fix loop ends in
    // no-changes or git-failure, the working tree holds the agent's
    // in-progress edits — running `run_checks_after_fix` here would measure
    // that mutated tree and its red tail would be reported (and filed by
    // workflow-health) as a repository test failure. Skip verification and
    // keep the precise agent-outcome error as the sole job verdict.
    const fixExitReason = core.getState(FIX_EXIT_REASON_STATE_KEY);
    if (shouldSkipPostVerification(fixExitReason)) {
      core.warning(
        sanitize(
          `Skipping verification: fix did not land (fix_exit_reason=${fixExitReason.trim()}) — not running run_checks_after_fix on the mutated working tree`,
        ),
      );
    } else if (inputs.mode === 'fix' && (await hasUncommittedChanges())) {
      // Fallback when the main step predates the exit-reason bridge (or the
      // state write was lost): a dirty tree in fix mode is the same mutated
      // signal, so skip rather than file it as a repo failure.
      core.warning(
        'Skipping verification: working tree has uncommitted changes after fix — not running run_checks_after_fix on the mutated working tree (diagnostic-only, not the job verdict)',
      );
    } else if (inputs.mode === 'fix' && (await hasUnpushedCommits())) {
      // Fallback for the committed-but-unpushed git-failure shape (commit
      // landed locally, push failed): the tree is clean but HEAD is ahead of
      // the remote, so verification would still measure a stale tree.
      core.warning(
        'Skipping verification: local fix commits are ahead of the remote after fix — not running run_checks_after_fix on the mutated working tree (diagnostic-only, not the job verdict)',
      );
    } else {
      core.info('Running verification commands after fix...');
      try {
        const steps = parseRunChecksCommands(
          inputs.runChecksAfterFix,
          inputs.checkAllowlist,
          process.env.GITHUB_WORKSPACE || process.cwd(),
        );
        for (const step of steps) {
          // Per-command timeout so a hung check fails verification with a
          // clear message instead of blocking the runner until it is killed.
          const { exitCode, output } = await execWithTimeout(step.program, step.args, {
            ...(step.cwd ? { cwd: step.cwd } : {}),
            signal,
          });
          if (exitCode !== 0) {
            // exit 124 conflates three cases: helper timeout, helper
            // cancellation (aborted run signal also returns 124), and a genuine
            // command exit 124 (e.g. GNU timeout). execWithTimeout appends a
            // 'timed out after … (TimeoutError)' or 'cancelled after …
            // (AbortError)' marker, so only treat 124 as a helper timeout/cancel
            // when that marker is present; otherwise report the raw exit code.
            const isHelperTimeout =
              exitCode === 124 &&
              (output.includes('timed out after') || output.includes('(TimeoutError)'));
            const isHelperCancel =
              exitCode === 124 &&
              (signal?.aborted === true ||
                output.includes('cancelled after') ||
                output.includes('(AbortError)'));
            const outcome = isHelperCancel
              ? 'was cancelled'
              : isHelperTimeout
                ? 'timed out'
                : `failed with exit code ${exitCode}`;
            // Output is already byte-capped by capVerificationOutput inside
            // execWithTimeout; scrub secrets before logging so check commands
            // like `--token=...` never reach action logs, then truncate the
            // warning excerpt on a code-point boundary so surrogate
            // pairs/emoji are never split (String.slice operates on UTF-16
            // code units).
            const scrubbed = scrubVerificationOutput(output);
            const excerpt = scrubbed ? truncateToCodePoints(scrubbed, 2000) : '';
            core.warning(
              sanitize(
                `Verification command "${formatVerificationCommandForLog(step.program, step.args)}" ${outcome}${excerpt ? `: ${excerpt}` : ''}`,
              ),
            );
            break;
          }
        }
      } catch (error) {
        core.warning(
          sanitize(
            `Verification command failed: ${redactSecrets(inputs.runChecksAfterFix)} — ${redactSecrets(String(error))}`,
          ),
        );
      }
    }
  }

  const reviewSummary = core.getInput('review_summary');
  if (prNumber && reviewSummary && inputs.reviewCommentSummary) {
    try {
      await withRetry(
        () =>
          gh.postOrUpdateComment(
            prNumber,
            '<!-- review-summary -->',
            `## Review Summary\n\n${sanitizeMarkdown(reviewSummary)}`,
          ),
        { operationName: 'post.reviewSummary', maxRetries: 1 },
      );
      core.info('Posted review summary comment');
    } catch (err) {
      core.warning(
        sanitize(
          `Failed to post review summary comment: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
  }

  // Post a token usage / cost summary to the PR conversation. The data is
  // read from the main step's saved state (core.saveState in review.ts), which
  // the runner exposes to this post step via the STATE_* environment variables.
  // Gating on the presence of saved state (rather than the raw workflow inputs)
  // keeps this consistent with the effective merged config: review.ts already
  // applied the config-file + inputs gate before saving state.
  //
  // NOTE: core.saveState/core.getState persist only within the same GitHub
  // Actions job (STATE_* env vars). On other platforms (e.g. GitLab, where the
  // post phase typically runs in a separate job) getState returns '' and this
  // comment is skipped — the token_usage / cost step outputs remain the
  // cross-platform surface for automation.
  const tokenUsageState = core.getState('token_usage');
  if (prNumber && tokenUsageState) {
    try {
      // Saved STATE_* values are untrusted strings: a corrupt value would
      // parse to NaN/Infinity and render a misleading usage summary, so each
      // conversion is guarded and non-finite values are skipped with a warning.
      const usage: TokenUsage = {
        totalTokens: parseFiniteState('token_usage', tokenUsageState) ?? 0,
        durationMs:
          parseFiniteState('token_usage_duration', core.getState('token_usage_duration') ?? '0') ??
          0,
      };
      // Detailed verbosity saves the prompt/completion breakdown, which
      // review.ts persists to state only when verbosity is 'detailed'.
      const promptTokens = core.getState('token_usage_prompt');
      if (promptTokens) {
        const parsed = parseFiniteState('token_usage_prompt', promptTokens);
        if (parsed !== undefined) usage.promptTokens = parsed;
      }
      const completionTokens = core.getState('token_usage_completion');
      if (completionTokens) {
        const parsed = parseFiniteState('token_usage_completion', completionTokens);
        if (parsed !== undefined) usage.completionTokens = parsed;
      }
      const cost = core.getState('cost');
      if (cost) {
        const parsed = parseFiniteState('cost', cost);
        if (parsed !== undefined) usage.estimatedCost = parsed;
      }
      // buildTokenUsageSection is the single canonical renderer shared with the
      // lib — it omits rows for undefined fields and returns '' when nothing
      // meaningful was measured, so a zero-token table is never posted.
      const section = buildTokenUsageSection(usage);
      if (section) {
        await withRetry(() => gh.postOrUpdateComment(prNumber, '<!-- token-usage -->', section), {
          operationName: 'post.tokenUsage',
          maxRetries: 1,
        });
        core.info('Posted token usage summary comment');
      }
    } catch (err) {
      core.warning(
        sanitize(`Failed to post token usage comment: ${err instanceof Error ? err.message : err}`),
      );
    }
  }

  // Post telemetry & metrics summary
  try {
    const learningEnabled = core.getInput('learning_enabled') !== 'false';
    if (learningEnabled) {
      const store = new LearningStore();
      try {
        const [stats, perPRStats, severityDist] = await Promise.all([
          store.getTelemetryStats(30),
          store.getPerPRStats(30),
          store.getSeverityDistribution(30),
        ]);

        const summaryItems: string[] = [];
        if (stats.totalReviews > 0) {
          summaryItems.push(
            `Total Reviews: ${stats.totalReviews}`,
            `Total Findings: ${perPRStats.totalFindings}`,
            `Average Duration: ${(stats.avgDurationMs / 1000).toFixed(1)}s`,
            `Total Tokens Used: ${stats.totalTokensUsed.toLocaleString()}`,
            `Avg Tokens/Review: ${stats.avgTokensPerReview.toLocaleString()}`,
          );
        }
        if (perPRStats.totalPrs > 0) {
          summaryItems.push(
            `Avg Findings/PR: ${perPRStats.avgFindingsPerPr}`,
            `Max Findings in a PR: ${perPRStats.maxFindingsInPr}`,
          );
        }
        const totalSeverity =
          severityDist.critical +
          severityDist.important +
          severityDist.minor +
          severityDist.unknown;
        if (totalSeverity > 0) {
          summaryItems.push(
            `Severity: ${severityDist.critical} critical, ${severityDist.important} important, ${severityDist.minor} minor, ${severityDist.unknown} unknown`,
          );
        }
        if (summaryItems.length > 0) {
          await core.summary.addHeading('Review Analytics', 2).addList(summaryItems).write();
          core.info('Posted review analytics summary');
        }
      } finally {
        await store.close();
      }
    }
  } catch (err) {
    core.warning(
      sanitize(
        `Failed to post review analytics summary: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

/**
 * Parse a saved STATE_* metric value, returning undefined (with a warning)
 * when the value is not a finite, non-negative number instead of propagating
 * NaN/Infinity/negatives into the rendered token-usage summary. Saved STATE_*
 * values are untrusted strings, so the warning is sanitized to block log-line
 * or workflow-command injection via newlines or `::` sequences.
 * @param name - State key (for the warning message).
 * @param raw - Raw state string.
 * @returns The finite non-negative number, or undefined when invalid.
 */
export function parseFiniteState(name: string, raw: string): number | undefined {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    core.warning(sanitize(`Ignoring non-finite saved state ${name}="${raw}"`));
    return undefined;
  }
  return parsed;
}
