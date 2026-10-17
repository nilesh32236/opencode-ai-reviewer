import type { ReviewIssue, ReviewResult, ReviewThreadInfo } from '@opencode-pr-agent/lib';
/**
 * Focused reuse helpers extracted from `fix.ts` (god-module split, step 1).
 * `fix.ts` re-exports everything here so existing import paths keep working.
 */
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
 * @returns Cleaned message text (truncated to `MAX_VERIFICATION_EXCERPT_CHARS` chars).
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
