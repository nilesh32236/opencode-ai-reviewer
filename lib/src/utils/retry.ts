import * as core from '@actions/core';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number, retryableStatuses: number[]): boolean {
  return retryableStatuses.includes(status);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, retryableStatuses } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;

      const status =
        err instanceof Error && 'status' in err
          ? (err as Error & { status: number }).status
          : err instanceof Response
            ? err.status
            : 0;

      if (status && !isRetryable(status, retryableStatuses)) {
        throw err;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = Math.random() * 0.3 * delay;
      core.warning(
        `Retryable error (attempt ${attempt}/${maxRetries}): ${err instanceof Error ? err.message : err}. Retrying in ${Math.round((delay + jitter) / 1000)}s...`,
      );
      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

export async function withRetryAndTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  options: RetryOptions = {},
): Promise<T> {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fn();
      } finally {
        clearTimeout(timeoutId);
      }
    },
    options,
  );
}
