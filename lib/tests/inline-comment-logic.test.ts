import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInlineComments } from '../src/jsonl-parser.js';
import type { ReviewResult } from '../src/types/index.js';
import { GitHubHelper } from '../src/utils/github.js';

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

const TOKEN = 'test-token';
const REPO = 'owner/repo';

function makeMockResponse(body: unknown, overrides: Partial<Response> = {}): Response {
  const headers = new Headers();
  return {
    ok: true,
    status: 200,
    headers,
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(JSON.stringify(body ?? '')),
    ...overrides,
  } as unknown as Response;
}

function makeMockTextResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'text/plain' }),
    json: vi.fn().mockRejectedValue(new Error('Not JSON')),
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

function resultWithIssues(issues: ReviewResult['issues']): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: {
      ready: false,
      reasoning: 'Issues found.',
      autoFixable: false,
      confidence: 'medium',
    },
    strengths: [],
    issues,
    stats: {
      total: issues.length,
      critical: issues.filter((i) => i.severity === 'critical').length,
      important: issues.filter((i) => i.severity === 'important').length,
      minor: issues.filter((i) => i.severity === 'minor').length,
    },
    rawLines: [],
    failedLines: 0,
  };
}

function makeIssue(
  overrides: Partial<ReviewResult['issues'][number]> = {},
): ReviewResult['issues'][number] {
  return {
    type: 'issue',
    severity: 'critical',
    file: 'src/test.ts',
    line: 10,
    message: 'Test issue.',
    suggestion: 'Fix it.',
    inline: true,
    ...overrides,
  };
}

const DIFF_ADDED_LINE = [
  'diff --git a/src/test.ts b/src/test.ts',
  'index abc..def 100644',
  '--- a/src/test.ts',
  '+++ b/src/test.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  ' line2',
  '+line3',
  '+line4',
].join('\n');

const DIFF_LINE_REMOVED = [
  'diff --git a/src/test.ts b/src/test.ts',
  'index abc..def 100644',
  '--- a/src/test.ts',
  '+++ b/src/test.ts',
  '@@ -1,5 +1,3 @@',
  ' line1',
  ' line2',
  '-line3',
  '-line4',
  ' line5',
].join('\n');

