import * as core from '@actions/core';

export interface RetryOptions {
  /** Total number of attempts (including the first call). E.g. maxRetries: 2 permits 2 total calls and 1 retry. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
  /** Optional AbortSignal to cancel retry loop mid-flight */
  signal?: AbortSignal;
  /** Optional operation name for log messages */
  operationName?: string;
  /** When true (default), retries unknown/statusless errors. Set false to never retry when status is 0. */
  retryUnknownStatus?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'signal'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503, 504],
  operationName: 'unknown',
  retryUnknownStatus: true,
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
 * - Supports cancellation via AbortSignal
 *
 * @param fn - Async function to retry.
 * @param options.maxRetries - Total attempts including the first call (default: 3).
 * @param options.baseDelayMs - Base delay in ms before first retry (default: 1000).
 * @param options.maxDelayMs - Maximum delay cap in ms (default: 30000).
 * @param options.retryableStatuses - HTTP status codes that trigger a retry.
 * @param options.signal - Optional AbortSignal to cancel the retry loop.
 * @param options.operationName - Optional label for log messages.
 * @param options.retryUnknownStatus - Whether to retry on status=0 errors (default: true).
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

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * 0.3 * delay;
      core.warning(
        `${opName}Retryable error (attempt ${attempt}/${maxRetries}): ${err instanceof Error ? err.message : err}. Retrying in ${Math.round((delay + jitter) / 1000)}s...`,
      );
      await sleep(delay + jitter, signal);
    }
  }

  throw lastError;
}

/**
 * Retry an async function with a per-attempt timeout.
 * Wraps `withRetry` and creates a new AbortController for each attempt
 * that fires after `timeoutMs` milliseconds.
 *
 * @param fn - Async function that receives an AbortSignal for the per-attempt timeout.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @param options - Standard retry options forwarded to `withRetry`.
 * @throws The last error encountered once all retries are exhausted, or TimeoutError.
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
