import * as core from '@actions/core';
import { getErrorStatus } from './errors.js';
import { sanitizeString } from './sanitize.js';

/** Details about a single failed attempt that is about to be retried. */
export interface RetryAttemptInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Total number of attempts configured (including the first call). */
  maxRetries: number;
  /** Extracted HTTP status of the failure (0 when unknown/statusless). */
  status: number;
  /** Scheduled wait in ms before the next attempt (backoff + Retry-After + jitter). */
  delayMs: number;
  /** The thrown value that triggered the retry. */
  error: unknown;
}

/** Options for configuring retry behavior in withRetry and withRetryAndTimeout. */
export interface RetryOptions {
  /** Total number of attempts (including the first call). Default: 3. */
  maxRetries?: number;
  /** Base delay in ms before first retry. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30000. */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry. Default: [429, 500, 502, 503, 504]. */
  retryableStatuses?: number[];
  /** Optional AbortSignal to cancel retry loop mid-flight */
  signal?: AbortSignal;
  /** Optional operation name for log messages */
  operationName?: string;
  /** When true (default), retries unknown/statusless errors. Set false to never retry when status is 0. */
  retryUnknownStatus?: boolean;
  /**
   * Escape hatch for statuses deliberately excluded from `retryableStatuses`
   * that are still safe to retry. Called with the thrown value on every
   * failure whose status is NOT in `retryableStatuses`; returning true retries
   * it anyway (subject to `maxRetries`).
   *
   * This exists for one case: a non-idempotent POST, which is not retried on
   * 5xx or network errors because the request may have been applied
   * server-side and a replay would duplicate the resource. A rate-limit
   * rejection is the exception — the resource was definitively NOT created,
   * so replaying is safe, and dropping it is what turned a transient throttle
   * into a lost verdict (L-054).
   * @since NEXT
   */
  shouldRetryAnyway?: (err: unknown, status: number) => boolean;
  /**
   * Maximum delay in ms to honor a server-provided Retry-After hint.
   * Hints larger than this are clamped. Default: 120000 (2 minutes).
   */
  maxRetryAfterMs?: number;
  /**
   * Optional hook invoked before each scheduled retry with the failed attempt
   * details (attempt index, extracted status, computed delay). Useful for
   * metrics collection and diagnostic logging. A throwing hook is logged as a
   * warning and never breaks the retry loop.
   */
  onRetry?: (info: RetryAttemptInfo) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'signal' | 'onRetry' | 'shouldRetryAnyway'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503, 504],
  operationName: 'unknown',
  retryUnknownStatus: true,
  maxRetryAfterMs: 120000,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Retry aborted by signal', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timeout);
      reject(new DOMException('Retry aborted by signal', 'AbortError'));
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isRetryable(status: number, retryableStatuses: number[]): boolean {
  return retryableStatuses.includes(status);
}

/**
 * Invoke the optional `onRetry` hook without ever breaking the retry loop.
 * A throwing hook is reported as a warning so hook bugs stay observable
 * instead of silently masking the original retryable error.
 *
 * @param onRetry - The hook from `RetryOptions`, if provided.
 * @param opName - The bracketed operation-name prefix used in log messages.
 * @param info - Details about the failed attempt that is about to be retried.
 */
function invokeOnRetry(
  onRetry: ((info: RetryAttemptInfo) => void) | undefined,
  opName: string,
  info: RetryAttemptInfo,
): void {
  if (!onRetry) {
    return;
  }
  try {
    onRetry(info);
  } catch (hookErr) {
    core.warning(
      `${opName}onRetry hook error: ${sanitizeString(hookErr instanceof Error ? hookErr.message : String(hookErr))}`,
    );
  }
}

/**
 * Transient network-failure signatures. Deliberately multi-word / code-shaped:
 * bare `socket` or `timeout` would also match provider config hints
 * (headerTimeout/chunkTimeout), timeout-kill messages, and other
 * non-transient output, triggering spurious extra spawns.
 */
const NETWORK_RE =
  /network[_\s-]?error|fetch failed|econnrefused|econnreset|enotfound|etimedout|eai_again|socket (hang up|timeout|reset|closed)|timed out|timedout|epipe|enetunreach|ehostunreach|enetdown|ehostdown|err_network|dns lookup|connection (reset|refused|aborted|timed out)/i;

