import { describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import {
  applyReviewLabels,
  collectReviewLabels,
  estimateReviewLabelMinutes,
  mapMinutesToLabel,
  mapRiskLevelToLabel,
} from '../src/utils/review-labels.js';

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'summary',
    verdict: { ready: true, reasoning: 'ok', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    ...overrides,
  } as ReviewResult;
}

describe('mapRiskLevelToLabel', () => {
  it('maps known risk levels to risk:* labels', () => {
    expect(mapRiskLevelToLabel('low')).toBe('risk:low');
    expect(mapRiskLevelToLabel('medium')).toBe('risk:medium');
    expect(mapRiskLevelToLabel('high')).toBe('risk:high');
  });

  it('returns null when the risk level is absent or invalid', () => {
    expect(mapRiskLevelToLabel(undefined)).toBeNull();
    expect(mapRiskLevelToLabel(null)).toBeNull();
    expect(mapRiskLevelToLabel('critical')).toBeNull();
    expect(mapRiskLevelToLabel('')).toBeNull();
  });

  it('normalizes case and surrounding whitespace (LLM output varies)', () => {
    expect(mapRiskLevelToLabel(' High ')).toBe('risk:high');
    expect(mapRiskLevelToLabel('MEDIUM')).toBe('risk:medium');
    expect(mapRiskLevelToLabel('\tlow\n')).toBe('risk:low');
  });
});

describe('estimateReviewLabelMinutes', () => {
  it('estimates a small PR under 15 minutes', () => {
    const files = [
      { path: 'a.ts', status: 'modified', additions: 50, deletions: 10 },
      { path: 'b.ts', status: 'added', additions: 40, deletions: 0 },
    ] as never;
    expect(estimateReviewLabelMinutes(files, { critical: 0, important: 0 })).toBeLessThan(15);
  });

  it('weights critical and important findings', () => {
    const files = [{ path: 'a.ts', status: 'modified', additions: 10, deletions: 0 }] as never;
    const clean = estimateReviewLabelMinutes(files, { critical: 0, important: 0 });
    const risky = estimateReviewLabelMinutes(files, { critical: 2, important: 3 });
    expect(risky).toBeGreaterThan(clean);
  });

  it('degrades gracefully for absent input', () => {
    expect(estimateReviewLabelMinutes(undefined, undefined)).toBe(1);
    expect(estimateReviewLabelMinutes(null, null)).toBe(1);
    expect(estimateReviewLabelMinutes([], { critical: 0, important: 0 })).toBe(1);
  });
});

describe('mapMinutesToLabel', () => {
  it('buckets minutes into review-time labels', () => {
    expect(mapMinutesToLabel(1)).toBe('review-time:<15m');
    expect(mapMinutesToLabel(14)).toBe('review-time:<15m');
    expect(mapMinutesToLabel(15)).toBe('review-time:15-60m');
    expect(mapMinutesToLabel(60)).toBe('review-time:15-60m');
    expect(mapMinutesToLabel(61)).toBe('review-time:>60m');
  });

  it('returns null for invalid input', () => {
    expect(mapMinutesToLabel(undefined)).toBeNull();
    expect(mapMinutesToLabel(null)).toBeNull();
    expect(mapMinutesToLabel(Number.NaN)).toBeNull();
    expect(mapMinutesToLabel(-1)).toBeNull();
  });
});

describe('collectReviewLabels', () => {
  const pr = {
    changedFiles: [{ path: 'a.ts', status: 'modified', additions: 20, deletions: 5 }],
  } as never;

  it('returns no labels when both flags are off', () => {
    const result = makeResult({
      executiveSummary: {
        purpose: 'p',
        riskLevel: 'high',
        riskRationale: 'r',
        breakingChanges: [],
      },
    });
    expect(
      collectReviewLabels(pr, result, { applyRiskLabels: false, applyReviewTimeLabels: false }),
    ).toEqual([]);
  });

  it('applies the matching risk label when risk scoring is enabled', () => {
    const result = makeResult({
      executiveSummary: {
        purpose: 'p',
        riskLevel: 'high',
        riskRationale: 'r',
        breakingChanges: [],
      },
    });
    expect(collectReviewLabels(pr, result, { applyRiskLabels: true })).toEqual(['risk:high']);
  });

  it('skips the risk label when the executive summary is absent', () => {
    const result = makeResult();
    expect(collectReviewLabels(pr, result, { applyRiskLabels: true })).toEqual([]);
  });

  it('applies the matching time label when review-time is enabled', () => {
    const result = makeResult();
    expect(collectReviewLabels(pr, result, { applyReviewTimeLabels: true })).toEqual([
      'review-time:<15m',
    ]);
  });

  it('skips labels for skipped reviews', () => {
    const result = makeResult({ skipped: true });
    expect(
      collectReviewLabels(pr, result, { applyRiskLabels: true, applyReviewTimeLabels: true }),
    ).toEqual([]);
  });
});

