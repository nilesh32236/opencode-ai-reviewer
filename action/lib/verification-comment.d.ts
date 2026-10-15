/**
 * Verification-comment helpers extracted from `fix.ts` (god-module split).
 * Pure builders live here (dependency-light, unit-testable); `fix.ts`
 * re-exports them so existing import paths keep working. Side-effecting
 * posters stay in `fix.ts` where the engine/exec dependencies already live.
 */
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