/**
 * Classify a thrown value or output string as a transient network error.
 * Inspects `message` + `code` + `cause` chains (bounded depth) for known
 * transient signatures: `network_error` token, `fetch failed`, ECONNREFUSED,
 * ECONNRESET, ENOTFOUND, ETIMEDOUT, EAI_AGAIN, socket hang-up/timeout/reset
 * phrasing, and connection reset/refused/aborted/timed-out. Reuses the regex
 * already proven in `classifyDownloadError()` (opencode.ts), generalized here.
 * Pure and side-effect-free; safe to call from fail-open retry paths.
 * @param err - The thrown value or CLI output string to classify.
 * @returns True when the value looks like a transient network failure.
 * @since NEXT
 */
export function isNetworkError(err: unknown): boolean {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  // Walk at most 4 cause links to avoid unbounded recursion on cyclic errors.
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth++) {
    if (typeof current === 'string') {
      texts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    if (seen.has(current)) break;
    seen.add(current);
    const rec = current as Record<string, unknown>;
    if (typeof rec.message === 'string') texts.push(rec.message);
    if (typeof rec.code === 'string') texts.push(rec.code);
    if (typeof rec.cause === 'string') texts.push(rec.cause);
    const next = rec.cause;
    if (next === null || next === undefined || typeof next === 'string') {
      current = typeof next === 'string' ? next : undefined;
      if (current === undefined) break;
      continue;
    }
    // Error check first: Error instances are objects, so a typeof-object
    // check above would swallow them before this branch is reached.
    if (next instanceof Error) {
      current = next;
      continue;
    }
    if (typeof next === 'object') {
      current = next;
      continue;
    }
    break;
  }
  if (texts.length === 0) {
    texts.push(String(err));
  }
  return texts.some((t) => NETWORK_RE.test(t));
}

/**
 * Detect a rate-limit rejection on a thrown GitHub API error.
 *
 * GitHub signals throttling two ways: HTTP 429, and HTTP 403 carrying a
 * `retry-after` header or an exhausted `x-ratelimit-remaining` budget. The
 * 403 form is the one that matters here — a POST is never retried on 403, so
 * a secondary-rate-limit throttle on `POST /pulls/{n}/reviews` used to abort
 * the review post on the first attempt (L-054).
 *
 * A rejection that is provably a throttle means the resource was NOT created,
 * so replaying the request cannot duplicate it. A bare permission 403 has
 * neither header and returns false, keeping it non-retryable.
 *
 * @param err - The thrown value; reads `status`/`statusCode` and `headers`.
 * @returns True when the error is a rate-limit rejection.
 * @since NEXT
 */
export function isRateLimitedError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = getErrorStatus(err) ?? 0;
  if (status !== 403 && status !== 429) return false;
  const headers = (err as { headers?: unknown }).headers;
  if (getRetryAfterHeader(headers) !== null) return true;
  const remaining = getHeaderValue(headers, 'x-ratelimit-remaining');
  if (remaining !== null && Number.parseInt(remaining, 10) === 0) return true;
  // A 429 is a throttle by definition, even without headers attached.
  return status === 429;
}

/**
 * Read a single header from a `Headers` instance or a plain record,
 * case-insensitively for the record form.
 *
 * @param headers - A `Headers` instance, a plain header record, or undefined.
 * @param name - Lowercase header name to read.
 * @returns The header value, or null when absent.
 */
function getHeaderValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }
  if (typeof headers !== 'object') return null;
  const record = headers as Record<string, unknown>;
  const direct = record[name];
  if (typeof direct === 'string') return direct;
  const match = Object.keys(record).find((k) => k.toLowerCase() === name);
  const found = match ? record[match] : undefined;
  return typeof found === 'string' ? found : null;
}

/**
 * Hard ceiling on total attempts for a single {@link withRetry} call.
 *
 * `maxRetries` is a total-attempt count here, so a caller that forwards an
 * unbounded or attacker-influenced value would otherwise spin for as long as
 * the value allows.
 */
export const MAX_RETRY_ATTEMPTS = 10;

/**
 * Clamp a caller-supplied attempt budget to a value the retry loop can always
 * run at least once with.
 *
 * `{ ...DEFAULT_OPTIONS, ...options }` lets an explicitly-present `undefined`
 * key clobber the default, so `{ maxRetries: undefined }` — the natural shape
 * of a spread-built options object — resolved to `undefined`. The loop guard is
 * `attempt <= maxRetries`, so it never entered, `fn` was never invoked, and the
 * post-loop `throw lastError` rejected with `undefined`. That is the worst
 * possible failure shape: a promise rejection indistinguishable from a genuine
 * failure, for work that never ran.
 *
 * `0` and negatives mean "try once, do not retry" — which is what a caller
 * asking for no retries expects, and what the old `attempt <= maxRetries`
 * guard got wrong by treating it as "never try at all".
 * @param value - Raw `maxRetries` value as resolved from options.
 * @returns An integer in [1, {@link MAX_RETRY_ATTEMPTS}].
 */
function normalizeAttemptBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  return Math.min(whole, MAX_RETRY_ATTEMPTS);
}

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * The retry strategy:
 * - Delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs) + random 0-30% jitter
 * - Only retries on status codes in `retryableStatuses` (default: 429, 500, 502, 503, 504)
 * - For status=0 (network/unknown errors), retry is controlled by `retryUnknownStatus`
 * - Honors a server-provided Retry-After hint (via `retryAfterSeconds` or the
 *   `retry-after` response header on the error) by waiting at least that long,
 *   clamped to `maxRetryAfterMs`
 * - Status is extracted via `getErrorStatus()` so `status`, `statusCode`,
 *   `response.status`, and `cause` chains all classify identically
 * - Supports cancellation via AbortSignal
 * - Invokes the optional `onRetry` hook before each scheduled retry
 *
 * @param fn - Async function to retry.
 * @param options - Retry configuration (maxRetries, delays, retryable statuses, etc.).
 * @returns The result of the function on success.
 * @throws The last error encountered once all retries are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    retryableStatuses,
    operationName,
    retryUnknownStatus,
    maxRetryAfterMs,
    onRetry,
    shouldRetryAnyway,
  } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const signal = options.signal;
  const opName = operationName ? `[${operationName}] ` : '';

  // Normalize the attempt budget. `{ ...DEFAULT_OPTIONS, ...options }` lets an
  // explicitly-present `undefined` key clobber the default, so
  // `{ maxRetries: undefined }` — the natural shape of a spread-built options
  // object — produced `maxRetries === undefined`. The loop guard is
  // `attempt <= maxRetries`, so it never entered, `fn` was never invoked, and
  // the post-loop `throw lastError` threw `undefined` with `lastError` never
  // assigned: a rejected promise indistinguishable from a real failure, for an
  // operation that had not run. Clamping to a minimum of 1 makes "the
  // operation was skipped" unrepresentable; 0 and negatives mean "try once,
  // do not retry", which is what a caller asking for no retries expects.
  const maxAttempts = normalizeAttemptBudget(maxRetries);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Retry aborted by signal', 'AbortError');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Cancellation is never retryable: an aborted outer signal or an
      // AbortError from the operation itself must fail fast instead of
      // burning retries on an outcome the caller explicitly cancelled.
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Retry aborted by signal', 'AbortError');
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      if (attempt === maxAttempts) break;

      // Unified status extraction: covers `status` (Octokit/Response),
      // `statusCode` (Node http/axios), `response.status` wrappers, and
      // `cause` chains. Statusless values surface as 0 and are governed by
      // `retryUnknownStatus`.
      const status = getErrorStatus(err) ?? 0;

      if (status === 0 && !retryUnknownStatus) {
        if (!shouldRetryAnyway?.(err, status)) throw err;
      } else if (status !== 0 && !isRetryable(status, retryableStatuses)) {
        if (!shouldRetryAnyway?.(err, status)) throw err;
      }

      const backoffDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const retryAfterMs = extractRetryAfterMs(err, maxRetryAfterMs);
      const delay = Math.max(backoffDelay, retryAfterMs);
      const jitter = Math.random() * 0.3 * backoffDelay;
      const totalDelay = Math.min(delay + jitter, Math.max(maxDelayMs, maxRetryAfterMs));
      const hint = retryAfterMs > 0 ? ' (Retry-After hint honored)' : '';
      core.warning(
        `${opName}Retryable error (attempt ${attempt}/${maxAttempts}): ${sanitizeString(err instanceof Error ? err.message : String(err))}. Retrying in ${Math.round(totalDelay / 1000)}s${hint}...`,
      );
      invokeOnRetry(onRetry, opName, {
        attempt,
        maxRetries: maxAttempts,
        status,
        delayMs: Math.round(totalDelay),
        error: err,
      });
      await sleep(totalDelay, signal);
    }
  }

  // Unreachable while `maxAttempts >= 1` guarantees the loop body ran at
  // least once. Kept as a hard backstop: a thrown `undefined` is
  // indistinguishable from a caller bug, and "the operation never ran" must
  // never be expressible as a silent skip.
  throw lastError ?? new Error('withRetry failed without recording an error');
}

