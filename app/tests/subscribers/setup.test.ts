import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';
import { createSetupSubscriber } from '../../src/subscribers/setup.js';

vi.mock('../../src/handlers/commands.js', () => ({
  handleCommand: vi.fn(),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        postOrUpdateComment = vi.fn().mockResolvedValue(undefined);
      },
    ),
  };
});

const mockedHandleCommand = vi.mocked(handleCommand);

function makeCommentEvent(
  prNumber: number,
  body: string,
  payload?: Record<string, unknown>,
): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'issue',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber,
    payload: {
      comment: { body, author_association: 'OWNER' },
      ...payload,
    },
  };
}

describe('SetupSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleCommand.mockReset();
    mockedHandleCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('triggers handleCommand with the parsed setup command on /setup', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent(123, '/setup'));

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
    expect(mockedHandleCommand).toHaveBeenCalledWith(
      'setup',
      123,
      'owner/repo',
      'test-token',
      expect.any(Object),
      expect.objectContaining({ command: 'setup' }),
      undefined,
      undefined,
      undefined,
    );
  });

  it('triggers handleCommand on /oc setup', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent(456, '/oc setup'));

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
    expect(mockedHandleCommand.mock.calls[0]?.[1]).toBe(456);
    expect(mockedHandleCommand.mock.calls[0]?.[5]).toEqual(
      expect.objectContaining({ command: 'setup' }),
    );
  });

  it('handles review_comment.created events', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle(
      makeCommentEvent(789, '/setup', {
        type: 'review_comment.created',
      }),
    );

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
  });

  it('does not trigger for unrelated comments', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent(123, 'just a normal comment'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('does not trigger when the issue number is missing', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle({
      type: 'comment.created',
      category: 'issue',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 0,
      payload: { comment: { body: '/setup', author_association: 'OWNER' } },
    });

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('fails closed when GITHUB_TOKEN is unset instead of cloning with empty credentials', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle(makeCommentEvent(321, '/setup'));

    // getToken() throws and the subscriber logs instead of invoking the
    // engine with an empty token.
    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('does not trigger for unprivileged authors', async () => {
    const sub = createSetupSubscriber(DEFAULT_CONFIG);
    await sub.handle({
      type: 'comment.created',
      category: 'issue',
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 123,
      payload: { comment: { body: '/setup', author_association: 'NONE' } },
    });

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });
});
