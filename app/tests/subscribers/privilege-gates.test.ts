import type { EventBus, GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG, EventBus as RealEventBus } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';
import { handleConversation } from '../../src/handlers/conversation.js';
import { handlePRReview } from '../../src/handlers/pr-review.js';
import { handleReply } from '../../src/handlers/reply.js';
import { createConversationSubscriber } from '../../src/subscribers/conversation.js';
import { createDescribeSubscriber } from '../../src/subscribers/describe.js';
import { createDiscoverSubscriber } from '../../src/subscribers/discover.js';
import { createDocsSubscriber } from '../../src/subscribers/docs.js';
import { createExplainSubscriber } from '../../src/subscribers/explain.js';
import { createFixSubscriber } from '../../src/subscribers/fix.js';
import { createMetricsSubscriber } from '../../src/subscribers/metrics.js';
import { createReplySubscriber } from '../../src/subscribers/reply.js';
import { createReviewSubscriber } from '../../src/subscribers/review.js';
import { createSetupSubscriber } from '../../src/subscribers/setup.js';
import { clearPrivilegeVerificationCache } from '../../src/utils/privilege.js';

vi.mock('../../src/handlers/commands.js', () => ({
  handleCommand: vi.fn(),
}));

vi.mock('../../src/handlers/pr-review.js', () => ({
  handlePRReview: vi.fn(),
}));

vi.mock('../../src/handlers/reply.js', () => ({
  handleReply: vi.fn(),
}));

vi.mock('../../src/handlers/conversation.js', () => ({
  handleConversation: vi.fn(),
}));

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

const mockedHandleCommand = vi.mocked(handleCommand);
const mockedHandleConversation = vi.mocked(handleConversation);
const mockedHandlePRReview = vi.mocked(handlePRReview);
const mockedHandleReply = vi.mocked(handleReply);

const DENIED_FILTER = {
  allowed: new Set<string>(),
  denied: new Set<string>(['owner/repo']),
};

/** Allowing stub limiter so privileged-path tests exercise the gate, not rate limits. */
function makeAllowLimiter() {
  return {
    checkReview: vi.fn(async () => ({
      allowed: true,
      remaining: 10,
      resetAt: Date.now() + 60_000,
      reservationId: 'res-allow',
    })),
    recordReview: vi.fn(async () => undefined),
  } as never;
}

function makeCommentEvent(body: string, authorAssociation?: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 42,
    correlationId: 'test-corr-id',
    payload: {
      comment: {
        body,
        author_association: authorAssociation,
        user: { login: 'octocat', type: 'User' },
      },
      sender: { login: 'octocat', type: 'User', author_association: authorAssociation },
      issue: { number: 42 },
      pull_request: { number: 42, user: { login: 'octocat' } },
    },
  };
}

function makeReplyEvent(): GitHubEvent {
  return {
    type: 'review_comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 123,
    correlationId: 'test-corr-id',
    payload: {
      comment: {
        body: 'Could you clarify why this is an issue?',
        in_reply_to_id: 42,
        user: { type: 'User', login: 'octocat' },
      },
    },
  };
}

function makeAskEvent(body: string, authorAssociation?: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 42,
    correlationId: 'test-corr-id',
    payload: {
      comment: {
        id: 999,
        body,
        author_association: authorAssociation,
        user: { type: 'User', login: 'octocat' },
      },
      sender: { login: 'octocat', type: 'User', author_association: authorAssociation },
      issue: { number: 42 },
    },
  };
}

