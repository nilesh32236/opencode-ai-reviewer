import * as core from '@actions/core';

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
   * Maximum delay in ms to honor a server-provided Retry-After hint.
   * Hints larger than this are clamped. Default: 120000 (2 minutes).
   */
  maxRetryAfterMs?: number;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'signal'>> = {
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
 * Retry an async function with exponential backoff and jitter.
 *
 * The retry strategy:
 * - Delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs) + random 0-30% jitter
 * - Only retries on status codes in `retryableStatuses` (default: 429, 500, 502, 503, 504)
 * - For status=0 (network/unknown errors), retry is controlled by `retryUnknownStatus`
 * - Honors a server-provided Retry-After hint (via `retryAfterSeconds` or the
 *   `retry-after` response header on the error) by waiting at least that long,
 *   clamped to `maxRetryAfterMs`
 * - Supports cancellation via AbortSignal
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
  } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const signal = options.signal;
  const opName = operationName ? `[${operationName}] ` : '';

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Retry aborted by signal', 'AbortError');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;

      const status =
        err instanceof Error && 'status' in err ? (err as Error & { status: number }).status : 0;

      if (status === 0 && !retryUnknownStatus) {
        throw err;
      }
      if (status !== 0 && !isRetryable(status, retryableStatuses)) {
        throw err;
      }

      const backoffDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const retryAfterMs = extractRetryAfterMs(err, maxRetryAfterMs);
      const delay = Math.max(backoffDelay, retryAfterMs);
      const jitter = Math.random() * 0.3 * backoffDelay;
      const totalDelay = Math.min(delay + jitter, Math.max(maxDelayMs, maxRetryAfterMs));
      const hint = retryAfterMs > 0 ? ' (Retry-After hint honored)' : '';
      core.warning(
        `${opName}Retryable error (attempt ${attempt}/${maxRetries}): ${err instanceof Error ? err.message : err}. Retrying in ${Math.round(totalDelay / 1000)}s${hint}...`,
      );
      await sleep(totalDelay, signal);
    }
  }

  throw lastError;
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
 * that fires after `timeoutMs` milliseconds.
 *
 * @param fn - Async function that receives an AbortSignal for the per-attempt timeout.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @param options - Standard retry options forwarded to `withRetry`.
 * @returns The result of the function on success.
 * @throws The last error encountered once all retries are exhausted, or a TimeoutError (DOMException).
 */
export async function withRetryAndTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: RetryOptions = {},
): Promise<T> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  }, options);
}
