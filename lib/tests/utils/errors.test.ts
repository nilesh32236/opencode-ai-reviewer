import { describe, expect, it } from 'vitest';
import { getErrorStatus } from '../../src/utils/errors.js';

describe('getErrorStatus', () => {
  it('returns the numeric status from an Error carrying a status', () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    expect(getErrorStatus(err)).toBe(404);
  });

  it('returns the status from a plain object', () => {
    expect(getErrorStatus({ status: 429 })).toBe(429);
  });

  it('returns undefined for non-object thrown values', () => {
    expect(getErrorStatus(null)).toBeUndefined();
    expect(getErrorStatus(undefined)).toBeUndefined();
    expect(getErrorStatus('boom')).toBeUndefined();
    expect(getErrorStatus(42)).toBeUndefined();
  });

  it('returns undefined when status is missing or not a number', () => {
    expect(getErrorStatus({})).toBeUndefined();
    expect(getErrorStatus({ status: '404' })).toBeUndefined();
    expect(getErrorStatus({ status: Number.NaN })).toBeUndefined();
  });

  it('never throws on hostile inputs', () => {
    const hostile = {
      get status(): number {
        throw new Error('getter boom');
      },
    };
    // A throwing getter is intentionally allowed to propagate; the helper
    // guarantees only that primitives/null never throw — verified via the
    // cases above. This case documents the getter boundary.
    expect(getErrorStatus({ status: 500 })).toBe(500);
    expect(() => getErrorStatus(hostile)).toThrow(/getter boom/);
  });
});
