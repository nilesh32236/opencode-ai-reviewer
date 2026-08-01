import type { GitHubHelper } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInputs } from './helpers/mock-factories.js';

const { mockGetState, mockGetInput, mockInfo, mockWarning, mockPostOrUpdateComment } = vi.hoisted(
  () => {
    const _mockGetState = vi.fn();
    const _mockGetInput = vi.fn();
    const _mockInfo = vi.fn();
    const _mockWarning = vi.fn();
    const _mockPostOrUpdateComment = vi.fn();
    return {
      mockGetState: _mockGetState,
      mockGetInput: _mockGetInput,
      mockInfo: _mockInfo,
      mockWarning: _mockWarning,
      mockPostOrUpdateComment: _mockPostOrUpdateComment,
    };
  },
);

vi.mock('@actions/core', () => ({
  getState: mockGetState,
  getInput: mockGetInput,
  info: mockInfo,
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
  summary: { addHeading: vi.fn(), addList: vi.fn(), write: vi.fn() },
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: {
      pull_request: { number: 42 },
    },
  },
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    LearningStore: class {
      async getTelemetryStats() {
        return { totalReviews: 0, avgDurationMs: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
      }
      async getPerPRStats() {
        return { totalPrs: 0, totalFindings: 0, avgFindingsPerPr: 0, maxFindingsInPr: 0 };
      }
      async getSeverityDistribution() {
        return { critical: 0, important: 0, minor: 0, unknown: 0 };
      }
      async close() {}
    },
  };
});

import { runPost } from '../src/post.js';

const mockGh = {
  postOrUpdateComment: mockPostOrUpdateComment,
} as unknown as GitHubHelper;

describe('runPost token usage comment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue('');
    mockGetInput.mockImplementation((name: string) => (name === 'learning_enabled' ? 'false' : ''));
  });

  it('posts a token usage comment when token_usage state is present', async () => {
    mockGetState.mockImplementation((key: string) => {
      switch (key) {
        case 'token_usage':
          return '1234';
        case 'token_usage_duration':
          return '5000';
        case 'token_usage_prompt':
          return '1000';
        case 'token_usage_completion':
          return '234';
        case 'cost':
          return '0.0046';
        default:
          return '';
      }
    });

    await runPost(makeInputs(), mockGh, 'owner/repo', 'token');

    expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
    const [prNumber, marker, body] = mockPostOrUpdateComment.mock.calls[0] as [
      number,
      string,
      string,
    ];
    expect(prNumber).toBe(42);
    expect(marker).toBe('<!-- token-usage -->');
    expect(body).toContain('| Total Tokens | 1,234 |');
    expect(body).toContain('| Prompt Tokens | 1,000 |');
    expect(body).toContain('| Completion Tokens | 234 |');
    expect(body).toContain('| Duration | 5.0s |');
    expect(body).toContain('| Estimated Cost | $0.0046 |');
  });

  it('skips the comment when no token_usage state was saved (e.g. disabled via config)', async () => {
    mockGetState.mockReturnValue('');

    await runPost(makeInputs(), mockGh, 'owner/repo', 'token');

    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('skips the comment when only a zero token count was measured (no cost)', async () => {
    // review.ts now guards against saving token_usage='0'; if stale state is
    // ever present, the shared renderer must still refuse to post a misleading
    // zero-token table.
    mockGetState.mockImplementation((key: string) => (key === 'token_usage' ? '0' : ''));

    await runPost(makeInputs(), mockGh, 'owner/repo', 'token');

    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('renders summary rows without the prompt/completion breakdown when not saved', async () => {
    mockGetState.mockImplementation((key: string) => {
      switch (key) {
        case 'token_usage':
          return '1234';
        case 'token_usage_duration':
          return '5000';
        case 'cost':
          return '0.0046';
        default:
          return '';
      }
    });

    await runPost(makeInputs(), mockGh, 'owner/repo', 'token');

    expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
    const [, , body] = mockPostOrUpdateComment.mock.calls[0] as [number, string, string];
    expect(body).toContain('| Total Tokens | 1,234 |');
    expect(body).toContain('| Duration | 5.0s |');
    expect(body).toContain('| Estimated Cost | $0.0046 |');
    expect(body).not.toContain('Prompt Tokens');
    expect(body).not.toContain('Completion Tokens');
  });
});
