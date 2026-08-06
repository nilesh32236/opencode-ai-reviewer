import * as core from '@actions/core';
import * as exec from '@actions/exec';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { validateRefName, withRetry } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { resolvePrNumber, sanitize } from './utils.js';

/**
 * Run documentation generation on a PR: resolve the PR, gather context, run the
 * docs engine to add documentation comments to changed code, and push the
 * generated docs directly onto the PR's head branch (mirrors the Action's fix
 * mode behavior).
 *
 * Honors `config.docs.enabled` and returns early without touching the PR when
 * docs generation is disabled. Platform reads (`isMR`, `getMR`, `gatherContext`)
 * are retried on transient failures. Git publishing failures are rethrown so
 * the action fails loudly, and `changes_made` is only reported true after the
 * push actually reaches the PR.
 *
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @returns A promise that resolves once docs generation and (on success) the
 * push to the PR head branch complete. When the PR number cannot be resolved,
 * the target is not a pull request, or docs are disabled, the function reports
 * failure/skip via `core` and returns early instead of rejecting. Rejects only
 * when platform reads fail after retries or the git commit/push fails.
 */
export async function runDocs(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
): Promise<void> {
  if (config.docs?.enabled === false) {
    core.info('Skipping docs mode — docs generation is disabled (docs.enabled: false)');
    return;
  }

  const prNumber = await resolvePrNumber();
  if (prNumber === null) {
    core.setFailed('Could not determine PR number for docs');
    return;
  }

  const isMr = await withRetry(() => gh.isMR(prNumber), { operationName: 'docs.isMR' });
  if (!isMr) {
    core.setFailed(`Docs mode requires a pull request, but #${prNumber} is not a PR`);
    return;
  }

  const pr = await withRetry(() => gh.getMR(prNumber), { operationName: 'docs.getMR' });
  const contextMarkdown = await withRetry(() => gh.gatherContext({ prNumber }), {
    operationName: 'docs.gatherContext',
  });

  const docStyle = config.docs?.style ?? inputs.docStyle;
  const docsResult = await engine.runDocs(pr, contextMarkdown, undefined, undefined, docStyle);

  let changesMade = false;
  if (docsResult?.changesMade) {
    try {
      await exec.exec('git', ['add', '-A']);
      await exec.exec('git', ['commit', '-m', `docs: add API documentation for #${prNumber}`]);
      validateRefName(pr.headRef);
      await exec.exec('git', ['push', 'origin', pr.headRef]);
      changesMade = true;
    } catch (err) {
      const message = sanitize(
        `Git operations failed: ${err instanceof Error ? err.message : err}`,
      );
      core.setFailed(message);
      throw err;
    }
  }

  core.setOutput('changes_made', String(changesMade));
}
