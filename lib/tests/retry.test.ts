import { describe, expect, it, vi } from 'vitest';
import { withRetry, withRetryAndTimeout } from '../src/utils/retry.js';

describe('withRetry', () => {
  it('returns the successful result on first try', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 502 }))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('Always fails'), { status: 500 }));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow('Always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable status codes', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('Bad request'), { status: 400 }));

    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports custom retryable statuses', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Custom error'), { status: 409 }))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 10,
      retryableStatuses: [409],
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles Response-like errors', async () => {
    const response = new Response(null, { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(response).mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error throw values', async () => {
    const fn = vi.fn().mockRejectedValueOnce('string error').mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetryAndTimeout', () => {
  it('rejects when fn exceeds timeout', async () => {
    const fn = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve());
      });
      throw new Error('Operation timed out');
    });

    await expect(withRetryAndTimeout(fn, 50, { maxRetries: 1, baseDelayMs: 10 })).rejects.toThrow(
      'Operation timed out',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resolves when fn completes before timeout', async () => {
    const fn = vi.fn().mockImplementation(async (_signal: AbortSignal) => 'fast');

    const result = await withRetryAndTimeout(fn, 5000, { maxRetries: 1 });
    expect(result).toBe('fast');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and respects timeout', async () => {
    const fn = vi.fn().mockImplementation(async (_signal: AbortSignal) => {
      throw Object.assign(new Error('Server error'), { status: 502 });
    });

    await expect(withRetryAndTimeout(fn, 5000, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow(
      'Server error',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry Retry-After handling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('honors retryAfterSeconds property on the error', async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error('Rate limited'), { status: 429, retryAfterSeconds: 60 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });

    // Not yet retried while inside the 60s hint window.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors retry-after header from a Headers instance', async () => {
    vi.useFakeTimers();
    const headers = new Headers();
    headers.set('Retry-After', '5');
    const err = Object.assign(new Error('Too many requests'), { status: 429, headers });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors retry-after header from a plain object record', async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error('Rate limited'), {
      status: 429,
      headers: { 'retry-after': '8' },
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('parses HTTP-date Retry-After values', async () => {
    vi.useFakeTimers();
    const retryAt = new Date(Date.now() + 3_000).toUTCString();
    const err = Object.assign(new Error('Slow down'), {
      status: 429,
      headers: { 'Retry-After': retryAt },
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clamps Retry-After hints to maxRetryAfterMs', async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error('Rate limited'), {
      status: 429,
      retryAfterSeconds: 10_000,
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 10,
      maxRetryAfterMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_200);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('falls back to exponential backoff when no hint is present', async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error('Server error'), { status: 502 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry signal support', () => {
  it('aborts retry loop when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10, signal: controller.signal }),
    ).rejects.toThrow('aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts mid-retry when signal fires', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('Server error'), { status: 502 });
    });

    await expect(
      withRetry(fn, { maxRetries: 5, baseDelayMs: 10, signal: controller.signal }),
    ).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
