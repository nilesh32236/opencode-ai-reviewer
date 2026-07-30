import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Run post-processing after a review/fix action: optionally run a
 * verification command, and post a review summary comment to the PR.
 * @param inputs - Parsed action inputs.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 */
export declare function runPost(inputs: ActionInputs, gh: PlatformAdapter, _repo: string, _token: string): Promise<void>;
