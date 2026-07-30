import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { LearningStore, validateRunChecksCommand } from '@opencode-pr-agent/lib';
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
  const prNumber =
    github.context.payload.pull_request?.number || github.context.payload.issue?.number;
  if (!prNumber) {
    core.setFailed('Could not determine PR number for post-processing');
    return;
  }

  if (inputs.runChecksAfterFix) {
    core.info('Running verification commands after fix...');
    try {
      const { program, args } = validateRunChecksCommand(
        inputs.runChecksAfterFix,
        inputs.checkAllowlist,
      );
      await exec.exec(program, args);
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
