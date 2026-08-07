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
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Run post-processing after a review/fix action: optionally run a
 * verification command, and post a review summary comment to the PR.
 * @param inputs - Parsed action inputs.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 */
export async function runPost(
  inputs: ActionInputs,
  gh: PlatformAdapter,
  _repo: string,
  _token: string,
): Promise<void> {
  const prNumber = process.env.CI_MERGE_REQUEST_IID
    ? Number(process.env.CI_MERGE_REQUEST_IID)
    : github.context.payload.pull_request?.number || github.context.payload.issue?.number;
  if (!prNumber) {
    core.setFailed('Could not determine PR number for post-processing');
    return;
  }

  if (inputs.runChecksAfterFix) {
    core.info('Running verification commands after fix...');
    try {
      const steps = parseRunChecksCommands(inputs.runChecksAfterFix, inputs.checkAllowlist);
      for (const step of steps) {
        const exitCode = await exec.exec(step.program, step.args, {
          ...(step.cwd ? { cwd: step.cwd } : {}),
          ignoreReturnCode: true,
        });
        if (exitCode !== 0) {
          core.warning(
            sanitize(
              `Verification command "${step.program} ${step.args.join(' ')}" failed with exit code ${exitCode}`,
            ),
          );
          break;
        }
      }
    } catch (error) {
      core.warning(
        sanitize(`Verification command failed: ${inputs.runChecksAfterFix} — ${String(error)}`),
      );
    }
  }

  const reviewSummary = core.getInput('review_summary');
  if (reviewSummary && inputs.reviewCommentSummary) {
    try {
      await gh.postOrUpdateComment(
        prNumber,
        '<!-- review-summary -->',
        `## Review Summary\n\n${reviewSummary}`,
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
  if (tokenUsageState) {
    try {
      const usage: TokenUsage = {
        totalTokens: Number(tokenUsageState),
        durationMs: Number(core.getState('token_usage_duration') ?? 0),
      };
      // Detailed verbosity saves the prompt/completion breakdown, which
      // review.ts persists to state only when verbosity is 'detailed'.
      const promptTokens = core.getState('token_usage_prompt');
      if (promptTokens) {
        usage.promptTokens = Number(promptTokens);
      }
      const completionTokens = core.getState('token_usage_completion');
      if (completionTokens) {
        usage.completionTokens = Number(completionTokens);
      }
      const cost = core.getState('cost');
      if (cost) {
        usage.estimatedCost = Number(cost);
      }
      // buildTokenUsageSection is the single canonical renderer shared with the
      // lib — it omits rows for undefined fields and returns '' when nothing
      // meaningful was measured, so a zero-token table is never posted.
      const section = buildTokenUsageSection(usage);
      if (section) {
        await withRetry(() => gh.postOrUpdateComment(prNumber, '<!-- token-usage -->', section), {
          operationName: 'post token usage comment',
        });
        core.info('Posted token usage summary comment');
      }
    } catch (err) {
      core.warning(
        sanitize(`Failed to post token usage comment: ${err instanceof Error ? err.message : err}`),
      );
    }
  }

  const verdict = core.getInput('verdict');
  if (verdict === 'true') {
    core.info('PR is approved — no annotations needed');
  } else {
    core.warning('PR has unresolved issues — check review output');
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
