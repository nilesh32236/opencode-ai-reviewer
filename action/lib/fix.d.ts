import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Determine whether a PR/MR has already been closed or merged, so a fix
 * loop can stop pushing iteration commits instead of force-pushing onto a
 * merged branch (which is what orphaned PR #466's hardening).
 *
 * GitHub reports state as 'open' | 'closed' | 'merged'; GitLab reports
 * 'opened' | 'closed' | 'merged'. An undefined state (older adapter builds
 * that did not populate it) is treated as still open so existing callers are
 * never silently blocked.
 * @param state - The PR/MR state string, when known.
 * @returns True when the PR/MR is closed or merged.
 */
export declare function isPrClosedOrMerged(state?: string): boolean;
/**
 * Run a single fix iteration on a PR: resolve PR, gather context, apply
 * changes, optionally verify with a user-configured command, and push.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export declare function runFix(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, signal?: AbortSignal): Promise<void>;
/**
 * Run a fix triggered from an issue (non-PR): create a branch, apply the fix,
 * commit, push, and open a new PR.
 * Includes wall-clock timeout guarding against queue wait time.
 * @param inputs - Action inputs.
 * @param config - Agent config (provides timeoutMinutes).
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo).
 * @param gitEmail - Configured bot commit author email, used to verify that an
 *   existing `autofix/issue-N` branch tip was authored by this bot before it is
 *   reused (see `configureGit`).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export declare function runFixIssue(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, gitEmail: string, signal?: AbortSignal): Promise<void>;
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
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export declare function runAutofixLoop(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, _token: string, signal?: AbortSignal): Promise<void>;
