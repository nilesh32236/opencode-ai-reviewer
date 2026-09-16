import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { sanitizeString } from '@opencode-pr-agent/lib';

/**
 * Sanitizes a message to prevent exposing secrets like Bearer tokens or API keys.
 * @param message - The raw message string.
 * @returns The sanitized string.
 */
export const sanitize = (message: string): string => sanitizeString(message);

/**
 * Maximum valid PR/issue number (signed 32-bit int, matching GitHub's range).
 */
const MAX_PR_NUMBER = 2147483647;

/**
 * Resolves the PR number from the `pr-number` input or the GitHub event context.
 * Rejects non-integer, zero, negative, and excessively large values so they
 * never reach the issues/pulls APIs (which would leak internal errors).
 * @returns The PR number, or `null` when no PR number can be determined.
 */
export async function resolvePrNumber(): Promise<number | null> {
  const prNumberInput = core.getInput('pr-number').trim();
  if (prNumberInput) {
    const trimmed = prNumberInput;
    // Require a canonical integer string: parseInt alone would accept "12abc"
    // or "1.5" (truncating to 1), so verify the round-trip first. This also
    // rejects partially-numeric values that would route against the wrong PR.
    const prNumber = Number.parseInt(trimmed, 10);
    if (
      Number.isNaN(prNumber) ||
      !Number.isInteger(prNumber) ||
      String(prNumber) !== trimmed ||
      prNumber < 1 ||
      prNumber > MAX_PR_NUMBER
    ) {
      core.setFailed(sanitize(`Invalid pr-number: ${prNumberInput}`));
      return null;
    }
    return prNumber;
  }
  const fromIssue = github.context.payload.issue?.number;
  const fromPR = github.context.payload.pull_request?.number;
  return fromPR || fromIssue || null;
}

/**
 * Strictly parse `CI_MERGE_REQUEST_IID` (GitLab MR IID) into a positive
 * integer. `Number()` alone accepts "", hex, scientific notation, floats
 * (truncated), and NaN/Infinity, which could route comments to the wrong MR.
 * @param raw - Raw IID string; defaults to `process.env.CI_MERGE_REQUEST_IID`.
 * @returns The MR IID, or `undefined` when unset or invalid (with a warning).
 */
export function resolveGitLabMrIid(raw?: string): number | undefined {
  const value = (raw ?? process.env.CI_MERGE_REQUEST_IID ?? '').trim();
  if (!value) return undefined;
  // Canonical integer string only: rejects "12abc", "1.5", "0x10", "1e2".
  const parsed = Number.parseInt(value, 10);
  if (
    Number.isNaN(parsed) ||
    !Number.isInteger(parsed) ||
    String(parsed) !== value ||
    parsed < 1 ||
    parsed > MAX_PR_NUMBER ||
    !Number.isFinite(parsed)
  ) {
    core.warning(sanitize(`Ignoring invalid CI_MERGE_REQUEST_IID="${value}"`));
    return undefined;
  }
  return parsed;
}

/**
 * Create a per-run AbortController whose signal aborts at the run deadline.
 * The deadline derives from `timeoutMinutes` (default 20m). The returned
 * controller fires with a `TimeoutError` reason so callers can distinguish a
 * deadline expiry from a deliberate cancel (`AbortError`).
 * @param timeoutMinutes - Run budget in minutes.
 * @returns The controller plus a `dispose` that clears the deadline timer.
 */
export function createRunAbortController(timeoutMinutes?: number): {
  controller: AbortController;
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  // Coerce to a positive finite number: 0/negative/NaN would fire the
  // deadline immediately (cancelling the whole run) and Infinity would
  // silently disable the deadline. Fall back to the 20-minute default.
  const minutes = Number(timeoutMinutes ?? 20);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 20;
  const timeoutMs = safeMinutes * 60 * 1000;
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Run deadline exceeded', 'TimeoutError'));
  }, timeoutMs);
  // Never keep the event loop alive just for the deadline timer.
  (timeoutId as unknown as { unref?: () => void }).unref?.();
  return {
    controller,
    signal: controller.signal,
    dispose: () => clearTimeout(timeoutId),
  };
}

/**
 * Describe an abort/cancellation error distinctly: deadline (`TimeoutError`)
 * vs deliberate cancel (`AbortError`).
 * @param err - The thrown value.
 * @returns Human-readable label (`timeout`, `cancelled`, or `error`).
 */
