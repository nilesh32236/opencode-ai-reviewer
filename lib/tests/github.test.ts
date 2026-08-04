import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { GitHubHelper } from '../src/utils/github.js';

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

const TOKEN = 'test-token';
const REPO = 'owner/repo';
const API_URL = 'https://api.github.com';
const _BASE = `${API_URL}/repos/${REPO}`;

function mockResponse(overrides: Partial<Response> & { body?: unknown } = {}): Response {
  const headers = new Headers(
    (overrides as Record<string, unknown>).headers as Record<string, string> | undefined,
  );
  const { body, ...rest } = overrides;
  return {
    ok: true,
    status: 200,
    headers,
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(body !== undefined ? JSON.stringify(body) : ''),
    ...rest,
  } as unknown as Response;
}

function mockErrorResponse(status: number, statusText = 'Error'): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    json: vi.fn().mockRejectedValue(new Error('Not JSON')),
    text: vi.fn().mockResolvedValue(statusText),
  } as unknown as Response;
}

function sampleReviewResult(): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'medium' },
    strengths: [{ type: 'strength', file: 'src/a.ts', line: 10, message: 'Good code.' }],
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
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

describe('GitHubHelper', () => {
  let helper: GitHubHelper;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    helper = new GitHubHelper(TOKEN, REPO);
  });

  describe('constructor', () => {
    it('creates instance with default apiUrl', () => {
      expect(helper).toBeInstanceOf(GitHubHelper);
    });

    it('accepts custom apiUrl', () => {
      const h = new GitHubHelper(TOKEN, REPO, 'https://custom.api.com');
      expect(h).toBeInstanceOf(GitHubHelper);
    });
  });

  describe('getPR', () => {
    const prData = {
      number: 42,
      title: 'Fix the thing',
      body: 'Fixes #123',
      head: { ref: 'feature-branch', sha: 'abc123def' },
      base: { ref: 'main' },
      user: { login: 'testuser' },
      labels: [{ name: 'bug' }],
    };

    const filesData = [
      {
        path: 'src/index.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        patch: '@@ -1 +1 @@',
      },
    ];

    it('returns PR context for valid PR', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42/files')) {
          return mockResponse({ body: filesData });
        }
        return mockResponse({ body: prData });
      });

      const pr = await helper.getPR(42);

      expect(pr.number).toBe(42);
      expect(pr.title).toBe('Fix the thing');
      expect(pr.body).toBe('Fixes #123');
      expect(pr.headRef).toBe('feature-branch');
      expect(pr.headSha).toBe('abc123def');
      expect(pr.baseRef).toBe('main');
      expect(pr.author).toBe('testuser');
      expect(pr.labels).toEqual(['bug']);
      expect(pr.changedFiles).toHaveLength(1);
      expect(pr.changedFiles[0].path).toBe('src/index.ts');
      expect(pr.changedFiles[0].status).toBe('modified');
      expect(pr.linkedIssue).toBe(123);
    });

    it('maps filename from GitHub REST API to path in PRContext', async () => {
      const gitHubApiFiles = [
        {
          filename: 'src/app.ts',
          status: 'modified',
          additions: 10,
          deletions: 0,
          patch: '@@ -1 +1 @@',
        },
      ];
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/files')) return mockResponse({ body: gitHubApiFiles });
        return mockResponse({ body: prData });
      });

      const pr = await helper.getPR(42);
      expect(pr.changedFiles[0].path).toBe('src/app.ts');
    });

    it('handles PR body without linked issue keyword', async () => {
      const noLinkPR = { ...prData, body: 'No references here' };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/files')) return mockResponse({ body: [] });
        return mockResponse({ body: noLinkPR });
      });

      const pr = await helper.getPR(42);
      expect(pr.linkedIssue).toBeUndefined();
    });

    it('extracts linkedIssue from Closes keyword', async () => {
      const closesPR = { ...prData, body: 'Closes #456' };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/files')) return mockResponse({ body: [] });
        return mockResponse({ body: closesPR });
      });

      const pr = await helper.getPR(42);
      expect(pr.linkedIssue).toBe(456);
    });

    it('extracts linkedIssue from Resolves keyword', async () => {
      const resolvesPR = { ...prData, body: 'Resolves #789' };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/files')) return mockResponse({ body: [] });
        return mockResponse({ body: resolvesPR });
      });

      const pr = await helper.getPR(42);
      expect(pr.linkedIssue).toBe(789);
    });

    it('uses empty string for null body', async () => {
      const nullBodyPR = { ...prData, body: null };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/files')) return mockResponse({ body: [] });
        return mockResponse({ body: nullBodyPR });
      });

      const pr = await helper.getPR(42);
      expect(pr.body).toBe('');
    });

    it('throws when PR API fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/') && !url.includes('/files')) {
          return mockErrorResponse(404, 'Not Found');
        }
        return mockResponse({ body: [] });
      });

      await expect(helper.getPR(999)).rejects.toThrow('GitHub API 404');
    });

    it('throws when files API fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/files')) {
          return mockErrorResponse(500, 'Server Error');
        }
        return mockResponse({ body: prData });
      });

      await expect(helper.getPR(42)).rejects.toThrow('GitHub API 500');
    });
  });

  describe('isPR', () => {
    it('returns true when PR exists', async () => {
      fetchMock.mockImplementation(async (_url: string, _options?: RequestInit) => {
        return mockResponse({ body: {} });
      });

      const result = await helper.isPR(42);
      expect(result).toBe(true);
    });

    it('returns true when HEAD request succeeds with empty response body', async () => {
      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return new Response(null, { status: 200 });
        }
        return mockResponse({ body: {} });
      });

      const result = await helper.isPR(42);
      expect(result).toBe(true);
    });

    it('returns false on 404', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      const result = await helper.isPR(42);
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Network failure'));

      const result = await helper.isPR(42);
      expect(result).toBe(false);
    });
  });

  describe('getDefaultBranch', () => {
    it('returns default branch from repo API', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { default_branch: 'main' } }));

      const branch = await helper.getDefaultBranch();
      expect(branch).toBe('main');
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(helper.getDefaultBranch()).rejects.toThrow('GitHub API 404');
    });
  });

  describe('getIssue', () => {
    const issueData = {
      number: 1,
      title: 'Bug report',
      body: 'Something broke',
      labels: [{ name: 'bug' }],
    };

    const commentsData = [
      { user: { login: 'commenter1' }, created_at: '2024-01-01T00:00:00Z', body: 'First!' },
    ];

    it('returns issue context', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/issues/1/comments')) {
          return mockResponse({ body: commentsData });
        }
        return mockResponse({ body: issueData });
      });

      const issue = await helper.getIssue(1);

      expect(issue.number).toBe(1);
      expect(issue.title).toBe('Bug report');
      expect(issue.body).toBe('Something broke');
      expect(issue.labels).toEqual(['bug']);
      expect(issue.comments).toHaveLength(1);
      expect(issue.comments[0].author).toBe('commenter1');
    });

    it('handles null body', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/comments')) return mockResponse({ body: [] });
        return mockResponse({ body: { ...issueData, body: null } });
      });

      const issue = await helper.getIssue(1);
      expect(issue.body).toBe('');
    });

    it('handles comments fetch failure gracefully', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/comments')) {
          return mockErrorResponse(500);
        }
        return mockResponse({ body: issueData });
      });

      const issue = await helper.getIssue(1);
      expect(issue.number).toBe(1);
      expect(issue.comments).toEqual([]);
    });

    it('throws when issue API fails', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(helper.getIssue(999)).rejects.toThrow('GitHub API 404');
    });
  });

  describe('getIssueComments', () => {
    it('returns mapped comments', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          body: [
            { user: { login: 'alice' }, created_at: '2024-01-01T00:00:00Z', body: 'Great work' },
            { user: { login: 'bob' }, created_at: '2024-01-02T00:00:00Z', body: 'Needs fixes' },
          ],
        }),
      );

      const comments = await helper.getIssueComments(1);

      expect(comments).toHaveLength(2);
      expect(comments[0].author).toBe('alice');
      expect(comments[1].author).toBe('bob');
    });

    it('returns empty array for no comments', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [] }));

      const comments = await helper.getIssueComments(1);
      expect(comments).toEqual([]);
    });
  });

  describe('getDiffLines', () => {
    it('parses diff text into line set', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
 line2
+line3
+line4`;

      fetchMock.mockImplementation(async (_url: string, _options?: RequestInit) => {
        return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
      });

      const lines = await helper.getDiffLines(42);

      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.has('src/a.ts:2')).toBe(true);
      expect(lines.has('src/a.ts:3')).toBe(true);
      expect(lines.has('src/a.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });

    it('handles multi-line hunks', async () => {
      const diffText = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,7 +5,9 @@
 context
+new1
+new2`;

      fetchMock.mockImplementation(async () => {
        return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
      });

      const lines = await helper.getDiffLines(42);
      expect(lines.has('src/b.ts:5')).toBe(true);
      expect(lines.has('src/b.ts:6')).toBe(true);
      expect(lines.size).toBe(9);
    });

    it('returns empty set when diff fetch fails', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const lines = await helper.getDiffLines(42);
      expect(lines).toBeInstanceOf(Set);
      expect(lines.size).toBe(0);
    });

    it('returns empty set on non-ok response', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(500));

      const lines = await helper.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('handles no-comma hunk both sides', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
 context`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.size).toBe(1);
    });

    it('handles no-comma hunk on new side only', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1 @@
 context`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.size).toBe(1);
    });

    it('handles hunk with explicit zero line count (all lines deleted)', async () => {
      const diffText = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,7 +1,0 @@`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('skips \\\\ No newline at end of file markers', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
 line2
+line3
+line4
\\\\ No newline at end of file`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.has('src/a.ts:2')).toBe(true);
      expect(lines.has('src/a.ts:3')).toBe(true);
      expect(lines.has('src/a.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });

    it('skips binary diff sections', async () => {
      const diffText = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('handles renamed-only file with no hunks', async () => {
      const diffText = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('processes text hunks after a binary diff in the same response', async () => {
      const diffText = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
 line2
+line3
+line4`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.has('src/a.ts:2')).toBe(true);
      expect(lines.has('src/a.ts:3')).toBe(true);
      expect(lines.has('src/a.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });

    it('handles new file addition with @@ -0,0 +1 @@', async () => {
      const diffText = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+new content`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('new.ts:1')).toBe(true);
      expect(lines.size).toBe(1);
    });

    it('handles context text after @@ markers', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ some function name
 line1
 line2
+line3
+line4`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.has('src/a.ts:2')).toBe(true);
      expect(lines.has('src/a.ts:3')).toBe(true);
      expect(lines.has('src/a.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });

    it('does not register lines from deleted files', async () => {
      const diffText = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
 line1
 line2
+line3
+line4
diff --git a/deleted.ts b/deleted.ts
--- a/deleted.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-old1
-old2`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await helper.getDiffLines(42);
      expect(lines.has('file1.ts:1')).toBe(true);
      expect(lines.has('file1.ts:2')).toBe(true);
      expect(lines.has('file1.ts:3')).toBe(true);
      expect(lines.has('file1.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });
  });

  describe('postReview', () => {
    it('posts full review with inline comments', async () => {
      const diffText = `@@ -42,1 +42,1 @@`;

      fetchMock.mockImplementation(async (url: string, _options?: RequestInit) => {
        if (
          url.includes('/pulls/42') &&
          !url.includes('/reviews') &&
          !url.includes('/comments') &&
          !url.includes('/files')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({
            body: {
              id: 1,
              comments: [{ id: 100, path: 'src/b.ts', line: 42 }],
            },
          });
        }
        if (url.includes('/pulls/42/comments')) {
          return mockResponse({ body: { id: 2 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('full');
      expect(result.commentIds).toHaveLength(1);
      expect(result.commentIds![0]).toMatchObject({
        file: 'src/b.ts',
        line: 42,
        commentId: 100,
      });
    });

    it('successfully posts batched review with inline comments', async () => {
      const diffText = `@@ -42,1 +42,1 @@`;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (
          url.includes('/pulls/42') &&
          !url.includes('/reviews') &&
          !url.includes('/comments') &&
          !url.includes('/files')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        if (url.includes('/pulls/42/reviews')) {
          if (options && typeof options.body === 'string' && options.body.includes('comments')) {
            return mockResponse({
              body: {
                id: 1,
                comments: [{ id: 100, path: 'src/b.ts', line: 42 }],
              },
            });
          }
          return mockResponse({ body: { id: 1 } });
        }
        if (url.includes('/pulls/42/comments')) {
          return mockResponse({ body: { id: 2 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('full');
      expect(result.commentIds).toHaveLength(1);
      expect(result.commentIds![0]).toMatchObject({
        file: 'src/b.ts',
        line: 42,
        commentId: 100,
      });
    });

    it('falls back to issue comment when inline comment fails with 422', async () => {
      const diffText = `@@ -42,1 +42,1 @@`;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (
          url.includes('/pulls/42') &&
          !url.includes('/reviews') &&
          !url.includes('/comments') &&
          !url.includes('/files')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        // First POST to /reviews is the batched request with inline comments — reject it
        if (url.includes('/pulls/42/reviews')) {
          if (options && typeof options.body === 'string' && options.body.includes('comments')) {
            const err = new Error('GitHub API 422 on /pulls/42/reviews: Unprocessable') as Error & {
              status: number;
            };
            err.status = 422;
            throw err;
          }
          return mockResponse({ body: { id: 1 } });
        }
        if (url.includes('/pulls/42/comments')) {
          const err = new Error('GitHub API 422 on /pulls/42/comments: Unprocessable') as Error & {
            status: number;
          };
          err.status = 422;
          throw err;
        }
        if (url.includes('/issues/42/comments')) {
          return mockResponse({ body: { id: 999 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('partial');
    });

    it('falls back to individual comments when batched review fails with 422', async () => {
      const diffText = `@@ -42,1 +42,1 @@`;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (
          url.includes('/pulls/42') &&
          !url.includes('/reviews') &&
          !url.includes('/comments') &&
          !url.includes('/files')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        // First POST to /reviews is the batched request — reject with 422
        if (url.includes('/pulls/42/reviews')) {
          if (options && typeof options.body === 'string' && options.body.includes('comments')) {
            const err = new Error('GitHub API 422 on /pulls/42/reviews: Unprocessable') as Error & {
              status: number;
            };
            err.status = 422;
            throw err;
          }
          return mockResponse({ body: { id: 1 } });
        }
        // Individual inline comment POST succeeds
        if (url.includes('/pulls/42/comments')) {
          return mockResponse({ body: { id: 200, node_id: 'node200' } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('partial');
      expect(result.commentIds).toHaveLength(1);
      expect(result.commentIds![0]).toMatchObject({
        file: 'src/b.ts',
        line: 42,
        commentId: 200,
      });
      expect(result.reviewId).toBe(1);
    });

    it('returns failed when review API fails with non-422 error', async () => {
      const diffText = `@@ -42,1 +42,1 @@`;

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42') && !url.includes('/reviews') && !url.includes('/comments')) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        if (url.includes('/pulls/42/reviews')) {
          const err = new Error('GitHub API 500 on /pulls/42/reviews: Server error') as Error & {
            status: number;
          };
          err.status = 500;
          throw err;
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(false);
      expect(result.method).toBe('failed');
    });

    it('posts body-only when no inline comments exist', async () => {
      const diffText = `@@ -1,1 +1,1 @@`;
      const noInlineResult: ReviewResult = {
        ...sampleReviewResult(),
        issues: [
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/c.ts',
            line: 5,
            message: 'Nit.',
            inline: false,
          },
        ],
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42') && !url.includes('/reviews') && !url.includes('/comments')) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({ body: { id: 1 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', noInlineResult);

      expect(result.success).toBe(true);
      expect(result.method).toBe('body-only');
    });

    it('forces body-only when postInlineComments is false even with inline issues', async () => {
      const diffText = `@@ -42,1 +42,1 @@`;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (
          url.includes('/pulls/42') &&
          !url.includes('/reviews') &&
          !url.includes('/comments') &&
          !url.includes('/files')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(diffText) });
        }
        if (url.includes('/pulls/42/reviews')) {
          const reqBody = options?.body ? JSON.parse(options.body as string) : {};
          expect(reqBody.comments).toBeUndefined();
          return mockResponse({ body: { id: 1 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postReview(42, 'sha123', sampleReviewResult(), false);

      expect(result.success).toBe(true);
      expect(result.method).toBe('body-only');
    });
  });

  describe('postOrUpdateComment', () => {
    const marker = '## OpenCode Review';

    it('creates new comment when no existing one matches marker', async () => {
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/issues/1/comments') && options?.method === 'POST') {
          return mockResponse({ body: { id: 999 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await helper.postOrUpdateComment(1, marker, 'New review');

      expect(result.action).toBe('created');
      expect(result.commentId).toBe(999);
    });

    it('updates existing comment when marker matches', async () => {
      let patchCalled = false;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/issues/comments/') && options?.method === 'PATCH') {
          patchCalled = true;
          return mockResponse({ body: {} });
        }
        return mockResponse({
          body: [
            { id: 1, body: 'not matching' },
            { id: 42, body: `${marker}\n\nOld review` },
          ],
        });
      });

      const result = await helper.postOrUpdateComment(1, marker, 'Updated review');

      expect(result.action).toBe('updated');
      expect(result.commentId).toBe(42);
      expect(patchCalled).toBe(true);
    });

    it('re-throws error on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(500));

      await expect(helper.postOrUpdateComment(1, marker, 'body')).rejects.toThrow('GitHub API 500');
    });
  });

  describe('replyToReviewComment', () => {
    it('posts a reply and returns the comment id', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { id: 789 } }));

      const result = await helper.replyToReviewComment(42, 100, 'Good question!');

      expect(result.id).toBe(789);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/pulls/42/comments/100/replies'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Good question!'),
        }),
      );
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      await expect(helper.replyToReviewComment(42, 100, 'body')).rejects.toThrow('GitHub API 422');
    });
  });

  describe('getReviewComment', () => {
    it('returns a review comment by id', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          body: {
            id: 123,
            body: 'This is a review comment',
            user: { login: 'opencode-bot', type: 'Bot' },
            path: 'src/index.ts',
            line: 42,
            in_reply_to_id: null,
            pull_request_review_id: 1,
          },
        }),
      );

      const comment = await helper.getReviewComment(1, 123);

      expect(comment.id).toBe(123);
      expect(comment.body).toBe('This is a review comment');
      expect(comment.user.type).toBe('Bot');
      expect(comment.path).toBe('src/index.ts');
      expect(comment.line).toBe(42);
      expect(comment.in_reply_to_id).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/pulls/comments/123'),
        expect.any(Object),
      );
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(helper.getReviewComment(1, 999)).rejects.toThrow('GitHub API 404');
    });

    it('propagates an already-aborted signal into the fetch request', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { id: 1 } }));
      const controller = new AbortController();
      controller.abort();

      await helper.getReviewComment(1, 2, controller.signal);

      // The fetch must have been issued with an aborted signal so it cannot run
      // uncancellable in the gap between the retry loop and listener registration.
      const fetchArgs = fetchMock.mock.calls[0][1] as RequestInit;
      expect(fetchArgs.signal).toBeDefined();
      expect((fetchArgs.signal as AbortSignal).aborted).toBe(true);
    });
  });

  describe('getReviewCommentThread', () => {
    it('walks in_reply_to_id chain to build thread', async () => {
      // Leaf comment replies to comment 2, which replies to comment 1 (root)
      const leafComment = {
        id: 3,
        body: 'Why is this critical?',
        user: { login: 'developer', type: 'User' },
        path: 'src/index.ts',
        line: 42,
        in_reply_to_id: 2,
        pull_request_review_id: 1,
      };
      const middleComment = {
        id: 2,
        body: 'Please fix this',
        user: { login: 'opencode-bot', type: 'Bot' },
        path: 'src/index.ts',
        line: 42,
        in_reply_to_id: 1,
        pull_request_review_id: 1,
      };
      const rootComment = {
        id: 1,
        body: 'This line has a bug',
        user: { login: 'opencode-bot', type: 'Bot' },
        path: 'src/index.ts',
        line: 42,
        in_reply_to_id: null,
        pull_request_review_id: 1,
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/comments/3')) return mockResponse({ body: leafComment });
        if (url.includes('/pulls/comments/2')) return mockResponse({ body: middleComment });
        if (url.includes('/pulls/comments/1')) return mockResponse({ body: rootComment });
        return mockResponse({ body: {} });
      });

      const thread = await helper.getReviewCommentThread(3);

      expect(thread.comments).toHaveLength(3);
      expect(thread.comments[0].id).toBe(1);
      expect(thread.comments[0].author).toBe('opencode-bot');
      expect(thread.comments[1].id).toBe(2);
      expect(thread.comments[2].id).toBe(3);
      expect(thread.comments[2].author).toBe('developer');
      expect(thread.rootComment.id).toBe(1);
      expect(thread.rootComment.isBot).toBe(true);
      expect(thread.filePath).toBe('src/index.ts');
      expect(thread.lineNumber).toBe(42);
    });

    it('handles single comment thread (no replies)', async () => {
      const comment = {
        id: 1,
        body: 'Issue here',
        user: { login: 'opencode-bot', type: 'Bot' },
        path: 'src/app.ts',
        line: 10,
        in_reply_to_id: null,
        pull_request_review_id: 1,
      };

      fetchMock.mockResolvedValue(mockResponse({ body: comment }));

      const thread = await helper.getReviewCommentThread(1);

      expect(thread.comments).toHaveLength(1);
      expect(thread.rootComment.id).toBe(1);
      expect(thread.filePath).toBe('src/app.ts');
      expect(thread.lineNumber).toBe(10);
    });

    it('throws when root comment has no file path', async () => {
      const comment = {
        id: 1,
        body: 'General comment',
        user: { login: 'opencode-bot', type: 'Bot' },
        path: undefined,
        line: undefined,
        in_reply_to_id: null,
        pull_request_review_id: 1,
      };

      fetchMock.mockResolvedValue(mockResponse({ body: comment }));

      // Should resolve with empty filePath
      const thread = await helper.getReviewCommentThread(1);
      expect(thread.filePath).toBe('');
      expect(thread.lineNumber).toBeUndefined();
    });

    it('reconstructs thread from paginated list in a single pass (prNumber provided)', async () => {
      const comments = [
        {
          id: 1,
          body: 'root',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: null,
        },
        {
          id: 2,
          body: 'middle',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 1,
        },
        {
          id: 3,
          body: 'leaf',
          user: { login: 'developer', type: 'User' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 2,
        },
      ];

      fetchMock.mockResolvedValue(mockResponse({ body: comments }));

      const thread = await helper.getReviewCommentThread(3, 1);

      expect(thread.comments.map((c) => c.id)).toEqual([1, 2, 3]);
      expect(thread.rootComment.id).toBe(1);
      expect(thread.filePath).toBe('src/index.ts');
      expect(thread.lineNumber).toBe(42);
      // No duplicate IDs from the single-pass path
      expect(new Set(thread.comments.map((c) => c.id)).size).toBe(3);
    });

    it('fetches the single-pass window newest-first (direction=desc)', async () => {
      const comments = [
        {
          id: 1,
          body: 'root',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: null,
        },
        {
          id: 2,
          body: 'leaf',
          user: { login: 'developer', type: 'User' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 1,
        },
      ];

      fetchMock.mockResolvedValue(mockResponse({ body: comments }));

      await helper.getReviewCommentThread(2, 1);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('direction=desc'),
        expect.any(Object),
      );
    });

    it('fetches missing ancestors without duplicating in-window comments', async () => {
      // Window contains the middle ancestor (2) and the leaf (3) but NOT the
      // root (1). The direct-walk fallback must start from the deepest found
      // ancestor so in-window comments are never re-fetched or re-added.
      const windowComments = [
        {
          id: 2,
          body: 'middle',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 1,
        },
        {
          id: 3,
          body: 'leaf',
          user: { login: 'developer', type: 'User' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 2,
        },
      ];
      const rootComment = {
        id: 1,
        body: 'root',
        user: { login: 'opencode-bot', type: 'Bot' },
        path: 'src/index.ts',
        line: 42,
        in_reply_to_id: null,
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/1/comments')) return mockResponse({ body: windowComments });
        if (url.includes('/pulls/comments/1')) return mockResponse({ body: rootComment });
        return mockResponse({ body: {} });
      });

      const thread = await helper.getReviewCommentThread(3, 1);

      expect(thread.comments.map((c) => c.id)).toEqual([1, 2, 3]);
      // The regression this guards against: [1, 2, 2, 3] from re-fetching an
      // in-window ancestor would leave a duplicate ID in the thread.
      expect(new Set(thread.comments.map((c) => c.id)).size).toBe(3);
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/pulls/comments/2'));
    });

    it('walks the full chain when the trigger is outside the paginated window', async () => {
      const comments = [
        {
          id: 1,
          body: 'root',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: null,
        },
        {
          id: 2,
          body: 'middle',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 1,
        },
        {
          id: 3,
          body: 'leaf',
          user: { login: 'developer', type: 'User' },
          path: 'src/index.ts',
          line: 42,
          in_reply_to_id: 2,
        },
      ];

      // Empty paginated window -> falls back to direct chain walk.
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/1/comments')) return mockResponse({ body: [] });
        if (url.includes('/pulls/comments/3')) return mockResponse({ body: comments[2] });
        if (url.includes('/pulls/comments/2')) return mockResponse({ body: comments[1] });
        if (url.includes('/pulls/comments/1')) return mockResponse({ body: comments[0] });
        return mockResponse({ body: {} });
      });

      const thread = await helper.getReviewCommentThread(3, 1);

      expect(thread.comments.map((c) => c.id)).toEqual([1, 2, 3]);
      expect(thread.rootComment.id).toBe(1);
    });

    it('anchors filePath/lineNumber on the root comment', async () => {
      const comments = [
        {
          id: 1,
          body: 'root',
          user: { login: 'opencode-bot', type: 'Bot' },
          path: 'src/root.ts',
          line: 10,
          in_reply_to_id: null,
        },
        {
          id: 2,
          body: 'leaf',
          user: { login: 'developer', type: 'User' },
          path: 'src/leaf.ts',
          line: 99,
          in_reply_to_id: 1,
        },
      ];

      fetchMock.mockResolvedValue(mockResponse({ body: comments }));

      const thread = await helper.getReviewCommentThread(2, 1);

      // Prior leaf-to-root semantics anchored on the root comment.
      expect(thread.filePath).toBe('src/root.ts');
      expect(thread.lineNumber).toBe(10);
    });

    it('guards against cyclic in_reply_to_id chains in the in-window walk', async () => {
      const comments = [
        { id: 1, body: 'a', user: { login: 'user', type: 'User' }, in_reply_to_id: 2 },
        { id: 2, body: 'b', user: { login: 'user', type: 'User' }, in_reply_to_id: 1 },
      ];

      fetchMock.mockResolvedValue(mockResponse({ body: comments }));

      const thread = await helper.getReviewCommentThread(1, 1);

      expect(thread.comments.map((c) => c.id)).toEqual([2, 1]);
      // No duplicate IDs even when the chain loops back on itself.
      expect(new Set(thread.comments.map((c) => c.id)).size).toBe(2);
    });

    it('guards against cycles in the direct-fetch ancestor walk', async () => {
      // Window contains the trigger (2) which replies to 1; 1 is fetched
      // directly and (malformed) replies back to 2 — the walk must terminate
      // without re-fetching or duplicating the in-window trigger.
      const windowComments = [
        { id: 2, body: 'trigger', user: { login: 'user', type: 'User' }, in_reply_to_id: 1 },
      ];
      const cyclicAncestor = {
        id: 1,
        body: 'ancestor',
        user: { login: 'user', type: 'User' },
        in_reply_to_id: 2,
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/1/comments')) return mockResponse({ body: windowComments });
        if (url.includes('/pulls/comments/1')) return mockResponse({ body: cyclicAncestor });
        return mockResponse({ body: {} });
      });

      const thread = await helper.getReviewCommentThread(2, 1);

      expect(thread.comments.map((c) => c.id)).toEqual([1, 2]);
      expect(new Set(thread.comments.map((c) => c.id)).size).toBe(2);
      // The window fetch plus a single direct fetch of the missing root only.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('guards against cyclic in_reply_to_id chains in the direct walk (no prNumber)', async () => {
      const leaf = {
        id: 1,
        body: 'a',
        user: { login: 'user', type: 'User' },
        in_reply_to_id: 2,
      };
      const other = {
        id: 2,
        body: 'b',
        user: { login: 'user', type: 'User' },
        in_reply_to_id: 1,
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/comments/1')) return mockResponse({ body: leaf });
        if (url.includes('/pulls/comments/2')) return mockResponse({ body: other });
        return mockResponse({ body: {} });
      });

      const thread = await helper.getReviewCommentThread(1);

      expect(thread.comments.map((c) => c.id)).toEqual([2, 1]);
      expect(new Set(thread.comments.map((c) => c.id)).size).toBe(2);
    });
  });

  describe('createComment', () => {
    it('creates a comment and returns its id', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { id: 456 } }));

      const result = await helper.createComment(1, 'Nice PR');

      expect(result.id).toBe(456);
    });

    it('throws on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(403));

      await expect(helper.createComment(1, 'body')).rejects.toThrow('GitHub API 403');
    });
  });

  describe('createIssue', () => {
    it('creates issue and returns number and url', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ body: { number: 10, html_url: 'https://github.com/owner/repo/issues/10' } }),
      );

      const result = await helper.createIssue('Bug', 'Description', ['bug']);

      expect(result).not.toBeNull();
      expect(result!.number).toBe(10);
      expect(result!.url).toBe('https://github.com/owner/repo/issues/10');
    });

    it('returns null on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      const result = await helper.createIssue('Bad', 'body', []);
      expect(result).toBeNull();
    });
  });

  describe('createPR', () => {
    it('creates PR and returns number and url', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          body: { number: 42, html_url: 'https://github.com/owner/repo/pull/42' },
        }),
      );

      const result = await helper.createPR('Title', 'Body', 'feature-branch', 'main');

      expect(result).not.toBeNull();
      expect(result!.number).toBe(42);
      expect(result!.url).toBe('https://github.com/owner/repo/pull/42');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/pulls'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"title":"Title"'),
        }),
      );
    });

    it('returns null on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      const result = await helper.createPR('Title', 'Body', 'head', 'base');
      expect(result).toBeNull();
    });
  });

  describe('addLabels', () => {
    it('posts labels to issue', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await helper.addLabels(1, ['bug', 'enhancement']);

      expect(fetchMock).toHaveBeenCalled();
    });

    it('throws on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(helper.addLabels(1, ['bug'])).rejects.toThrow('GitHub API 404');
    });
  });

  describe('removeLabel', () => {
    it('deletes label from issue', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await expect(helper.removeLabel(1, 'wontfix')).resolves.toBeUndefined();
    });

    it('does not throw on 404 (label may not exist)', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(helper.removeLabel(1, 'missing')).resolves.toBeUndefined();
    });
  });

  describe('setLabels', () => {
    it('adds and removes labels in batches of 5', async () => {
      let callCount = 0;

      fetchMock.mockImplementation(async () => {
        callCount++;
        return mockResponse({ body: {} });
      });

      const addLabels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const removeLabels = ['x', 'y'];

      await helper.setLabels(1, addLabels, removeLabels);

      // All adds are batched into a single addLabels call; removes are individual calls.
      // Total: 1 addLabels call (all 8) + 2 removeLabel calls = 3 API calls
      expect(callCount).toBe(3);
    });

    it('handles empty add and remove arrays', async () => {
      await helper.setLabels(1, [], []);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ensureLabels', () => {
    it('creates labels in batches of 3', async () => {
      let callCount = 0;

      fetchMock.mockImplementation(async () => {
        callCount++;
        return mockResponse({ body: {} });
      });

      await helper.ensureLabels(['label1', 'label2', 'label3', 'label4']);

      expect(callCount).toBe(4);
    });

    it('handles partial failures gracefully', async () => {
      let callCount = 0;

      fetchMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return mockErrorResponse(422);
        }
        return mockResponse({ body: {} });
      });

      await expect(helper.ensureLabels(['good', 'bad', 'also-good'])).resolves.toBeUndefined();
    });

    it('handles empty labels array', async () => {
      await helper.ensureLabels([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses the semantic palette color for severity labels', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await helper.ensureLabels(['audit:critical']);

      const postCall = fetchMock.mock.calls.find(
        ([, opts]: [string, RequestInit]) => opts?.method === 'POST',
      );
      const body = JSON.parse(String(postCall?.[1]?.body));
      expect(body.color).toBe('b60205');
    });
  });

  describe('gatherContext', () => {
    const prData = {
      number: 42,
      title: 'PR title',
      body: 'PR desc',
      head: { ref: 'branch', sha: 'sha1' },
      base: { ref: 'main' },
      user: { login: 'author' },
      labels: [{ name: 'enhancement' }],
    };

    it('gathers issue context when issueNumber is provided', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/issues/1') && !url.includes('/comments')) {
          return mockResponse({
            body: { number: 1, title: 'Issue title', body: 'Issue body', labels: [] },
          });
        }
        if (url.includes('/issues/1/comments')) {
          return mockResponse({
            body: [
              { user: { login: 'u1' }, created_at: '2024-01-01T00:00:00Z', body: 'Comment 1' },
            ],
          });
        }
        return mockResponse({ body: [] });
      });

      const context = await helper.gatherContext({ issueNumber: 1 });

      expect(context).toContain('Issue #1');
      expect(context).toContain('Issue title');
      expect(context).toContain('Comment 1');
    });

    it('gathers PR context when prNumber is provided', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42/files')) {
          return mockResponse({
            body: [
              {
                path: 'f.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                patch: '@@ -1 +1 @@',
              },
            ],
          });
        }
        if (url.includes('/pulls/42/comments')) {
          return mockResponse({
            body: [{ user: { login: 'reviewer' }, path: 'f.ts', line: 5, body: 'Nice' }],
          });
        }
        if (url.includes('/pulls/42/reviews')) {
          return mockResponse({
            body: [{ user: { login: 'reviewer' }, state: 'APPROVED', body: 'LGTM' }],
          });
        }
        if (url.includes('/pulls/42')) {
          return mockResponse({ body: prData });
        }
        return mockResponse({ body: [] });
      });

      const context = await helper.gatherContext({ prNumber: 42 });

      expect(context).toContain('PR #42');
      expect(context).toContain('PR title');
      expect(context).toContain('Inline Review Comments');
      expect(context).toContain('APPROVED');
    });

    it('gathers both issue and PR context simultaneously', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/issues/1') && !url.includes('/comments')) {
          return mockResponse({ body: { number: 1, title: 'Issue', body: 'body', labels: [] } });
        }
        if (url.includes('/issues/1/comments')) {
          return mockResponse({ body: [] });
        }
        if (
          url.includes('/pulls/42/files') ||
          url.includes('/pulls/42/comments') ||
          url.includes('/pulls/42/reviews')
        ) {
          return mockResponse({ body: [] });
        }
        if (url.includes('/pulls/42')) {
          return mockResponse({ body: prData });
        }
        return mockResponse({ body: [] });
      });

      const context = await helper.gatherContext({ issueNumber: 1, prNumber: 42 });

      expect(context).toContain('Issue #1');
      expect(context).toContain('PR #42');
    });

    it('returns empty string when neither is provided', async () => {
      const context = await helper.gatherContext({});
      expect(context).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('closeOpenCodePRs', () => {
    it('closes PRs with opencode/ head ref', async () => {
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/pulls?state=open')) {
          return mockResponse({
            body: [
              { number: 1, head: { ref: 'opencode/fix-1' }, created_at: '2024-01-01T00:00:00Z' },
              { number: 2, head: { ref: 'opencode/fix-2' }, created_at: '2024-01-02T00:00:00Z' },
              { number: 3, head: { ref: 'manual-branch' }, created_at: '2024-01-03T00:00:00Z' },
            ],
          });
        }
        if (url.includes('/pulls/') && options?.method === 'PATCH') {
          return mockResponse({ body: {} });
        }
        return mockResponse({ body: [] });
      });

      await helper.closeOpenCodePRs();

      // Should have closed 2 PRs (opencode/fix-1 and opencode/fix-2)
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, opts]: [string, RequestInit]) => url.includes('/pulls/') && opts?.method === 'PATCH',
      );
      expect(patchCalls).toHaveLength(2);
    });

    it('filters by since date', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/pulls?state=open')) {
          return mockResponse({
            body: [
              { number: 1, head: { ref: 'opencode/fix-1' }, created_at: '2024-01-01T00:00:00Z' },
              { number: 2, head: { ref: 'opencode/fix-2' }, created_at: '2024-02-01T00:00:00Z' },
            ],
          });
        }
        if (url.includes('/pulls/') && url.includes('/pulls/1')) {
          return mockResponse({ body: {} });
        }
        return mockResponse({ body: [] });
      });

      await helper.closeOpenCodePRs('2024-01-15T00:00:00Z');

      const patchCalls = fetchMock.mock.calls.filter(
        ([url, opts]: [string, RequestInit]) => url.includes('/pulls/') && opts?.method === 'PATCH',
      );
      // Only PR #2 (created Feb 1) should be closed
      expect(patchCalls).toHaveLength(1);
    });
  });

  describe('mergePR', () => {
    it('returns true on successful merge', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      const result = await helper.mergePR(42);
      expect(result).toBe(true);
    });

    it('returns false on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(409));

      const result = await helper.mergePR(42);
      expect(result).toBe(false);
    });
  });

  describe('enableAutoMerge', () => {
    it('returns true on success', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      const result = await helper.enableAutoMerge(42);
      expect(result).toBe(true);
    });

    it('returns false on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(405));

      const result = await helper.enableAutoMerge(42);
      expect(result).toBe(false);
    });
  });

  describe('closeIssue', () => {
    it('closes issue without comment', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await helper.closeIssue(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('closes issue with comment', async () => {
      let patchDone = false;

      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patchDone = true;
          return mockResponse({ body: {} });
        }
        if (options?.method === 'POST') {
          return mockResponse({ body: { id: 999 } });
        }
        return mockResponse({ body: {} });
      });

      await helper.closeIssue(1, 'Closed via automation');

      expect(patchDone).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not throw when PATCH fails', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(helper.closeIssue(999)).resolves.toBeUndefined();
    });

    it('does not throw when comment POST fails', async () => {
      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          return mockResponse({ body: {} });
        }
        throw new Error('Comment failed');
      });

      await expect(helper.closeIssue(1, 'comment')).resolves.toBeUndefined();
    });
  });

  describe('rate limit handling', () => {
    it('warns when rate limit is low', async () => {
      const { warning } = await import('@actions/core');

      fetchMock.mockImplementation(async () => {
        const headers = new Headers();
        headers.set('X-RateLimit-Remaining', '25');
        headers.set('X-RateLimit-Reset', '2000000000');
        return mockResponse({ headers, body: {} });
      });

      await helper.isPR(1);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('rate limit low'));
    });

    it('warns on 429 with retry-after header', async () => {
      const { warning } = await import('@actions/core');

      fetchMock.mockImplementation(async () => {
        const headers = new Headers();
        headers.set('Retry-After', '10');
        return mockResponse({ ok: false, status: 429, headers });
      });

      await helper.isPR(1);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
    });
  });

  describe('paginate', () => {
    it('returns all items from single page', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }, { id: 2 }] }));

      const result = await helper.paginate('/issues/1/comments');
      expect(result).toHaveLength(2);
    });

    it('appends direction to the page URL', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      await helper.paginate('/issues/1/comments', { perPage: 100, maxPages: 1, direction: 'asc' });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('direction=asc');
    });

    it('rethrows page-fetch errors when throwOnError is set', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(500));

      await expect(
        helper.paginate('/issues/1/comments', { perPage: 100, maxPages: 2, throwOnError: true }),
      ).rejects.toThrow('GitHub API 500');
    });

    it('returns partial data silently when throwOnError is not set', async () => {
      const { warning } = await import('@actions/core');

      let callCount = 0;
      fetchMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1)
          return mockResponse({ body: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
        return mockErrorResponse(500);
      });

      const result = await helper.paginate('/issues/1/comments');
      expect(result).toHaveLength(100);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch page'));
    });
  });

  describe('custom apiUrl', () => {
    it('uses custom base URL for API calls', async () => {
      const customHelper = new GitHubHelper(TOKEN, REPO, 'https://custom.api.com');
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await customHelper.isPR(42);

      const callUrl = fetchMock.mock.calls[0][0] as string;
      expect(callUrl).toContain('https://custom.api.com');
    });
  });

  describe('createCheckRun', () => {
    it('creates a check run with the given conclusion and output', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { id: 77 } }));

      const result = await helper.createCheckRun('OpenCode AI Reviewer', 'abc123', 'failure', {
        title: 'Issues found',
        summary: '2 issues',
        text: 'details',
      });

      expect(result).toEqual({ id: 77 });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/repos/owner/repo/check-runs');
      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse((options as RequestInit).body as string);
      expect(body).toEqual({
        name: 'OpenCode AI Reviewer',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'failure',
        output: { title: 'Issues found', summary: '2 issues', text: 'details' },
      });
    });
  });

  describe('updateCheckRun', () => {
    it('patches the check run with an updated conclusion and output', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await helper.updateCheckRun(77, 'success', {
        title: 'All clear',
        summary: 'No issues',
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/repos/owner/repo/check-runs/77');
      const [, options] = fetchMock.mock.calls[0];
      expect((options as RequestInit).method).toBe('PATCH');
      const body = JSON.parse((options as RequestInit).body as string);
      expect(body).toEqual({
        status: 'completed',
        conclusion: 'success',
        output: { title: 'All clear', summary: 'No issues' },
      });
    });
  });
});
