import type { AgentConfig, GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';
import { createDescribeSubscriber } from '../../src/subscribers/describe.js';

vi.mock('../../src/handlers/commands.js', () => ({
  handleCommand: vi.fn(),
}));

const mockedHandleCommand = vi.mocked(handleCommand);

const originalToken = process.env.GITHUB_TOKEN;

function makeCommentEvent(body: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'issue',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 42,
    payload: {
      comment: { body },
    },
  };
}

function makeEnabledConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    describe: { enabled: true },
  };
}

describe('DescribeSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleCommand.mockReset();
    mockedHandleCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalToken === undefined) {
      const tokenKey = 'GITHUB_TOKEN';
      delete process.env[tokenKey];
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('triggers the describe command on /describe', async () => {
    const sub = createDescribeSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('/describe'));

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
    expect(mockedHandleCommand).toHaveBeenCalledWith(
      'describe',
      42,
      'owner/repo',
      'test-token',
      expect.any(Object),
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('does not trigger the describe command for unrelated comments', async () => {
    const sub = createDescribeSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('lgtm'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('does not trigger the describe command for other slash commands', async () => {
    const sub = createDescribeSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('/review'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('skips the describe command when describe generation is disabled', async () => {
    const sub = createDescribeSubscriber(null, {
      ...DEFAULT_CONFIG,
      describe: { enabled: false },
    });

    await sub.handle(makeCommentEvent('/describe'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });
});
