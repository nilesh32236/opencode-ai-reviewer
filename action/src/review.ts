import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, PRContext, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Execute a code review on a pull request and post results.
 * Determines the PR number from input or event context, fetches the PR,
 * checks skip-labels/actors, runs the review engine, and posts
 * the review to GitHub.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo).
 */
export async function runReview(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  _repo: string,
): Promise<void> {
  const prNumberInput = core.getInput('pr-number');
  let prNumber: number | null = null;

  if (prNumberInput) {
    prNumber = Number.parseInt(prNumberInput, 10);
  } else {
    const fromPR = github.context.payload.pull_request?.number;
    if (fromPR) {
      prNumber = fromPR;
    } else {
      const issueNum = github.context.payload.issue?.number;
      if (issueNum && (await gh.isPR(issueNum))) {
        prNumber = issueNum;
      }
    }
  }

  if (prNumber === null) {
    core.setFailed('Could not determine PR number from event or input');
    return;
  }

  let pr: PRContext;
  try {
    pr = await gh.getPR(prNumber);
  } catch (err) {
    core.setFailed(
      sanitize(`Failed to get PR #${prNumber}: ${err instanceof Error ? err.message : err}`),
    );
    return;
  }

  const hasSkipLabel = pr.labels.some((l: string) => config.review.skipLabels.includes(l));
  const isSkippedActor = config.review.skipActors.includes(pr.author);

  if (hasSkipLabel) {
    core.info(`PR has skip label — skipping review`);
    return;
  }
  if (isSkippedActor) {
    core.info(`PR author ${pr.author} is in skip list — skipping`);
    return;
  }

  const result = await engine.reviewPR(
    pr,
    undefined,
    inputs.reviewPromptFile,
    inputs.reviewPromptExtra,
  );

  if (!result || (!result.summary && result.issues.length === 0 && result.strengths.length === 0)) {
    core.setFailed('Review returned no meaningful content - AI model may have failed silently');
    return;
  }

  const reviewResult = await gh.postReview(prNumber, pr.headSha, result, config.review.inline);

  if (!reviewResult.success) {
    core.warning('Failed to post review to GitHub');
  }

  core.setOutput('review_summary', result.summary);
  core.setOutput('verdict', String(result.verdict.ready));
  core.setOutput('critical_count', String(result.stats.critical));
  core.setOutput('important_count', String(result.stats.important));
  core.setOutput('minor_count', String(result.stats.minor));
}
