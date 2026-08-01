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
  isPrivilegedAuthor,
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

describe('isPrivilegedAuthor', () => {
  it('allows owner, member, and collaborator associations', () => {
    expect(isPrivilegedAuthor('OWNER')).toBe(true);
    expect(isPrivilegedAuthor('MEMBER')).toBe(true);
    expect(isPrivilegedAuthor('COLLABORATOR')).toBe(true);
  });

  it('rejects unprivileged and missing associations', () => {
    expect(isPrivilegedAuthor('CONTRIBUTOR')).toBe(false);
    expect(isPrivilegedAuthor('NONE')).toBe(false);
    expect(isPrivilegedAuthor(undefined)).toBe(false);
    expect(isPrivilegedAuthor('')).toBe(false);
  });
});

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

  it('joins multi-word positional arguments into an underscore reason', () => {
    const parsed: ParsedCommand = {
      command: 'dismiss',
      args: ['false', 'positive'],
      flags: {},
      raw: '/dismiss false positive',
    };
    expect(parseDismissReason(parsed)).toBe('false_positive');
  });

  it('normalizes spaced flag reasons', () => {
    const parsed: ParsedCommand = {
      command: 'dismiss',
      args: [],
      flags: { reason: 'false positive' },
      raw: '/dismiss --reason="false positive"',
    };
    expect(parseDismissReason(parsed)).toBe('false_positive');
  });
});

describe('buildDismissAck', () => {
  it('includes the reason in the ack', () => {
    const ack = buildDismissAck('false_positive');
    expect(ack).toContain('false_positive');
    expect(ack).toContain('dismissed');
  });

  it('notes suppression for false_positive dismissals', () => {
    const ack = buildDismissAck('false_positive', { suppressed: true, minimized: true });
    expect(ack).toContain('Future reviews will account for this feedback.');
  });

  it('notes metrics-only behavior for out_of_scope dismissals', () => {
    const ack = buildDismissAck('out_of_scope', { suppressed: false, minimized: true });
    expect(ack).toContain('recorded for metrics only');
  });

  it('notes when the comment could not be minimized', () => {
    const ack = buildDismissAck('false_positive', { suppressed: true, minimized: false });
    expect(ack).toContain('could not be hidden automatically');
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
      'COLLABORATOR',
    );

    expect(store.recordFeedbackBatch).not.toHaveBeenCalled();
    expect(ghMock.minimizeReviewComment).not.toHaveBeenCalled();
  });

  it('skips when the dismissing user is not privileged', async () => {
    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed('other'),
      'CONTRIBUTOR',
    );

    expect(ghMock.getReviewCommentThread).not.toHaveBeenCalled();
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
      'COLLABORATOR',
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

  it('correlates findings by comment_id when the identifier is available', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'f1',
        pr_number: 1,
        type: 'issue',
        file: 'src/a.ts',
        line: 5,
        message: 'x',
        comment_id: 9,
      },
      {
        id: 'f2',
        pr_number: 1,
        type: 'issue',
        file: 'src/a.ts',
        line: 5,
        message: 'x',
        comment_id: 10,
      },
    ]);

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed('false_positive'),
      'COLLABORATOR',
    );

    expect(store.recordFeedbackBatch).toHaveBeenCalledWith([
      {
        findingId: 'f2',
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 1,
      },
    ]);
  });

  it('bails out when the thread has no file/line anchor and no comment_id', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: '',
      lineNumber: undefined,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
    ]);

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed(),
      'COLLABORATOR',
    );

    expect(store.recordFeedbackBatch).not.toHaveBeenCalled();
    expect(ghMock.minimizeReviewComment).not.toHaveBeenCalled();
    expect(ghMock.replyToReviewComment).toHaveBeenCalledWith(
      1,
      10,
      expect.stringContaining('No matching finding found'),
    );
  });

  it('skips immediately on the gitlab platform', async () => {
    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      { ...makeConfig(), platform: 'gitlab' },
      store,
      10,
      makeParsed('false_positive'),
      'COLLABORATOR',
    );

    expect(ghMock.getReviewCommentThread).not.toHaveBeenCalled();
    expect(store.recordFeedbackBatch).not.toHaveBeenCalled();
  });

  it('minimizes a nested bot reply via its own node id when no thread root matches', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [
        { id: 10, author: 'bot', body: 'root', isBot: true },
        { id: 11, author: 'bot', body: 'follow-up', isBot: true },
      ],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
    ]);
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
    ghMock.getReviewComment.mockResolvedValue({
      id: 11,
      body: 'follow-up',
      user: { login: 'bot', type: 'Bot' },
      node_id: 'node-11',
    });

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      11,
      makeParsed('false_positive'),
      'COLLABORATOR',
    );

    expect(ghMock.minimizeReviewComment).toHaveBeenCalledWith('node-11', 'RESOLVED');
    expect(ghMock.replyToReviewComment).toHaveBeenCalledWith(
      1,
      11,
      expect.stringContaining('false_positive'),
    );
  });

  it('acknowledges metrics-only dismissal for out_of_scope', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
    ]);
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
      makeParsed('out_of_scope'),
      'COLLABORATOR',
    );

    expect(ghMock.replyToReviewComment).toHaveBeenCalledWith(
      1,
      10,
      expect.stringContaining('recorded for metrics only'),
    );
  });

  it('minimizes the bot comment and posts an acknowledgment', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
    ]);
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
      'COLLABORATOR',
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
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
    ]);

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed(),
      'COLLABORATOR',
    );

    expect(store.recordFeedbackBatch).toHaveBeenCalledWith([
      {
        findingId: 'f1',
        signalType: 'dismissed',
        signalValue: 'other',
        prNumber: 1,
      },
    ]);
  });

  it('does not minimize or post an ack when nothing was recorded', async () => {
    ghMock.getReviewCommentThread.mockResolvedValue({
      comments: [{ id: 10, author: 'bot', body: 'root', isBot: true }],
      rootComment: { id: 10, author: 'bot', body: 'root', isBot: true },
      filePath: 'src/a.ts',
      lineNumber: 5,
    });
    (store.getFindings as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'f1', pr_number: 1, type: 'issue', file: 'src/a.ts', line: 5, message: 'x' },
    ]);
    (store.recordFeedbackBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db down'),
    );

    await handleDismissCommand(
      1,
      'owner/repo',
      'token',
      makeConfig(),
      store,
      10,
      makeParsed('other'),
      'COLLABORATOR',
    );

    expect(ghMock.minimizeReviewComment).not.toHaveBeenCalled();
    expect(ghMock.replyToReviewComment).not.toHaveBeenCalled();
  });
});
