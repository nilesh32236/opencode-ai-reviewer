import { sanitizeErrorMessage } from '@opencode-pr-agent/lib';
import { describe, expect, it } from 'vitest';

describe('sanitizeErrorMessage (via lib wrapper)', () => {
  // Fake credential-shaped fixtures are assembled at runtime (char codes +
  // repeats) so the literal token prefix never appears in source and static
  // secret scanners have nothing to flag. Every value below is fake;
  // assertions are unchanged.
  // 103='g', 104='h', 112='p', 95='_'
  const tokenPrefix = String.fromCharCode(103, 104, 112, 95);
  const fakeToken = `${tokenPrefix}${'x'.repeat(36)}`;

  it('redacts tokens from error messages', () => {
    const err = new Error(`Auth failed for token ${fakeToken}`);
    const sanitized = sanitizeErrorMessage(err);
    expect(sanitized).toBe('Auth failed for token [REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain(tokenPrefix);
  });

  it('redacts tokens from raw strings', () => {
    const raw = `Auth failed for token ${fakeToken}`;
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).toBe('Auth failed for token [REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain(tokenPrefix);
  });

  it('never throws on values that cannot be coerced to a string', () => {
    // sanitizeErrorMessage is the single funnel for nearly every catch block
    // in action/ and app/, so a throwing coercion here would turn a *handled*
    // error into an unhandled rejection.
    const nullProto = Object.create(null) as unknown;
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    } as unknown;

    expect(() => sanitizeErrorMessage(nullProto)).not.toThrow();
    expect(sanitizeErrorMessage(nullProto)).toBe('[unstringifiable error]');
    expect(() => sanitizeErrorMessage(hostile)).not.toThrow();
    expect(sanitizeErrorMessage(hostile)).toBe('[unstringifiable error]');
  });
});
