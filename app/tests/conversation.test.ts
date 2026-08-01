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
    ...overrides,
  } as unknown as PlatformAdapter;
}

describe('conversation thread gathering', () => {
  describe('gatherReviewCommentThread', () => {
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
  });

  describe('gatherIssueCommentThread', () => {
    it('takes up to 5 preceding comments plus the trigger', async () => {
      const comments = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        body: `c${i + 1}`,
        user: { login: 'user' },
      }));
      const gh = makeAdapter({ listComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherIssueCommentThread(gh, 1, 10, MENTION);

      // triggerIdx=9 -> start at 4 -> ids 5..10
      expect(result.thread.map((m) => m.body)).toEqual(['c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
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
  });
});
