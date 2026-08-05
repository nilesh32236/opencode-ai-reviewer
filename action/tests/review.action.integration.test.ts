import {
  DEFAULT_CONFIG,
  type GitHubHelper,
  type ReviewEngine,
  type ReviewResult,
} from '@opencode-pr-agent/lib';
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
  mockSaveState,
  mockGetLastTelemetry,
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
  const _mockSaveState = vi.fn();
  const _mockGetLastTelemetry = vi.fn().mockReturnValue(null);
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
    mockSaveState: _mockSaveState,
    mockGetLastTelemetry: _mockGetLastTelemetry,
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
  saveState: mockSaveState,
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
  getLastTelemetry: mockGetLastTelemetry,
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

  it('exposes token usage and normalized cost when cost tracking is enabled', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: '## Review\nGood PR.',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });
    mockGetLastTelemetry.mockReturnValue({
      totalTokens: 1234,
      promptTokens: 1000,
      completionTokens: 234,
      durationMs: 5000,
      estimatedCost: 0.0046005,
    });

    const config = makeConfig({
      enableMCP: false,
      mcpServers: [],
      review: {
        ...DEFAULT_CONFIG.review,
        costTracking: { enabled: true, verbosity: 'summary' },
      },
    });

    await runReview(
      makeInputs({ reviewModel: config.reviewModel, fixModel: config.fixModel }),
      config,
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetOutput).toHaveBeenCalledWith('token_usage', '1234');
    expect(mockSaveState).toHaveBeenCalledWith('token_usage', '1234');
    expect(mockSaveState).toHaveBeenCalledWith('token_usage_duration', '5000');
    // Cost is normalized to the fixed-decimal format used by the post comment.
    expect(mockSetOutput).toHaveBeenCalledWith('cost', '0.0046');
    expect(mockSaveState).toHaveBeenCalledWith('cost', '0.0046');
    // Summary verbosity must not persist the prompt/completion breakdown.
    expect(mockSaveState).not.toHaveBeenCalledWith('token_usage_prompt', '1000');
  });

  it('saves the prompt/completion breakdown to state for detailed verbosity', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: '## Review\nGood PR.',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });
    mockGetLastTelemetry.mockReturnValue({
      totalTokens: 1234,
      promptTokens: 1000,
      completionTokens: 234,
      durationMs: 5000,
      estimatedCost: 0.0046,
    });

    const config = makeConfig({
      enableMCP: false,
      mcpServers: [],
      review: {
        ...DEFAULT_CONFIG.review,
        costTracking: { enabled: true, verbosity: 'detailed' },
      },
    });

    await runReview(
      makeInputs({ reviewModel: config.reviewModel, fixModel: config.fixModel }),
      config,
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSaveState).toHaveBeenCalledWith('token_usage_prompt', '1000');
    expect(mockSaveState).toHaveBeenCalledWith('token_usage_completion', '234');
  });

  it('does not save token usage/cost state when nothing meaningful was measured', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: '## Review\nGood PR.',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });
    // The default free model often emits no parseable usage: totalTokens is 0
    // and no rate applies, so estimatedCost is undefined. The wrapper must not
    // surface a misleading 'Total Tokens | 0 |' state/output/comment.
    mockGetLastTelemetry.mockReturnValue({
      totalTokens: 0,
      durationMs: 1000,
      estimatedCost: undefined,
    });

    const config = makeConfig({
      enableMCP: false,
      mcpServers: [],
      review: {
        ...DEFAULT_CONFIG.review,
        costTracking: { enabled: true, verbosity: 'summary' },
      },
    });

    await runReview(
      makeInputs({ reviewModel: config.reviewModel, fixModel: config.fixModel }),
      config,
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetOutput).not.toHaveBeenCalledWith('token_usage', expect.anything());
    expect(mockSetOutput).not.toHaveBeenCalledWith('cost', expect.anything());
    expect(mockSaveState).not.toHaveBeenCalledWith('token_usage', expect.anything());
    expect(mockSaveState).not.toHaveBeenCalledWith('cost', expect.anything());
  });

  it('sanitizes the warning when fetching previous review threads fails', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    const secret = 'sk-ant-api03secretkeyvalue1234567890abcdefghijkl';
    mockGetBotReviewThreads.mockRejectedValue(new Error(`GraphQL error: ${secret}`));
    mockReviewPR.mockResolvedValue({
      summary: '## Review\nGood PR.',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    await runReview(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch previous review comments'),
    );
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('[REDACTED_ANTHROPIC_KEY]'));
    expect(mockWarning).toHaveBeenCalledWith(expect.not.stringContaining(secret));
  });

  it('fails the action when critical issues are found at the critical threshold', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: 'Found issues.',
      verdict: { ready: false, reasoning: 'Issues', autoFixable: false, confidence: 'medium' },
      strengths: [],
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/bug.ts',
          line: 10,
          message: 'Critical bug',
          inline: true,
        },
      ],
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    await runReview(
      makeInputs(),
      makeConfig({
        enableMCP: false,
        mcpServers: [],
        review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'critical' },
      }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('at or above severity "critical" threshold'),
    );
  });

  it('does not fail the action when no finding reaches the configured threshold', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: 'Minor nit only.',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 1, critical: 0, important: 0, minor: 1 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    await runReview(
      makeInputs(),
      makeConfig({ enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('fails the action on important+critical findings when threshold is important', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: 'Important issue.',
      verdict: { ready: false, reasoning: 'Issues', autoFixable: false, confidence: 'medium' },
      strengths: [],
      issues: [],
      stats: { total: 1, critical: 0, important: 1, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    const config = makeConfig({
      enableMCP: false,
      mcpServers: [],
      review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'important' },
    });

    await runReview(
      makeInputs({ reviewModel: config.reviewModel, fixModel: config.fixModel }),
      config,
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('at or above severity "important" threshold'),
    );
  });

  it('preserves existing behavior when failOnSeverity is off', async () => {
    const pr = makePRContext();
    mockGetPR.mockResolvedValue(pr);
    mockReviewPR.mockResolvedValue({
      summary: 'Critical issue.',
      verdict: { ready: false, reasoning: 'Issues', autoFixable: false, confidence: 'medium' },
      strengths: [],
      issues: [],
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    });
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    const config = makeConfig({
      enableMCP: false,
      mcpServers: [],
      review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'off' },
    });

    await runReview(
      makeInputs({ reviewModel: config.reviewModel, fixModel: config.fixModel }),
      config,
      mockEngine,
      mockGh,
      'owner/repo',
    );

    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
