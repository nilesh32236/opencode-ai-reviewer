import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';

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

  const pr = await gh.getPR(prNumber);

  const hasSkipLabel = pr.labels.some((l) => config.review.skipLabels.includes(l));
  const isSkippedActor = config.review.skipActors.includes(pr.author);

  if (hasSkipLabel) {
    core.info(`PR has skip label — skipping review`);
    return;
  }
  if (isSkippedActor) {
    core.info(`PR author ${pr.author} is in skip list — skipping`);
    return;
  }

  const result = await engine.reviewPR(pr);

  const reviewResult = await gh.postReview(prNumber, pr.headSha, result);

  if (!reviewResult.success) {
    core.warning('Failed to post review to GitHub');
  }

  core.setOutput('review_summary', result.summary);
  core.setOutput('verdict', String(result.verdict.ready));
  core.setOutput('critical_count', String(result.stats.critical));
  core.setOutput('important_count', String(result.stats.important));
  core.setOutput('minor_count', String(result.stats.minor));

  if (!result.verdict.ready && result.verdict.autoFixable && result.verdict.confidence === 'high') {
    core.info(
      '🤖 Review agent confirmed issues are auto-fixable with high confidence. Launching autofix loop...',
    );
    const { runAutofixLoop } = await import('./fix.js');
    await runAutofixLoop(inputs, config, engine, gh, _repo, inputs.githubToken);
  }
}
