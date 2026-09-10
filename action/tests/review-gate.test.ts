import { describe, expect, it } from 'vitest';

import { isHardcodedSecretFinding } from '../src/review.js';

describe('isHardcodedSecretFinding()', () => {
  it('matches a structured critical security finding with the secret prefix', () => {
    expect(
      isHardcodedSecretFinding({
        category: 'security',
        severity: 'critical',
        message: 'Hardcoded secret detected: AWS key in config',
      }),
    ).toBe(true);
  });

  it('matches a legacy prefix-only finding without structured fields', () => {
    expect(isHardcodedSecretFinding({ message: 'Hardcoded password in source' })).toBe(true);
  });

  it('rejects a critical security finding without the secret prefix', () => {
    expect(
      isHardcodedSecretFinding({
        category: 'security',
        severity: 'critical',
        message: 'SQL injection in query builder',
      }),
    ).toBe(false);
  });

  it('rejects non-secret findings regardless of category/severity', () => {
    expect(
      isHardcodedSecretFinding({ category: 'bug', severity: 'minor', message: 'typo in comment' }),
    ).toBe(false);
    expect(
      isHardcodedSecretFinding({
        category: 'security',
        severity: 'important',
        message: 'XSS in template rendering',
      }),
    ).toBe(false);
  });
});
