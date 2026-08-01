import { describe, expect, it } from 'vitest';
import type { ReviewIssue, Severity } from '../src/types/index.js';
import {
  computeReviewStats,
  confidenceThresholdRank,
  filterFindings,
  minSeverityRank,
  severityRank,
} from '../src/utils/filter-findings.js';

function issue(partial: Partial<ReviewIssue> & { severity: Severity }): ReviewIssue {
  return {
    type: 'issue',
    file: 'src/foo.ts',
    line: 1,
    message: 'Finding message',
    ...partial,
  };
}

describe('severity ranking helpers', () => {
  it('maps minSeverity floors to the existing severity scale', () => {
    expect(minSeverityRank('warning')).toBe(1);
    expect(minSeverityRank('error')).toBe(2);
    expect(minSeverityRank('critical')).toBe(3);
    expect(minSeverityRank(undefined)).toBe(1);
  });

  it('ranks existing severities', () => {
    expect(severityRank('minor')).toBe(1);
    expect(severityRank('important')).toBe(2);
    expect(severityRank('critical')).toBe(3);
  });

  it('maps confidenceThreshold floors', () => {
    expect(confidenceThresholdRank('low')).toBe(1);
    expect(confidenceThresholdRank('medium')).toBe(2);
    expect(confidenceThresholdRank('high')).toBe(3);
    expect(confidenceThresholdRank(undefined)).toBe(1);
  });
});

