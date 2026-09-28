import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import type { GitHubEvent, RateLimiter } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminSubscriber } from '../../src/subscribers/admin.js';
import { clearPrivilegeVerificationCache } from '../../src/utils/privilege.js';

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
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
    clearPrivilegeVerificationCache();
    // The allowlist only names who may TRY; the collaborator-permission API
    // decides who may. Default seam: everyone is a privileged collaborator.
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ permission: 'admin' }) }) as never,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assignment would store the STRING "undefined"
    delete process.env.GITHUB_TOKEN;
    globalThis.fetch = realFetch;
    clearPrivilegeVerificationCache();
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

  it('rejects --all combined with scoped flags without resetting anything', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --all --repo=some/repo', 'alice'));

    expect(limiter.resetAll).not.toHaveBeenCalled();
    expect(limiter.resetRepo).not.toHaveBeenCalled();
    expect(limiter.resetUser).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      123,
      '<!-- rate-limits-status -->',
      expect.stringContaining('exclusive'),
    );
  });

  it('resets globally for an explicit --all flag', async () => {
    const limiter = makeLimiter();
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --all', 'alice'));

    expect(limiter.resetAll).toHaveBeenCalledTimes(1);
  });

  // `comment.user.login` is webhook-supplied, so an allowlisted name in a
  // forged payload is a complete bypass of the highest-value commands here —
  // `--all` disables spend protection instance-wide. The allowlist says who may
  // try; only the API says who may act.
  it('denies an allowlisted login the API does not recognise as a collaborator', async () => {
    const limiter = makeLimiter();
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ permission: 'read' }) }) as never,
    ) as unknown as typeof fetch;
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --all', 'alice'));

    expect(limiter.resetAll).not.toHaveBeenCalled();
    expect(limiter.getStatus).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('fails closed when the API errors', async () => {
    const limiter = makeLimiter();
    globalThis.fetch = vi.fn(async () => Promise.reject(new Error('network down'))) as never;
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));

    await sub.handle(makeEvent('/rate-limits-reset --all', 'alice'));

    expect(limiter.resetAll).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // A `String` wrapper stringifies to the allowlisted login and survives
  // `author.toLowerCase()`, so the allowlist cannot be the only thing checking
  // it. `typeof author === 'string'` rejects the payload before that comparison
  // and before any collaborator lookup. (The server-side gate rejects it again —
  // this guard is depth behind it, so a non-string login never reaches
  // `.toLowerCase()` and cannot throw out of the handler.)
  it('fails closed on a non-string comment user', async () => {
    const limiter = makeLimiter();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sub = createAdminSubscriber(limiter, makeConfig(['alice']));
    const event = makeEvent('/rate-limits', 'alice');
    (event.payload.comment as Record<string, unknown>).user = { login: new String('alice') };

    await sub.handle(event);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.getStatus).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });
});
