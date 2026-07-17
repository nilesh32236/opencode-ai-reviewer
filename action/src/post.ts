import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import type { GitHubHelper } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';

export async function runPost(
  inputs: ActionInputs,
  gh: GitHubHelper,
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
      await exec.exec('bash', ['-c', inputs.runChecksAfterFix]);
    } catch (error) {
      core.warning(`Verification command failed: ${inputs.runChecksAfterFix} — ${String(error)}`);
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
        `Failed to post review summary comment: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const verdict = core.getInput('verdict');
  if (verdict === 'true') {
    core.info('PR is approved — no annotations needed');
  } else {
    core.warning('PR has unresolved issues — check review output');
  }
}
