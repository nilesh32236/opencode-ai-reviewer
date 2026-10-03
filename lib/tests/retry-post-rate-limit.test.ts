/**
 * L-054, half two: why the review POST failed in the first place.
 *
 * `POST /pulls/{n}/reviews` is non-idempotent, so `GitHubHelper.api()` retries
 * it on 429 only. GitHub also throttles with HTTP 403 + `retry-after` /
 * `x-ratelimit-remaining: 0`, and that rejection was thrown on the first
 * attempt — turning a transient throttle into a lost verdict. These tests pin
 * the distinction that makes the retry safe: a rate-limit rejection is provably
 * not applied (replay cannot duplicate), a permission 403 is not.
 */
import { describe, expect, it, vi } from 'vitest';

import { isRateLimitedError, withRetry } from '../src/utils/retry.js';

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeApiError(res: FakeResponse): Error {
  const err = new Error(`GitHub API ${res.status}: ${res.body}`) as Error & {
    status: number;
    headers: Headers;
  };
  err.status = res.status;
  err.headers = new Headers(res.headers);
  return err;
}

describe('isRateLimitedError()', () => {
  it('detects a secondary-rate-limit 403 carrying retry-after', () => {
    expect(
      isRateLimitedError(
        makeApiError({
          status: 403,
          headers: { 'retry-after': '30' },
          body: 'You have exceeded a secondary rate limit.',
        }),
      ),
    ).toBe(true);
  });

  it('detects an exhausted primary rate-limit budget on 403', () => {
    expect(
      isRateLimitedError(
        makeApiError({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: 'nope' }),
      ),
    ).toBe(true);
  });

  it('treats 429 as a throttle even without headers', () => {
    expect(isRateLimitedError(makeApiError({ status: 429, headers: {}, body: 'slow down' }))).toBe(
      true,
    );
  });

  it('does NOT treat a permission 403 as a throttle', () => {
    expect(
      isRateLimitedError(
        makeApiError({
          status: 403,
          headers: { 'x-ratelimit-remaining': '4999' },
          body: 'Resource not accessible by integration',
        }),
      ),
    ).toBe(false);
  });

  it('does not fire on non-403 statuses', () => {
    expect(isRateLimitedError(makeApiError({ status: 500, headers: {}, body: 'boom' }))).toBe(
      false,
    );
    expect(isRateLimitedError(makeApiError({ status: 422, headers: {}, body: 'bad' }))).toBe(false);
  });

  it('tolerates non-object throws', () => {
    expect(isRateLimitedError('nope')).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
    expect(isRateLimitedError(undefined)).toBe(false);
  });
});

describe('withRetry() shouldRetryAnyway', () => {
  const POST_RETRY_POLICY = {
    // Exactly GitHubHelper.api()'s non-idempotent POST policy.
    retryableStatuses: [429],
    retryUnknownStatus: false,
    maxRetries: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    maxRetryAfterMs: 0,
    shouldRetryAnyway: (err: unknown) => isRateLimitedError(err),
  };

  it('retries a rate-limited POST and succeeds on the second attempt', async () => {
    const throttle = makeApiError({
      status: 403,
      headers: { 'retry-after': '0' },
      body: 'secondary rate limit',
    });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce('review-created');

    await expect(withRetry(fn, POST_RETRY_POLICY)).resolves.toBe('review-created');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a permission 403 on a POST (no duplicate risk taken)', async () => {
    const denied = makeApiError({ status: 403, headers: {}, body: 'not permitted' });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(denied);

    await expect(withRetry(fn, POST_RETRY_POLICY)).rejects.toThrow(/not permitted/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an ambiguous 5xx on a POST (would duplicate)', async () => {
    const boom = makeApiError({ status: 502, headers: {}, body: 'bad gateway' });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(boom);

    await expect(withRetry(fn, POST_RETRY_POLICY)).rejects.toThrow(/bad gateway/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries on a persistently rate-limited POST', async () => {
    const throttle = makeApiError({ status: 403, headers: { 'retry-after': '0' }, body: 'slow' });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(throttle);

    await expect(withRetry(fn, POST_RETRY_POLICY)).rejects.toThrow(/slow/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('still honours the signal: an aborted run is not retried', async () => {
    const controller = new AbortController();
    controller.abort();
    const throttle = makeApiError({ status: 403, headers: { 'retry-after': '0' }, body: 'slow' });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(throttle);

    await expect(
      withRetry(fn, { ...POST_RETRY_POLICY, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
