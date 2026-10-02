/**
 * Defect: `withRetry` could report on an operation it never performed.
 *
 * `const { maxRetries } = { ...DEFAULT_OPTIONS, ...options }` lets an
 * explicitly-present `undefined` key clobber the default, so
 * `withRetry(fn, { maxRetries: undefined })` yields `maxRetries === undefined`.
 * `for (let attempt = 1; attempt <= undefined; attempt++)` never enters, `fn`
 * is never invoked, and the post-loop `throw lastError` throws `undefined`
 * with `lastError` never assigned.
 *
 * The caller sees a rejected promise — the same shape as a genuine failure —
 * but the wrapped operation never ran. That is the same failure family as
 * L-054, which started this campaign: a verdict reported for work that was
 * never delivered. It is also worse than a plain bug, because `throw
 * undefined` carries no message, no stack the caller can read, and no
 * indication that the retry budget was the cause.
 *
 * Every current caller passes an object literal, so this is latent rather than
 * live. It becomes live the moment a caller forwards a partially-built
 * options object (`{ ...maybeOpts, maxRetries: opts.retries }` where
 * `opts.retries` is absent), which is the single most common way a
 * RetryOptions gets constructed.
 */
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/utils/retry.js';

describe('withRetry must never skip the operation it wraps', () => {
  it('invokes the operation even when maxRetries is explicitly undefined', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: undefined });
    expect(fn, 'operation was silently skipped').toHaveBeenCalledTimes(1);
    expect(result).toBe('ok');
  });

  it('invokes the operation when maxRetries is 0', async () => {
    // 0 reads as "do not retry", i.e. try once. Under `attempt <= maxRetries`
    // it meant "never try at all".
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 0 });
    expect(fn, 'operation was silently skipped').toHaveBeenCalledTimes(1);
    expect(result).toBe('ok');
  });

  it('invokes the operation when maxRetries is negative', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: -5 });
    expect(fn, 'operation was silently skipped').toHaveBeenCalledTimes(1);
    expect(result).toBe('ok');
  });

  it('invokes the operation when maxRetries is NaN', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: Number.NaN });
    expect(fn, 'operation was silently skipped').toHaveBeenCalledTimes(1);
    expect(result).toBe('ok');
  });

  it('never rejects with undefined when the operation fails', async () => {
    // The failure path with maxRetries: 0 was `throw lastError` where
    // lastError was never assigned, so the caller received `undefined`.
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toBeInstanceOf(Error);
  });

  it('rejects with a real Error carrying the original failure', async () => {
    const original = Object.assign(new Error('rate limited'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(original);
    let caught: unknown;
    try {
      await withRetry(fn, { maxRetries: undefined, baseDelayMs: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('rate limited');
  });

  it('forwards a partially-built options object and still runs the operation', async () => {
    // The realistic shape: a caller assembling options from optional input.
    const fromEnv: { retries?: number } = {};
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, {
      ...(fromEnv.retries !== undefined && { maxRetries: fromEnv.retries }),
      baseDelayMs: 1,
    });
    expect(
      fn,
      'operation was silently skipped by a spread-built options object',
    ).toHaveBeenCalledTimes(1);
    expect(result).toBe('ok');
  });

  it('still honours a real retry budget', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('a'), { status: 500 }))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe('ok');
  });

  it('does not retry more than a sane ceiling when handed a huge value', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await expect(withRetry(fn, { maxRetries: 1_000_000, baseDelayMs: 1 })).rejects.toThrow();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(10);
  });
});
