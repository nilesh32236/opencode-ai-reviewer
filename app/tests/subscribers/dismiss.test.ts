import type { GitHubEvent, LearningStore } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDismissCommand } from '../../src/handlers/dismiss.js';
import { createDismissSubscriber } from '../../src/subscribers/dismiss.js';

vi.mock('../../src/handlers/dismiss.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/handlers/dismiss.js')>();
  return {
    ...actual,
    handleDismissCommand: vi.fn(),
  };
});

const mockedHandleDismiss = vi.mocked(handleDismissCommand);

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
        author_association: 'COLLABORATOR',
      },
      ...overrides,
    },
  };
}

describe('DismissSubscriber', () => {
  const store = {} as LearningStore;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleDismiss.mockReset();
    mockedHandleDismiss.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('triggers the dismiss handler for a /dismiss reply', async () => {
    const sub = createDismissSubscriber(store);

    await sub.handle(makeEvent('/dismiss false_positive'));

    expect(mockedHandleDismiss).toHaveBeenCalledTimes(1);
    const [prNumber, repo, token, , , parentId, parsed, association] =
      mockedHandleDismiss.mock.calls[0];
    expect(prNumber).toBe(123);
    expect(repo).toBe('owner/repo');
    expect(token).toBe('test-token');
    expect(parentId).toBe(42);
    expect(parsed?.command).toBe('dismiss');
    expect(parsed?.args).toEqual(['false_positive']);
    expect(association).toBe('COLLABORATOR');
  });

  it('does not trigger for non-dismiss comments', async () => {
    const sub = createDismissSubscriber(store);

    await sub.handle(makeEvent('Looks good to me!'));

    expect(mockedHandleDismiss).not.toHaveBeenCalled();
  });

  it('does not trigger for other slash commands', async () => {
    const sub = createDismissSubscriber(store);

    await sub.handle(makeEvent('/fix'));

    expect(mockedHandleDismiss).not.toHaveBeenCalled();
  });

  it('does not trigger for bot-authored comments', async () => {
    const sub = createDismissSubscriber(store);

    await sub.handle(
      makeEvent('/dismiss false_positive', {
        comment: {
          body: '/dismiss false_positive',
          in_reply_to_id: 42,
          user: { type: 'Bot', login: 'opencode-pr-agent[bot]' },
          author_association: 'MEMBER',
        },
      }),
    );

    expect(mockedHandleDismiss).not.toHaveBeenCalled();
  });

  it('does not trigger without an in_reply_to_id', async () => {
    const sub = createDismissSubscriber(store);

    await sub.handle(
      makeEvent('/dismiss false_positive', {
        comment: {
          body: '/dismiss false_positive',
          user: { type: 'User', login: 'octocat' },
          author_association: 'COLLABORATOR',
        },
      }),
    );

    expect(mockedHandleDismiss).not.toHaveBeenCalled();
  });

  it('does not trigger for unprivileged commenters', async () => {
    const sub = createDismissSubscriber(store);

    await sub.handle(
      makeEvent('/dismiss false_positive', {
        comment: {
          body: '/dismiss false_positive',
          in_reply_to_id: 42,
          user: { type: 'User', login: 'external-contributor' },
          author_association: 'CONTRIBUTOR',
        },
      }),
    );

    expect(mockedHandleDismiss).not.toHaveBeenCalled();
  });
});
