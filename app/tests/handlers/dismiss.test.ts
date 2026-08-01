import type { AgentConfig, LearningStore, ParsedCommand } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn(),
  };
});

import { GitHubHelper } from '@opencode-pr-agent/lib';
import {
  buildDismissAck,
  handleDismissCommand,
  parseDismissReason,
} from '../../src/handlers/dismiss.js';

const mockedGitHubHelper = vi.mocked(GitHubHelper);

function makeParsed(reason?: string): ParsedCommand {
  return {
    command: 'dismiss',
    args: reason ? [reason] : [],
    flags: {},
    raw: reason ? `/dismiss ${reason}` : '/dismiss',
  };
}

function makeConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
  };
}

describe('parseDismissReason', () => {
  it('parses a positional reason', () => {
    expect(parseDismissReason(makeParsed('false_positive'))).toBe('false_positive');
  });

  it('parses a reason flag', () => {
    const parsed: ParsedCommand = {
      command: 'dismiss',
      args: [],
      flags: { reason: 'intentional' },
      raw: '/dismiss --reason=intentional',
    };
    expect(parseDismissReason(parsed)).toBe('intentional');
  });

  it('defaults to other when no reason is given', () => {
    expect(parseDismissReason(makeParsed())).toBe('other');
  });

  it('defaults to other for unknown reasons', () => {
    expect(parseDismissReason(makeParsed('not-a-reason'))).toBe('other');
  });
});

describe('buildDismissAck', () => {
  it('includes the reason in the ack', () => {
    const ack = buildDismissAck('false_positive');
    expect(ack).toContain('false_positive');
    expect(ack).toContain('dismissed');
  });
});

describe('handleDismissCommand', () => {
  const store = {
    getFindings: vi.fn(),
    recordFeedbackBatch: vi.fn(),
  } as unknown as LearningStore;

  const ghMock = {
    getReviewCommentThread: vi.fn(),
    getBotReviewThreads: vi.fn(),
    minimizeReviewComment: vi.fn(),
    replyToReviewComment: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGitHubHelper.mockImplementation(
      class {
        constructor() {
          // biome-ignore lint/correctness/noConstructorReturn: return the shared mock instance for `new GitHubHelper(...)`
          return ghMock;
        }
      } as unknown as typeof GitHubHelper,
    );
  });

  it('skips when the replied-to comment is not from the bot', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'octocat', body: 'root', isBot: false }],
      rootComment: { id: 10, author: 'octocat', body: 'root', isBot: false },
      filePath: 'src/a.ts',
      lineNumber: 1,
    });

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed('other'),
    );

    expect(store.recordFeedbackBatch).not.toHaveBeenCalled();
    expect(ghMock.minimizeReviewComment).not.toHaveBeenCalled();
  });

  it('records dismissal feedback for matched findings', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
      { id: 'f2', pr_number: 1, type: 'issue', file: 'src/b.ts', line: 5, message: 'y' },
    ]);

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed('false_positive'),
    );

    expect(store.recordFeedbackBatch).toHaveBeenCalledWith([
      {
        findingId: 'f1',
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 1,
      },
    ]);
  });

  it('minimizes the bot comment and posts an acknowledgment', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    ghMock.getBotReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-1',
        isResolved: false,
        firstComment: {
          commentId: 'node-10',
          databaseId: 10,
          body: 'root',
          filePath: 'src/a.ts',
          lineNumber: 5,
          author: 'bot',
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    ]);

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed('intentional'),
    );

    expect(ghMock.minimizeReviewComment).toHaveBeenCalledWith('node-10', 'RESOLVED');
    expect(ghMock.replyToReviewComment).toHaveBeenCalledWith(
      1,
      10,
      expect.stringContaining('intentional'),
    );
  });

  it('records feedback with default reason other when none provided', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: undefined,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', message: 'x' },
    ]);

    await handleDismissCommand(1, 'owner/repo', 'token', makeConfig(), store, 10, makeParsed());

    expect(store.recordFeedbackBatch).toHaveBeenCalledWith([
      {
        findingId: 'f1',
        signalType: 'dismissed',
        signalValue: 'other',
        prNumber: 1,
      },
    ]);
  });
});
