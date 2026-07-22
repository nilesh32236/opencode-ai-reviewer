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
    });

    it('falls back to issue comment when inline comment fails with 422', async () => {
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

      // Total calls: 8 add + 2 remove = 10 label operations
      // Batched: 5 + 5 => 2 batches for adds + 1 batch for removes = 2 Promise.all calls
      // Actually each individual addLabels/removeLabel call is a single API call
      // Operations are partitioned: [a,b,c,d,e] in first Promise.all, [f,g,h,x,y] in second
      expect(callCount).toBe(10);
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

  describe('custom apiUrl', () => {
    it('uses custom base URL for API calls', async () => {
      const customHelper = new GitHubHelper(TOKEN, REPO, 'https://custom.api.com');
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await customHelper.isPR(42);

      const callUrl = fetchMock.mock.calls[0][0] as string;
      expect(callUrl).toContain('https://custom.api.com');
    });
  });
});
