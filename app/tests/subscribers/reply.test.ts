import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleReply } from '../../src/handlers/reply.js';
import { createReplySubscriber } from '../../src/subscribers/reply.js';

vi.mock('../../src/handlers/reply.js', () => ({
  handleReply: vi.fn(),
}));

const mockedHandleReply = vi.mocked(handleReply);

function makeEvent(body: string, overrides: Record<string, unknown> = {}): GitHubEvent {
  return {
    type: 'review_comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 123,
    payload: {
      comment: {
        body,
        in_reply_to_id: 42,
        user: { type: 'User', login: 'octocat' },
      },
      ...overrides,
    },
  };
}

describe('ReplySubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleReply.mockReset();
    mockedHandleReply.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('handles a non-command reply conversationally', async () => {
    const sub = createReplySubscriber();

    await sub.handle(makeEvent('Could you clarify why this is an issue?'));

    expect(mockedHandleReply).toHaveBeenCalledTimes(1);
    const [prNumber, repo, , , parentId, body] = mockedHandleReply.mock.calls[0];
    expect(prNumber).toBe(123);
    expect(repo).toBe('owner/repo');
    expect(parentId).toBe(42);
    expect(body).toBe('Could you clarify why this is an issue?');
  });

  it('skips /dismiss replies (handled by the dismiss subscriber)', async () => {
    const sub = createReplySubscriber();

    await sub.handle(makeEvent('/dismiss false_positive'));

    expect(mockedHandleReply).not.toHaveBeenCalled();
  });

  it('still handles other slash commands conversationally', async () => {
    const sub = createReplySubscriber();

    await sub.handle(makeEvent('/help'));

    expect(mockedHandleReply).toHaveBeenCalledTimes(1);
  });
});
