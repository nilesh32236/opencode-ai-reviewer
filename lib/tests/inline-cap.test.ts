import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INLINE_CAP,
  type InlineCommentPayload,
  MAX_INLINE_CAP,
  formatOverflowSummary,
  resolveInlineCap,
  sortAndCapFindings,
} from '../src/utils/review-body.js';

const mk = (
  i: number,
  severity: 'critical' | 'important' | 'minor',
  confidence: 'high' | 'medium' | 'low' = 'medium',
): InlineCommentPayload => ({
  path: `src/file-${i}.ts`,
  line: i + 1,
  side: 'RIGHT',
  body: `finding ${i}`,
  severity,
  confidence,
  message: `message ${i}`,
});

/** 15 findings: 5 critical, 5 important, 5 minor, all high confidence. */
function mixedFindings(): InlineCommentPayload[] {
  return [
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'minor')),
    ...Array.from({ length: 5 }, (_, i) => mk(10 + i, 'critical')),
    ...Array.from({ length: 5 }, (_, i) => mk(20 + i, 'important')),
  ];
}

describe('resolveInlineCap()', () => {
  it('defaults to 10 and clamps to the documented range', () => {
    expect(DEFAULT_INLINE_CAP).toBe(10);
    expect(MAX_INLINE_CAP).toBe(10);
    expect(resolveInlineCap()).toBe(10);
    expect(resolveInlineCap({})).toBe(10);
    expect(resolveInlineCap({ maxInlineComments: 5 })).toBe(5);
    expect(resolveInlineCap({ maxInlineComments: 999 })).toBe(10);
    expect(resolveInlineCap({ maxInlineComments: 0 })).toBeUndefined();
  });

  it('returns undefined for the legacy opt-out', () => {
    expect(resolveInlineCap({ disableInlineCap: true })).toBeUndefined();
  });

  it('returns undefined for an explicitly invalid value (fail-open)', () => {
    expect(resolveInlineCap({ maxInlineComments: Number.NaN })).toBeUndefined();
    expect(resolveInlineCap({ maxInlineComments: 'lots' as unknown as number })).toBeUndefined();
  });
});

describe('sortAndCapFindings()', () => {
  it('caps 15 mixed findings at 10, severity-sorted, remainder in overflow', () => {
    const { inline, overflow } = sortAndCapFindings(mixedFindings(), { maxInlineComments: 10 });

    expect(inline).toHaveLength(10);
    expect(overflow).toHaveLength(5);
    // Most severe first: all 5 critical, then 5 important.
    expect(inline.slice(0, 5).every((c) => c.severity === 'critical')).toBe(true);
    expect(inline.slice(5).every((c) => c.severity === 'important')).toBe(true);
    // Only minors remain in overflow.
    expect(overflow.every((c) => c.severity === 'minor')).toBe(true);
  });

  it('honors a custom cap of 5 and reports the remainder', () => {
    const total = mixedFindings().length;
    const { inline, overflow } = sortAndCapFindings(mixedFindings(), { maxInlineComments: 5 });

    expect(inline).toHaveLength(5);
    expect(overflow).toHaveLength(total - 5);
    expect(inline.every((c) => c.severity === 'critical')).toBe(true);
  });

  it('breaks severity ties by confidence (high first)', () => {
    const comments = [
      { ...mk(1, 'important', 'low'), path: 'src/low.ts' },
      { ...mk(2, 'important', 'high'), path: 'src/high.ts' },
      { ...mk(3, 'important', 'medium'), path: 'src/med.ts' },
    ];
    const { inline } = sortAndCapFindings(comments, { maxInlineComments: 3 });
    expect(inline.map((c) => c.path)).toEqual(['src/high.ts', 'src/med.ts', 'src/low.ts']);
  });

  it('returns everything inline when no cap is given (legacy path)', () => {
    const all = mixedFindings();
    const { inline, overflow } = sortAndCapFindings(all);
    expect(inline).toHaveLength(all.length);
    expect(overflow).toHaveLength(0);
  });

  it('fails open to the input order when sorting throws', () => {
    const broken = [
      { ...mk(1, 'minor') },
      Object.create(null) as InlineCommentPayload,
      { ...mk(2, 'critical') },
    ];
    // A getter that throws forces the catch branch.
    const hostile = [
      {
        path: 'src/a.ts',
        line: 1,
        side: 'RIGHT' as const,
        body: 'a',
        get severity(): 'critical' {
          throw new Error('boom');
        },
      },
      { ...mk(2, 'minor') },
    ] as InlineCommentPayload[];
    const result = sortAndCapFindings(hostile, { maxInlineComments: 1 });
    expect(result.inline).toHaveLength(hostile.length);
    expect(result.overflow).toHaveLength(0);
    // Malformed input never throws.
    expect(() => sortAndCapFindings(broken, { maxInlineComments: 2 })).not.toThrow();
  });

  it('handles zero findings: no inline, no overflow', () => {
    const { inline, overflow } = sortAndCapFindings([], { maxInlineComments: 10 });
    expect(inline).toHaveLength(0);
    expect(overflow).toHaveLength(0);
  });

  it('does not throw on malformed input', () => {
    expect(() =>
      sortAndCapFindings(null as unknown as InlineCommentPayload[], { maxInlineComments: 10 }),
    ).not.toThrow();
    expect(sortAndCapFindings(null as unknown as InlineCommentPayload[]).inline).toEqual([]);
  });
});

describe('formatOverflowSummary()', () => {
  it('renders a collapsible table for the overflow tail', () => {
    const { overflow } = sortAndCapFindings(mixedFindings(), { maxInlineComments: 10 });
    const summary = formatOverflowSummary(overflow);

    expect(summary).toContain('<details>');
    expect(summary).toContain('5 more finding(s) not posted inline');
    expect(summary).toContain('| Severity | Location | Finding |');
    expect(summary).toContain('src/file-0.ts:1');
  });

  it('renders nothing when there is no overflow', () => {
    expect(formatOverflowSummary([])).toBe('');
    expect(formatOverflowSummary(undefined as unknown as InlineCommentPayload[])).toBe('');
  });
});
