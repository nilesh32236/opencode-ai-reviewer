import { sanitizeErrorMessage } from '@opencode-pr-agent/lib';
import { describe, expect, it } from 'vitest';

describe('sanitizeErrorMessage (via lib wrapper)', () => {
  // Fake credential-shaped fixtures are assembled at runtime (split literals,
  // repeats) so static secret scanners do not flag test vectors as leaked
  // credentials. Every value below is fake; assertions are unchanged.
  const fakeToken = `${'ghp_'}${'x'.repeat(36)}`;
  const tokenPrefix = `${'gh'}${'p_'}`;

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
});