export function describeAbortKind(err: unknown): 'timeout' | 'cancelled' | 'error' {
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'timeout';
  if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
  return 'error';
}

/** Default per-command verification timeout (5 minutes). */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Cap on captured verification output fed back to the fix engine (256 KiB). */
export const MAX_VERIFICATION_OUTPUT_BYTES = 256 * 1024;

/**
 * Truncate captured verification output to the byte cap, annotating truncation.
 * @param output - Full captured output.
 * @returns Output within the cap.
 */
export function capVerificationOutput(output: string): string {
  const byteLen = Buffer.byteLength(output, 'utf-8');
  if (byteLen <= MAX_VERIFICATION_OUTPUT_BYTES) return output;
  const buf = Buffer.from(output, 'utf-8').subarray(0, MAX_VERIFICATION_OUTPUT_BYTES);
  return `${buf.toString('utf-8')}\n…[truncated ${byteLen - MAX_VERIFICATION_OUTPUT_BYTES} bytes: output capped at ${MAX_VERIFICATION_OUTPUT_BYTES} bytes]`;
}

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
export async function execWithTimeout(
  program: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    silent?: boolean;
  } = {},
): Promise<{ exitCode: number; output: string }> {
  // Coerce to a positive finite number, mirroring createRunAbortController:
  // 0/negative/NaN would fire immediately and Infinity would never fire.
  const rawTimeoutMs = Number(options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
      ? rawTimeoutMs
      : DEFAULT_VERIFICATION_TIMEOUT_MS;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let settled = false;
  const pushChunk = (data: Buffer): void => {
    // Stop capturing once the race has settled so a still-running hung child
    // cannot grow memory after the caller already received exit 124.
    if (settled) return;
    // Cap in-memory capture: keep the head of the log (most useful for
    // diagnosis) and drop the tail beyond 2x the feedback cap.
    if (totalBytes < MAX_VERIFICATION_OUTPUT_BYTES * 2) {
      const remaining = MAX_VERIFICATION_OUTPUT_BYTES * 2 - totalBytes;
      chunks.push(data.subarray(0, remaining));
      totalBytes += Math.min(data.length, remaining);
    }
  };
  const execPromise = exec.exec(program, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.silent !== undefined ? { silent: options.silent } : {}),
    listeners: {
      stdout: pushChunk,
      stderr: pushChunk,
    },
    ignoreReturnCode: true,
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    (timeoutId as unknown as { unref?: () => void }).unref?.();
    onAbort = (): void => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ timedOut: true });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ timedOut: true });
    }
  });
  // Spawn/startup failures (ENOENT, EACCES) reject execPromise: convert to a
  // failure result so verification fails closed with diagnostics instead of
  // throwing out of a call site that expects an {exitCode, output} tuple.
  const winner = await Promise.race([
    execPromise.then(
      (exitCode) => ({ timedOut: false as const, exitCode }),
      (err: unknown) => ({
        timedOut: false as const,
        exitCode: 1,
        execError: err instanceof Error ? err.message : String(err),
      }),
    ),
    timeoutPromise,
  ]);
  settled = true;
  if (timeoutId) clearTimeout(timeoutId);
  if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  if (winner.timedOut) {
    // Reuse describeAbortKind so Error-named TimeoutError/AbortError reasons
    // are labeled correctly (a hand-rolled DOMException-only check mislabels
    // them). Defaults to TimeoutError when the race was won by the timer.
    const abortKind =
      options.signal?.aborted && options.signal.reason !== undefined
        ? describeAbortKind(options.signal.reason)
        : 'timeout';
    const reason = abortKind === 'cancelled' ? 'AbortError' : 'TimeoutError';
    const verb = abortKind === 'cancelled' ? 'cancelled' : 'timed out';
    const output = capVerificationOutput(
      `${Buffer.concat(chunks).toString('utf-8')}\nVerification command ${verb} after ${Math.round(timeoutMs / 1000)}s (${reason}): ${program} ${args.join(' ')}`,
    );
    return { exitCode: 124, output };
  }
  const rawOutput = Buffer.concat(chunks).toString('utf-8');
  const execError = 'execError' in winner ? winner.execError : undefined;
  const output = capVerificationOutput(
    execError ? `${rawOutput}\nVerification command failed to start: ${execError}` : rawOutput,
  );
  return { exitCode: winner.exitCode, output };
}
