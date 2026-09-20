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
/**
 * Redact secret-bearing fragments (CLI flags, assignments, URLs, tokens,
 * keys, certificates) before they reach action logs or LLM context. Builds
 * on {@link sanitizeString} — which already covers GitHub/GitLab tokens,
 * Bearer values, OpenAI/Anthropic keys, AWS access-key IDs, and `*_API_KEY`
 * assignments — with additional patterns for the forms it misses: short
 * `github_pat_` / `gh*_` variants, generic `sk-` keys, `Authorization`
 * headers, PEM blocks, `x-access-token` values, AWS secret values, and
 * generic `--flag=value` / `key=value` masking so workflow check commands
 * like `--token=...` never leak via warnings or verification feedback.
 * @param text - Raw text (command line, log excerpt, verification output).
 * @returns Redacted text.
 */
export declare function redactSecrets(text: string): string;
/**
 * Format a verification command for log output with secret-bearing args
 * redacted. Only the program name is trusted verbatim; args pass through
 * {@link redactSecrets}.
 * @param program - Bare executable name.
 * @param args - Command arguments.
 * @returns Single-line redacted command description.
 */
export declare function formatVerificationCommandForLog(program: string, args: string[]): string;
/**
 * Scrub captured verification output before logging or feeding it back to
 * the fix engine, so secrets embedded in check output cannot resurface in
 * LLM-generated comments.
 * @param output - Captured (already byte-capped) output.
 * @returns Redacted output.
 */
export declare function scrubVerificationOutput(output: string): string;
/** Default per-command verification timeout (5 minutes). */
export declare const DEFAULT_VERIFICATION_TIMEOUT_MS: number;
/** Cap on captured verification output fed back to the fix engine (256 KiB). */
export declare const MAX_VERIFICATION_OUTPUT_BYTES: number;
/**
 * Truncate captured verification output to the byte cap, annotating truncation.
 * Over-cap output keeps the head (first 128 KiB) and the tail (last 128 KiB)
 * with a gap marker: for failing verification commands the tail usually holds
 * the actual error, so head-only retention would hide the diagnostic the
 * engine needs most. Both cut points are clamped to UTF-8 character
 * boundaries so capping never emits a U+FFFD replacement character.
 * @param output - Full captured output.
 * @returns Output within the cap.
 */
export declare function capVerificationOutput(output: string): string;
/**
 * Run a subprocess with a per-command timeout and output-byte cap.
 * A timeout (or an aborted outer signal) kills the subprocess
 * (SIGTERM, escalating to SIGKILL) and is reported as exit 124 with a clear
 * message so callers treat it as verification failure, never a hang — the
 * child cannot keep running in the background holding CPU/locks/ports (or
 * the workflow token in scope) on self-hosted runners.
 *
 * Runs without a shell via `node:child_process` spawn: `program` must be a
 * bare executable name (PATH-resolved; paths and shell metacharacters are
 * rejected) so execution can never be redirected to a planted binary.
 * @param program - Bare executable name (PATH-resolved; paths and shell metacharacters are rejected).
 * @param args - Arguments.
 * @param options - Exec options plus optional timeout/signal/cwd.
 * @param options.cwd - Working directory for the subprocess.
 * @param options.timeoutMs - Per-command timeout in milliseconds.
 * @param options.signal - AbortSignal to cancel the subprocess.
 * @param options.silent - When true, suppress live output forwarding.
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
