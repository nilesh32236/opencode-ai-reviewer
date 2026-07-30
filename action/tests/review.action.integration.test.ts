import type { GitHubHelper, ReviewEngine, ReviewResult } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

const {
  mockGetInput,
  mockSetOutput,
  mockSetFailed,
  mockInfo,
  mockWarning,
  mockError,
  mockDebug,
  mockGetPR,
  mockIsPR,
  mockGetBotReviewThreads,
  mockReviewPR,
  mockPostReview,
} = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockSetOutput = vi.fn();
  const _mockSetFailed = vi.fn();
  const _mockInfo = vi.fn();
  const _mockWarning = vi.fn();
  const _mockError = vi.fn();
  const _mockDebug = vi.fn();
  const _mockGetPR = vi.fn();
  const _mockIsPR = vi.fn();
  const _mockGetBotReviewThreads = vi.fn();
  const _mockReviewPR = vi.fn();
  const _mockPostReview = vi.fn();
  return {
    mockGetInput: _mockGetInput,
    mockSetOutput: _mockSetOutput,
    mockSetFailed: _mockSetFailed,
    mockInfo: _mockInfo,
    mockWarning: _mockWarning,
    mockError: _mockError,
    mockDebug: _mockDebug,
    mockGetPR: _mockGetPR,
    mockIsPR: _mockIsPR,
    mockGetBotReviewThreads: _mockGetBotReviewThreads,
    mockReviewPR: _mockReviewPR,
    mockPostReview: _mockPostReview,
  };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
  debug: mockDebug,
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: {
      pull_request: { number: 42 },
    },
    repo: { owner: 'owner', repo: 'repo' },
  },
}));

import { runReview } from '../src/review.js';

const mockGh = {
  getMR: mockGetPR,
  isMR: mockIsPR,
  getBotReviewThreads: mockGetBotReviewThreads,
  postReview: mockPostReview,
} as unknown as GitHubHelper;

const mockEngine = {
  reviewPR: mockReviewPR,
} as unknown as ReviewEngine;

describe('runReview (action wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'pr-number': '',
      };
      return inputs[name] || '';
    });

    mockGetBotReviewThreads.mockResolvedValue([]);
  });

  it('calls engine.reviewPR and gh.postReview on success', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);

    const reviewResult: ReviewResult = {
      summary: '## Review\nGood PR.',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    };
    mockReviewPR.mockResolvedValue(reviewResult);
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    const config = makeConfig({ enableMCP: false, mcpServers: [] });

    await runReview(
      makeInputs({ reviewModel: config.reviewModel, fixModel: config.fixModel }),
      config,
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockGetPR).toHaveBeenCalledWith(42);
    expect(mockReviewPR).toHaveBeenCalledWith(
      pr,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(mockPostReview).toHaveBeenCalledWith(42, 'abc123', reviewResult, config.review.inline);
    expect(mockSetOutput).toHaveBeenCalledWith('review_summary', reviewResult.summary);
    expect(mockSetOutput).toHaveBeenCalledWith('verdict', 'true');
    expect(mockSetOutput).toHaveBeenCalledWith('critical_count', '0');
  });

  it('handles PR fetch failure gracefully', async () => {
    mockGetPR.mockRejectedValue(new Error('Not found'));

    await runReview(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to get PR #42'));
    expect(mockReviewPR).not.toHaveBeenCalled();
  });

  it('skips review when PR has skip label', async () => {
    const pr = makePRContext({ labels: ['autofix'] });
    mockGetPR.mockResolvedValue(pr);

    await runReview(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockReviewPR).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('skip label'));
  });

  it('handles review returning no content', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: '',
      verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    } as ReviewResult);

    await runReview(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetFailed).toHaveBeenCalledWith(
      'Review returned no meaningful content - AI model may have failed silently',
    );
  });

  it('attaches comment IDs to issues', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);

    const reviewResult: ReviewResult = {
      summary: 'Found issues.',
      verdict: { ready: false, reasoning: 'Issues', autoFixable: false, confidence: 'medium' },
      strengths: [],
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/bug.ts',
          line: 10,
          message: 'Bug',
          inline: true,
        },
      ],
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    };
    mockReviewPR.mockResolvedValue(reviewResult);
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [{ file: 'src/bug.ts', line: 10, commentId: 555 }],
    });

    await runReview(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(reviewResult.issues[0].commentId).toBe(555);
    expect(mockSetOutput).toHaveBeenCalledWith('verdict', 'false');
  });
});
