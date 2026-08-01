import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { describe, expect, it, vi } from 'vitest';
import {
  gatherIssueCommentThread,
  gatherReviewCommentThread,
} from '../src/handlers/conversation.js';

const MENTION = '@bot';

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    listReviewComments: vi.fn().mockResolvedValue([]),
    getReviewComment: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    getIssueComment: vi.fn(),
    getRecentIssueComments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PlatformAdapter;
}

describe('conversation thread gathering', () => {
  describe('gatherReviewCommentThread', () => {
    it('fetches the window newest-first so recent triggers stay in-window', async () => {
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([
          { id: 1, body: 'root', in_reply_to_id: null, user: { login: 'user' } },
          { id: 2, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } },
        ]),
      });

      const result = await gatherReviewCommentThread(gh, 1, 2, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
      expect(gh.listReviewComments).toHaveBeenCalledWith(
        1,
        { perPage: 100, maxPages: 5, direction: 'desc' },
        undefined,
      );
    });

    it('includes the ancestor chain and sibling replies, ascending by id', async () => {
      const comments = [
        {
          id: 1,
          body: 'root',
          in_reply_to_id: null,
          path: 'src/a.ts',
          diff_hunk: 'hunk',
          user: { login: 'user' },
        },
        { id: 2, body: 'sibling', in_reply_to_id: 1, user: { login: 'user' } },
        { id: 3, body: 'ancestor reply', in_reply_to_id: 1, user: { login: 'user' } },
        { id: 4, body: 'trigger', in_reply_to_id: 3, user: { login: 'user' } },
      ];
      const gh = makeAdapter({ listReviewComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherReviewCommentThread(gh, 1, 4, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual([
        'root',
        'sibling',
        'ancestor reply',
        'trigger',
      ]);
      expect(result.filePath).toBe('src/a.ts');
      expect(result.diffHunk).toBe('hunk');
    });

    it('fetches missing ancestors by id when the trigger is outside the window', async () => {
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: null,
        path: 'src/a.ts',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([]),
        getReviewComment: vi
          .fn()
          .mockImplementation(async (_p: number, id: number) =>
            id === 3
              ? { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } }
              : root,
          ),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
      expect(result.filePath).toBe('src/a.ts');
    });

    it('does not hang on a cyclic in_reply_to_id chain', async () => {
      const comments = [
        { id: 1, body: 'a', in_reply_to_id: 2, user: { login: 'user' } },
        { id: 2, body: 'b', in_reply_to_id: 1, user: { login: 'user' } },
      ];
      const gh = makeAdapter({ listReviewComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherReviewCommentThread(gh, 1, 1, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['a', 'b']);
    });

    it('resolves in-window ancestors from the map without re-fetching them', async () => {
      // Window contains comments 2..5 but NOT the root (1). The trigger is 5,
      // whose chain is 5 -> 4 -> 3 -> 2 -> 1. Only 1 is genuinely missing and
      // should be direct-fetched; 2..4 are already in the window and must be
      // resolved from the in-memory map without extra API calls.
      const windowComments = [
        { id: 2, body: 'c2', in_reply_to_id: 1, user: { login: 'user' } },
        { id: 3, body: 'c3', in_reply_to_id: 2, user: { login: 'user' } },
        { id: 4, body: 'c4', in_reply_to_id: 3, user: { login: 'user' } },
        { id: 5, body: 'c5', in_reply_to_id: 4, user: { login: 'user' } },
      ];
      const getReviewComment = vi.fn().mockImplementation(async (_p: number, id: number) => ({
        id,
        body: `fetched-${id}`,
        in_reply_to_id: id === 1 ? null : id - 1,
        user: { login: 'user' },
      }));
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue(windowComments),
        getReviewComment,
      });

      const result = await gatherReviewCommentThread(gh, 1, 5, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['fetched-1', 'c2', 'c3', 'c4', 'c5']);
      // Only the genuinely missing root is fetched by ID.
      expect(getReviewComment).toHaveBeenCalledTimes(1);
      expect(getReviewComment).toHaveBeenCalledWith(1, 1, undefined);
    });

    it('falls back to the first chain comment carrying a path when the root lacks one', async () => {
      const comments = [
        { id: 1, body: 'root (thread-level)', in_reply_to_id: null, user: { login: 'user' } },
        {
          id: 2,
          body: 'trigger',
          in_reply_to_id: 1,
          path: 'src/a.ts',
          diff_hunk: 'hunk',
          user: { login: 'user' },
        },
      ];
      const gh = makeAdapter({ listReviewComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherReviewCommentThread(gh, 1, 2, MENTION);

      expect(result.filePath).toBe('src/a.ts');
      expect(result.diffHunk).toBe('hunk');
    });

    it('preserves diff_hunk from directly-fetched chain comments', async () => {
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: null,
        path: 'src/a.ts',
        diff_hunk: 'hunk-from-fetch',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([]),
        getReviewComment: vi
          .fn()
          .mockImplementation(async (_p: number, id: number) =>
            id === 3
              ? { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } }
              : root,
          ),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.diffHunk).toBe('hunk-from-fetch');
      expect(result.filePath).toBe('src/a.ts');
    });

    it('returns the partially gathered chain when an ancestor fetch fails', async () => {
      // Trigger is outside the window; its root is direct-fetched, then the
      // root's own ancestor fetch fails — the gathered chain must survive.
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: 0,
        path: 'src/a.ts',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([]),
        getReviewComment: vi.fn().mockImplementation(async (_p: number, id: number) => {
          if (id === 3)
            return { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } };
          if (id === 1) return root;
          throw new Error('GitHub API 404');
        }),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
    });

    it('falls through to the by-id walk when the window fetch fails', async () => {
      // A window-fetch failure must not surface as 'comment not found': the
      // trigger and its ancestors are fetched by ID instead.
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: null,
        path: 'src/a.ts',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockRejectedValue(new Error('GitHub API 500')),
        getReviewComment: vi
          .fn()
          .mockImplementation(async (_p: number, id: number) =>
            id === 3
              ? { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } }
              : root,
          ),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
      expect(result.filePath).toBe('src/a.ts');
    });
  });

  describe('gatherIssueCommentThread', () => {
    it('takes up to 5 preceding comments plus the trigger, in chronological order', async () => {
      // Ascending window (direction: 'asc') — the ordering GitHub's issue
      // comments endpoint actually returns (it ignores sort/direction).
      const comments = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        body: `c${i + 1}`,
        user: { login: 'user' },
      }));
      const gh = makeAdapter({ listComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherIssueCommentThread(gh, 1, 10, MENTION);

      // trigger at idx 9; preceding 5 (older) are ids 5..9, already chronological.
      expect(result.thread.map((m) => m.body)).toEqual(['c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
      expect(gh.listComments).toHaveBeenCalledWith(
        1,
        { perPage: 100, maxPages: 5, direction: 'asc' },
        undefined,
      );
    });

    it('fetches the trigger by id when it is older than the window', async () => {
      const gh = makeAdapter({
        listComments: vi
          .fn()
          .mockResolvedValue([{ id: 9, body: 'recent', user: { login: 'user' } }]),
        getIssueComment: vi
          .fn()
          .mockResolvedValue({ id: 1, body: 'old trigger', user: { login: 'user' } }),
      });

      const result = await gatherIssueCommentThread(gh, 1, 1, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['old trigger']);
    });

    it('falls back to recent window comments when the by-id trigger fetch fails', async () => {
      const gh = makeAdapter({
        listComments: vi.fn().mockResolvedValue([
          { id: 8, body: 'c8', user: { login: 'user' } },
          { id: 9, body: 'c9', user: { login: 'user' } },
        ]),
        getIssueComment: vi.fn().mockRejectedValue(new Error('GitHub API 404')),
      });

      const result = await gatherIssueCommentThread(gh, 1, 1, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['c8', 'c9']);
    });

    it('recovers preceding turns from the conversation tail when the trigger is outside the window', async () => {
      // Busy PR: the ascending window does not include the freshly-posted
      // trigger (id 20). The recent tail contains the trigger and the turns
      // preceding it, so the model still receives context.
      const gh = makeAdapter({
        listComments: vi.fn().mockResolvedValue([]),
        getRecentIssueComments: vi.fn().mockResolvedValue(
          [16, 17, 18, 19, 20].map((id) => ({
            id,
            body: `c${id}`,
            user: { login: 'user' },
          })),
        ),
      });

      const result = await gatherIssueCommentThread(gh, 1, 20, MENTION);

      // Newest 5 preceding turns (16..19) plus the trigger, in chronological order.
      expect(result.thread.map((m) => m.body)).toEqual(['c16', 'c17', 'c18', 'c19', 'c20']);
      expect(gh.getRecentIssueComments).toHaveBeenCalledWith(1, 6, undefined);
      expect(gh.getIssueComment).not.toHaveBeenCalled();
    });
  });
});
