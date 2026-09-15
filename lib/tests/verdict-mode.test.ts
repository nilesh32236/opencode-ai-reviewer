import { describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { normalizeVerdictMode, resolveReviewEvent } from '../src/utils/github.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug };
});

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: true, reasoning: 'Looks good.', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    ...overrides,
  };
}

describe('normalizeVerdictMode()', () => {
  it('accepts every valid mode', () => {
    expect(normalizeVerdictMode('comment')).toBe('comment');
    expect(normalizeVerdictMode('approve')).toBe('approve');
    expect(normalizeVerdictMode('request-changes')).toBe('request-changes');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(normalizeVerdictMode(' Approve ')).toBe('approve');
    expect(normalizeVerdictMode('REQUEST-CHANGES')).toBe('request-changes');
  });

  it('falls back to comment for empty/unset/non-string input', () => {
    expect(normalizeVerdictMode('')).toBe('comment');
    expect(normalizeVerdictMode('   ')).toBe('comment');
    expect(normalizeVerdictMode(undefined)).toBe('comment');
    expect(normalizeVerdictMode(null)).toBe('comment');
    expect(normalizeVerdictMode(42)).toBe('comment');
  });
});

describe('resolveReviewEvent()', () => {
  it('always returns COMMENT in comment mode (default)', () => {
    const critical = makeResult({
      verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'high' },
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    });
    expect(resolveReviewEvent(critical, 'comment')).toBe('COMMENT');
    expect(resolveReviewEvent(critical, undefined)).toBe('COMMENT');
    expect(resolveReviewEvent(critical, 'bogus')).toBe('COMMENT');
  });

  it('approves only a clean ready verdict', () => {
    expect(resolveReviewEvent(makeResult(), 'approve')).toBe('APPROVE');
  });

  it('stays COMMENT in approve mode when findings/partial-failures/sentinels block', () => {
    const withCritical = makeResult({ stats: { total: 1, critical: 1, important: 0, minor: 0 } });
    expect(resolveReviewEvent(withCritical, 'approve')).toBe('COMMENT');

    const withImportant = makeResult({ stats: { total: 1, critical: 0, important: 1, minor: 0 } });
    expect(resolveReviewEvent(withImportant, 'approve')).toBe('COMMENT');

    const notReady = makeResult({
      verdict: { ready: false, reasoning: 'Needs work.', autoFixable: false, confidence: 'high' },
    });
    expect(resolveReviewEvent(notReady, 'approve')).toBe('COMMENT');

    const partial = makeResult({ failedBatches: 1 });
    expect(resolveReviewEvent(partial, 'approve')).toBe('COMMENT');

    const sentinel = makeResult({
      verdict: {
        ready: true,
        reasoning: 'All review batches failed',
        autoFixable: false,
        confidence: 'low',
      },
    });
    expect(resolveReviewEvent(sentinel, 'approve')).toBe('COMMENT');
  });

  it('requests changes only when criticals exist', () => {
    const critical = makeResult({
      verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'high' },
      stats: { total: 1, critical: 2, important: 0, minor: 0 },
    });
    expect(resolveReviewEvent(critical, 'request-changes')).toBe('REQUEST_CHANGES');
    expect(resolveReviewEvent(makeResult(), 'request-changes')).toBe('COMMENT');
  });
});
