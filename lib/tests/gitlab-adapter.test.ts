import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInlineComments } from '../src/jsonl-parser.js';
import type { ReviewResult } from '../src/types/index.js';
import { GitLabAdapter } from '../src/utils/gitlab-adapter.js';

const { retryErrors } = vi.hoisted(() => ({ retryErrors: [] as unknown[] }));

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug };
});

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (error) {
      retryErrors.push(error);
      throw error;
    }
  }),
  withRetryAndTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../src/jsonl-parser.js', () => ({
  buildInlineComments: vi.fn(),
}));

const TOKEN = 'test-token';
const REPO = 'owner/repo';
const API_URL = 'https://gitlab.com/api/v4';
const ENCODED_REPO = encodeURIComponent(REPO);
const _BASE = `${API_URL}/projects/${ENCODED_REPO}`;

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

describe('GitLabAdapter', () => {
  let adapter: GitLabAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    retryErrors.length = 0;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    adapter = new GitLabAdapter(TOKEN, REPO);
  });

  describe('constructor', () => {
    it('creates instance with default apiUrl', () => {
      expect(adapter).toBeInstanceOf(GitLabAdapter);
    });

    it('accepts custom apiUrl', () => {
      const h = new GitLabAdapter(TOKEN, REPO, 'https://custom.gitlab.com/api/v4');
      expect(h).toBeInstanceOf(GitLabAdapter);
    });
  });

  describe('getMR', () => {
    const mrData = {
      iid: 42,
      title: 'Fix the thing',
      description: 'Fixes #123',
      source_branch: 'feature-branch',
      sha: 'abc123def',
      target_branch: 'main',
      author: { username: 'testuser' },
      labels: ['bug'],
    };

    const changesData = {
      changes: [
        {
          new_path: 'src/index.ts',
          old_path: 'src/index.ts',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          diff: '@@ -1 +1 @@',
        },
      ],
    };

    it('returns PR context for valid MR', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) {
          return mockResponse({ body: changesData });
        }
        return mockResponse({ body: mrData });
      });

      const mr = await adapter.getMR(42);

      expect(mr.number).toBe(42);
      expect(mr.title).toBe('Fix the thing');
      expect(mr.body).toBe('Fixes #123');
      expect(mr.headRef).toBe('feature-branch');
      expect(mr.headSha).toBe('abc123def');
      expect(mr.baseRef).toBe('main');
      expect(mr.author).toBe('testuser');
      expect(mr.labels).toEqual(['bug']);
      expect(mr.changedFiles).toHaveLength(1);
      expect(mr.changedFiles[0].path).toBe('src/index.ts');
      expect(mr.changedFiles[0].status).toBe('modified');
      expect(mr.linkedIssue).toBe(123);
    });

    it('handles changes fetch failure gracefully', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) {
          return mockErrorResponse(500);
        }
        return mockResponse({ body: mrData });
      });

      const mr = await adapter.getMR(42);
      expect(mr.changedFiles).toEqual([]);
    });

    it('throws when MR fetch fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) {
          return mockResponse({ body: changesData });
        }
        return mockErrorResponse(404, 'Not Found');
      });

      await expect(adapter.getMR(999)).rejects.toThrow('GitLab API 404');
    });

    it('handles null description without linked issue', async () => {
      const noDesc = { ...mrData, description: null };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: { changes: [] } });
        return mockResponse({ body: noDesc });
      });

      const mr = await adapter.getMR(42);
      expect(mr.body).toBe('');
      expect(mr.linkedIssue).toBeUndefined();
    });

    it('extracts linkedIssue from Closes keyword', async () => {
      const closesMR = { ...mrData, description: 'Closes #456' };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: { changes: [] } });
        return mockResponse({ body: closesMR });
      });

      const mr = await adapter.getMR(42);
      expect(mr.linkedIssue).toBe(456);
    });

    it('extracts linkedIssue from Resolves keyword', async () => {
      const resolvesMR = { ...mrData, description: 'Resolves #789' };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: { changes: [] } });
        return mockResponse({ body: resolvesMR });
      });

      const mr = await adapter.getMR(42);
      expect(mr.linkedIssue).toBe(789);
    });

    it('maps deleted_file status correctly', async () => {
      const delChanges = {
        changes: [
          {
            new_path: 'old.ts',
            old_path: 'old.ts',
            new_file: false,
            renamed_file: false,
            deleted_file: true,
            diff: '',
          },
        ],
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: delChanges });
        return mockResponse({ body: mrData });
      });

      const mr = await adapter.getMR(42);
      expect(mr.changedFiles[0].status).toBe('removed');
    });

    it('maps new_file status correctly', async () => {
      const newChanges = {
        changes: [
          {
            new_path: 'new.ts',
            old_path: 'new.ts',
            new_file: true,
            renamed_file: false,
            deleted_file: false,
            diff: '',
          },
        ],
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: newChanges });
        return mockResponse({ body: mrData });
      });

      const mr = await adapter.getMR(42);
      expect(mr.changedFiles[0].status).toBe('added');
    });

    it('maps renamed_file status correctly', async () => {
      const renamedChanges = {
        changes: [
          {
            new_path: 'new.ts',
            old_path: 'old.ts',
            new_file: false,
            renamed_file: true,
            deleted_file: false,
            diff: '',
          },
        ],
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: renamedChanges });
        return mockResponse({ body: mrData });
      });

      const mr = await adapter.getMR(42);
      expect(mr.changedFiles[0].status).toBe('renamed');
    });

    it('uses empty array for null labels', async () => {
      const nullLabels = { ...mrData, labels: null };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/changes')) return mockResponse({ body: { changes: [] } });
        return mockResponse({ body: nullLabels });
      });

      const mr = await adapter.getMR(42);
      expect(mr.labels).toEqual([]);
    });
  });

  describe('isMR', () => {
    it('returns true when HEAD request succeeds', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

      const result = await adapter.isMR(42);
      expect(result).toBe(true);
    });

    it('returns false on 404', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      const result = await adapter.isMR(42);
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Network failure'));

      const result = await adapter.isMR(42);
      expect(result).toBe(false);
    });
  });

  describe('getDefaultBranch', () => {
    it('returns default branch from project API', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { default_branch: 'main' } }));

      const branch = await adapter.getDefaultBranch();
      expect(branch).toBe('main');
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(adapter.getDefaultBranch()).rejects.toThrow('GitLab API 404');
    });
  });

  describe('getIssue', () => {
    const issueData = {
      iid: 1,
      title: 'Bug report',
      description: 'Something broke',
      labels: ['bug'],
    };

    const notesData = [
      {
        id: 101,
        author: { username: 'commenter1' },
        created_at: '2024-01-01T00:00:00Z',
        body: 'First!',
      },
    ];

    it('returns issue context', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/notes')) {
          return mockResponse({ body: notesData });
        }
        return mockResponse({ body: issueData });
      });

      const issue = await adapter.getIssue(1);

      expect(issue.number).toBe(1);
      expect(issue.title).toBe('Bug report');
      expect(issue.body).toBe('Something broke');
      expect(issue.labels).toEqual(['bug']);
      expect(issue.comments).toHaveLength(1);
      expect(issue.comments[0].author).toBe('commenter1');
      expect(issue.comments[0].id).toBe(101);
    });

    it('handles null description', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/notes')) return mockResponse({ body: [] });
        return mockResponse({ body: { ...issueData, description: null } });
      });

      const issue = await adapter.getIssue(1);
      expect(issue.body).toBe('');
    });

    it('handles notes fetch failure gracefully', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/notes')) return mockErrorResponse(500);
        return mockResponse({ body: issueData });
      });

      const issue = await adapter.getIssue(1);
      expect(issue.number).toBe(1);
      expect(issue.comments).toEqual([]);
    });

    it('throws when issue API fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/notes')) return mockResponse({ body: [] });
        return mockErrorResponse(404);
      });

      await expect(adapter.getIssue(999)).rejects.toThrow('GitLab API 404');
    });
  });

  describe('getIssueComments', () => {
    it('returns mapped comments', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          body: [
            {
              id: 1,
              author: { username: 'alice' },
              created_at: '2024-01-01T00:00:00Z',
              body: 'Great work',
            },
            {
              id: 2,
              author: { username: 'bob' },
              created_at: '2024-01-02T00:00:00Z',
              body: 'Needs fixes',
            },
          ],
        }),
      );

      const comments = await adapter.getIssueComments(1);

      expect(comments).toHaveLength(2);
      expect(comments[0].author).toBe('alice');
      expect(comments[1].author).toBe('bob');
    });

    it('returns empty array for no comments', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [] }));

      const comments = await adapter.getIssueComments(1);
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

      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );

      const lines = await adapter.getDiffLines(42);

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

      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );

      const lines = await adapter.getDiffLines(42);
      expect(lines.has('src/b.ts:5')).toBe(true);
      expect(lines.size).toBe(9);
    });

    it('returns empty set when diff fetch fails', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const lines = await adapter.getDiffLines(42);
      expect(lines).toBeInstanceOf(Set);
      expect(lines.size).toBe(0);
    });

    it('returns empty set on non-ok response', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(500));

      const lines = await adapter.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('handles no-comma hunk on both sides', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
 context`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await adapter.getDiffLines(42);
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
      const lines = await adapter.getDiffLines(42);
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
      const lines = await adapter.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('skips no-newline-at-eof markers', async () => {
      const diffText = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
 line2
+line3
+line4
\\ No newline at end of file`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await adapter.getDiffLines(42);
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
      const lines = await adapter.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('handles new file addition with /dev/null source', async () => {
      const diffText = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+new content`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await adapter.getDiffLines(42);
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
      const lines = await adapter.getDiffLines(42);
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
      const lines = await adapter.getDiffLines(42);
      expect(lines.has('file1.ts:1')).toBe(true);
      expect(lines.has('file1.ts:2')).toBe(true);
      expect(lines.has('file1.ts:3')).toBe(true);
      expect(lines.has('file1.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });

    it('handles renamed-only file with no hunks', async () => {
      const diffText = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts`;
      fetchMock.mockImplementation(async () =>
        mockResponse({ text: vi.fn().mockResolvedValue(diffText) }),
      );
      const lines = await adapter.getDiffLines(42);
      expect(lines.size).toBe(0);
    });

    it('processes text hunks after a binary diff', async () => {
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
      const lines = await adapter.getDiffLines(42);
      expect(lines.has('src/a.ts:1')).toBe(true);
      expect(lines.has('src/a.ts:2')).toBe(true);
      expect(lines.has('src/a.ts:3')).toBe(true);
      expect(lines.has('src/a.ts:4')).toBe(true);
      expect(lines.size).toBe(4);
    });
  });

  describe('getDiffSince', () => {
    it('returns diff text from compare endpoint', async () => {
      const diffText = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-change\n+change';
      fetchMock.mockImplementation(async () =>
        mockResponse({ body: { diffs: [{ diff: diffText }] } }),
      );

      const result = await adapter.getDiffSince('abc123', 'def456');
      expect(result).toBe(diffText);
    });

    it('returns empty string on failure', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const result = await adapter.getDiffSince('abc123', 'def456');
      expect(result).toBe('');
    });
  });

  describe('listReviewComments', () => {
    it('calls paginate and returns comments', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1, body: 'Review note' }] }));

      const result = await adapter.listReviewComments(42);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });
  });

  describe('listComments', () => {
    it('calls paginate and returns comments', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1, body: 'Issue note' }] }));

      const result = await adapter.listComments(1);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });
  });

  describe('postComment', () => {
    it('POSTs to notes endpoint', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { id: 42 } }));

      await adapter.postComment(1, 'Nice work');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/issues/1/notes'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Nice work'),
        }),
      );
    });

    it('throws on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(403));

      await expect(adapter.postComment(1, 'body')).rejects.toThrow('GitLab API 403');
    });
  });

  describe('postOrUpdateComment', () => {
    const marker = '## OpenCode Review';

    it('creates new comment when no existing one matches marker', async () => {
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/notes') && options?.method === 'POST') {
          return mockResponse({ body: { id: 999 } });
        }
        return mockResponse({ body: [] });
      });

      const result = await adapter.postOrUpdateComment(1, marker, 'New review');

      expect(result.action).toBe('created');
      expect(result.commentId).toBe(999);
    });

    it('updates existing comment when marker matches', async () => {
      let putCalled = false;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/notes/') && options?.method === 'PUT') {
          putCalled = true;
          return mockResponse({ body: {} });
        }
        return mockResponse({
          body: [
            { id: 1, body: 'not matching' },
            { id: 42, body: `${marker}\n\nOld review` },
          ],
        });
      });

      const result = await adapter.postOrUpdateComment(1, marker, 'Updated review');

      expect(result.action).toBe('updated');
      expect(result.commentId).toBe(42);
      expect(putCalled).toBe(true);
    });

    it('re-throws error on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(500));

      await expect(adapter.postOrUpdateComment(1, marker, 'body')).rejects.toThrow(
        'GitLab API 500',
      );
    });
  });

  describe('createReviewCommentReply', () => {
    it('POSTs reply to discussion', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/notes/100') && !url.includes('/notes/100/notes')) {
          return mockResponse({ body: { id: 100, discussion_id: 'disc-42' } });
        }
        return mockResponse({ body: { id: 789 } });
      });

      await adapter.createReviewCommentReply(42, 100, 'Good question!');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/merge_requests/42/discussions/disc-42/notes'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Good question!'),
        }),
      );
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      await expect(adapter.createReviewCommentReply(42, 100, 'body')).rejects.toThrow(
        'GitLab API 422',
      );
    });
  });

  describe('replyToReviewComment', () => {
    it('posts a reply and returns the comment id', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/notes/100') && !url.includes('/notes/100/notes')) {
          return mockResponse({ body: { id: 100, discussion_id: 'disc-789' } });
        }
        return mockResponse({ body: { id: 789 } });
      });

      const result = await adapter.replyToReviewComment(42, 100, 'Good question!');

      expect(result.id).toBe(789);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/merge_requests/42/discussions/disc-789/notes'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Good question!'),
        }),
      );
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      await expect(adapter.replyToReviewComment(42, 100, 'body')).rejects.toThrow('GitLab API 422');
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

      const comment = await adapter.getReviewComment(1, 123);

      expect(comment.id).toBe(123);
      expect(comment.body).toBe('This is a review comment');
      expect(comment.user.type).toBe('Bot');
      expect(comment.path).toBe('src/index.ts');
    });

    it('throws on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(adapter.getReviewComment(1, 999)).rejects.toThrow('GitLab API 404');
    });
  });

  describe('getReviewCommentThread', () => {
    it('returns empty fallback', async () => {
      const result = await adapter.getReviewCommentThread(1);
      expect(result.comments).toEqual([]);
      expect(result.filePath).toBe('');
    });
  });

  describe('postReview', () => {
    it('posts body-only when no inline comments exist', async () => {
      vi.mocked(buildInlineComments).mockReturnValue([]);

      fetchMock.mockImplementation(async (url: string) => {
        if (
          url.includes('/diff_lines') ||
          (url.includes('/merge_requests/42') && !url.includes('/changes'))
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue('@@ -1 +1 @@') });
        }
        if (url.includes('/notes') && url.includes('method')) {
          return mockResponse({ body: { id: 1 } });
        }
        return mockResponse({ body: {} });
      });

      const result = await adapter.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('body-only');
    });

    it('posts body with inline comments', async () => {
      vi.mocked(buildInlineComments).mockReturnValue([
        { path: 'src/b.ts', line: 42, side: 'RIGHT', body: 'Fix this' },
      ]);

      const mrTextResponse = `@@ -abc123 +def456 @@`;
      let discussionPostCalled = false;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (
          url.includes('/merge_requests/42') &&
          !url.includes('/changes') &&
          !url.includes('/discussions') &&
          !url.includes('/notes')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(mrTextResponse) });
        }
        if (url.includes('/discussions') && options?.method === 'POST') {
          discussionPostCalled = true;
          return mockResponse({ body: {} });
        }
        if (url.includes('/notes') && options?.method === 'POST') {
          return mockResponse({ body: { id: 1 } });
        }
        return mockResponse({ body: {} });
      });

      const result = await adapter.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('partial');
      expect(discussionPostCalled).toBe(true);
    });

    it('handles inline comment 422 fallback', async () => {
      vi.mocked(buildInlineComments).mockReturnValue([
        { path: 'src/b.ts', line: 42, side: 'RIGHT', body: 'Fix this' },
      ]);

      const mrTextResponse = `@@ -abc123 +def456 @@`;
      let fallbackNoteCalled = false;

      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (
          url.includes('/merge_requests/42') &&
          !url.includes('/changes') &&
          !url.includes('/discussions') &&
          !url.includes('/notes')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue(mrTextResponse) });
        }
        if (url.includes('/discussions') && options?.method === 'POST') {
          const err = new Error('GitLab API 422 on discussions: Unprocessable') as Error & {
            status: number;
          };
          err.status = 422;
          throw err;
        }
        if (url.includes('/notes') && options?.method === 'POST') {
          fallbackNoteCalled = true;
          return mockResponse({ body: { id: 99 } });
        }
        return mockResponse({ body: {} });
      });

      const result = await adapter.postReview(42, 'sha123', sampleReviewResult());

      expect(result.success).toBe(true);
      expect(result.method).toBe('partial');
      expect(fallbackNoteCalled).toBe(true);
    });

    it('suppresses low-confidence issues when flag is set', async () => {
      vi.mocked(buildInlineComments).mockReturnValue([]);

      fetchMock.mockImplementation(async (url: string) => {
        if (
          url.includes('/merge_requests/42') &&
          !url.includes('/changes') &&
          !url.includes('/notes')
        ) {
          return mockResponse({ text: vi.fn().mockResolvedValue('@@ -1 +1 @@') });
        }
        if (url.includes('/notes') && url.includes('POST')) {
          return mockResponse({ body: { id: 1 } });
        }
        return mockResponse({ body: {} });
      });

      const result = await adapter.postReview(42, 'sha123', sampleReviewResult(), true, true);

      expect(result.success).toBe(true);
    });
  });

  describe('addLabels', () => {
    it('PUTs labels to issue', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await adapter.addLabels(1, ['bug', 'enhancement']);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/issues/1'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('bug,enhancement'),
        }),
      );
    });

    it('throws on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(adapter.addLabels(1, ['bug'])).rejects.toThrow('GitLab API 404');
    });
  });

  describe('removeLabel', () => {
    it('fetches current labels, removes one, and PUTs', async () => {
      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PUT') {
          return mockResponse({ body: {} });
        }
        return mockResponse({ body: { labels: ['bug', 'wontfix', 'enhancement'] } });
      });

      await adapter.removeLabel(1, 'wontfix');

      const putCall = fetchMock.mock.calls.find(
        ([, opts]: [string, RequestInit]) => opts?.method === 'PUT',
      );
      const body = JSON.parse(putCall[1].body as string);
      expect(body.labels).toBe('bug,enhancement');
    });

    it('handles 404 gracefully', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(adapter.removeLabel(1, 'missing')).resolves.toBeUndefined();
    });
  });

  describe('setLabels', () => {
    it('merges add/remove with current labels and PUTs', async () => {
      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PUT') {
          const body = JSON.parse(options.body as string);
          expect(body.labels).toBe('existing,added1,added2');
          return mockResponse({ body: {} });
        }
        return mockResponse({ body: { labels: ['existing', 'removeme'] } });
      });

      await adapter.setLabels(1, ['added1', 'added2'], ['removeme']);

      const putCalls = fetchMock.mock.calls.filter(
        ([, opts]: [string, RequestInit]) => opts?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(1);
    });
  });

  describe('ensureLabels', () => {
    it('creates missing labels', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await adapter.ensureLabels(['label1', 'label2']);

      const postCalls = fetchMock.mock.calls.filter(
        ([, opts]: [string, RequestInit]) => opts?.method === 'POST',
      );
      expect(postCalls).toHaveLength(2);
      expect(postCalls[0][0]).toContain('/labels');
    });

    it('uses the semantic palette color for severity labels', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await adapter.ensureLabels(['audit:important']);

      const postCall = fetchMock.mock.calls.find(
        ([, opts]: [string, RequestInit]) => opts?.method === 'POST',
      );
      const body = JSON.parse(String(postCall?.[1]?.body));
      expect(body.color).toBe('#9a5a00');
    });
  });

  describe('review threads (no-ops)', () => {
    it('getReviewThreads returns empty', async () => {
      const threads = await adapter.getReviewThreads(42);
      expect(threads).toEqual([]);
    });

    it('resolveReviewThread warns', async () => {
      const { warning } = await import('@actions/core');

      await adapter.resolveReviewThread('thread-1');

      expect(warning).toHaveBeenCalledWith('resolveReviewThread not supported for GitLab');
    });

    it('minimizeReviewComment warns', async () => {
      const { warning } = await import('@actions/core');

      await adapter.minimizeReviewComment('42', 'OUTDATED');

      expect(warning).toHaveBeenCalledWith('minimizeReviewComment not supported for GitLab');
    });

    it('getBotReviewThreads returns empty', async () => {
      const threads = await adapter.getBotReviewThreads(42);
      expect(threads).toEqual([]);
    });

    it('getOpenHumanThreads returns empty string', async () => {
      const result = await adapter.getOpenHumanThreads(42);
      expect(result).toBe('');
    });
  });

  describe('mergeMR', () => {
    it('returns true on successful merge', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      const result = await adapter.mergeMR(42);
      expect(result).toBe(true);
    });

    it('returns false on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(409));

      const result = await adapter.mergeMR(42);
      expect(result).toBe(false);
    });
  });

  describe('enableAutoMerge', () => {
    it('returns true on success', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      const result = await adapter.enableAutoMerge(42);
      expect(result).toBe(true);
    });

    it('returns false on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(405));

      const result = await adapter.enableAutoMerge(42);
      expect(result).toBe(false);
    });
  });

  describe('updateMR', () => {
    it('PUTs title and description', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await adapter.updateMR(42, { title: 'New title', body: 'New body' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/merge_requests/42'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"title":"New title"'),
        }),
      );
    });

    it('PUTs only body if title not provided', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await adapter.updateMR(42, { body: 'Just body' });

      const callBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(callBody.title).toBeUndefined();
      expect(callBody.description).toBe('Just body');
    });
  });

  describe('createPR', () => {
    it('creates MR and returns number and url', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          body: { iid: 42, web_url: 'https://gitlab.com/owner/repo/-/merge_requests/42' },
        }),
      );

      const result = await adapter.createPR('Title', 'Body', 'feature-branch', 'main');

      expect(result).not.toBeNull();
      expect(result!.number).toBe(42);
      expect(result!.url).toBe('https://gitlab.com/owner/repo/-/merge_requests/42');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/merge_requests'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"title":"Title"'),
        }),
      );
    });

    it('returns null on API failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      const result = await adapter.createPR('Title', 'Body', 'head', 'base');
      expect(result).toBeNull();
    });
  });

  describe('closeIssue', () => {
    it('closes issue without comment', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: {} }));

      await adapter.closeIssue(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/issues/1'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('state_event'),
        }),
      );
    });

    it('closes issue with comment', async () => {
      let putDone = false;

      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PUT') {
          putDone = true;
          return mockResponse({ body: {} });
        }
        if (options?.method === 'POST') {
          return mockResponse({ body: { id: 999 } });
        }
        return mockResponse({ body: {} });
      });

      await adapter.closeIssue(1, 'Closed via automation');

      expect(putDone).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not throw when PUT fails', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(404));

      await expect(adapter.closeIssue(999)).resolves.toBeUndefined();
    });

    it('does not throw when comment POST fails', async () => {
      fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PUT') {
          return mockResponse({ body: {} });
        }
        throw new Error('Comment failed');
      });

      await expect(adapter.closeIssue(1, 'comment')).resolves.toBeUndefined();
    });
  });

  describe('closeOpenCodePRs', () => {
    it('closes MRs with opencode/ source branch', async () => {
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/merge_requests?state=opened')) {
          return mockResponse({
            body: [
              { iid: 1, source_branch: 'opencode/fix-1', created_at: '2024-01-01T00:00:00Z' },
              { iid: 2, source_branch: 'opencode/fix-2', created_at: '2024-01-02T00:00:00Z' },
              { iid: 3, source_branch: 'manual-branch', created_at: '2024-01-03T00:00:00Z' },
            ],
          });
        }
        if (url.includes('/merge_requests/') && options?.method === 'PUT') {
          return mockResponse({ body: {} });
        }
        return mockResponse({ body: [] });
      });

      await adapter.closeOpenCodePRs();

      const putCalls = fetchMock.mock.calls.filter(
        ([url, opts]: [string, RequestInit]) =>
          url.includes('/merge_requests/') && opts?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(2);
    });

    it('filters by since date', async () => {
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/merge_requests?state=opened')) {
          return mockResponse({
            body: [
              { iid: 1, source_branch: 'opencode/fix-1', created_at: '2024-01-01T00:00:00Z' },
              { iid: 2, source_branch: 'opencode/fix-2', created_at: '2024-02-01T00:00:00Z' },
            ],
          });
        }
        if (url.includes('/merge_requests/') && options?.method === 'PUT') {
          return mockResponse({ body: {} });
        }
        return mockResponse({ body: [] });
      });

      await adapter.closeOpenCodePRs('2024-01-15T00:00:00Z');

      const putCalls = fetchMock.mock.calls.filter(
        ([url, opts]: [string, RequestInit]) =>
          url.includes('/merge_requests/') && opts?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(1);
    });

    it('handles close API failure gracefully', async () => {
      fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('/merge_requests?state=opened')) {
          return mockResponse({
            body: [{ iid: 1, source_branch: 'opencode/fix-1', created_at: '2024-01-01T00:00:00Z' }],
          });
        }
        if (url.includes('/merge_requests/') && options?.method === 'PUT') {
          return mockErrorResponse(500);
        }
        return mockResponse({ body: [] });
      });

      await expect(adapter.closeOpenCodePRs()).resolves.toBeUndefined();
    });
  });

  describe('gatherContext', () => {
    const mrData = {
      iid: 42,
      title: 'MR title',
      description: 'MR desc',
      source_branch: 'branch',
      sha: 'sha1',
      target_branch: 'main',
      author: { username: 'author' },
      labels: ['enhancement'],
    };

    it('gathers issue context when issueNumber is provided', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/issues/1') && !url.includes('/notes')) {
          return mockResponse({
            body: { iid: 1, title: 'Issue title', description: 'Issue body', labels: [] },
          });
        }
        if (url.includes('/issues/1/notes')) {
          return mockResponse({
            body: [
              {
                id: 1,
                author: { username: 'u1' },
                created_at: '2024-01-01T00:00:00Z',
                body: 'Comment 1',
              },
            ],
          });
        }
        return mockResponse({ body: [] });
      });

      const context = await adapter.gatherContext({ issueNumber: 1 });

      expect(context).toContain('Issue #1');
      expect(context).toContain('Issue title');
      expect(context).toContain('Comment 1');
    });

    it('gathers MR context when prNumber is provided', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/merge_requests/42/changes')) {
          return mockResponse({ body: { changes: [] } });
        }
        if (url.includes('/merge_requests/42') && url.includes('/notes')) {
          return mockResponse({
            body: [
              {
                id: 1,
                author: { username: 'reviewer' },
                body: 'Nice',
                created_at: '2024-01-01T00:00:00Z',
              },
            ],
          });
        }
        if (url.includes('/merge_requests/42')) {
          return mockResponse({ body: mrData });
        }
        return mockResponse({ body: [] });
      });

      const context = await adapter.gatherContext({ prNumber: 42 });

      expect(context).toContain('MR #42');
      expect(context).toContain('MR title');
      expect(context).toContain('Inline Review Comments');
    });

    it('gathers both issue and MR context simultaneously', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/issues/1') && !url.includes('/notes')) {
          return mockResponse({
            body: { iid: 1, title: 'Issue', description: 'body', labels: [] },
          });
        }
        if (url.includes('/merge_requests/42') && url.includes('/notes')) {
          return mockResponse({ body: [] });
        }
        if (url.includes('/merge_requests/42/changes')) {
          return mockResponse({ body: { changes: [] } });
        }
        if (url.includes('/merge_requests/42')) {
          return mockResponse({ body: mrData });
        }
        if (url.includes('/issues/1/notes')) {
          return mockResponse({ body: [] });
        }
        return mockResponse({ body: [] });
      });

      const context = await adapter.gatherContext({ issueNumber: 1, prNumber: 42 });

      expect(context).toContain('Issue #1');
      expect(context).toContain('MR #42');
    });

    it('returns empty string when neither is provided', async () => {
      const context = await adapter.gatherContext({});
      expect(context).toBe('');
    });
  });

  describe('getCurrentUser', () => {
    it('returns user from env var GITLAB_USER_LOGIN', async () => {
      process.env.GITLAB_USER_LOGIN = 'env-user';
      const result = await adapter.getCurrentUser();
      expect(result).toBe('env-user');
      process.env.GITLAB_USER_LOGIN = '';
    });

    it('returns user from API when env var is not set', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { username: 'api-user' } }));

      const result = await adapter.getCurrentUser();
      expect(result).toBe('api-user');
    });

    it('falls back to bot name on API failure', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const result = await adapter.getCurrentUser();
      expect(result).toBe('opencode-reviewer[bot]');
    });

    it('caches user after first fetch', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: { username: 'api-user' } }));

      await adapter.getCurrentUser();
      await adapter.getCurrentUser();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('createIssue', () => {
    it('creates issue and returns number and url', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          body: { iid: 10, web_url: 'https://gitlab.com/owner/repo/-/issues/10' },
        }),
      );

      const result = await adapter.createIssue('Bug', 'Description', ['bug']);

      expect(result).not.toBeNull();
      expect(result!.number).toBe(10);
      expect(result!.url).toBe('https://gitlab.com/owner/repo/-/issues/10');
    });

    it('returns null on failure', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(422));

      const result = await adapter.createIssue('Bad', 'body', []);
      expect(result).toBeNull();
    });
  });

  describe('paginate', () => {
    it('returns all items from single page', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }, { id: 2 }] }));

      const result = await adapter.paginate('/issues/1/notes');
      expect(result).toHaveLength(2);
    });

    it('paginates through multiple pages', async () => {
      let callCount = 0;
      fetchMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({ body: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
        }
        return mockResponse({ body: [{ id: 100 }] });
      });

      const result = await adapter.paginate('/issues/1/notes');
      expect(result).toHaveLength(101);
      expect(callCount).toBe(2);
    });

    it('stops at max pages', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ body: Array.from({ length: 100 }, (_, i) => ({ id: i })) }),
      );

      const result = await adapter.paginate('/issues/1/notes', { maxPages: 3 });
      expect(result).toHaveLength(300);
    });

    it('handles page fetch failure gracefully', async () => {
      const { warning } = await import('@actions/core');

      let callCount = 0;
      fetchMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1)
          return mockResponse({ body: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
        return mockErrorResponse(500);
      });

      const result = await adapter.paginate('/issues/1/notes');
      expect(result).toHaveLength(100);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch page'));
    });

    it('respects perPage option in URL params', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      await adapter.paginate('/issues/1/notes', { perPage: 50, maxPages: 1 });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('per_page=50');
    });

    it('uses ascending direction when specified', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      const result = await adapter.paginate('/issues/1/notes', {
        perPage: 100,
        maxPages: 1,
        direction: 'asc',
      });
      expect(result).toHaveLength(1);

      // GitLab needs explicit order_by/sort (it ignores GitHub's `direction`).
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('order_by=created_at');
      expect(url).toContain('sort=asc');
    });

    it('appends descending sort when direction is desc', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      await adapter.paginate('/issues/1/notes', {
        perPage: 100,
        maxPages: 1,
        direction: 'desc',
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('order_by=created_at');
      expect(url).toContain('sort=desc');
    });

    it('rethrows page-fetch errors when throwOnError is set', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(500));

      await expect(
        adapter.paginate('/issues/1/notes', { perPage: 100, maxPages: 2, throwOnError: true }),
      ).rejects.toThrow('GitLab API 500');
    });

    it('adds ? when no query params exist', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      await adapter.paginate('/test', { perPage: 50, maxPages: 1 });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/test?per_page=50&page=1');
    });

    it('adds & when query params already exist', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      await adapter.paginate('/test?state=opened', { perPage: 50, maxPages: 1 });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/test?state=opened&per_page=50&page=1');
    });

    it('passes perPage and maxPages to paginate call', async () => {
      fetchMock.mockResolvedValue(mockResponse({ body: [{ id: 1 }] }));

      await adapter.paginate('/test', { perPage: 10, maxPages: 1 });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('per_page=10&page=1');
    });
  });

  describe('rate limit handling', () => {
    it('warns when rate limit is low', async () => {
      const { warning } = await import('@actions/core');

      fetchMock.mockImplementation(async () => {
        const headers = new Headers();
        headers.set('RateLimit-Remaining', '25');
        headers.set('RateLimit-Reset', '2000000000');
        return mockResponse({ headers, body: {} });
      });

      await adapter.isMR(1);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('rate limit low'));
    });

    it('warns on 429 with retry-after header', async () => {
      const { warning } = await import('@actions/core');

      fetchMock.mockImplementation(async () => {
        const headers = new Headers();
        headers.set('Retry-After', '10');
        const res = mockErrorResponse(429, 'Too Many Requests');
        (res as Record<string, unknown>).headers = headers;
        (res as Record<string, unknown>).text = vi.fn().mockResolvedValue('Too Many Requests');
        return res;
      });

      await adapter.isMR(1);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
    });

    it('passes response headers to retry handling on HTTP errors', async () => {
      const headers = new Headers({ 'Retry-After': '10' });
      const response = mockErrorResponse(429, 'Too Many Requests');
      Object.assign(response, { headers });
      fetchMock.mockResolvedValue(response);

      await adapter.isMR(1);

      expect(retryErrors).toHaveLength(1);
      expect((retryErrors[0] as { headers?: Headers }).headers).toBe(headers);
    });
  });
});
