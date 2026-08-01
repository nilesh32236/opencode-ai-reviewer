import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  type PRContext,
  type PlatformAdapter,
  type ReviewEngine,
  formatCostUsd,
} from '@opencode-pr-agent/lib';
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
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo).
 */
export async function runReview(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  _repo: string,
): Promise<void> {
  let prNumber = await resolvePrNumber();

  if (
    prNumber !== null &&
    !core.getInput('pr-number') &&
    !github.context.payload.pull_request?.number
  ) {
    const issueNum = github.context.payload.issue?.number;
    if (issueNum === prNumber && !(await gh.isMR(issueNum))) {
      prNumber = null;
    }
  }

  if (prNumber === null) {
    core.setFailed('Could not determine PR number from event or input');
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

  // Persist summary/verdict and token-usage data for the post step (a separate
  // process) via core.saveState — step outputs written with core.setOutput are
  // never visible to it. Only save when the review was actually posted, so the
  // post step never surfaces a comment on a PR whose review was not published.
  if (!reviewResult.success) {
    core.info('Review was not posted — skipping post-step state/outputs');
    return;
  }
  core.saveState('review_summary', result.summary);
  core.saveState('verdict', String(result.verdict.ready));

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
      // Normalize to the same significance-preserving format used by the post
      // comment and review-body renderer so automation consumers see stable
      // output that never collapses a tiny charge to a misleading $0.0000.
      const cost = formatCostUsd(telemetry.estimatedCost);
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
