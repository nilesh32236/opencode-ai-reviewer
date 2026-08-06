import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PRContext, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import {
  GitLabAdapter,
  Logger,
  countAtOrAboveSeverity,
  sendNotification,
  shouldFailOnSeverity,
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
 * @param repo - Repository string (owner/repo).
 */
export async function runReview(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  repo: string,
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

  const isManualTrigger =
    github.context.eventName === 'issue_comment' ||
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
    const message = `Failed to fetch previous review comments: ${err}`;
    core.warning(sanitize(message));
    new Logger('Review').warn('Failed to fetch previous review comments', {
      operation: 'review.threads',
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
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

  core.setOutput('review_summary', result.summary);
  core.setOutput('verdict', String(result.verdict.ready));
  core.setOutput('critical_count', String(result.stats.critical));
  core.setOutput('important_count', String(result.stats.important));
  core.setOutput('minor_count', String(result.stats.minor));

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
  // also covers this without the dedicated toggle.
  if (config.secrets?.failCI && result.issues.some((i) => i.message.startsWith('Hardcoded'))) {
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
