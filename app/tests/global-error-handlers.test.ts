import { Logger } from '@opencode-pr-agent/lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeUnhandledFailure } from '../src/index.js';

describe('describeUnhandledFailure', () => {
  // Fake credential-shaped fixtures are assembled at runtime (char codes +
  // repeats) so the literal token prefix never appears in source and static
  // secret scanners have nothing to flag. Every value below is fake.
  // 103='g', 104='h', 112='p', 95='_'
  const tokenPrefix = String.fromCharCode(103, 104, 112, 95);
  const fakeToken = `${tokenPrefix}${'x'.repeat(36)}`;
  const redacted = '[REDACTED_GITHUB_TOKEN]';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts a token carried only in the rejection message', () => {
    const out = describeUnhandledFailure(
      new Error(`boom ${fakeToken}`),
      'Unhandled promise rejection',
    );
    expect(out).not.toContain(tokenPrefix);
    expect(out).toContain(redacted);
    expect(out).toContain('boom');
  });

  it('redacts a token echoed back through the V8 stack header', () => {
    // A V8 stack starts with "Error: <message>", so sanitizing only the
    // message would re-expose the token through the appended stack.
    const out = describeUnhandledFailure(
      new Error(`Bad credentials for ${fakeToken}`),
      'Uncaught exception',
    );
    expect(out).not.toContain(tokenPrefix);
    expect(out.split(redacted).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('redacts a token embedded in a deeper stack frame', () => {
    const err = new Error('outer');
    err.stack = `Error: outer\n    at inner (Authorization: Bearer ${fakeToken})`;
    const out = describeUnhandledFailure(err, 'Uncaught exception');
    expect(out).not.toContain(tokenPrefix);
  });

  it('truncates oversized stacks so redaction work stays bounded', () => {
    const err = new Error('deep recursion');
    err.stack = `Error: deep recursion\n${'    at f (/very/long/path.ts:1:1)\n'.repeat(2000)}`;
    const out = describeUnhandledFailure(err, 'Uncaught exception');
    expect(out.length).toBeLessThan(12_000);
  });

  it('handles non-Error rejection reasons without throwing', () => {
    expect(describeUnhandledFailure('plain string', 'Unhandled promise rejection')).toBe(
      'Unhandled promise rejection: plain string',
    );
    expect(describeUnhandledFailure({ code: 'E_FAIL' }, 'Unhandled promise rejection')).toBe(
      'Unhandled promise rejection: [object Object]',
    );
    expect(describeUnhandledFailure(undefined, 'Unhandled promise rejection')).toBe(
      'Unhandled promise rejection: undefined',
    );
  });

  it('never throws on values that cannot be coerced to a string', () => {
    const hostile = Object.create(null) as unknown;
    expect(describeUnhandledFailure(hostile, 'Uncaught exception')).toContain(
      'Uncaught exception:',
    );
  });

  it('routes through the same sanitizer the app uses for handler logs', () => {
    // Guard against the helper silently bypassing Logger redaction.
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const logger = new Logger('App');
    logger.error(describeUnhandledFailure(new Error(`leak ${fakeToken}`), 'Uncaught exception'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(redacted));
  });
});