/**
 * Extract a Retry-After wait hint (in milliseconds) from a thrown error.
 * Precedence: explicit `retryAfterSeconds` property, then the `retry-after`
 * response header on `error.headers` (numeric seconds or an HTTP-date).
 *
 * @param err - The thrown value, which may carry `retryAfterSeconds` or `headers`.
 * @param maxRetryAfterMs - Upper clamp for the returned hint.
 * @returns A delay in milliseconds, or 0 when no hint is present.
 */
function extractRetryAfterMs(err: unknown, maxRetryAfterMs: number): number {
  if (typeof err !== 'object' || err === null) {
    return 0;
  }
  const candidate = err as { retryAfterSeconds?: unknown; headers?: unknown };

  const fromProperty = toRetrySeconds(candidate.retryAfterSeconds);
  if (fromProperty !== null) {
    return Math.min(fromProperty * 1000, maxRetryAfterMs);
  }

  const rawHeader = getRetryAfterHeader(candidate.headers);
  if (rawHeader !== null) {
    const fromHeader = parseRetryAfterHeader(rawHeader);
    if (fromHeader !== null) {
      return Math.min(fromHeader * 1000, maxRetryAfterMs);
    }
  }

  return 0;
}

/**
 * Coerce a `retryAfterSeconds` value into a positive number of seconds.
 *
 * @param value - The candidate value (number or numeric string).
 * @returns Seconds as a number, or null when the value is not usable.
 */
function toRetrySeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

/**
 * Read the `retry-after` header from a Headers instance or a plain record.
 *
 * @param headers - The headers attached to the thrown error, if any.
 * @returns The raw header value, or null when absent.
 */
function getRetryAfterHeader(headers: unknown): string | null {
  if (!headers) {
    return null;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('retry-after');
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const value = record['retry-after'] ?? record['Retry-After'] ?? record['Retry-after'];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * Parse a Retry-After header value into a number of seconds.
 * Supports both delta-seconds ("60") and HTTP-date formats.
 *
 * @param value - The raw Retry-After header value.
 * @returns Seconds until retry, or null when the value cannot be parsed.
 */
function parseRetryAfterHeader(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

/**
 * Retry an async function with a per-attempt timeout.
 * Wraps `withRetry` and creates a new AbortController for each attempt
 * that fires after `timeoutMs` milliseconds. When `options.signal` is
 * provided, the per-attempt signal is combined with the outer signal via
 * `AbortSignal.any()` (with a manual fallback for runtimes without it),
 * so an outer cancellation aborts the in-flight attempt immediately
 * instead of only being checked between retries. The combined signal's
 * `reason` preserves which source fired first, letting callers distinguish
 * a deadline (`TimeoutError`) from a deliberate cancel (`AbortError`).
 *
 * @param fn - Async function that receives an AbortSignal for the per-attempt timeout.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @param options - Standard retry options forwarded to `withRetry` (including `signal`).
 * @returns The result of the function on success.
 * @throws The last error encountered once all retries are exhausted, or a TimeoutError (DOMException).
 */
export async function withRetryAndTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: RetryOptions = {},
): Promise<T> {
  const outerSignal = options.signal;
  if (outerSignal?.aborted) {
    throw outerSignal.reason instanceof Error
      ? outerSignal.reason
      : new DOMException('Retry aborted by signal', 'AbortError');
  }
  return withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException('Operation timed out', 'TimeoutError')),
      timeoutMs,
    );
    try {
      const attemptSignal = combineSignals(outerSignal, controller.signal);
      return await fn(attemptSignal);
    } finally {
      clearTimeout(timeoutId);
    }
  }, options);
}

/**
 * Combine an optional outer AbortSignal with a per-attempt timeout signal.
 * Prefers `AbortSignal.any()` (Node 20.3+); falls back to manual event
 * wiring on runtimes without it.
 *
 * @param outer - The caller-provided cancellation signal, if any.
 * @param timeoutSignal - The per-attempt timeout signal.
 * @returns A signal that aborts when either input aborts.
 */
export function combineSignals(
  outer: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  if (!outer) {
    return timeoutSignal;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outer, timeoutSignal]);
  }
  const controller = new AbortController();
  const forward = (source: AbortSignal): void => {
    if (source.aborted) {
      controller.abort(source.reason);
      return;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  };
  forward(outer);
  forward(timeoutSignal);
  return controller.signal;
}
