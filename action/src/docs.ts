import * as core from '@actions/core';
import * as exec from '@actions/exec';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { validateRefName } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { resolvePrNumber, sanitize } from './utils.js';

/**
 * Run documentation generation on a PR: resolve the PR, gather context, run the
 * docs engine to add documentation comments to changed code, and push the
 * generated docs directly onto the PR's head branch (mirrors the Action's fix
 * mode behavior).
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 */
export async function runDocs(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
): Promise<void> {
  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for docs');
    return;
  }

  const pr = await gh.getMR(prNumber);
  const contextMarkdown = await gh.gatherContext({ prNumber });

  const docsResult = await engine.runDocs(
    pr,
    contextMarkdown,
    undefined,
    undefined,
    inputs.docStyle,
  );

  let changesMade = false;
  if (docsResult?.changesMade) {
    try {
      await exec.exec('git', ['add', '-A']);
      await exec.exec('git', ['commit', '-m', `docs: add API documentation for #${prNumber}`]);
      validateRefName(pr.headRef);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
    } catch (err) {
      core.warning(sanitize(`Git operations failed: ${err instanceof Error ? err.message : err}`));
    }
    changesMade = true;
  }

  core.setOutput('changes_made', String(changesMade ?? false));
}