describe('privilege deny-path gates', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleCommand.mockReset();
    mockedHandleCommand.mockResolvedValue(undefined);
    mockedHandlePRReview.mockReset();
    mockedHandlePRReview.mockResolvedValue(null);
    mockedHandleReply.mockReset();
    mockedHandleReply.mockResolvedValue(undefined);
    mockedHandleConversation.mockReset();
    mockedHandleConversation.mockResolvedValue(undefined);
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
    clearPrivilegeVerificationCache();
    // Server-side verification seam: privileged collaborator by default.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ permission: 'write' }) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The whole point of verifyPrivilegeGate is that a payload-supplied
  // `author_association` is a HINT, not proof. Without this test the suite
  // cannot tell "verified against the API" apart from "trusted the payload":
  // making the gate return early without any API call leaves every other case
  // in this file green.
  describe('forged privilege hint', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('denies when the payload claims OWNER but the API says otherwise', async () => {
      let apiCalls = 0;
      globalThis.fetch = vi.fn(async () => {
        apiCalls++;
        // 404 from the collaborator-permission endpoint == not a collaborator.
        return new Response('{"message":"Not Found"}', { status: 404 }) as unknown as Response;
      }) as unknown as typeof fetch;

      const sub = createFixSubscriber(undefined as never, DEFAULT_CONFIG);
      await sub.handle(makeCommentEvent('/fix', 'OWNER'));

      expect(apiCalls).toBeGreaterThan(0);
      expect(mockedHandleCommand).not.toHaveBeenCalled();
    });
  });

  it('unprivileged /review posts denial and skips handlePRReview', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as never, bus, makeAllowLimiter(), DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent('/review', 'NONE'));
    expect(mockedHandlePRReview).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:review -->',
      expect.stringContaining('/review'),
    );
  });

  it('privileged /review proceeds to handlePRReview', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as never, bus, makeAllowLimiter(), DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent('/review', 'OWNER'));
    expect(mockedHandlePRReview).toHaveBeenCalledTimes(1);
  });

  it('unprivileged /explain posts denial and skips handleCommand', async () => {
    const sub = createExplainSubscriber(undefined as never, DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent('/explain', 'CONTRIBUTOR'));
    expect(mockedHandleCommand).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:explain -->',
      expect.stringContaining('/explain'),
    );
  });

  it('unprivileged /fix posts denial and skips handleCommand', async () => {
    const sub = createFixSubscriber(undefined as never, DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent('/fix', 'NONE'));
    expect(mockedHandleCommand).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:fix -->',
      expect.stringContaining('/fix'),
    );
  });

  it('unprivileged /describe posts denial and skips handleCommand', async () => {
    const sub = createDescribeSubscriber(null, {
      ...DEFAULT_CONFIG,
      describe: { enabled: true },
    });
    await sub.handle(makeCommentEvent('/describe', 'NONE'));
    expect(mockedHandleCommand).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:describe -->',
      expect.stringContaining('/describe'),
    );
  });

  it('unprivileged /docs posts denial and skips handleCommand', async () => {
    const sub = createDocsSubscriber(null, {
      ...DEFAULT_CONFIG,
      docs: { ...DEFAULT_CONFIG.docs, enabled: true },
    });
    await sub.handle(makeCommentEvent('/docs', 'NONE'));
    expect(mockedHandleCommand).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:docs -->',
      expect.stringContaining('/docs'),
    );
  });

  it('unprivileged /ask skips handleConversation', async () => {
    const sub = createConversationSubscriber({} as never, null as never, {
      ...DEFAULT_CONFIG,
      conversation: {
        ...DEFAULT_CONFIG.conversation,
        enabled: true,
        askCommandEnabled: true,
        mentionHandle: 'bot',
      },
    });
    await sub.handle(makeAskEvent('/ask why is this null?', 'NONE'));
    expect(mockedHandleConversation).not.toHaveBeenCalled();
  });

  it('privileged /ask proceeds to handleConversation', async () => {
    const sub = createConversationSubscriber({} as never, makeAllowLimiter(), {
      ...DEFAULT_CONFIG,
      conversation: {
        ...DEFAULT_CONFIG.conversation,
        enabled: true,
        askCommandEnabled: true,
        mentionHandle: 'bot',
      },
    });
    await sub.handle(makeAskEvent('/ask why is this null?', 'OWNER'));
    expect(mockedHandleConversation).toHaveBeenCalledTimes(1);
  });

  it('unprivileged plain @mention conversation skips handleConversation', async () => {
    const sub = createConversationSubscriber({} as never, makeAllowLimiter(), {
      ...DEFAULT_CONFIG,
      conversation: {
        ...DEFAULT_CONFIG.conversation,
        enabled: true,
        askCommandEnabled: true,
        mentionHandle: 'bot',
      },
    });
    await sub.handle(makeAskEvent('@bot hello there', 'NONE'));
    expect(mockedHandleConversation).not.toHaveBeenCalled();
  });

  it('privileged plain @mention conversation proceeds to handleConversation', async () => {
    const sub = createConversationSubscriber({} as never, makeAllowLimiter(), {
      ...DEFAULT_CONFIG,
      conversation: {
        ...DEFAULT_CONFIG.conversation,
        enabled: true,
        askCommandEnabled: true,
        mentionHandle: 'bot',
      },
    });
    await sub.handle(makeAskEvent('@bot hello there', 'OWNER'));
    expect(mockedHandleConversation).toHaveBeenCalledTimes(1);
  });

  it('unprivileged reply skips handleReply', async () => {
    const sub = createReplySubscriber(undefined as never, DEFAULT_CONFIG);
    const event: GitHubEvent = {
      type: 'review_comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 123,
      correlationId: 'test-corr-id',
      payload: {
        comment: {
          body: 'Could you clarify why this is an issue?',
          in_reply_to_id: 42,
          author_association: 'NONE',
          user: { type: 'User', login: 'octocat' },
        },
      },
    };
    await sub.handle(event);
    expect(mockedHandleReply).not.toHaveBeenCalled();
  });

  it('unprivileged /metrics posts denial and skips the report', async () => {
    const sub = createMetricsSubscriber({} as never);
    const event: GitHubEvent = {
      type: 'comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 42,
      correlationId: 'test-corr-id',
      payload: { comment: { body: '/metrics', author_association: 'NONE' } },
    };
    await sub.handle(event);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:metrics -->',
      expect.stringContaining('/metrics'),
    );
  });

  it('unprivileged /discover posts denial and skips discovery', async () => {
    const sub = createDiscoverSubscriber({} as never, null as never);
    const event: GitHubEvent = {
      type: 'comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 42,
      correlationId: 'test-corr-id',
      payload: { comment: { body: '/discover', author_association: 'NONE' } },
    };
    await sub.handle(event);
    expect(mockedHandleCommand).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:discover -->',
      expect.stringContaining('/discover'),
    );
  });

  it('unprivileged /setup posts denial and skips handleCommand', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    const event: GitHubEvent = {
      type: 'comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 42,
      correlationId: 'test-corr-id',
      payload: { comment: { body: '/setup', author_association: 'NONE' } },
    };
    await sub.handle(event);
    expect(mockedHandleCommand).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:setup -->',
      expect.stringContaining('/setup'),
    );
  });

  it('missing association on a comment event fails closed', async () => {
    const sub = createFixSubscriber(makeAllowLimiter(), DEFAULT_CONFIG);
    const event: GitHubEvent = {
      type: 'comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 42,
      correlationId: 'test-corr-id',
      payload: { comment: { body: '/fix' } },
    };
    await sub.handle(event);
    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });
});

describe('repo-allowlist deny-path gates', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleReply.mockReset();
    mockedHandleReply.mockResolvedValue(undefined);
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
  });

  it('reply with denied repoFilter skips handleReply', async () => {
    const sub = createReplySubscriber(undefined as never, DEFAULT_CONFIG, DENIED_FILTER);
    await sub.handle(makeReplyEvent());
    expect(mockedHandleReply).not.toHaveBeenCalled();
  });

  it('metrics with denied repoFilter posts no comment', async () => {
    const sub = createMetricsSubscriber({} as never, DENIED_FILTER);
    const event: GitHubEvent = {
      type: 'comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 42,
      correlationId: 'test-corr-id',
      payload: { comment: { body: '/metrics' } },
    };
    await sub.handle(event);
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('discover with denied repoFilter posts no comment', async () => {
    const sub = createDiscoverSubscriber({} as never, null as never, DENIED_FILTER);
    const event: GitHubEvent = {
      type: 'comment.created',
      category: 'comment',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 42,
      correlationId: 'test-corr-id',
      payload: { comment: { body: '/discover' } },
    };
    await sub.handle(event);
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });
});