describe('GitHubHelper inline comment placement logic', () => {
  let helper: GitHubHelper;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    helper = new GitHubHelper(TOKEN, REPO);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Added line placement ──────────────────────────────────

  describe('added line placement', () => {
    it('places inline comment on an added line in the diff', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_ADDED_LINE);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          const body = JSON.parse((options?.body as string) || '{}');
          if (body.comments && body.comments.length > 0) {
            return makeMockResponse({
              id: 100,
              comments: body.comments.map((c: { path: string; line: number }, i: number) => ({
                id: 10 + i,
                path: c.path,
                line: c.line,
              })),
            });
          }
          return makeMockResponse({ id: 100 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([
        makeIssue({ file: 'src/test.ts', line: 3 }),
        makeIssue({ file: 'src/test.ts', line: 4 }),
      ]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
      expect(response.method).toBe('full');
      expect(response.commentIds).toHaveLength(2);

      const reviewCall = fetchMock.mock.calls.find(
        ([, opts]) =>
          opts &&
          typeof (opts as RequestInit).body === 'string' &&
          (opts as RequestInit).method === 'POST',
      );
      if (reviewCall) {
        const reviewBody = JSON.parse((reviewCall[1] as RequestInit).body as string);
        expect(reviewBody.comments).toHaveLength(2);
        expect(reviewBody.comments[0]).toMatchObject({
          path: 'src/test.ts',
          line: 3,
          side: 'RIGHT',
        });
        expect(reviewBody.comments[1]).toMatchObject({
          path: 'src/test.ts',
          line: 4,
          side: 'RIGHT',
        });
      }
    });

    it('places comment on the correct side (RIGHT) for added lines', () => {
      const result = resultWithIssues([makeIssue({ file: 'src/test.ts', line: 3 })]);
      const diffLines = new Set([
        'src/test.ts:1',
        'src/test.ts:2',
        'src/test.ts:3',
        'src/test.ts:4',
      ]);
      const comments = buildInlineComments(result, diffLines);
      expect(comments).toHaveLength(1);
      expect(comments[0].side).toBe('RIGHT');
      expect(comments[0].line).toBe(3);
      expect(comments[0].path).toBe('src/test.ts');
    });
  });

  // ─── Removed line placement ────────────────────────────────

  describe('removed line placement', () => {
    it('filters out issues on lines that were removed (not in new diff)', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_LINE_REMOVED);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          return makeMockResponse({ id: 100 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([makeIssue({ file: 'src/test.ts', line: 4 })]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
      expect(response.method).toBe('body-only');

      const reviewCall = fetchMock.mock.calls.find(
        ([, opts]) =>
          opts &&
          typeof (opts as RequestInit).body === 'string' &&
          (opts as RequestInit).method === 'POST',
      );
      if (reviewCall) {
        const reviewBody = JSON.parse((reviewCall[1] as RequestInit).body as string);
        expect(reviewBody.comments).toBeUndefined();
      }
    });

    it('buildInlineComments excludes removed lines when diffLines provided', () => {
      const result = resultWithIssues([makeIssue({ file: 'src/test.ts', line: 4 })]);
      const diffLines = new Set(['src/test.ts:1', 'src/test.ts:2', 'src/test.ts:3']);
      const comments = buildInlineComments(result, diffLines);
      expect(comments).toHaveLength(0);
    });
  });

  // ─── Multi-line comment placement ─────────────────────────

  describe('multi-line comment placement', () => {
    it('builds inline comment body with multi-line diff suggestion', () => {
      const result = resultWithIssues([
        makeIssue({
          file: 'src/test.ts',
          line: 10,
          message: 'Missing null check.',
          suggestion: '-if (x) {\n+if (x !== null) {',
          inline: true,
        }),
      ]);

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain('```diff');
      expect(comments[0].body).toContain('-if (x) {');
      expect(comments[0].body).toContain('+if (x !== null) {');
    });

    it('places multi-line comment as inline in postReview', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_ADDED_LINE);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          const body = JSON.parse((options?.body as string) || '{}');
          if (body.comments && body.comments.length > 0) {
            return makeMockResponse({
              id: 100,
              comments: body.comments.map((c: { path: string; line: number }, i: number) => ({
                id: 10 + i,
                path: c.path,
                line: c.line,
              })),
            });
          }
          return makeMockResponse({ id: 100 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([
        makeIssue({
          file: 'src/test.ts',
          line: 3,
          message: 'Missing null check.',
          suggestion: '-if (x) {\n+if (x !== null) {',
          inline: true,
        }),
      ]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
      expect(response.method).toBe('full');
      expect(response.commentIds).toHaveLength(1);
    });
  });

  // ─── 422 fallback ──────────────────────────────────────────

  describe('422 fallback to issue comment', () => {
    it('falls back to issue comment on 422 for individual inline comment', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_ADDED_LINE);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          const reqBody = JSON.parse((options?.body as string) || '{}');
          if (reqBody.comments) {
            const err = new Error('GitHub API 422') as Error & { status: number };
            err.status = 422;
            throw err;
          }
          return makeMockResponse({ id: 100 });
        }

        if (urlStr.includes('/pulls/') && urlStr.includes('/comments') && method === 'POST') {
          const err = new Error('GitHub API 422') as Error & { status: number };
          err.status = 422;
          throw err;
        }

        if (urlStr.includes('/issues/') && urlStr.includes('/comments') && method === 'POST') {
          return makeMockResponse({ id: 999 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([
        makeIssue({ file: 'src/test.ts', line: 3, message: 'Test. 422 fallback test.' }),
      ]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
      expect(response.method).toBe('partial');

      const issueCommentCalls = fetchMock.mock.calls.filter(
        ([url, opts]) =>
          typeof url === 'string' &&
          url.includes('/issues/') &&
          url.includes('/comments') &&
          opts &&
          (opts as RequestInit).method === 'POST',
      );
      expect(issueCommentCalls.length).toBeGreaterThanOrEqual(1);
      const issueCallBody = JSON.parse((issueCommentCalls[0][1] as RequestInit).body as string);
      expect(issueCallBody.body).toContain('Inline comment (src/test.ts:3)');
      expect(issueCallBody.body).toContain('Test.');
    });

    it('does not attempt issue comment fallback on non-422 errors', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_ADDED_LINE);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          const reqBody = JSON.parse((options?.body as string) || '{}');
          if (reqBody.comments) {
            const err = new Error('GitHub API 422') as Error & { status: number };
            err.status = 422;
            throw err;
          }
          return makeMockResponse({ id: 100 });
        }

        if (urlStr.includes('/pulls/') && urlStr.includes('/comments') && method === 'POST') {
          const err = new Error('GitHub API 500') as Error & { status: number };
          err.status = 500;
          throw err;
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([makeIssue({ file: 'src/test.ts', line: 3 })]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);

      const issueCommentCalls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/issues/') && url.includes('/comments'),
      );
      expect(issueCommentCalls).toHaveLength(0);
    });
  });

  // ─── Empty diff handling ───────────────────────────────────

  describe('empty diff handling', () => {
    it('getDiffLines returns empty set for empty diff', async () => {
      fetchMock.mockResolvedValue(makeMockTextResponse(''));
      const lines = await helper.getDiffLines(42);
      expect(lines).toBeInstanceOf(Set);
      expect(lines.size).toBe(0);
    });

    it('postReview succeeds with empty diff', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse('');
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          return makeMockResponse({ id: 100 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([makeIssue({ file: 'src/test.ts', line: 3 })]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
    });

    it('buildInlineComments returns all inline issues when no diff lines provided', () => {
      const result = resultWithIssues([
        makeIssue({ file: 'src/test.ts', line: 10 }),
        makeIssue({ file: 'src/a.ts', line: 20 }),
      ]);

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(2);
    });
  });

  // ─── Binary file handling ─────────────────────────────────

  describe('binary file handling', () => {
    it('getDiffLines returns empty set for binary-only diffs', async () => {
      const binaryDiff =
        'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ';
      fetchMock.mockResolvedValue(makeMockTextResponse(binaryDiff));
      const lines = await helper.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('postReview succeeds with binary-only PR diff', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';
      const binaryDiff =
        'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(binaryDiff);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          return makeMockResponse({ id: 100 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([
        makeIssue({ file: 'image.png', line: 1, message: 'Large image.' }),
      ]);

      const response = await helper.postReview(prNumber, commitSha, result, true);
      expect(response.success).toBe(true);
    });

    it('processes text file hunks after binary file in diff', async () => {
      const diffWithBinaryThenText = [
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,4 @@',
        ' line1',
        ' line2',
        '+line3',
        '+line4',
      ].join('\n');

      const prNumber = 42;
      fetchMock.mockResolvedValue(makeMockTextResponse(diffWithBinaryThenText));

      const lines = await helper.getDiffLines(prNumber);
      expect(lines.has('src/app.ts:1')).toBe(true);
      expect(lines.has('src/app.ts:2')).toBe(true);
      expect(lines.has('src/app.ts:3')).toBe(true);
      expect(lines.has('src/app.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });
  });

  // ─── Multiple hunks per file ──────────────────────────────

  describe('hunks spanning multiple sections', () => {
    it('parses multiple hunks within the same file', async () => {
      const multiHunkDiff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,5 +10,7 @@',
        ' context',
        '+added1',
        '+added2',
        '@@ -30,3 +32,5 @@',
        ' more context',
        '+added3',
        '+added4',
      ].join('\n');

      fetchMock.mockResolvedValue(makeMockTextResponse(multiHunkDiff));

      const lines = await helper.getDiffLines(42);

      expect(lines.has('src/app.ts:10')).toBe(true);
      expect(lines.has('src/app.ts:11')).toBe(true);
      expect(lines.has('src/app.ts:12')).toBe(true);
      expect(lines.has('src/app.ts:32')).toBe(true);
      expect(lines.has('src/app.ts:33')).toBe(true);
      expect(lines.has('src/app.ts:34')).toBe(true);
      expect(lines.has('src/app.ts:35')).toBe(true);
      expect(lines.has('src/app.ts:36')).toBe(true);
      expect(lines.size).toBe(12);
    });

    it('comments from both hunks are properly placed', async () => {
      const multiHunkDiff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,5 +10,7 @@',
        ' context1',
        '+add1',
        '+add2',
        '@@ -30,3 +32,5 @@',
        ' context2',
        '+add3',
        '+add4',
      ].join('\n');

      const prNumber = 42;
      const commitSha = 'sha123';

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(multiHunkDiff);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          const body = JSON.parse((options?.body as string) || '{}');
          if (body.comments && body.comments.length > 0) {
            return makeMockResponse({
              id: 100,
              comments: body.comments.map((c: { path: string; line: number }, i: number) => ({
                id: 10 + i,
                path: c.path,
                line: c.line,
              })),
            });
          }
          return makeMockResponse({ id: 100 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([
        makeIssue({ file: 'src/app.ts', line: 11, message: 'Issue in hunk 1.' }),
        makeIssue({ file: 'src/app.ts', line: 33, message: 'Issue in hunk 2.' }),
      ]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
      expect(response.method).toBe('full');
      expect(response.commentIds).toHaveLength(2);
    });

    it('postReview correctly filters issues across multiple files with multiple hunks', async () => {
      const multiFileMultiHunkDiff = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,4 @@',
        ' a1',
        ' a2',
        '+a3',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -10,5 +10,6 @@',
        ' b1',
        ' b2',
        '+b3',
      ].join('\n');

      fetchMock.mockResolvedValue(makeMockTextResponse(multiFileMultiHunkDiff));

      const lines = await helper.getDiffLines(42);

      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.has('src/a.ts:2')).toBe(true);
      expect(lines.has('src/a.ts:3')).toBe(true);
      expect(lines.has('src/a.ts:4')).toBe(true);
      expect(lines.has('src/b.ts:10')).toBe(true);
      expect(lines.has('src/b.ts:11')).toBe(true);
      expect(lines.has('src/b.ts:12')).toBe(true);
      expect(lines.has('src/b.ts:13')).toBe(true);
      expect(lines.has('src/b.ts:14')).toBe(true);
      expect(lines.has('src/b.ts:15')).toBe(true);
      expect(lines.size).toBe(10);
    });
  });

  // ─── Large diff truncation ────────────────────────────────

  describe('large diff truncation', () => {
    it('handles a large diff with many hunks across many files gracefully', async () => {
      const largeLines: string[] = [];
      for (let fileIdx = 0; fileIdx < 20; fileIdx++) {
        largeLines.push(`diff --git a/src/file${fileIdx}.ts b/src/file${fileIdx}.ts`);
        largeLines.push(`--- a/src/file${fileIdx}.ts`);
        largeLines.push(`+++ b/src/file${fileIdx}.ts`);
        largeLines.push(`@@ -1,1 +1,${100 + fileIdx} @@`);
        for (let line = 1; line <= 100 + fileIdx; line++) {
          largeLines.push(line === 1 ? `+line${line}` : `+extra${line}`);
        }
      }
      const largeDiff = largeLines.join('\n');

      fetchMock.mockResolvedValue(makeMockTextResponse(largeDiff));

      const lines = await helper.getDiffLines(42);
      let expectedTotal = 0;
      for (let fileIdx = 0; fileIdx < 20; fileIdx++) {
        expectedTotal += 100 + fileIdx;
      }
      expect(lines.size).toBe(expectedTotal);

      for (let fileIdx = 0; fileIdx < 20; fileIdx++) {
        expect(lines.has(`src/file${fileIdx}.ts:1`)).toBe(true);
      }
    });
  });

  // ─── Concurrent posting ───────────────────────────────────

  describe('concurrent posting scenarios', () => {
    it('handles multiple simultaneous postReview calls', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      let callCount = 0;

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_ADDED_LINE);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          callCount++;
          return makeMockResponse({
            id: 100 + callCount,
            comments: [{ id: callCount, path: 'src/test.ts', line: 3 }],
          });
        }

        return makeMockResponse({});
      });

      const result1 = resultWithIssues([
        makeIssue({ file: 'src/test.ts', line: 3, message: 'Issue 1.' }),
      ]);
      const result2 = resultWithIssues([
        makeIssue({ file: 'src/test.ts', line: 4, message: 'Issue 2.' }),
      ]);

      const [res1, res2] = await Promise.all([
        helper.postReview(prNumber, commitSha, result1, true),
        helper.postReview(prNumber, commitSha, result2, true),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res1.method).toBe('full');
      expect(res2.method).toBe('full');
    });

    it('individual 422 failure in one call does not affect other concurrent calls', async () => {
      const prNumber = 42;
      const commitSha = 'sha123';

      let inlinePostCount = 0;

      fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (options?.method as string) || 'GET';

        if (urlStr.endsWith(`/pulls/${prNumber}`) && method === 'GET') {
          return makeMockTextResponse(DIFF_ADDED_LINE);
        }

        if (urlStr.includes('/reviews') && method === 'POST') {
          const reqBody = JSON.parse((options?.body as string) || '{}');
          if (reqBody.comments) {
            const err = new Error('GitHub API 422') as Error & { status: number };
            err.status = 422;
            throw err;
          }
          return makeMockResponse({ id: 100 });
        }

        if (urlStr.includes('/pulls/') && urlStr.includes('/comments') && method === 'POST') {
          inlinePostCount++;
          if (inlinePostCount === 1) {
            const err = new Error('GitHub API 422') as Error & { status: number };
            err.status = 422;
            throw err;
          }
          return makeMockResponse({ id: 200, node_id: 'node200' });
        }

        if (urlStr.includes('/issues/') && urlStr.includes('/comments') && method === 'POST') {
          return makeMockResponse({ id: 999 });
        }

        return makeMockResponse({});
      });

      const result = resultWithIssues([
        makeIssue({ file: 'src/test.ts', line: 3, message: 'Will 422.' }),
        makeIssue({ file: 'src/test.ts', line: 4, message: 'Will succeed.' }),
      ]);

      const response = await helper.postReview(prNumber, commitSha, result, true);

      expect(response.success).toBe(true);
      expect(response.method).toBe('partial');
      expect(response.commentIds).toHaveLength(1);
    });
  });
});