describe('applyReviewLabels', () => {
  const pr = {
    changedFiles: [{ path: 'a.ts', status: 'modified', additions: 20, deletions: 5 }],
  } as never;

  it('calls ensureLabels + addLabels with the computed labels', async () => {
    const adapter = { ensureLabels: vi.fn().mockResolvedValue(undefined), addLabels: vi.fn() };
    adapter.addLabels.mockResolvedValue(undefined);
    const result = makeResult({
      executiveSummary: {
        purpose: 'p',
        riskLevel: 'medium',
        riskRationale: 'r',
        breakingChanges: [],
      },
    });
    await applyReviewLabels(adapter, 42, pr, result, {
      applyRiskLabels: true,
      applyReviewTimeLabels: true,
    });
    expect(adapter.ensureLabels).toHaveBeenCalledWith(['risk:medium', 'review-time:<15m']);
    expect(adapter.addLabels).toHaveBeenCalledWith(42, ['risk:medium', 'review-time:<15m']);
  });

  it('makes no API calls when both flags are off', async () => {
    const adapter = { ensureLabels: vi.fn(), addLabels: vi.fn() };
    await applyReviewLabels(adapter, 42, pr, makeResult(), {});
    expect(adapter.ensureLabels).not.toHaveBeenCalled();
    expect(adapter.addLabels).not.toHaveBeenCalled();
  });

  it('fails open when the label API rejects (review still posts)', async () => {
    const adapter = {
      ensureLabels: vi.fn().mockRejectedValue(new Error('403 Forbidden')),
      addLabels: vi.fn(),
    };
    const result = makeResult({
      executiveSummary: {
        purpose: 'p',
        riskLevel: 'low',
        riskRationale: 'r',
        breakingChanges: [],
      },
    });
    await expect(
      applyReviewLabels(adapter, 42, pr, result, { applyRiskLabels: true }),
    ).resolves.toBeUndefined();
  });

  it('removes stale same-family labels via setLabels when available', async () => {
    const adapter = {
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn(),
      setLabels: vi.fn().mockResolvedValue(undefined),
    };
    const result = makeResult({
      executiveSummary: {
        purpose: 'p',
        riskLevel: 'high',
        riskRationale: 'r',
        breakingChanges: [],
      },
    });
    await applyReviewLabels(adapter, 42, pr, result, {
      applyRiskLabels: true,
      applyReviewTimeLabels: true,
    });
    // New labels applied; superseded family members removed; the disabled
    // family would be left alone (both flags on here, so both cleaned).
    expect(adapter.setLabels).toHaveBeenCalledWith(
      42,
      ['risk:high', 'review-time:<15m'],
      expect.arrayContaining(['risk:low', 'risk:medium', 'review-time:15-60m', 'review-time:>60m']),
    );
    expect(adapter.addLabels).not.toHaveBeenCalled();
  });

  it('leaves the disabled family untouched during stale cleanup', async () => {
    const adapter = {
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn(),
      setLabels: vi.fn().mockResolvedValue(undefined),
    };
    const result = makeResult({
      executiveSummary: {
        purpose: 'p',
        riskLevel: 'low',
        riskRationale: 'r',
        breakingChanges: [],
      },
    });
    await applyReviewLabels(adapter, 42, pr, result, { applyRiskLabels: true });
    const [, , removed] = adapter.setLabels.mock.calls[0];
    expect(removed).toEqual(expect.arrayContaining(['risk:medium', 'risk:high']));
    expect(removed.join(' ')).not.toContain('review-time:');
  });
});
