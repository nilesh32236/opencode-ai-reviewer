import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { MAX_INSTRUCTION_SECTION_CHARS } from '@opencode-pr-agent/lib';
import { FIX_EXIT_REASON_STATE_KEY, isMutatedTreeExitReason } from './fix-exit.js';
import type { ActionInputs } from './inputs.js';
export { FIX_EXIT_REASON_STATE_KEY, isMutatedTreeExitReason };
/**
 * Operator instruction passed from the triggering `/fix` comment.
 * A plain string is treated as raw comment text (classified internally);
 * the object form additionally carries the authorized actor for provenance.
 */
export interface FixOperatorInstruction {
    /** Raw comment text or pre-extracted instruction remainder. */
    instruction?: string;
    /** Authorized comment author login (used only for provenance header). */
    actor?: string;
}
/**
 * Maximum operator-instruction characters appended to fix-agent context.
 * Canonical owner is `MAX_INSTRUCTION_SECTION_CHARS` from lib.
 * @deprecated Use `MAX_INSTRUCTION_SECTION_CHARS` instead. Kept for
 * backward compatibility; both names currently resolve to the same value.
 */
export declare const MAX_OPERATOR_INSTRUCTION_CHARS = 2000;
export { MAX_INSTRUCTION_SECTION_CHARS };
/**
 * Best-effort persistence of the fix terminal for the post step. A save
 * failure must never mask the run's real outcome.
 * @param reason - Terminal exit reason to expose to `runPost`.
 */
export declare function saveFixExitReason(reason: string): void;
/**
 * Build the provenanced operator-instruction section appended to fix-agent
 * context. The header marks the text as an authorized operator instruction —
 * but it is data scoped to the operator role, never a priority elevation:
 * system policy always outranks it. The body is wrapped in explicit
 * untrusted-operator delimiters with a restated precedence rule so a crafted
 * /fix remainder cannot steer tool use as a system instruction. Any in-band
 * delimiter copies inside the instruction are neutralized, the section is
 * length-capped, and the classification is logged with actor provenance for
 * audit.
 * @param instruction - Classified instruction remainder (non-empty).
 * @param actor - Authorized comment author login, when known.
 * @returns The markdown section to append to the fix context.
 */
export declare function buildOperatorInstructionSection(instruction: string, actor?: string): string;
/**
 * Append an operator-instruction section to fix-agent context.
 * Returns `context` byte-identical when `instruction` is missing/blank, so
 * no-comment triggers (label, dispatch, GitLab) behave exactly as today.
 * @param context - Assembled issue/PR context markdown.
 * @param instruction - Classified instruction remainder, when any.
 * @param actor - Authorized comment author login, when known.
 * @returns The context with the provenanced section appended, or unchanged.
 */
export declare function appendOperatorInstruction(context: string, instruction?: string, actor?: string): string;
/**
 * Resolve the effective operator instruction from action inputs and/or an
 * explicit trailing override. Classification (token stripping, truncation)
 * runs here so callers may pass raw comment bodies safely; double extraction
 * is idempotent for already-classified text.
 * @param inputs - Parsed action inputs (`commentBody` when the workflow passes `comment-body`).
 * @param operator - Trailing override (raw string or `{ instruction, actor }`).
 * @returns The classified instruction, or `undefined` when there is none.
 */
export declare function resolveOperatorInstruction(inputs: Pick<ActionInputs, 'commentBody'>, operator?: FixOperatorInstruction | string): string | undefined;
/**
 * Resolve the provenance actor: explicit override first, then the in-process
 * GitHub comment payload, then the workflow actor (only when a comment payload
 * body exists). Returns `undefined` on non-comment triggers (schedule,
 * dispatch, label) and on GitLab / non-comment triggers (no-op provenance),
 * so provenance is never misattributed to e.g. a scheduler.
 * @param operator - Trailing override carrying an optional actor.
 * @returns The actor login, or `undefined` when unknown/unsafe.
 */
