/**
 * L-064: the verdict was lost to GitHub's review-body length limit.
 *
 * `POST /pulls/{n}/reviews` rejects a body over 65536 characters with HTTP 422
 * `Body is too long`. The body was assembled with no cap, so a large
 * consolidated review was rejected twice — once with inline comments, once
 * body-only — logged three warnings, and the job exited SUCCESS with an empty
 * `.reviews` (performance-optimisation#1760, run 37019639478).
 *
 * These tests pin the three things that were missing: a cap, a MARKER so the
 * cut is visible, and preservation of the lines that carry the verdict.
 */
import { describe, expect, it } from 'vitest';

import type { ReviewResult } from '../src/types/index.js';
import {
  DEFAULT_MAX_INLINE_COMMENTS,
  GITHUB_REVIEW_BODY_LIMIT,
  buildReviewBody,
  capInlineComments,
  formatDroppedInlineNotice,
  truncateReviewBody,
} from '../src/utils/review-body.js';
import type { InlineCommentPayload } from '../src/utils/review-body.js';

/** Build a review result large enough to blow the limit. */
function makeLargeResult(issues = 80, msgLen = 1200): ReviewResult {
  return {
    summary: '**Consolidated result:** many issues.',
    verdict: { ready: false, reasoning: 'Needs work', autoFixable: false, confidence: 'high' },
    executiveSummary: {
      purpose: 'p'.repeat(1200),
      riskLevel: 'high',
      riskRationale: 'r'.repeat(2500),
      breakingChanges: ['b'.repeat(300)],
    },
    strengths: Array.from({ length: 9 }, (_, i) => `Strength ${i}`),
    issues: Array.from({ length: issues }, (_, i) => ({
      type: 'issue' as const,
      severity: (['important', 'minor'] as const)[i % 2],
      file: `src/module-${i % 30}/component-${i}.ts`,
      line: (i % 300) + 1,
      message: `Finding ${i}: ` + 'detail '.repeat(Math.ceil(msgLen / 7)).slice(0, msgLen),
      inline: false,
      confidence: 'medium' as const,
    })),
    stats: { total: issues, critical: 0, important: issues / 2, minor: issues / 2 },
  } as unknown as ReviewResult;
}

describe('buildReviewBody() — the length cap (L-064)', () => {
  it('NEVER exceeds GitHub’s limit, even for a huge review', () => {
    const body = buildReviewBody(makeLargeResult());
    expect(body.length).toBeLessThanOrEqual(GITHUB_REVIEW_BODY_LIMIT);
    expect(GITHUB_REVIEW_BODY_LIMIT).toBe(65535);
  });

  it('leaves a body that already fits byte-identical', () => {
    const small = makeLargeResult(5, 120);
    const body = buildReviewBody(small);

    expect(body.length).toBeLessThan(GITHUB_REVIEW_BODY_LIMIT);
    expect(body).not.toContain('TRUNCATED');
  });

  it('marks the truncation in the body — a silent cut is worse than no review', () => {
    const body = buildReviewBody(makeLargeResult());

    expect(body).toContain('THIS REVIEW IS TRUNCATED');
    expect(body).toContain('INCOMPLETE');
  });

  it('states the ORIGINAL length so the shortfall is measurable', () => {
    const original = truncateReviewBody('x'.repeat(70000));
    expect(original.truncated).toBe(true);
    expect(original.originalLength).toBe(70000);
    expect(original.body).toContain('70000');
  });

  it('points the reader at the untruncated output', () => {
    const body = buildReviewBody(makeLargeResult());
    expect(body).toContain('job log');
  });

  it('PRESERVES the verdict line, the readiness line and the risk rating', () => {
    // These must NEVER be the thing that gets cut: a truncated review that
    // loses "Ready to merge?" is worse than useless.
    const body = buildReviewBody(makeLargeResult());

    expect(body).toContain('## MR Review Summary');
    expect(body).toContain('**Ready to merge?** No');
    expect(body).toContain('**Merge-readiness:**');
    expect(body).toContain('**Reasoning:** Needs work');
    expect(body).toContain('**Risk:** 🔴 HIGH');
  });

  it('keeps the verdict intact even when the summary itself is enormous', () => {
    // A pathological summary must not be able to push the readiness line out.
    const huge = makeLargeResult(60, 900);
    huge.summary = 'S'.repeat(200000);
    huge.executiveSummary = {
      purpose: 'p'.repeat(100000),
      riskLevel: 'high',
      riskRationale: 'r'.repeat(100000),
      breakingChanges: [],
    };

    const body = buildReviewBody(huge);

    expect(body.length).toBeLessThanOrEqual(GITHUB_REVIEW_BODY_LIMIT);
    expect(body).toContain('**Ready to merge?**');
    expect(body).toContain('**Risk:** 🔴 HIGH');
  });

  it('reports truncation through the onTruncate callback', () => {
    const seen: Array<{ truncated: boolean; originalLength: number }> = [];
    buildReviewBody(makeLargeResult(), { onTruncate: (i) => seen.push(i) });

    expect(seen).toHaveLength(1);
    expect(seen[0].truncated).toBe(true);
    expect(seen[0].originalLength).toBeGreaterThan(GITHUB_REVIEW_BODY_LIMIT);
  });

  it('does not fire onTruncate for a body that fits', () => {
    let fired = 0;
    buildReviewBody(makeLargeResult(4, 100), { onTruncate: () => fired++ });
    expect(fired).toBe(0);
  });
});

