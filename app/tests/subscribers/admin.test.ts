import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import type { GitHubEvent, RateLimiter } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminSubscriber } from '../../src/subscribers/admin.js';

const { mockPostOrUpdateComment } = vi.hoisted(() => ({
  mockPostOrUpdateComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        postOrUpdateComment = mockPostOrUpdateComment;
      },
    ),
  };
});

function makeEvent(body: string, author: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 123,
    payload: {
      comment: { body, user: { login: author } },
    },
  };
}

function makeLimiter(): RateLimiter {
  return {
    getStatus: vi.fn().mockResolvedValue({
      repoHourly: [],
      userDaily: [],
      tokenUsageToday: 0,
      tokenBudget: 500000,
    }),
    resetAll: vi.fn().mockResolvedValue(3),
    resetRepo: vi.fn().mockResolvedValue(1),
    resetUser: vi.fn().mockResolvedValue(1),
  } as unknown as RateLimiter;
}

function makeConfig(adminUsers: string[]) {
  return {
    ...DEFAULT_CONFIG,
    rateLimiting: { ...DEFAULT_CONFIG.rateLimiting, adminUsers },
  };
}

describe('AdminSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('allows admins case-insensitively', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['Alice']));

    await sub.handle(makeEvent('/rate-limits', 'alice'));

    expect(limiter.getStatus).toHaveBeenCalledTimes(1);
    expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('rejects non-admins without taking any action', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['Alice']));

    await sub.handle(makeEvent('/rate-limits', 'bob'));

    expect(limiter.getStatus).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('rejects the space-separated --repo flag form instead of resetting globally', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --repo some/repo', 'alice'));

    expect(limiter.resetAll).not.toHaveBeenCalled();
    expect(limiter.resetRepo).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      123,
      '<!-- rate-limits-status -->',
      expect.stringContaining('Invalid syntax'),
    );
  });

  it('supports the equals-form --repo=<name> reset', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --repo=some/repo', 'alice'));

    expect(limiter.resetAll).not.toHaveBeenCalled();
    expect(limiter.resetRepo).toHaveBeenCalledWith('some/repo');
  });

  it('supports the equals-form --user=<login> reset', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --user=octocat', 'alice'));

    expect(limiter.resetAll).not.toHaveBeenCalled();
    expect(limiter.resetUser).toHaveBeenCalledWith('octocat');
  });

  it('resets globally for an explicit --all flag', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --all', 'alice'));

    expect(limiter.resetAll).toHaveBeenCalledTimes(1);
  });
});
