import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { GitHubHelper, normalizeVerdictMode, resolveReviewEvent } from '../src/utils/github.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug };
});

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

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
    const withCritical = makeResult({
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/a.ts',
          line: 1,
          message: 'Bug.',
        },
      ],
    });
    expect(resolveReviewEvent(withCritical, 'approve')).toBe('COMMENT');

    const withImportant = makeResult({
      stats: { total: 1, critical: 0, important: 1, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'important',
          file: 'src/a.ts',
          line: 2,
          message: 'Smell.',
        },
      ],
    });
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
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/a.ts',
          line: 1,
          message: 'Bug.',
        },
      ],
    });
    expect(resolveReviewEvent(critical, 'request-changes')).toBe('REQUEST_CHANGES');
    expect(resolveReviewEvent(makeResult(), 'request-changes')).toBe('COMMENT');
  });

  it('approves minor-only findings in approve mode', () => {
    const minorOnly = makeResult({
      stats: { total: 1, critical: 0, important: 0, minor: 1 },
      issues: [
        {
          type: 'issue',
          severity: 'minor',
          file: 'src/a.ts',
          line: 1,
          message: 'Nit.',
        },
      ],
    });
    expect(resolveReviewEvent(minorOnly, 'approve')).toBe('APPROVE');
  });

  it('stays COMMENT for important-only findings in request-changes mode', () => {
    const importantOnly = makeResult({
      stats: { total: 1, critical: 0, important: 1, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'important',
          file: 'src/a.ts',
          line: 1,
          message: 'Smell.',
        },
      ],
    });
    expect(resolveReviewEvent(importantOnly, 'request-changes')).toBe('COMMENT');
  });

  it('stays COMMENT on failedAgents in both gated modes (fail-open)', () => {
    const failedAgents = makeResult({
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/a.ts',
          line: 1,
          message: 'Bug.',
        },
      ],
      failedAgents: 2,
    });
    expect(resolveReviewEvent(failedAgents, 'request-changes')).toBe('COMMENT');
    expect(resolveReviewEvent(makeResult({ failedAgents: 1 }), 'approve')).toBe('COMMENT');
  });

  it('ignores stale stats and counts post-filter issues', () => {
    // Stats computed pre-filter must not gate: a suppressed critical that is
    // no longer in the issues array stays COMMENT instead of REQUEST_CHANGES.
    const staleStats = makeResult({
      verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'high' },
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
      issues: [],
    });
    expect(resolveReviewEvent(staleStats, 'request-changes')).toBe('COMMENT');
  });

  it('stays COMMENT in request-changes mode on failed/unreliable passes', () => {
    const failedPass = makeResult({
      verdict: {
        ready: false,
        reasoning: 'All review agents failed',
        autoFixable: false,
        confidence: 'low',
      },
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/a.ts',
          line: 1,
          message: 'Bug.',
        },
      ],
      failedBatches: 1,
    });
    expect(resolveReviewEvent(failedPass, 'request-changes')).toBe('COMMENT');
  });
});

