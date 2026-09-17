import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { GitHubHelper, validateInlinePositionsAgainstHunks } from '../src/utils/github.js';

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

function makeIssue(file: string, line: number, message: string, inline = true) {
  return { type: 'issue' as const, severity: 'important' as const, file, line, message, inline };
}

function makeResult(issues: ReturnType<typeof makeIssue>[] = []): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: true, reasoning: 'Looks good.', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues,
    stats: { total: issues.length, critical: 0, important: issues.length, minor: 0 },
  };
}

describe('validateInlinePositionsAgainstHunks()', () => {
  it('splits mappable from stale/out-of-diff findings', () => {
    const issues = [makeIssue('src/a.ts', 10, 'Mappable.'), makeIssue('src/a.ts', 99, 'Stale.')];
    const { mappable, unmappable } = validateInlinePositionsAgainstHunks(
      issues,
      new Set(['src/a.ts:10']),
    );
    expect(mappable.map((i) => i.message)).toEqual(['Mappable.']);
    expect(unmappable.map((i) => i.message)).toEqual(['Stale.']);
  });

  it('normalizes leading-slash paths and keeps non-inline issues in the body', () => {
    const issues = [
      makeIssue('/src/a.ts', 10, 'Slashed.'),
      makeIssue('src/a.ts', 11, 'Not inline.', false),
    ];
    const { mappable, unmappable } = validateInlinePositionsAgainstHunks(
      issues,
      new Set(['src/a.ts:10']),
    );
    expect(mappable.map((i) => i.message)).toEqual(['Slashed.']);
    expect(unmappable.map((i) => i.message)).toEqual(['Not inline.']);
  });

  it('treats missing/invalid lines as unmappable and never throws', () => {
    const issues = [makeIssue('src/a.ts', 0, 'Zero.'), makeIssue('src/a.ts', Number.NaN, 'NaN.')];
    const diff = new Set(['src/a.ts:0']);
    const { mappable, unmappable } = validateInlinePositionsAgainstHunks(issues, diff);
    expect(mappable).toEqual([]);
    expect(unmappable).toHaveLength(2);
    expect(() =>
      validateInlinePositionsAgainstHunks(undefined as never, undefined as never),
    ).not.toThrow();
    expect(validateInlinePositionsAgainstHunks(undefined as never, undefined as never)).toEqual({
      mappable: [],
      unmappable: [],
    });
  });

  it('fails open to all-unmappable when diff hunks are unavailable', () => {
    const issues = [makeIssue('src/a.ts', 10, 'Inline.')];
    expect(validateInlinePositionsAgainstHunks(issues, new Set()).mappable).toEqual([]);
    expect(validateInlinePositionsAgainstHunks(issues, new Set()).unmappable).toHaveLength(1);
  });
});

