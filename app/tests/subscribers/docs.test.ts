import type { AgentConfig, GitHubEvent } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/handlers/commands.js';
import { createDocsSubscriber } from '../../src/subscribers/docs.js';

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
    docs: { enabled: true, style: 'auto' },
  };
}

describe('DocsSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandleCommand.mockReset();
    mockedHandleCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalToken === undefined) {
      // Deleting via a computed key fully unsets the variable; assigning
      // `undefined` would store the literal string "undefined".
      const tokenKey = 'GITHUB_TOKEN';
      delete process.env[tokenKey];
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('triggers the docs command on /docs', async () => {
    const sub = createDocsSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('/docs'));

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
    expect(mockedHandleCommand).toHaveBeenCalledWith(
      'docs',
      42,
      'owner/repo',
      'test-token',
      expect.any(Object),
      expect.objectContaining({ command: 'docs' }),
      undefined,
      undefined,
      undefined,
    );
  });

  it('triggers the docs command with a parsed style flag', async () => {
    const sub = createDocsSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('/docs --style=tsdoc'));

    expect(mockedHandleCommand).toHaveBeenCalledTimes(1);
    expect(mockedHandleCommand).toHaveBeenCalledWith(
      'docs',
      42,
      'owner/repo',
      'test-token',
      expect.any(Object),
      expect.objectContaining({
        command: 'docs',
        flags: expect.objectContaining({ style: 'tsdoc' }),
      }),
      undefined,
      undefined,
      undefined,
    );
  });

  it('does not trigger the docs command for unrelated comments', async () => {
    const sub = createDocsSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('lgtm'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('does not trigger the docs command for other slash commands', async () => {
    const sub = createDocsSubscriber(null, makeEnabledConfig());

    await sub.handle(makeCommentEvent('/review'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });

  it('skips the docs command when docs generation is disabled', async () => {
    const sub = createDocsSubscriber(null, DEFAULT_CONFIG);

    await sub.handle(makeCommentEvent('/docs'));

    expect(mockedHandleCommand).not.toHaveBeenCalled();
  });
});