export declare function resolveOperatorActor(operator?: FixOperatorInstruction | string): string | undefined;
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
 * Fix-reuse helpers live in `./fix-reuse.js` (god-module split, step 1).
 * Re-exported here so existing import paths keep working.
 */
import { buildCleanReusedReviewResult, cleanReusedBody, filterHeadCurrentReuseThreads, findReusableHeadCurrentReview, isReviewStubBody, parseReusedSeverity, rehydrateReviewResultFromBotThreads } from './fix-reuse.js';
export { buildCleanReusedReviewResult, cleanReusedBody, filterHeadCurrentReuseThreads, findReusableHeadCurrentReview, isReviewStubBody, parseReusedSeverity, rehydrateReviewResultFromBotThreads, };
/**
 * Run a single fix iteration on a PR: resolve PR, gather context, apply
 * changes, optionally verify with a user-configured command, and push.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, races verification timeouts, and is
 *   threaded into the engine's OpenCode child ownership.
 * @param operator - Optional operator instruction from the triggering `/fix`
 *   comment (raw string or `{ instruction, actor }`). Classified internally;
 *   absent means behave exactly as today.
 */
export declare function runFix(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, signal?: AbortSignal, operator?: FixOperatorInstruction | string): Promise<void>;
/**
 * Attach HEAD to a local branch for the PR head ref before pushing.
 *
 * The review-loop workflow checks out the pinned head SHA (immutable,
 * TOCTOU-safe) which leaves a detached HEAD with no local branch — so a
 * bare `git push origin <headRef>` fails with
 * `error: src refspec <ref> does not match any` before any authentication
 * happens (not a PAT/token problem; issue #674). `checkout -B` keeps the
 * working tree untouched and attaches HEAD to the ref, so the iteration
 * commit and every later commit land on the branch and pushes succeed.
 * Plain push stays fail-closed on divergence (a concurrent human push turns
 * into a non-fast-forward rejection, never a silent overwrite).
 * @param headRef - PR head branch name (validated; e.g. 'autofix/issue-123').
 */
export declare function ensureLocalBranchForPush(headRef: string): Promise<void>;
/**
 * Run a fix triggered from an issue (non-PR): create a branch, apply the fix,
 * commit, push, and open a new PR.
 * Includes optional wall-clock timeout guarding against queue wait time when
 * an explicit timeout is configured.
 * @param inputs - Action inputs.
 * @param config - Agent config (provides timeoutMinutes).
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo).
 * @param gitEmail - Configured bot commit author email, used to verify that an
 *   existing `autofix/issue-N` branch tip was authored by this bot before it is
 *   reused (see `configureGit`).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly,
 *   breaks withRetry backoff sleeps, races verification timeouts, and is
 *   threaded into the engine's OpenCode child ownership.
 * @param operator - Optional operator instruction from the triggering `/fix`
 *   comment (raw string or `{ instruction, actor }`); seeds fix-agent context.
 */
export declare function runFixIssue(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, gitEmail: string, signal?: AbortSignal, operator?: FixOperatorInstruction | string): Promise<void>;
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
 *   breaks withRetry backoff sleeps, races verification timeouts, and is
 *   threaded into the engine's OpenCode child ownership.
 * @param operator - Optional operator instruction from the triggering `/fix`
 *   comment (raw string or `{ instruction, actor }`); seeds fix-agent context.
 */
export declare function runAutofixLoop(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, _token: string, signal?: AbortSignal, operator?: FixOperatorInstruction | string): Promise<void>;
/**
 * Verification-comment builders live in `./verification-comment.js`
 * (god-module split, step 1). Re-exported here so existing import paths keep
 * working; side-effecting posters stay in this file.
 */
import { VERIFICATION_FAILED_FALLBACK, VERIFICATION_FAILED_MARKER, VERIFICATION_FAILED_OUTPUT_LIMIT, buildVerificationFailedCommentBody } from './verification-comment.js';
export { VERIFICATION_FAILED_FALLBACK, VERIFICATION_FAILED_MARKER, VERIFICATION_FAILED_OUTPUT_LIMIT, buildVerificationFailedCommentBody, };
