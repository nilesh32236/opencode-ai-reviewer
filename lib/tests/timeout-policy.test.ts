import { describe, expect, it } from 'vitest';
import { ReviewEngine } from '../src/engine.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { MAX_TIMEOUT_MINUTES, validateTimeoutMinutes } from '../src/utils/timeout-policy.js';

describe('timeout policy', () => {
  it('accepts omission and the supported maximum only', () => {
    expect(validateTimeoutMinutes(undefined)).toBeUndefined();
    expect(validateTimeoutMinutes(1)).toBe(1);
    expect(validateTimeoutMinutes(MAX_TIMEOUT_MINUTES)).toBe(MAX_TIMEOUT_MINUTES);
  });

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MINUTES + 1])(
    'rejects invalid programmatic value %s',
    (value) => {
      expect(() => validateTimeoutMinutes(value)).toThrow(/positive integer/);
    },
  );

  it('rejects invalid timeout values at the AgentConfig/ReviewEngine boundary', () => {
    expect(
      () => new ReviewEngine({ ...DEFAULT_CONFIG, timeoutMinutes: Number.NaN }, {} as never),
    ).toThrow(/positive integer/);
  });
});
