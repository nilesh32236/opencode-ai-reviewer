/**
 * Sanitizes a message to prevent exposing secrets like Bearer tokens or API keys.
 * @param message - The raw message string.
 * @returns The sanitized string.
 */
export declare const sanitize: (message: string) => string;
/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * Rejects non-integer, zero, negative, and excessively large values so they
 * never reach the issues/pulls APIs (which would leak internal errors).
 * @returns The PR number, or `null` when no PR number can be determined.
 */
export declare function resolvePrNumber(): Promise<number | null>;
/**
 * Strictly parse `CI_MERGE_REQUEST_IID` (GitLab MR IID) into a positive
 * integer. `Number()` alone accepts "", hex, scientific notation, floats
 * (truncated), and NaN/Infinity, which could route comments to the wrong MR.
 * @param raw - Raw IID string; defaults to `process.env.CI_MERGE_REQUEST_IID`.
 * @returns The MR IID, or `undefined` when unset or invalid (with a warning).
 */
export declare function resolveGitLabMrIid(raw?: string): number | undefined;
/**
 * Create a per-run AbortController whose signal aborts at the run deadline.
 * The deadline derives from `timeoutMinutes` (default 20m). The returned
 * controller fires with a `TimeoutError` reason so callers can distinguish a
 * deadline expiry from a deliberate cancel (`AbortError`).
 * @param timeoutMinutes - Run budget in minutes.
 * @returns The controller plus a `dispose` that clears the deadline timer.
 */
export declare function createRunAbortController(timeoutMinutes?: number): {
    controller: AbortController;
    signal: AbortSignal;
    dispose: () => void;
};
/**
 * Describe an abort/cancellation error distinctly: deadline (`TimeoutError`)
 * vs deliberate cancel (`AbortError`).
 * @param err - The thrown value.
 * @returns Human-readable label (`timeout`, `cancelled`, or `error`).
 */
export declare function describeAbortKind(err: unknown): 'timeout' | 'cancelled' | 'error';
/** Default per-command verification timeout (5 minutes). */
export declare const DEFAULT_VERIFICATION_TIMEOUT_MS: number;
/** Cap on captured verification output fed back to the fix engine (256 KiB). */
export declare const MAX_VERIFICATION_OUTPUT_BYTES: number;
/**
 * Truncate captured verification output to the byte cap, annotating truncation.
 * @param output - Full captured output.
 * @returns Output within the cap.
 */
export declare function capVerificationOutput(output: string): string;
/**
 * Run a subprocess with a per-command timeout and output-byte cap.
 * A timeout (or an aborted outer signal) is reported as a non-zero exit with
 * a clear message so callers treat it as verification failure, never a hang.
 *
 * NOTE — report-only timeout: `@actions/exec` exposes no child handle, so a
 * hung check cannot be killed here and may keep running in the background
 * (holding CPU/locks/ports) after the race settles. The signal is
 * advisory-only for the exec race: capture stops being consumed after the
 * race settles, listeners are detached, and the caller sees exit 124. Switch
 * to `node:child_process` spawn + `child.kill('SIGTERM')` with a SIGKILL
 * fallback if true subprocess reaping is ever required.
 * @param program - Executable.
 * @param args - Arguments.
 * @param options - Exec options plus optional timeout/signal/cwd.
 * @returns Exit code and capped combined output.
 */
export declare function execWithTimeout(program: string, args: string[], options?: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    silent?: boolean;
}): Promise<{
    exitCode: number;
    output: string;
}>;
