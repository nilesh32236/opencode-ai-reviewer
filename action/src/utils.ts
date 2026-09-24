import { spawn } from 'node:child_process';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  registerManagedProcess,
  sanitizeString,
  terminateManagedProcessGroup,
  validateTimeoutMinutes,
} from '@opencode-pr-agent/lib';

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
 * Create a per-run AbortController whose signal aborts only when an explicit
 * run budget was supplied. Omission creates no deadline; any non-undefined
 * invalid value is rejected before a timer or child can start. The returned
 * controller fires with a `TimeoutError` reason so callers can distinguish a
 * deadline expiry from a deliberate cancel (`AbortError`).
 * @param timeoutMinutes - Optional hard run budget in minutes.
 * @returns The controller plus a `dispose` that clears the deadline timer.
 */
export function createRunAbortController(timeoutMinutes?: number): {
  controller: AbortController;
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const minutes = validateTimeoutMinutes(timeoutMinutes);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (minutes !== undefined) {
    const timeoutMs = minutes * 60 * 1000;
    timeoutId = setTimeout(() => {
      controller.abort(new DOMException('Run deadline exceeded', 'TimeoutError'));
    }, timeoutMs);
    // Never keep the event loop alive just for an optional deadline timer.
    (timeoutId as unknown as { unref?: () => void }).unref?.();
  }

  return {
    controller,
    signal: controller.signal,
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
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
export function redactSecrets(text: string): string {
  return (
    sanitizeString(String(text ?? ''))
      // PEM blocks (multi-line secrets sanitizeString does not cover).
      .replace(
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      // Authorization headers (Bearer/Basic/Token) sanitizeString misses in
      // `Header: value` form.
      .replace(/(authorization\s*:\s*(?:bearer|basic|token)\s+)([^\s'"]+)/gi, '$1[REDACTED]')
      // Short GitHub token variants below sanitizeString's {36,} threshold
      // (fine-grained PATs are ~22+ chars).
      .replace(/github_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/gh[psuor]_[A-Za-z0-9]{22,}/g, '[REDACTED_GITHUB_TOKEN]')
      // Generic OpenAI/Anthropic-style keys below sanitizeString's longer
      // thresholds ({48,}/{40,}).
      .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]')
      // AWS secret access key values (40-char base64).
      .replace(
        /(aws_secret_access_key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(["']?)/gi,
        '$1[REDACTED]$3',
      )
      // x-access-token credential values sanitizeString only covers in URL form.
      .replace(/(x-access-token\s*[:=]\s*)([^\s'"]+)/gi, '$1[REDACTED]')
      .replace(
        /(--?(?:token|password|passwd|pwd|secret|api[_-]?key|auth|access[_-]?key)[=:\s]+)([^\s'"]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/((?:password|passwd|secret)\s*[:=]\s*)([^\s'"]+)/gi, '$1[REDACTED]')
      .replace(/([?&](?:token|key|secret|password)=[^&\s'"]+)/gi, '[REDACTED_PARAM]')
  );
}

/**
 * Format a verification command for log output with secret-bearing args
 * redacted. Only the program name is trusted verbatim; args pass through
 * {@link redactSecrets}.
 * @param program - Bare executable name.
 * @param args - Command arguments.
 * @returns Single-line redacted command description.
 */
export function formatVerificationCommandForLog(program: string, args: string[]): string {
  const redacted = redactSecrets(args.join(' '));
  return redacted ? `${program} ${redacted}` : program;
}

/**
 * Scrub captured verification output before logging or feeding it back to
 * the fix engine, so secrets embedded in check output cannot resurface in
 * LLM-generated comments.
 * @param output - Captured (already byte-capped) output.
 * @returns Redacted output.
 */
export function scrubVerificationOutput(output: string): string {
  return redactSecrets(output);
}

/** Default per-command verification timeout (5 minutes). */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Cap on captured verification output fed back to the fix engine (256 KiB). */
export const MAX_VERIFICATION_OUTPUT_BYTES = 256 * 1024;

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
export function capVerificationOutput(output: string): string {
  const byteLen = Buffer.byteLength(output, 'utf-8');
  if (byteLen <= MAX_VERIFICATION_OUTPUT_BYTES) return output;
  const buf = Buffer.from(output, 'utf-8');
  const HEAD_KEEP_BYTES = 128 * 1024;
  const TAIL_KEEP_BYTES = 128 * 1024;
  const headEnd = clampToCharBoundary(buf, Math.min(HEAD_KEEP_BYTES, buf.length));
  const tailStart = advanceToCharBoundary(buf, Math.max(headEnd, buf.length - TAIL_KEEP_BYTES));
  const head = buf.subarray(0, headEnd).toString('utf-8');
  const tail = buf.subarray(tailStart).toString('utf-8');
  return `${head}\n…[truncated ${byteLen - MAX_VERIFICATION_OUTPUT_BYTES} bytes: output capped at ${MAX_VERIFICATION_OUTPUT_BYTES} bytes — showing head and tail]…\n${tail}`;
}

/**
 * Move a head-truncation end index left until it lands on a UTF-8 character
 * boundary, so decoding never splits a multi-byte sequence (which would emit
 * U+FFFD). `Buffer.subarray(0, N).toString('utf-8')` does not do this.
 * @param buf - UTF-8 encoded bytes.
 * @param end - Proposed end index.
 * @returns Adjusted end index on a character boundary.
 */
function clampToCharBoundary(buf: Buffer, end: number): number {
  const e = Math.min(end, buf.length);
  let i = e - 1;
  let cont = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    cont++;
    i--;
  }
  if (cont === 0) return e;
  if (i < 0) return 0;
  const lead = buf[i];
  let need = 0;
  if (lead >= 0xc2 && lead <= 0xdf) need = 1;
  else if (lead >= 0xe0 && lead <= 0xef) need = 2;
  else if (lead >= 0xf0 && lead <= 0xf4) need = 3;
  else return e;
  // Available continuation bytes: e - i - 1. Incomplete sequence → drop it.
  return e - i - 1 < need ? i : e;
}

/**
 * Move a tail-truncation start index right until it lands on a UTF-8
 * character boundary (skipping continuation bytes of a split sequence).
 * @param buf - UTF-8 encoded bytes.
 * @param start - Proposed start index.
 * @returns Adjusted start index on a character boundary.
 */
function advanceToCharBoundary(buf: Buffer, start: number): number {
  let s = Math.max(0, start);
  while (s < buf.length && (buf[s] & 0xc0) === 0x80) s++;
  return s;
}

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
  // Fail closed on a non-trivial program name: this helper runs with the
  // workflow's token in scope, so the executable must be a bare command
  // resolved via PATH — never a path (absolute, relative, or UNC, which
  // would bypass PATH and allow a planted binary) and never shell
  // metacharacters (exec.exec spawns without a shell, but a hostile value
  // here would still misdirect execution). Callers pass literals ('pnpm').
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(program)) {
    throw new Error(`Refusing to execute non-bare program name: ${program}`);
  }
  // Coerce to a positive finite number, mirroring createRunAbortController:
  // 0/negative/NaN would fire immediately and Infinity would never fire.
  const rawTimeoutMs = Number(options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
      ? rawTimeoutMs
      : DEFAULT_VERIFICATION_TIMEOUT_MS;
  // In-memory capture retains head + tail (not head-only): the tail usually
  // holds the actual error for failing commands. Head keeps the first 128
  // KiB; the tail is a sliding window over the last 384 KiB, so live memory
  // stays bounded at ~512 KiB no matter how much a runaway process emits.
  const HEAD_KEEP_BYTES = 128 * 1024;
  const TAIL_KEEP_BYTES = 384 * 1024;
  const headQueue: Buffer[] = [];
  let headBytes = 0;
  const tailQueue: Buffer[] = [];
  let tailBytes = 0;
  let totalBytes = 0;
  let settled = false;
  const pushChunk = (data: Buffer): void => {
    // Stop capturing once the race has settled so a still-running hung child
    // cannot grow memory after the caller already received exit 124.
    if (settled) return;
    totalBytes += data.length;
    if (headBytes < HEAD_KEEP_BYTES) {
      const slice = data.subarray(0, HEAD_KEEP_BYTES - headBytes);
      // Accumulate head slices and concat once at read time: Buffer.concat on
      // every chunk is O(n^2) for runaway commands emitting many small chunks.
      headQueue.push(Buffer.from(slice));
      headBytes += slice.length;
    }
    tailQueue.push(data);
    tailBytes += data.length;
    while (tailBytes > TAIL_KEEP_BYTES && tailQueue.length > 0) {
      const first = tailQueue[0];
      const excess = tailBytes - TAIL_KEEP_BYTES;
      if (first.length <= excess) {
        tailQueue.shift();
        tailBytes -= first.length;
      } else {
        tailQueue[0] = first.subarray(excess);
        tailBytes -= excess;
        break;
      }
    }
  };
  // Assemble head + gap marker + tail, decoding each side on a UTF-8
  // character boundary so a multi-byte sequence split across the cut never
  // surfaces as U+FFFD.
  const combinedRawOutput = (): string => {
    const head = headQueue.length > 0 ? Buffer.concat(headQueue) : Buffer.alloc(0);
    if (totalBytes <= TAIL_KEEP_BYTES) {
      return Buffer.concat(tailQueue).toString('utf-8');
    }
    const tail = Buffer.concat(tailQueue);
    const headEnd = clampToCharBoundary(head, head.length);
    const tailStart = advanceToCharBoundary(tail, 0);
    const omitted = Math.max(0, totalBytes - headEnd - (tail.length - tailStart));
    return (
      `${head.subarray(0, headEnd).toString('utf-8')}\n…[omitted ${omitted} bytes of middle output]…\n` +
      tail.subarray(tailStart).toString('utf-8')
    );
  };
  const onData = (data: Buffer | string): void => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    pushChunk(buf);
    // Mirror @actions/exec live forwarding (silent suppresses it): stream to
    // the runner log unless the caller opted out.
    if (!options.silent && !settled) {
      try {
        process.stdout.write(buf);
      } catch {
        /* ignore — capture is authoritative, forwarding is best-effort */
      }
    }
  };
  return await new Promise<{ exitCode: number; output: string }>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let unregisterManaged: (() => void) | undefined;
    let done = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number, output: string): void => {
      if (done) return;
      done = true;
      settled = true;
      clearTimeout(timeoutId);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      unregisterManaged?.();
      unregisterManaged = undefined;
      resolve({ exitCode, output: capVerificationOutput(output) });
    };
    const finishTimeout = (): void => {
      // Reuse describeAbortKind so Error-named TimeoutError/AbortError reasons
      // are labeled correctly (a hand-rolled DOMException-only check mislabels
      // them). Defaults to TimeoutError when the timer won; an aborted signal
      // without a reason still reads as 'cancelled'.
      const abortKind = !options.signal?.aborted
        ? 'timeout'
        : options.signal.reason === undefined
          ? 'cancelled'
          : describeAbortKind(options.signal.reason);
      const reason = abortKind === 'cancelled' ? 'AbortError' : 'TimeoutError';
      const verb = abortKind === 'cancelled' ? 'cancelled' : 'timed out';
      timedOut = true;
      core.warning(
        sanitize(
          `Verification command ${verb} after ${Math.round(timeoutMs / 1000)}s (${reason}): ${formatVerificationCommandForLog(program, args)} — sent SIGTERM (SIGKILL fallback) so no hung process is left running`,
        ),
      );
      // SIGTERM first so the child can flush/exit cleanly; SIGKILL fallback
      // guarantees reaping when it ignores the signal. Resolves 124 once the
      // child exits, or after the SIGKILL grace at the latest — the caller is
      // never left hanging on an unkillable child. The grace is bounded to 2s
      // so a hung command settles promptly (timeout + grace stays well under
      // typical step/test timeouts) while still giving SIGTERM a chance.
      if (child) terminateManagedProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child) terminateManagedProcessGroup(child, 'SIGKILL');
        // Even if 'close' never fires, stop waiting: report the timeout with
        // whatever was captured so far.
        finish(
          124,
          `${combinedRawOutput()}\nVerification command ${verb} after ${Math.round(timeoutMs / 1000)}s (${reason}): ${formatVerificationCommandForLog(program, args)}`,
        );
      }, 2000);
      (killTimer as unknown as { unref?: () => void }).unref?.();
    };
    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(finishTimeout, timeoutMs);
    (timeoutId as unknown as { unref?: () => void }).unref?.();
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      finishTimeout();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(program, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      });
      unregisterManaged = registerManagedProcess(child, { detached: true });
    } catch (err: unknown) {
      // Synchronous spawn throw (should be rare; async failures arrive via
      // 'error'): fail closed with diagnostics instead of throwing out of a
      // call site that expects an {exitCode, output} tuple.
      const execError = err instanceof Error ? err.message : String(err);
      finish(1, `${combinedRawOutput()}\nVerification command failed to start: ${execError}`);
      return;
    }
    if (options.signal?.aborted) {
      finishTimeout();
      return;
    }
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    // Spawn/startup failures (ENOENT, EACCES) arrive here: convert to a
    // failure result so verification fails closed with diagnostics instead of
    // throwing out of a call site that expects an {exitCode, output} tuple.
    child.on('error', (err: Error) => {
      finish(1, `${combinedRawOutput()}\nVerification command failed to start: ${err.message}`);
    });
    child.on('close', (code: number | null) => {
      // A close that follows our own timeout kill is already resolved by the
      // SIGKILL grace; `finish` is idempotent so a double-resolve is harmless.
      if (done) return;
      if (timedOut) {
        const abortKind = !options.signal?.aborted
          ? 'timeout'
          : options.signal.reason === undefined
            ? 'cancelled'
            : describeAbortKind(options.signal.reason);
        const reason = abortKind === 'cancelled' ? 'AbortError' : 'TimeoutError';
        const verb = abortKind === 'cancelled' ? 'cancelled' : 'timed out';
        finish(
          124,
          `${combinedRawOutput()}\nVerification command ${verb} after ${Math.round(timeoutMs / 1000)}s (${reason}): ${formatVerificationCommandForLog(program, args)}`,
        );
        return;
      }
      finish(code ?? 1, combinedRawOutput());
    });
  });
}
