import { describe, expect, it } from 'vitest';
import { countAtOrAboveSeverity, shouldFailOnSeverity } from '../src/utils/threshold.js';

const CLEAN = { critical: 0, important: 0, minor: 0 };
const MIXED = { critical: 1, important: 2, minor: 3 };

describe('countAtOrAboveSeverity', () => {
  it('counts only criticals at the critical threshold', () => {
    expect(countAtOrAboveSeverity(MIXED, 'critical')).toBe(1);
  });

  it('counts criticals and importants at the important threshold', () => {
    expect(countAtOrAboveSeverity(MIXED, 'important')).toBe(3);
  });

  it('counts all findings at the minor threshold', () => {
    expect(countAtOrAboveSeverity(MIXED, 'minor')).toBe(6);
  });
});

describe('shouldFailOnSeverity', () => {
  it('never fails for off regardless of findings', () => {
    expect(shouldFailOnSeverity(MIXED, 'off')).toBe(false);
  });

  it('fails when critical findings exist at the critical threshold', () => {
    expect(shouldFailOnSeverity(MIXED, 'critical')).toBe(true);
  });

  it('passes when no finding reaches the threshold', () => {
    expect(shouldFailOnSeverity(CLEAN, 'critical')).toBe(false);
    expect(shouldFailOnSeverity({ critical: 0, important: 1, minor: 2 }, 'critical')).toBe(false);
  });

  it('fails on important+critical for the important threshold', () => {
    expect(shouldFailOnSeverity({ critical: 0, important: 1, minor: 5 }, 'important')).toBe(true);
  });

  it('fails on any finding for the minor threshold', () => {
    expect(shouldFailOnSeverity({ critical: 0, important: 0, minor: 1 }, 'minor')).toBe(true);
  });
});