describe('postReview reviews-array path (enableReviewsArrayInline)', () => {
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

  function mockDiff(diffText: string) {
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue(diffText),
    } as unknown as Response;
  }

  function isDiffUrl(url: string): boolean {
    return (
      url.includes('/pulls/42') &&
      !url.includes('/reviews') &&
      !url.includes('/comments') &&
      !url.includes('/files')
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    helper = new GitHubHelper('test-token', 'owner/repo');
  });

  it('bundles 2 mappable findings into one reviews-array request plus summary', async () => {
    const diffText = `+++ b/src/a.ts\n@@ -10,2 +10,2 @@\n+++ b/src/b.ts\n@@ -20,1 +20,1 @@`;
    const result = makeResult([
      makeIssue('src/a.ts', 10, 'First finding.'),
      makeIssue('src/b.ts', 20, 'Second finding.'),
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (isDiffUrl(url)) return mockDiff(diffText);
      if (url.includes('/pulls/42/reviews')) return mockOk({ id: 101, comments: [] });
      return mockOk({});
    });
    const posted = await helper.postReview(42, 'sha123', result, true, undefined, {
      enableReviewsArrayInline: true,
    });
    expect(posted.success).toBe(true);
    expect(posted.method).toBe('full');
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].comments as unknown[]).toHaveLength(2);
    expect(bodies[0].body as string).toContain('Review summary');
  });

  it('retries summary-only on 422 with zero findings lost', async () => {
    const diffText = `+++ b/src/a.ts\n@@ -10,1 +10,1 @@`;
    const result = makeResult([makeIssue('src/a.ts', 10, 'Mappable finding.')]);
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (isDiffUrl(url)) return mockDiff(diffText);
      if (url.includes('/pulls/42/reviews')) {
        const body = JSON.parse((options as RequestInit).body as string);
        if (body.comments !== undefined) {
          throw httpError(422, 'GitHub API 422 on /pulls/42/reviews: Unprocessable');
        }
        return mockOk({ id: 102 });
      }
      return mockOk({});
    });
    const posted = await helper.postReview(42, 'sha123', result, true, undefined, {
      enableReviewsArrayInline: true,
    });
    expect(posted.success).toBe(true);
    expect(posted.method).toBe('body-only');
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('comments');
    expect(bodies[1].body as string).toContain('Mappable finding.');
  });

  it('short-circuits to a single summary-only request when the diff is unavailable', async () => {
    const result = makeResult([makeIssue('src/a.ts', 10, 'Inline finding.')]);
    fetchMock.mockImplementation(async (url: string) => {
      if (isDiffUrl(url)) return mockDiff('no file headers here');
      if (url.includes('/pulls/42/reviews')) return mockOk({ id: 103 });
      return mockOk({});
    });
    const posted = await helper.postReview(42, 'sha123', result, true, undefined, {
      enableReviewsArrayInline: true,
    });
    expect(posted.success).toBe(true);
    expect(posted.method).toBe('body-only');
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('comments');
    expect(bodies[0].body as string).toContain('Inline finding.');
    expect(vi.mocked(core.warning)).toHaveBeenCalled();
  });

  it('rethrows non-retryable errors (e.g. 500) instead of masking them summary-only', async () => {
    const diffText = `+++ b/src/a.ts\n@@ -10,1 +10,1 @@`;
    const result = makeResult([makeIssue('src/a.ts', 10, 'Inline finding.')]);
    fetchMock.mockImplementation(async (url: string) => {
      if (isDiffUrl(url)) return mockDiff(diffText);
      if (url.includes('/pulls/42/reviews')) {
        throw httpError(500, 'GitHub API 500 on /pulls/42/reviews: Server error');
      }
      return mockOk({});
    });
    await expect(
      helper.postReview(42, 'sha123', result, true, undefined, {
        enableReviewsArrayInline: true,
      }),
    ).rejects.toThrow();
    expect(reviewBodies()).toHaveLength(1);
  });

  it('keeps legacy fan-out behavior when the flag is absent', async () => {
    const diffText = `+++ b/src/a.ts\n@@ -10,1 +10,1 @@`;
    const result = makeResult([makeIssue('src/a.ts', 10, 'Inline finding.')]);
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (isDiffUrl(url)) return mockDiff(diffText);
      if (url.includes('/pulls/42/reviews')) {
        const body = JSON.parse((options as RequestInit).body as string);
        if (body.comments !== undefined) {
          throw httpError(422, 'GitHub API 422 on /pulls/42/reviews: Unprocessable');
        }
        return mockOk({ id: 104 });
      }
      if (url.includes('/pulls/42/comments')) return mockOk({ id: 201, node_id: 'node1' });
      return mockOk({});
    });
    const posted = await helper.postReview(42, 'sha123', result);
    expect(posted.success).toBe(true);
    // Legacy path fans out per-comment instead of the reviews-array
    // summary-only retry: body-only review + one individual comment request.
    expect(posted.method).toBe('partial');
    expect(
      fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/pulls/42/comments')),
    ).toHaveLength(1);
  });
});