describe('filterFindings', () => {
  it('drops findings below the minSeverity floor', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts' }),
      issue({ severity: 'important', file: 'b.ts' }),
      issue({ severity: 'minor', file: 'c.ts' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, { minSeverity: 'error' });
    expect(dropped).toBe(1);
    expect(kept.map((i) => i.severity)).toEqual(['critical', 'important']);
  });

  it('minSeverity warning keeps everything', () => {
    const issues = [
      issue({ severity: 'important', file: 'a.ts' }),
      issue({ severity: 'minor', file: 'b.ts' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, { minSeverity: 'warning' });
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it('caps total findings keeping the highest severity', () => {
    const issues = [
      issue({ severity: 'minor', file: 'a.ts' }),
      issue({ severity: 'critical', file: 'b.ts' }),
      issue({ severity: 'important', file: 'c.ts' }),
      issue({ severity: 'minor', file: 'd.ts' }),
    ];
    const { issues: kept } = filterFindings(issues, { maxTotalFindings: 2 });
    expect(kept).toHaveLength(2);
    expect(kept.map((i) => i.severity)).toEqual(['critical', 'important']);
  });

  it('caps findings per category', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', category: 'security' }),
      issue({ severity: 'important', file: 'b.ts', category: 'security' }),
      issue({ severity: 'minor', file: 'c.ts', category: 'security' }),
      issue({ severity: 'critical', file: 'd.ts', category: 'performance' }),
      issue({ severity: 'important', file: 'e.ts', category: 'performance' }),
    ];
    const { issues: kept } = filterFindings(issues, { maxFindingsPerCategory: 2 });
    expect(kept).toHaveLength(4);
    const security = kept.filter((i) => i.category === 'security');
    const performance = kept.filter((i) => i.category === 'performance');
    expect(security.map((i) => i.severity)).toEqual(['critical', 'important']);
    expect(performance.map((i) => i.severity)).toEqual(['critical', 'important']);
  });

  it('filters issues whose file matches an ignore pattern', () => {
    const issues = [
      issue({ severity: 'critical', file: 'src/foo.test.ts' }),
      issue({ severity: 'critical', file: 'src/foo.ts' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, {
      ignorePatterns: ['**/*.test.ts'],
    });
    expect(dropped).toBe(1);
    expect(kept.map((i) => i.file)).toEqual(['src/foo.ts']);
  });

  it('keeps only findings in focus areas', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', category: 'security' }),
      issue({ severity: 'critical', file: 'b.ts', category: 'performance' }),
      issue({ severity: 'critical', file: 'c.ts', category: 'style' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, {
      focusAreas: ['security', 'performance'],
    });
    expect(dropped).toBe(1);
    expect(kept.map((i) => i.category)).toEqual(['security', 'performance']);
  });

  it('applies per-category minSeverity overrides above the global floor', () => {
    const issues = [
      issue({ severity: 'important', file: 'a.ts', category: 'security' }),
      issue({ severity: 'critical', file: 'b.ts', category: 'security' }),
      issue({ severity: 'important', file: 'c.ts', category: 'performance' }),
    ];
    const { issues: kept } = filterFindings(issues, {
      minSeverity: 'warning',
      categories: { security: { minSeverity: 'critical' } },
    });
    expect(kept.map((i) => i.file)).toEqual(['b.ts', 'c.ts']);
  });

  it('disables a category when enabled is false', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', category: 'security' }),
      issue({ severity: 'critical', file: 'b.ts', category: 'style' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, {
      categories: { style: { enabled: false } },
    });
    expect(dropped).toBe(1);
    expect(kept.map((i) => i.category)).toEqual(['security']);
  });

  it('honors per-category maxFindings over the global cap', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', category: 'security' }),
      issue({ severity: 'important', file: 'b.ts', category: 'security' }),
      issue({ severity: 'minor', file: 'c.ts', category: 'security' }),
    ];
    const { issues: kept } = filterFindings(issues, {
      maxFindingsPerCategory: 1,
      categories: { security: { maxFindings: 2 } },
    });
    expect(kept).toHaveLength(2);
    expect(kept.map((i) => i.severity)).toEqual(['critical', 'important']);
  });

  it('drops low-confidence findings above the confidence floor', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', confidence: 'high' }),
      issue({ severity: 'critical', file: 'b.ts', confidence: 'medium' }),
      issue({ severity: 'critical', file: 'c.ts', confidence: 'low' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, { confidenceThreshold: 'medium' });
    expect(dropped).toBe(1);
    expect(kept.map((i) => i.confidence)).toEqual(['high', 'medium']);
  });

  it('assigns the default category to uncategorized findings', () => {
    const issues = [issue({ severity: 'critical', file: 'a.ts' })];
    const { issues: kept } = filterFindings(issues, { defaultCategory: 'security' });
    expect(kept[0].category).toBe('security');
  });

  it('uses general as the default category when not provided', () => {
    const issues = [issue({ severity: 'critical', file: 'a.ts' })];
    const { issues: kept } = filterFindings(issues, {});
    expect(kept[0].category).toBe('general');
  });

  it('returns empty result when no issues provided', () => {
    const result = filterFindings([], { minSeverity: 'critical' });
    expect(result.issues).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it('combines an extra severity rank floor with minSeverity (audit threshold)', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts' }),
      issue({ severity: 'important', file: 'b.ts' }),
      issue({ severity: 'minor', file: 'c.ts' }),
    ];
    const { issues: kept, dropped } = filterFindings(issues, {
      minSeverity: 'warning',
      minSeverityRankValue: severityRank('important'),
    });
    expect(dropped).toBe(1);
    expect(kept.map((i) => i.severity)).toEqual(['critical', 'important']);
  });
});

describe('computeReviewStats', () => {
  it('recomputes severity and confidence counts', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', confidence: 'high' }),
      issue({ severity: 'critical', file: 'b.ts', confidence: 'low' }),
      issue({ severity: 'important', file: 'c.ts' }),
      issue({ severity: 'minor', file: 'd.ts', confidence: 'medium' }),
    ];
    expect(computeReviewStats(issues)).toEqual({
      total: 4,
      critical: 2,
      important: 1,
      minor: 1,
      highConfidence: 1,
      mediumConfidence: 1,
      lowConfidence: 1,
    });
  });

  it('omits zero confidence counts', () => {
    const issues = [issue({ severity: 'critical', file: 'a.ts' })];
    expect(computeReviewStats(issues)).toEqual({
      total: 1,
      critical: 1,
      important: 0,
      minor: 0,
    });
  });
});
