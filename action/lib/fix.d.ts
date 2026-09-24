import type { AgentConfig, PlatformAdapter, ReviewEngine, ReviewIssue, ReviewResult, ReviewThreadInfo } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
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
 * Bounds prompt-injection blast radius: a crafted /fix remainder cannot
 * steer tool use beyond this quoted, delimited budget.
 */
export declare const MAX_OPERATOR_INSTRUCTION_CHARS = 2000;
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
 * Head-current, non-stub, unresolved subset of bot threads eligible for
 * reuse. Single source of truth shared by {@link findReusableHeadCurrentReview}
 * and the skipped-postReview id mapping so stale-head and stub-thread comment
 * IDs never leak into fix-progress tracking.
 * @param threads - Bot review threads for the PR.
 * @param headSha - Current PR head SHA.
 * @param commitByCommentId - Optional databaseId → commit SHA map built from
 * `listReviewComments` (each record's `commit_id`).
 * @returns Threads anchored to the current head SHA.
 */
export declare function filterHeadCurrentReuseThreads(threads: ReviewThreadInfo[], headSha: string, commitByCommentId?: Map<number, string>): ReviewThreadInfo[];
/**
 * Ready verdict for a head-current bot review that carries zero inline
 * threads (clean review or body-only findings). Lets `/fix` skip the fresh
 * `engine.reviewPR` LLM pass instead of repaying it for an already-clean head.
 * @param headSha - Current PR head SHA (used only for the summary line).
 * @returns ReviewResult with zero issues and a ready verdict.
 */
export declare function buildCleanReusedReviewResult(headSha: string): ReviewResult;
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
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
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
 *   breaks withRetry backoff sleeps, and races verification timeouts.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 * @param operator - Optional operator instruction from the triggering `/fix`
 *   comment (raw string or `{ instruction, actor }`); seeds fix-agent context.
 */
export declare function runAutofixLoop(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, _token: string, signal?: AbortSignal, operator?: FixOperatorInstruction | string): Promise<void>;
/** Marker for the fail-closed verification-failure comment (upserted, never spammed). */
export declare const VERIFICATION_FAILED_MARKER = "<!-- autofix-verification-failed -->";
/** Max failing-output characters embedded in the verification-failed comment. */
export declare const VERIFICATION_FAILED_OUTPUT_LIMIT = 4000;
/** Fallback diagnostic when no failing-check output was captured. */
export declare const VERIFICATION_FAILED_FALLBACK = "Autofix verification failed (run_checks_after_fix did not pass after retries).";
/**
 * Build the fail-closed verification-failure comment body (pure, unit-tested).
 * Neutralizes triple-backtick sequences so attacker-controlled check output
 * cannot break out of the fenced block, caps output length, and falls back
 * to a diagnostic message when output is empty.
 * @param output - Failing check output (or rejection reason); already sanitized by callers.
 * @param extraNote - Optional extra context appended below the heading.
 * @returns Markdown comment body including the stable upsert marker.
 */
export declare function buildVerificationFailedCommentBody(output: string, extraNote?: string): string;
