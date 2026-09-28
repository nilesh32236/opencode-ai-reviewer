import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuestionAnsweredSubscriber } from '../../src/subscribers/question-answered.js';

const { mockGetIssueComments, mockSetLabels, mockPostOrUpdateComment } = vi.hoisted(() => ({
  mockGetIssueComments: vi.fn(),
  mockSetLabels: vi.fn().mockResolvedValue(undefined),
  mockPostOrUpdateComment: vi.fn().mockResolvedValue({ action: 'created', commentId: 1 }),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        getIssueComments = mockGetIssueComments;
        setLabels = mockSetLabels;
        postOrUpdateComment = mockPostOrUpdateComment;
      },
    ),
  };
});

const QUESTIONS_MARKER = '<!-- issue-analysis-questions -->';

const ISSUE_AUTHOR = 'octocat';

function makeEvent(
  comment: Record<string, unknown> | undefined,
  issueAuthor: string = ISSUE_AUTHOR,
): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 7,
    correlationId: 'test-corr-id',
    payload: {
      ...(comment === undefined ? {} : { comment }),
      issue: {
        number: 7,
        user: { login: issueAuthor },
        labels: [{ name: 'analysis:needs-input' }],
      },
    },
  };
}

/** A reply from the issue author — the only shape that may advance the issue. */
function authorReply(): Record<string, unknown> {
  return { body: 'here are the answers', user: { login: ISSUE_AUTHOR, type: 'User' } };
}

describe('QuestionAnsweredSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockGetIssueComments.mockReset();
    mockGetIssueComments.mockResolvedValue([
      {
        id: 1,
        author: 'opencode-pr-agent[bot]',
        createdAt: '2026-01-01T00:00:00Z',
        body: QUESTIONS_MARKER,
      },
    ]);
    mockSetLabels.mockReset();
    mockSetLabels.mockResolvedValue(undefined);
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('marks the issue ready when the issue author answers', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent(authorReply()));

    expect(mockSetLabels).toHaveBeenCalledWith(7, ['analysis:ready'], ['analysis:needs-input']);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      7,
      '<!-- analysis-answers-received -->',
      expect.stringContaining('/fix'),
    );
  });

  it('does nothing for a reply from anyone other than the issue author', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent({ body: 'not mine', user: { login: 'stranger', type: 'User' } }));

    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // The regression for #922: `user?.login && user.login !== issueAuthor`
  // short-circuited on a missing `comment.user`, and `isBotUser(undefined)` is
  // false, so a payload with NO comment author skipped the author check and
  // still flipped the issue to `analysis:ready` plus posted a public comment.
  // GitHub always sends `comment.user`, so this is only reachable from a forged
  // payload — which is exactly the threat model this subscriber sits inside.
  it('fails closed when the comment carries no user', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent({ body: 'answers' }));

    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it.each([
    ['user is null', null],
    ['user is an empty object', {}],
    ['user is a bare string', 'octocat'],
    ['user is an array', [{ login: ISSUE_AUTHOR }]],
  ])('fails closed when comment.user is type-confused: %s', async (_label, user) => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent({ body: 'answers', user }));

    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('fails closed when the login is not an exact string match', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(
      makeEvent({ body: 'answers', user: { login: { toString: () => ISSUE_AUTHOR } } }),
    );

    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // The bot guard has to be doing this on its own: here the bot IS the issue
  // author, so the author check would happily let it through.
  it('ignores bot replies even when the bot opened the issue', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(
      makeEvent(
        { body: 'answers', user: { login: 'opencode-pr-agent[bot]', type: 'Bot' } },
        'opencode-pr-agent[bot]',
      ),
    );

    expect(mockGetIssueComments).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('ignores comments on pull requests', async () => {
    const sub = createQuestionAnsweredSubscriber();
    const event = makeEvent(authorReply());
    (event.payload.issue as Record<string, unknown>).pull_request = { number: 7 };

    await sub.handle(event);

    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it('ignores issues that are not awaiting input', async () => {
    const sub = createQuestionAnsweredSubscriber();
    const event = makeEvent(authorReply());
    (event.payload.issue as Record<string, unknown>).labels = [{ name: 'bug' }];

    await sub.handle(event);

    expect(mockGetIssueComments).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });

  it('ignores threads with no posted questions', async () => {
    mockGetIssueComments.mockResolvedValue([
      { id: 1, author: 'octocat', createdAt: '2026-01-01T00:00:00Z', body: 'unrelated chatter' },
    ]);
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent(authorReply()));

    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('no-ops when the event is already aborted', async () => {
    const sub = createQuestionAnsweredSubscriber();
    const controller = new AbortController();
    controller.abort();

    await sub.handle(makeEvent(authorReply()), controller.signal);

    expect(mockGetIssueComments).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });
});