describe('truncateReviewBody()', () => {
  it('returns the input unchanged when it fits', () => {
    const body = 'short';
    const r = truncateReviewBody(body);
    expect(r.body).toBe(body);
    expect(r.truncated).toBe(false);
    expect(r.droppedChars).toBe(0);
  });

  it('cuts at a line boundary, never mid-line', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    expect(text.length).toBeGreaterThan(3000);
    const r = truncateReviewBody(text, { limit: 3000 });
    expect(r.truncated).toBe(true);
    const head = r.body.slice(0, r.body.indexOf('\n\n---'));
    // The last visible line must be a complete line, not a fragment.
    expect(head.split('\n').pop()).toMatch(/^line \d+$/);
  });

  it('reports how many characters were dropped', () => {
    const r = truncateReviewBody('y'.repeat(80000));
    expect(r.truncated).toBe(true);
    expect(r.droppedChars).toBeGreaterThan(0);
    expect(r.droppedChars).toBeLessThan(r.originalLength);
  });

  it('honours a limit override', () => {
    const r = truncateReviewBody('z'.repeat(5000), { limit: 1000 });
    expect(r.body.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
  });

  it('survives a pathologically small limit instead of posting an over-limit body', () => {
    const r = truncateReviewBody('w'.repeat(50000), { limit: 80 });
    expect(r.body.length).toBeLessThanOrEqual(80);
    expect(r.truncated).toBe(true);
  });

  it('handles an empty body', () => {
    const r = truncateReviewBody('');
    expect(r.truncated).toBe(false);
    expect(r.body).toBe('');
  });
});

describe('capInlineComments()', () => {
  const mk = (n: number, bodyLen = 100): InlineCommentPayload[] =>
    Array.from({ length: n }, (_, i) => ({
      path: `src/file-${i}.ts`,
      line: i + 1,
      side: 'RIGHT',
      body: 'b'.repeat(bodyLen),
    }));

  it('passes a small batch through untouched', () => {
    const r = capInlineComments(mk(5));
    expect(r.comments).toHaveLength(5);
    expect(r.dropped).toBe(false);
    expect(r.droppedCount).toBe(0);
  });

  it('caps the COUNT and names what was dropped', () => {
    const r = capInlineComments(mk(120), { maxCount: 50 });

    expect(r.comments).toHaveLength(50);
    expect(r.droppedCount).toBe(70);
    expect(r.droppedPaths).toHaveLength(70);
    expect(r.droppedPaths[0]).toBe('src/file-50.ts:51');
  });

  it('caps a single oversized comment body with its own visible marker', () => {
    const r = capInlineComments(mk(1, 20000), { maxBodyChars: 8000 });

    expect(r.comments[0].body.length).toBeLessThan(8000 + 300);
    expect(r.comments[0].body).toContain('truncated');
    expect(r.comments[0].body).toContain('20000');
  });

  it('never silently posts fewer: the notice names the shortfall', () => {
    const r = capInlineComments(mk(60), { maxCount: 50 });
    const notice = formatDroppedInlineNotice(r);

    expect(notice).toContain('10 inline finding(s) were NOT posted');
    expect(notice).toContain('src/file-50.ts:51');
    expect(notice).toContain('INCOMPLETE');
  });

  it('renders nothing when nothing was dropped', () => {
    expect(formatDroppedInlineNotice(capInlineComments(mk(3)))).toBe('');
  });

  it('summarises a long drop list rather than listing all of it', () => {
    const r = capInlineComments(mk(200), { maxCount: 10 });
    const notice = formatDroppedInlineNotice(r, 3);

    expect(notice).toContain('…and 187 more');
  });

  it('uses a sane default cap', () => {
    expect(DEFAULT_MAX_INLINE_COMMENTS).toBe(50);
    expect(capInlineComments(mk(200)).comments).toHaveLength(DEFAULT_MAX_INLINE_COMMENTS);
  });

  it('does not throw on malformed input', () => {
    expect(capInlineComments(null as unknown as InlineCommentPayload[]).comments).toEqual([]);
  });
});
