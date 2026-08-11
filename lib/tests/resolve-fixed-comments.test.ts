import { describe, expect, it, vi } from 'vitest';
import type { PreviousFindingIteration, ReviewIssue } from '../src/types/index.js';
import { resolveFixedComments } from '../src/utils/autofix-body.js';

function makeAdapter() {
  return {
    getReviewThreads: vi.fn(),
    resolveReviewThread: vi.fn(),
    minimizeReviewComment: vi.fn(),
  };
}

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    type: 'issue',
    severity: 'important',
    file: 'src/a.ts',
    line: 10,
    message: 'Potential null dereference on user input',
    ...overrides,
  };
}

describe('resolveFixedComments', () => {
  it('resolves a thread whose issue no longer appears in the current review', async () => {
    const adapter = makeAdapter();
    adapter.getReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-1',
        isResolved: false,
        firstComment: {
          commentId: 'node-1',
          databaseId: 1,
          body: 'issue',
          filePath: 'src/a.ts',
          lineNumber: 10,
          author: 'bot',
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    ]);
    const previous: PreviousFindingIteration = {
      iteration: 0,
      issues: [makeIssue()],
      commentIds: [{ file: 'src/a.ts', line: 10, commentId: 1, nodeId: 'node-1' }],
    };

    await resolveFixedComments(
      adapter as never,
      1,
      [previous],
      [makeIssue({ message: 'Unrelated new finding' })],
    );

    expect(adapter.resolveReviewThread).toHaveBeenCalledWith('thread-1');
  });

  it('keeps a thread open when the same message still appears (line shifted)', async () => {
    const adapter = makeAdapter();
    adapter.getReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-1',
        isResolved: false,
        firstComment: {
          commentId: 'node-1',
          databaseId: 1,
          body: 'issue',
          filePath: 'src/a.ts',
          lineNumber: 10,
          author: 'bot',
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    ]);
    const previous: PreviousFindingIteration = {
      iteration: 0,
      issues: [makeIssue()],
      commentIds: [{ file: 'src/a.ts', line: 10, commentId: 1, nodeId: 'node-1' }],
    };
    // The issue moved from line 10 to line 14 (lines added above) but is the
    // same message — it must NOT be resolved as fixed.
    const current = [makeIssue({ line: 14, message: 'Potential null dereference on user input' })];

    await resolveFixedComments(adapter as never, 1, [previous], current);

    expect(adapter.resolveReviewThread).not.toHaveBeenCalled();
    expect(adapter.getReviewThreads).not.toHaveBeenCalled();
  });

  it('resolves a thread when the same line recurs but the message changed', async () => {
    const adapter = makeAdapter();
    adapter.getReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-1',
        isResolved: false,
        firstComment: {
          commentId: 'node-1',
          databaseId: 1,
          body: 'issue',
          filePath: 'src/a.ts',
          lineNumber: 10,
          author: 'bot',
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
    ]);
    const previous: PreviousFindingIteration = {
      iteration: 0,
      issues: [makeIssue()],
      commentIds: [{ file: 'src/a.ts', line: 10, commentId: 1, nodeId: 'node-1' }],
    };
    const current = [makeIssue({ line: 10, message: 'A different issue entirely' })];

    await resolveFixedComments(adapter as never, 1, [previous], current);

    // Same coordinates but a different message — the original issue is gone.
    expect(adapter.resolveReviewThread).toHaveBeenCalledWith('thread-1');
  });

  it('does nothing when there are no previous findings or comment IDs', async () => {
    const adapter = makeAdapter();

    await resolveFixedComments(adapter as never, 1, [], [makeIssue()]);

    expect(adapter.getReviewThreads).not.toHaveBeenCalled();
    expect(adapter.resolveReviewThread).not.toHaveBeenCalled();
  });
});
