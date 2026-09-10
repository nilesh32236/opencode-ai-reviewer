import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { mergeDescribeBody } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { resolvePrNumber, sanitize } from './utils.js';

/**
 * Execute PR description generation: determine the PR number from input or
 * event context, fetch the PR, run the describe engine, and post the generated
 * description as a PR comment (upserted by a stable marker so it is updated on
 * subsequent pushes).
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration (used for skip-label/skip-actor checks).
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 */
export async function runDescribe(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  _repo: string,
  _token: string,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number from event or input');
    return;
  }

  const isManualTrigger =
    github.context.eventName === 'issue_comment' ||
    github.context.eventName === 'workflow_dispatch' ||
    Boolean(core.getInput('pr-number'));

  core.info(`Generating description for PR #${prNumber}`);

  try {
    const pr = await gh.getMR(prNumber);

    const hasSkipLabel = pr.labels.some((l: string) => config.review.skipLabels.includes(l));
    const isSkippedActor = config.review.skipActors.includes(pr.author);

    if (hasSkipLabel && !isManualTrigger) {
      core.info(`PR has skip label — skipping description generation`);
      return;
    }
    if (isSkippedActor) {
      core.info(`PR author ${pr.author} is in skip list — skipping`);
      return;
    }

    const description = await engine.runDescribe(
      pr,
      undefined,
      undefined,
      inputs.describePromptFile,
      inputs.describePromptExtra,
    );

    const publishAsComment = config.describe?.publishAsComment ?? true;
    const useMarkers = config.describe?.useMarkers ?? false;

    if (publishAsComment !== false) {
      await gh.postOrUpdateComment(prNumber, '<!-- pr-description -->', description);
    }

    if (useMarkers === true) {
      try {
        const current = pr.body ?? '';
        const merged = mergeDescribeBody(current, description);
        if (merged !== current) {
          await gh.updateMR(prNumber, { body: merged });
        }
      } catch (e) {
        core.warning(
          `PR body merge failed, kept comment output: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    core.setOutput('description', description);
    core.info(`Posted PR description for PR #${prNumber}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(sanitize(`Description generation failed for PR #${prNumber}: ${message}`));
    await gh.postOrUpdateComment(
      prNumber,
      '<!-- pr-description-error -->',
      `❌ **Description Generation Failed**: ${sanitize(message)}`,
    );
  }
}
