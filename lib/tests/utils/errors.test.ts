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
    expect(getErrorStatus({ statusCode: '500' })).toBeUndefined();
    expect(getErrorStatus({ status: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('reads statusCode from Node http / axios-style errors', () => {
    expect(getErrorStatus({ statusCode: 503 })).toBe(503);
    expect(getErrorStatus(Object.assign(new Error('boom'), { statusCode: 400 }))).toBe(400);
  });

  it('prefers status over statusCode when both are present', () => {
    expect(getErrorStatus({ status: 400, statusCode: 500 })).toBe(400);
  });

  it('reads nested response.status from axios-style wrappers', () => {
    expect(getErrorStatus({ response: { status: 422 } })).toBe(422);
    expect(getErrorStatus({ response: { statusCode: 502 } })).toBe(502);
    expect(getErrorStatus({ response: null })).toBeUndefined();
    expect(getErrorStatus({ response: 'oops' })).toBeUndefined();
  });

  it('reads the status from fetch Response instances', () => {
    expect(getErrorStatus(new Response(null, { status: 503 }))).toBe(503);
    expect(getErrorStatus(new Response(null, { status: 404 }))).toBe(404);
  });

  it('walks the cause chain for wrapped errors', () => {
    const wrapped = new Error('outer', { cause: { status: 503 } });
    expect(getErrorStatus(wrapped)).toBe(503);
    const nested = new Error('outer', {
      cause: new Error('inner', { cause: { statusCode: 429 } }),
    });
    expect(getErrorStatus(nested)).toBe(429);
  });

  it('terminates on cyclic causes instead of looping', () => {
    const err = { status: undefined } as { status?: number; cause?: unknown };
    err.cause = err;
    expect(getErrorStatus(err)).toBeUndefined();
  });

  it('never throws on hostile inputs, including throwing getters', () => {
    const hostile = {
      get status(): number {
        throw new Error('getter boom');
      },
    };
    // Every property read is guarded, so even a throwing getter yields
    // undefined instead of masking the original error.
    expect(getErrorStatus(hostile)).toBeUndefined();
    expect(getErrorStatus({ response: hostile })).toBeUndefined();
  });
});
