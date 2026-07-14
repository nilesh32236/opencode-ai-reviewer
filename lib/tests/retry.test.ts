import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/utils/retry.js';

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
    const fn = vi
      .fn()
      .mockRejectedValueOnce(response)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error throw values', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce('string error')
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
