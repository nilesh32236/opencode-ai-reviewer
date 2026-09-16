import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
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
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps. Advisory-only: engine calls themselves
 *   are not yet cancellable.
 */
export declare function runDescribe(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, _token: string, signal?: AbortSignal): Promise<void>;
