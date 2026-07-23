import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Execute a code review on a pull request and post results.
 * Determines the PR number from input or event context, fetches the PR,
 * checks skip-labels/actors, runs the review engine, and posts
 * the review to GitHub.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo).
 */
export declare function runReview(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, _repo: string): Promise<void>;
