import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  GitHubHelper,
  GitLabAdapter,
  type PlatformAdapter,
  loadConfig,
} from '@opencode-pr-agent/lib';
import { parseInputs } from './inputs.js';
import { runPost } from './post.js';
import { sanitize } from './utils.js';

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
  try {
    const platform = (process.env.PLATFORM || 'github') as 'github' | 'gitlab';
    // Load the config file before parsing inputs (mirroring the main entry) so
    // a config-file-only `llm.defaultProvider` (or azure deployment / bedrock
    // model id) prefixes bare model names identically in the post phase. Without
    // this, reviewModel/fixModel stay bare and the hard-gated model validation
    // would fail the whole post step.
    const loadedConfig = loadConfig(undefined, platform, core.getInput('config') || undefined);
    const inputs = parseInputs(loadedConfig?.llm);
    const token = inputs.githubToken;
    const repo =
      platform === 'gitlab'
        ? `${process.env.CI_PROJECT_NAMESPACE || ''}/${process.env.CI_PROJECT_NAME || ''}`
        : core.getInput('repo') || `${github.context.repo.owner}/${github.context.repo.repo}`;
    const gh: PlatformAdapter =
      platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
    await runPost(inputs, gh, repo, token);
  } catch (error) {
    core.setFailed(
      `Post action failed: ${sanitize(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

void main();
