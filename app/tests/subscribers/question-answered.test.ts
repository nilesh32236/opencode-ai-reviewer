import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuestionAnsweredSubscriber } from '../../src/subscribers/question-answered.js';

const { mockGetIssue, mockSetLabels, mockPostOrUpdateComment } = vi.hoisted(() => ({
  mockGetIssue: vi.fn(),
  mockSetLabels: vi.fn().mockResolvedValue(undefined),
  mockPostOrUpdateComment: vi.fn().mockResolvedValue({ action: 'created', commentId: 1 }),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        getIssue = mockGetIssue;
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
    mockGetIssue.mockReset();
    // The author comes from GitHub's own record, not from the delivery, so
    // every test states it explicitly rather than letting the payload decide.
    mockGetIssue.mockResolvedValue({
      number: 7,
      title: 'Something is broken',
      body: '',
      labels: ['analysis:needs-input'],
      author: ISSUE_AUTHOR,
      comments: [
        {
          id: 1,
          author: 'opencode-pr-agent[bot]',
          createdAt: '2026-01-01T00:00:00Z',
          body: QUESTIONS_MARKER,
        },
      ],
    });
    mockSetLabels.mockReset();
    mockSetLabels.mockResolvedValue(undefined);
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
  });

  afterEach(() => {
    // `delete`, not assignment: `process.env.X = undefined` stores the STRING
    // "undefined", which is truthy, so `getToken()` would stop failing closed
    // for every later test in this process.
    // biome-ignore lint/performance/noDelete: assignment would store the STRING "undefined"
    delete process.env.GITHUB_TOKEN;
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

  // The author's first guard, before any identity or I/O work.
  it('ignores events with no comment payload', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent(undefined));

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('does nothing for a reply from anyone other than the issue author', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent({ body: 'not mine', user: { login: 'stranger', type: 'User' } }));

    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // GitHub logins are case-insensitive identities, so a delivery whose casing
  // differs (or an account renamed between issue creation and the reply) must
  // still count as the author — otherwise the issue silently never advances
  // past `analysis:needs-input`.
  it('matches the author case-insensitively', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(makeEvent({ body: 'answers', user: { login: 'OctoCat', type: 'User' } }));

    expect(mockSetLabels).toHaveBeenCalledWith(7, ['analysis:ready'], ['analysis:needs-input']);
    expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
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

    expect(mockGetIssue).not.toHaveBeenCalled();
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

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // A `String` wrapper is truthy, survives the bot check without throwing, and
  // is never `===` the plain string, so this case can only pass through the
  // author guard. An object with a `toString` would instead throw inside
  // `isBotLogin` and be swallowed by the catch — green, but vacuous.
  it('fails closed when the login is not a plain string', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(
      makeEvent({ body: 'answers', user: { login: new String(ISSUE_AUTHOR), type: 'User' } }),
    );

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // Comparing two fields of one delivery would be a consistency check, not
  // authentication: a forger controls both. The comparison is against GitHub's
  // record, so a payload that names the attacker on BOTH sides is still denied.
  it('rejects a forged payload that claims the attacker is the issue author', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(
      makeEvent({ body: 'answers', user: { login: 'attacker', type: 'User' } }, 'attacker'),
    );

    expect(mockGetIssue).toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  // The bot guard has to be doing this on its own: here the bot would also be
  // the author, so only the bot check can produce the observed result.
  it('ignores bot replies even when the bot opened the issue', async () => {
    const sub = createQuestionAnsweredSubscriber();

    await sub.handle(
      makeEvent(
        { body: 'answers', user: { login: 'opencode-pr-agent[bot]', type: 'Bot' } },
        'opencode-pr-agent[bot]',
      ),
    );

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('ignores comments on pull requests', async () => {
    const sub = createQuestionAnsweredSubscriber();
    const event = makeEvent(authorReply());
    (event.payload.issue as Record<string, unknown>).pull_request = { number: 7 };

    await sub.handle(event);

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('ignores issues that are not awaiting input', async () => {
    const sub = createQuestionAnsweredSubscriber();
    const event = makeEvent(authorReply());
    (event.payload.issue as Record<string, unknown>).labels = [{ name: 'bug' }];

    await sub.handle(event);

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('ignores threads with no posted questions', async () => {
    mockGetIssue.mockResolvedValue({
      number: 7,
      title: 'Something is broken',
      body: '',
      labels: ['analysis:needs-input'],
      author: ISSUE_AUTHOR,
      comments: [
        {
          id: 1,
          author: ISSUE_AUTHOR,
          createdAt: '2026-01-01T00:00:00Z',
          body: 'unrelated chatter',
        },
      ],
    });
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

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetLabels).not.toHaveBeenCalled();
  });
});
