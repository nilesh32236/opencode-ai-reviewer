import type { AgentConfig, PlatformAdapter, ReviewEngine, ReviewIssue, ReviewResult, ReviewThreadInfo } from '@opencode-pr-agent/lib';
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
 * Read the `/fix` trigger comment body from the workflow event payload, when
 * present. Used only to honor an explicit `/fix re-review` request; absent or
 * unreadable payloads fail-open to normal reuse behavior.
 * @returns Raw trigger comment body, or '' when unavailable.
 */
export declare function getFixTriggerBody(): string;
/**
 * Whether the `/fix` trigger explicitly requests a fresh review.
 * Exported for unit testing; the loop reads the live payload via
 * {@link getFixTriggerBody} so `/fix re-review` bypasses review reuse.
 * @param body - Raw trigger comment body.
 * @returns True when a re-review token follows the /fix token.
 */
export declare function shouldForceFreshReview(body: string | undefined | null): boolean;
/**
 * Parse a finding severity from a posted inline body. Posted bodies render as
 * `<badge> **SEVERITY**: message`, so reuse recovers the original bucket
 * instead of defaulting everything to one level.
 * @param body - Posted inline comment body.
 * @returns Parsed severity (defaults to 'important').
 */
export declare function parseReusedSeverity(body: string): ReviewIssue['severity'];
/**
 * Bodies that indicate the previous review never produced usable findings
 * (LLM timeout, empty stub). Reusing them would loop on the same failure the
 * issue reports, so they force a fresh review instead.
 * @param body - Posted bot thread body.
 * @returns True when the body looks like a timeout/empty stub.
 */
export declare function isReviewStubBody(body: string): boolean;
/**
 * Strip fingerprint markers and HTML comments from a posted body so the
 * reused finding message stays readable for the fix agent.
 * @param body - Posted inline comment body.
 * @returns Cleaned message text (truncated to 2000 chars).
 */
export declare function cleanReusedBody(body: string): string;
/**
 * Rehydrate fixable findings from head-current bot threads. Only unresolved
 * threads with usable (non-stub) bodies become issues; resolved threads are
 * already fixed and must not reseed the fix phase.
 * @param threads - Bot review threads (already filtered to the bot author).
 * @param headSha - Current PR head SHA (used only for the summary line).
 * @returns Rehydrated ReviewResult, or null when nothing usable remains.
 */
export declare function rehydrateReviewResultFromBotThreads(threads: ReviewThreadInfo[], headSha: string): ReviewResult | null;
/**
 * Decide whether iteration 1 can reuse an existing bot review instead of
 * paying for a fresh `engine.reviewPR` LLM pass. Head-current means at least
 * one unresolved, non-stub bot thread is anchored to the current head SHA
 * (via `firstComment.commitId`, or via `listReviewComments` commit
 * correlation when the adapter does not populate it).
 * @param threads - Bot review threads for the PR.
 * @param headSha - Current PR head SHA.
 * @param commitByCommentId - Optional databaseId → commit SHA map built from
 * `listReviewComments` (each record's `commit_id`).
 * @returns Rehydrated ReviewResult when reuse applies, else null.
 */
export declare function findReusableHeadCurrentReview(threads: ReviewThreadInfo[], headSha: string, commitByCommentId?: Map<number, string>): ReviewResult | null;
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
