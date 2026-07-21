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
 * Retries on HTTP statuses in retryableStatuses (default: 429, 500, 502, 503, 504).
 * Unknown/unstatused errors (status 0) are retried only when retryUnknownStatus is true.
 * Supports cancellation via AbortSignal.
 *
 * Backoff strategy: baseDelayMs * 2^(attempt-1) capped at maxDelayMs, plus 0-30% jitter.
 * @param fn - Async function to execute and potentially retry.
 * @param options.maxRetries - Total attempts including the first (default 3).
 * @param options.baseDelayMs - Initial delay in ms (default 1000).
 * @param options.maxDelayMs - Maximum delay in ms (default 30000).
 * @param options.retryableStatuses - HTTP status codes that trigger a retry.
 * @param options.signal - Optional AbortSignal to cancel the retry loop.
 * @param options.operationName - Optional name for log messages.
 * @param options.retryUnknownStatus - Whether to retry errors without a status code (default true).
 * @returns The result of fn.
 * @throws The last error encountered if all retries are exhausted, or AbortError if cancelled.
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
 * Execute an async function with a per-attempt timeout and retry support.
 * Each attempt gets its own AbortSignal that is aborted after timeoutMs.
 * Useful for network calls where individual requests can hang.
 * @param fn - Async function accepting an AbortSignal for per-attempt cancellation.
 * @param timeoutMs - Timeout in milliseconds for each individual attempt.
 * @param options - Standard RetryOptions (see withRetry).
 * @returns The result of fn.
 * @throws The last error if all retries are exhausted, or AbortError on timeout/cancellation.
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