describe('verdictMode transport (postReview event propagation)', () => {
  let helper: GitHubHelper;
  let fetchMock: ReturnType<typeof vi.fn>;

  function mockOk(body: unknown = { id: 1 }) {
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    } as unknown as Response;
  }

  function httpError(status: number, message: string): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
  }

  function reviewBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter(([url]: [string]) => url.includes('/pulls/42/reviews'))
      .map(([, options]) => JSON.parse((options as RequestInit).body as string));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    helper = new GitHubHelper('test-token', 'owner/repo');
  });

  it('posts APPROVE for a clean ready verdict in approve mode', async () => {
    fetchMock.mockImplementation(async () => mockOk({ id: 11 }));
    const result = await helper.postReview(42, 'sha123', makeResult(), false, undefined, {
      verdictMode: 'approve',
    });
    expect(result.success).toBe(true);
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].event).toBe('APPROVE');
  });

  it('posts REQUEST_CHANGES for criticals in request-changes mode', async () => {
    fetchMock.mockImplementation(async () => mockOk({ id: 12 }));
    const critical = makeResult({
      verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'high' },
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/a.ts',
          line: 1,
          message: 'Bug.',
        },
      ],
    });
    const result = await helper.postReview(42, 'sha123', critical, false, undefined, {
      verdictMode: 'request-changes',
    });
    expect(result.success).toBe(true);
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].event).toBe('REQUEST_CHANGES');
  });

  it('retries a rejected APPROVE as summary-only COMMENT with a warning suffix', async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes('/pulls/42/reviews')) {
        const body = JSON.parse((options as RequestInit).body as string);
        if (body.event === 'APPROVE') {
          throw httpError(403, 'GitHub API 403 on /pulls/42/reviews: Forbidden');
        }
        return mockOk({ id: 13 });
      }
      return mockOk({});
    });
    const result = await helper.postReview(42, 'sha123', makeResult(), false, undefined, {
      verdictMode: 'approve',
    });
    expect(result.success).toBe(true);
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].event).toBe('APPROVE');
    expect(bodies[1].event).toBe('COMMENT');
    expect(bodies[1].body as string).toContain('was not permitted; posted as a comment instead');
    expect(bodies[1]).not.toHaveProperty('comments');
    expect(vi.mocked(core.warning)).toHaveBeenCalled();
  });

  it('preserves inline comments when a batched gated review falls back to COMMENT', async () => {
    const diffText = `+++ b/src/c.ts\n@@ -7,1 +7,1 @@`;
    const criticalInline: ReviewResult = {
      ...makeResult({
        verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'high' },
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
      }),
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/c.ts',
          line: 7,
          message: 'Bug.',
          suggestion: 'Fix it.',
          inline: true,
        },
      ],
    };
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (
        url.includes('/pulls/42') &&
        !url.includes('/reviews') &&
        !url.includes('/comments') &&
        !url.includes('/files')
      ) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({}),
          text: vi.fn().mockResolvedValue(diffText),
        } as unknown as Response;
      }
      if (url.includes('/pulls/42/reviews')) {
        const body = JSON.parse((options as RequestInit).body as string);
        if (body.event === 'REQUEST_CHANGES') {
          throw httpError(403, 'GitHub API 403 on /pulls/42/reviews: Forbidden');
        }
        return mockOk({ id: 15 });
      }
      return mockOk({});
    });
    const result = await helper.postReview(42, 'sha123', criticalInline, true, undefined, {
      enableReviewsArrayInline: true,
      verdictMode: 'request-changes',
    });
    expect(result.success).toBe(true);
    expect(result.method).toBe('full');
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].event).toBe('REQUEST_CHANGES');
    expect(bodies[0]).toHaveProperty('comments');
    expect(bodies[1].event).toBe('COMMENT');
    // Permission fallback keeps the batched inline findings.
    expect(bodies[1]).toHaveProperty('comments');
    expect(bodies[1].body as string).toContain('was not permitted; posted as a comment instead');
  });

  it('preserves the REQUEST_CHANGES gate when the reviews-array batch fails', async () => {
    const diffText = `+++ b/src/b.ts\n@@ -42,1 +42,1 @@`;
    const criticalInline: ReviewResult = {
      ...makeResult({
        verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'high' },
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
      }),
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/b.ts',
          line: 42,
          message: 'Bug.',
          suggestion: 'Fix it.',
          inline: true,
        },
      ],
    };
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (
        url.includes('/pulls/42') &&
        !url.includes('/reviews') &&
        !url.includes('/comments') &&
        !url.includes('/files')
      ) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({}),
          text: vi.fn().mockResolvedValue(diffText),
        } as unknown as Response;
      }
      if (url.includes('/pulls/42/reviews')) {
        const body = JSON.parse((options as RequestInit).body as string);
        if (body.comments !== undefined) {
          throw httpError(422, 'GitHub API 422 on /pulls/42/reviews: Unprocessable');
        }
        return mockOk({ id: 14 });
      }
      return mockOk({});
    });
    const result = await helper.postReview(42, 'sha123', criticalInline, true, undefined, {
      enableReviewsArrayInline: true,
      verdictMode: 'request-changes',
    });
    expect(result.success).toBe(true);
    expect(result.method).toBe('body-only');
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].event).toBe('REQUEST_CHANGES');
    expect(bodies[0]).toHaveProperty('comments');
    // Summary-only retry preserves the gate (createReview falls back to
    // COMMENT itself only on 403/422 permission rejections).
    expect(bodies[1].event).toBe('REQUEST_CHANGES');
    expect(bodies[1]).not.toHaveProperty('comments');
  });
});
