import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { resolvePrNumber, sanitize } from './utils.js';

/**
 * Execute PR description generation: determine the PR number from input or
 * event context, fetch the PR, run the describe engine, and post the generated
 * description as a PR comment (upserted by a stable marker so it is updated on
 * subsequent pushes).
 * @param inputs - Parsed action inputs.
 * @param _config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 */
export async function runDescribe(
  inputs: ActionInputs,
  _config: AgentConfig,
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

    const hasSkipLabel = pr.labels.some((l: string) =>
      _config.review.skipLabels
        .filter((skipLabel: string) => !/^autofix/.test(skipLabel))
        .includes(l),
    );
    const isSkippedActor = _config.review.skipActors.includes(pr.author);

    if (hasSkipLabel && !isManualTrigger) {
      core.info(`PR has skip label — skipping description generation`);
      return;
    }
    if (isSkippedActor && !isManualTrigger) {
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

    // The engine returns fallback/warning strings on failure/disabled rather
    // than throwing. Treat them as a failure so a downstream consumer of the
    // `description` output can never mistake an error for a real description.
    if (description.startsWith('⚠️ **Description')) {
      core.setFailed('PR description generation failed or was disabled');
      await gh.postOrUpdateComment(
        prNumber,
        '<!-- pr-description-error -->',
        `❌ **Description Generation Failed**: ${sanitize(description)}`,
      );
      return;
    }

    await gh.postOrUpdateComment(prNumber, '<!-- pr-description -->', description);

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
