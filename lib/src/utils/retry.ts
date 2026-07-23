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
