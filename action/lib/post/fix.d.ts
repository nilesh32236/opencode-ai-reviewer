import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Run a single fix iteration on a PR: resolve PR, gather context, apply
 * changes, optionally verify with a user-configured command, and push.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 */
export declare function runFix(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper): Promise<void>;
/**
 * Run a fix triggered from an issue (non-PR): create a branch, apply the fix,
 * commit, push, and open a new PR.
 * Includes wall-clock timeout guarding against queue wait time.
 * @param _inputs - Parsed action inputs (unused, retained for interface compat).
 * @param _config - Agent config (provides timeoutMinutes).
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 */
export declare function runFixIssue(_inputs: ActionInputs, _config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, repo: string, token: string): Promise<void>;
/**
 * Run the complete review-fix loop on a PR. Iterates up to config.maxIterations:
 * reviews the PR, applies fixes, runs optional verification, and posts
 * status comments. Stops early on approval or when no changes are made.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 */
export declare function runAutofixLoop(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, _repo: string, _token: string): Promise<void>;
