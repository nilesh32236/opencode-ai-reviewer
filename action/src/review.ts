import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, PRContext, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { resolvePrNumber, sanitize } from './utils.js';

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
  let prNumber = await resolvePrNumber();

  if (
    prNumber !== null &&
    !core.getInput('pr-number') &&
    !github.context.payload.pull_request?.number
  ) {
    const issueNum = github.context.payload.issue?.number;
    if (issueNum === prNumber && !(await gh.isPR(issueNum))) {
      prNumber = null;
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

  let previousComments:
    | Array<{ file: string; line: number | null; body: string; commentId: number }>
    | undefined;
  try {
    const threads = await gh.getBotReviewThreads(prNumber);
    previousComments = threads
      .filter((t) => t.firstComment)
      .map((t) => ({
        file: t.firstComment!.filePath,
        line: t.firstComment!.lineNumber,
        body: t.firstComment!.body,
        commentId: t.firstComment!.databaseId,
      }));
  } catch (err) {
    core.warning(`Failed to fetch previous review comments: ${err}`);
  }

  const result = await engine.reviewPR(
    pr,
    undefined,
    inputs.reviewPromptFile,
    inputs.reviewPromptExtra,
    undefined,
    undefined,
    undefined,
    undefined,
    previousComments,
  );

  if (!result || (!result.summary && result.issues.length === 0 && result.strengths.length === 0)) {
    core.setFailed('Review returned no meaningful content - AI model may have failed silently');
    return;
  }

  const reviewResult = await gh.postReview(prNumber, pr.headSha, result, config.review.inline);

  if (!reviewResult.success) {
    core.warning('Failed to post review to GitHub');
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

  core.setOutput('review_summary', result.summary);
  core.setOutput('verdict', String(result.verdict.ready));
  core.setOutput('critical_count', String(result.stats.critical));
  core.setOutput('important_count', String(result.stats.important));
  core.setOutput('minor_count', String(result.stats.minor));
}
