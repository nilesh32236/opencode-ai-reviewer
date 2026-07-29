import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubHelper } from '../src/utils/github.js';
import { makeReviewResult, mockResponse } from './helpers/mock-factories.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

function makeTestReviewResult() {
  return makeReviewResult({
    summary: '## Review Summary\nFound issues.',
    verdict: { ready: false, reasoning: 'Issues found.', autoFixable: false, confidence: 'medium' },
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/auth/jwt.ts',
        line: 28,
        message: 'JWT secret hardcoded',
        suggestion: 'Use env var',
        inline: true,
      },
      {
        type: 'issue',
        severity: 'important',
        file: 'src/auth/middleware.ts',
        line: 55,
        message: 'No token expiration check',
        inline: true,
      },
      {
        type: 'issue',
        severity: 'minor',
        file: 'src/routes/user.ts',
        line: 10,
        message: 'Unused import',
        inline: false,
      },
    ],
    stats: { total: 3, critical: 1, important: 1, minor: 1 },
  });
}

const mockJsonResponse = (body: unknown): Response => mockResponse({ body });

function mockErrorJsonResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('GitHubHelper postReview Integration', () => {
  let gh: GitHubHelper;
  let fetchMock: ReturnType<typeof vi.fn>;

  const PR_NUMBER = 42;
  const SHA = 'abc123def';

  function setupFetch(): void {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    gh = new GitHubHelper('test-token', 'owner/repo');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a) successful batch review (standard flow)', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`)) {
        return mockJsonResponse({});
      }

      if (urlStr.includes('/pulls/') && urlStr.includes('/reviews')) {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.comments && body.comments.length > 0) {
          return mockJsonResponse({
            id: 100,
            comments: [
              { id: 1, path: 'src/auth/jwt.ts', line: 28 },
              { id: 2, path: 'src/auth/middleware.ts', line: 55 },
            ],
          });
        }
        return mockJsonResponse({ id: 100 });
      }

      if (urlStr.includes('/pulls/') && urlStr.includes('/comments')) {
        return mockJsonResponse({ id: 3 });
      }

      return mockJsonResponse({});
    });

    const result = makeTestReviewResult();
    const response = await gh.postReview(PR_NUMBER, SHA, result, true);

    expect(response.success).toBe(true);
    expect(response.method).toBe('full');
    expect(response.reviewId).toBe(100);
    expect(response.commentIds).toHaveLength(2);
    expect(response.commentIds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'src/auth/jwt.ts', line: 28, commentId: 1 }),
        expect.objectContaining({ file: 'src/auth/middleware.ts', line: 55, commentId: 2 }),
      ]),
    );
  });

  it('b) batch review fails → falls back to body-only + per-comment', async () => {
    const apiCalls: Array<{ url: string; method?: string }> = [];

    fetchMock.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (options?.method as string) || 'GET';
      apiCalls.push({ url: urlStr, method });

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`)) {
        return mockJsonResponse({});
      }

      if (urlStr.includes('/reviews') && method === 'POST') {
        if (apiCalls.filter((c) => c.url.includes('/reviews')).length === 1) {
          const body = JSON.parse((options?.body as string) || '{}');
          if (body.comments) {
            return mockErrorJsonResponse(422, {
              message: 'Validation error',
              errors: [{ code: 'unpublished' }],
            });
          }
        }
        return mockJsonResponse({ id: 101 });
      }

      if (urlStr.includes('/comments') && method === 'POST') {
        return mockJsonResponse({ id: 3, node_id: 'node3' });
      }

      return mockJsonResponse({});
    });

    const result = makeTestReviewResult();
    const response = await gh.postReview(PR_NUMBER, SHA, result, true);

    expect(response.success).toBe(true);
    expect(response.method).toBe('partial');
    expect(response.commentIds).toHaveLength(2);
  });

  it('c) per-comment 422 → falls back to issue comment', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (options?.method as string) || 'GET';

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`)) {
        return mockJsonResponse({});
      }

      if (urlStr.includes('/reviews') && method === 'POST') {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.comments) {
          return mockErrorJsonResponse(422, {
            message: 'Validation error',
          });
        }
        return mockJsonResponse({ id: 102 });
      }

      if (urlStr.includes('/pulls/') && urlStr.includes('/comments') && method === 'POST') {
        return mockErrorJsonResponse(422, {
          message: 'Comment not on diff',
        });
      }

      if (urlStr.includes('/issues/') && urlStr.includes('/comments') && method === 'POST') {
        return mockJsonResponse({ id: 200 });
      }

      return mockJsonResponse({});
    });

    const result = makeTestReviewResult();
    const response = await gh.postReview(PR_NUMBER, SHA, result, true);

    expect(response.success).toBe(true);
    expect(response.method).toBe('partial');

    const issueCommentCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) =>
        typeof url === 'string' && url.includes('/issues/') && url.includes('/comments'),
    );
    expect(issueCommentCalls.length).toBeGreaterThanOrEqual(1);

    const lastIssueCall = issueCommentCalls[issueCommentCalls.length - 1];
    const body = JSON.parse((lastIssueCall[1]?.body as string) || '{}');
    expect(body.body).toContain('Inline comment');
  });

  it('d) body-only review also fails', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (options?.method as string) || 'GET';

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`)) {
        return mockJsonResponse({});
      }

      if (urlStr.includes('/reviews') && method === 'POST') {
        return mockErrorJsonResponse(422, { message: 'Validation error' });
      }

      return mockJsonResponse({});
    });

    const result = makeTestReviewResult();
    const response = await gh.postReview(PR_NUMBER, SHA, result, true);

    expect(response.success).toBe(false);
    expect(response.method).toBe('failed');
  });

  it('e) zero inline comments (inline mode disabled)', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (options?.method as string) || 'GET';

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`)) {
        return mockJsonResponse({});
      }

      if (urlStr.includes('/reviews') && method === 'POST') {
        return mockJsonResponse({ id: 103 });
      }

      return mockJsonResponse({});
    });

    const result = makeTestReviewResult();
    const response = await gh.postReview(PR_NUMBER, SHA, result, false);

    expect(response.success).toBe(true);
    expect(response.method).toBe('body-only');
    expect(response.reviewId).toBe(103);

    const reviewCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/reviews'),
    );
    expect(reviewCalls).toHaveLength(1);

    const reviewBody = JSON.parse((reviewCalls[0][1]?.body as string) || '{}');
    expect(reviewBody.comments).toBeUndefined();
  });

  it('f) inline comment filtering with diff lines', async () => {
    const diffText = [
      'diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts',
      'index abc..def 100644',
      '--- a/src/auth/jwt.ts',
      '+++ b/src/auth/jwt.ts',
      '@@ -25,7 +25,7 @@',
      ' const SECRET = "hardcoded";',
      '+const SECRET = process.env.JWT_SECRET;',
    ].join('\n');

    fetchMock.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      if (urlStr.endsWith(`/pulls/${PR_NUMBER}`)) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/plain' }),
          json: vi.fn().mockRejectedValue(new Error('Not JSON')),
          text: vi.fn().mockResolvedValue(diffText),
        } as unknown as Response;
      }

      if (urlStr.includes('/reviews') && (options?.method as string) === 'POST') {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.comments && body.comments.length > 0) {
          return mockJsonResponse({
            id: 104,
            comments: body.comments.map((c: { path: string; line: number }, i: number) => ({
              id: 10 + i,
              path: c.path,
              line: c.line,
            })),
          });
        }
        return mockJsonResponse({ id: 104 });
      }

      return mockJsonResponse({});
    });

    const result = makeTestReviewResult();
    const response = await gh.postReview(PR_NUMBER, SHA, result, true);

    expect(response.success).toBe(true);
    expect(response.method).toBe('full');
    expect(response.commentIds).toBeDefined();

    // Only src/auth/jwt.ts:28 is in the diff (middleware.ts:55 is not)
    // non-inline issue (routes/user.ts:10) should not be posted as a review comment
    const reviewCall = fetchMock.mock.calls.find(
      ([url, opts]) =>
        typeof url === 'string' && url.includes('/reviews') && opts?.method === 'POST',
    );
    const reviewBody = JSON.parse((reviewCall?.[1]?.body as string) || '{}');
    expect(reviewBody.comments).toHaveLength(1);
    expect(reviewBody.comments[0].path).toBe('src/auth/jwt.ts');
    expect(reviewBody.comments[0].line).toBe(28);
  });
});
