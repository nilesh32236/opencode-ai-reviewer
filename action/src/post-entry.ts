import * as core from '@actions/core';
import * as github from '@actions/github';
import { GitHubHelper, GitLabAdapter, type PlatformAdapter } from '@opencode-pr-agent/lib';
import { parseInputs } from './inputs.js';
import { runPost } from './post.js';
import { createRunAbortController, sanitize } from './utils.js';

/**
 * Standalone entry point for the GitHub Action's `post` phase.
 *
 * The action.yml `post` field points the compiled bundle for this file
 * (action/lib/post/index.js), which the runner executes as a separate process
 * after the main step. Keeping the entry separate from `post.ts` (a pure
 * library module imported by tests) means importing `runPost` in tests never
 * triggers a side-effecting top-level run.
 */
async function main(): Promise<void> {
  // Parse inputs inside try so a validation throw is reported via setFailed
  // instead of escaping as an unhandled rejection.
  let runAbort: { signal: AbortSignal; dispose: () => void } | undefined;
  try {
    // The post phase runs as a separate process with no shared run controller,
    // so it owns a per-process deadline (same helper/default as the main run).
    // Per-command verification timeouts still apply inside runPost.
    const inputs = parseInputs();
    runAbort = createRunAbortController(inputs.timeoutMinutes);
    const platform = (process.env.PLATFORM || 'github') as 'github' | 'gitlab';
    const token = inputs.githubToken;
    const repo =
      platform === 'gitlab'
        ? `${process.env.CI_PROJECT_NAMESPACE || ''}/${process.env.CI_PROJECT_NAME || ''}`
        : core.getInput('repo') || `${github.context.repo.owner}/${github.context.repo.repo}`;
    const gh: PlatformAdapter =
      platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
    await runPost(inputs, gh, repo, token, runAbort.signal);
  } catch (error) {
    core.setFailed(
      `Post action failed: ${sanitize(error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    runAbort?.dispose();
  }
}

void main();
