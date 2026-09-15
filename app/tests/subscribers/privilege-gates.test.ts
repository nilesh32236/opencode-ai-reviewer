import type { EventBus, GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG, EventBus as RealEventBus } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeCommentEvent(body: string, authorAssociation?: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 42,
    correlationId: 'test-corr-id',
    payload: {
      comment: { body, author_association: authorAssociation },
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
  });

  it('unprivileged /review posts denial and skips handlePRReview', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as never, bus, undefined as never, DEFAULT_CONFIG);
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
    const sub = createReviewSubscriber({} as never, bus, undefined as never, DEFAULT_CONFIG);
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
    const sub = createConversationSubscriber({} as never, null as never, {
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
