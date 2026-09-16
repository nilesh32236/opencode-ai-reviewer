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
  const timeoutMs = (timeoutMinutes ?? 20) * 60 * 1000;
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const pushChunk = (data: Buffer): void => {
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
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    (timeoutId as unknown as { unref?: () => void }).unref?.();
    options.signal?.addEventListener(
      'abort',
      () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve({ timedOut: true });
      },
      { once: true },
    );
    if (options.signal?.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ timedOut: true });
    }
  });
  const winner = await Promise.race([
    execPromise.then((exitCode) => ({ timedOut: false as const, exitCode })),
    timeoutPromise,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (winner.timedOut) {
    const reason =
      options.signal?.aborted && options.signal.reason instanceof DOMException
        ? options.signal.reason.name
        : 'TimeoutError';
    const output = capVerificationOutput(
      `${Buffer.concat(chunks).toString('utf-8')}\nVerification command timed out after ${Math.round(timeoutMs / 1000)}s (${reason}): ${program} ${args.join(' ')}`,
    );
    return { exitCode: 124, output };
  }
  const output = capVerificationOutput(Buffer.concat(chunks).toString('utf-8'));
  return { exitCode: winner.exitCode, output };
}
