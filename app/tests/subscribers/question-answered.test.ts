import { beforeEach, describe, expect, it, vi } from 'vitest';

const setLabels = vi.fn();
const postOrUpdateComment = vi.fn();
const getIssueComments = vi.fn();

vi.mock('@opencode-pr-agent/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@opencode-pr-agent/lib');
  return {
    ...actual,
    GitHubHelper: class {
      getIssueComments = getIssueComments;
      setLabels = setLabels;
      postOrUpdateComment = postOrUpdateComment;
    },
  };
});

const isBotUser = vi.fn();
vi.mock('../../src/utils/bot.js', () => ({ isBotUser: (u: unknown) => isBotUser(u) }));
vi.mock('../../src/utils/token.js', () => ({ getToken: () => 'test-token' }));

import { createQuestionAnsweredSubscriber } from '../../src/subscribers/question-answered.js';

const QUESTIONS_MARKER = '<!-- issue-analysis-questions -->';

interface EventOverrides {
  commentUser?: unknown;
  issueUser?: unknown;
  labels?: unknown;
  body?: string;
  questionsPresent?: boolean;
  hasIssue?: boolean;
  isPullRequest?: boolean;
}

function makeEvent(o: EventOverrides = {}): never {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: 1_700_000_000_000,
    repo: 'owner/repo',
    correlationId: 'corr-1',
    payload: {
      comment: {
        body: o.body ?? 'here are my answers',
        user: o.commentUser,
      },
      issue: {
        number: 7,
        user: o.issueUser,
        labels: o.labels ?? [{ name: 'analysis:needs-input' }],
        ...(o.isPullRequest ? { pull_request: { number: 7 } } : {}),
      },
    },
  } as never;
}

/** Assert the issue was NOT advanced — the mutation, not just the return value. */
function expectNotAdvanced() {
  expect(setLabels, 'label was flipped by a non-author').not.toHaveBeenCalled();
  expect(
    postOrUpdateComment,
    'a misleading "Answers received" comment was posted',
  ).not.toHaveBeenCalled();
}

function expectAdvanced() {
  expect(setLabels, 'author was blocked').toHaveBeenCalledWith(
    7,
    ['analysis:ready'],
    ['analysis:needs-input'],
  );
}

describe('QuestionAnsweredSubscriber identity guard', () => {
  beforeEach(() => {
    setLabels.mockClear();
    postOrUpdateComment.mockClear();
    isBotUser.mockReset();
    isBotUser.mockReturnValue(false);
    getIssueComments.mockResolvedValue([{ body: QUESTIONS_MARKER }]);
  });

  it('lets the issue author advance the issue (positive control)', async () => {
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser: { login: 'owner-author' }, issueUser: { login: 'owner-author' } }),
    );
    expectAdvanced();
  });

  it('blocks a commenter who is not the issue author', async () => {
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser: { login: 'stranger' }, issueUser: { login: 'owner-author' } }),
    );
    expectNotAdvanced();
  });

  // The regression this file exists for: a payload with no `comment.user` used to
  // short-circuit the author check and advance the issue on anyone's behalf.
  it.each([
    ['comment.user absent', undefined],
    ['comment.user null', null],
    ['comment.user is a string', 'owner-author'],
    ['comment.user has no login', { type: 'User' }],
    ['comment.user.login is empty', { login: '' }],
    ['comment.user.login is a number', { login: 42 }],
    ['comment.user.login is an object', { login: { toString: () => 'owner-author' } }],
    ['comment.user.login is an array', { login: ['owner-author'] }],
  ])('blocks when %s', async (_label, commentUser) => {
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser, issueUser: { login: 'owner-author' } }),
    );
    expectNotAdvanced();
  });

  it.each([
    ['issue.user absent', undefined],
    ['issue.user null', null],
    ['issue.user has no login', {}],
    ['issue.user.login is empty', { login: '' }],
    ['issue.user.login is a number', { login: 7 }],
  ])('blocks when %s even if the commenter claims a login', async (_label, issueUser) => {
    // Both sides must be present; a missing author is not a wildcard match.
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser: { login: 'anyone' }, issueUser }),
    );
    expectNotAdvanced();
  });

  it('is case-sensitive about the login comparison', async () => {
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser: { login: 'Owner-Author' }, issueUser: { login: 'owner-author' } }),
    );
    expectNotAdvanced();
  });

  it('blocks a bot commenter', async () => {
    isBotUser.mockReturnValue(true);
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser: { login: 'owner-author' }, issueUser: { login: 'owner-author' } }),
    );
    expectNotAdvanced();
  });

  it('blocks when the questions marker is absent', async () => {
    getIssueComments.mockResolvedValue([{ body: 'just an ordinary comment' }]);
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({ commentUser: { login: 'owner-author' }, issueUser: { login: 'owner-author' } }),
    );
    expectNotAdvanced();
  });

  it('blocks when analysis:needs-input is not set', async () => {
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({
        commentUser: { login: 'owner-author' },
        issueUser: { login: 'owner-author' },
        labels: [{ name: 'bug' }],
      }),
    );
    expectNotAdvanced();
  });

  it('blocks on a pull request comment', async () => {
    await createQuestionAnsweredSubscriber().handle(
      makeEvent({
        commentUser: { login: 'owner-author' },
        issueUser: { login: 'owner-author' },
        isPullRequest: true,
      }),
    );
    expectNotAdvanced();
  });
});
