import { sanitizeErrorMessage } from '@opencode-pr-agent/lib';
import { describe, expect, it } from 'vitest';

describe('sanitizeErrorMessage (via lib wrapper)', () => {
  it('redacts tokens from error messages', () => {
    const err = new Error('Auth failed for token ghp_123456789012345678901234567890123456');
    const sanitized = sanitizeErrorMessage(err);
    expect(sanitized).toBe('Auth failed for token [REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain('ghp_');
  });

  it('redacts tokens from raw strings', () => {
    const raw = 'Auth failed for token ghp_123456789012345678901234567890123456';
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).toBe('Auth failed for token [REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain('ghp_');
  });
});
