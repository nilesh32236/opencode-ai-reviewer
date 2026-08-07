import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
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
export declare function runDescribe(inputs: ActionInputs, _config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, _token: string): Promise<void>;
