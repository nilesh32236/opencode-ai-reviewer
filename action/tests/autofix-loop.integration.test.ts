import type {
  AgentConfig,
  FixResult,
  GitHubHelper,
  PRContext,
  ReviewEngine,
  ReviewResult,
} from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetInput,
  mockSetOutput,
  mockSetFailed,
  mockInfo,
  mockWarning,
  mockError,
  mockDebug,
  mockGetPR,
  mockGetIssueComments,
  mockGetBotReviewThreads,
  mockPostReview,
  mockSetLabels,
  mockRemoveLabel,
  mockCreateComment,
  mockPostOrUpdateComment,
  mockGatherContext,
  mockReviewPR,
  mockRunFix,
  mockGetReviewThreads,
  mockResolveReviewThread,
  mockMinimizeReviewComment,
} = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockSetOutput = vi.fn();
  const _mockSetFailed = vi.fn();
  const _mockInfo = vi.fn();
  const _mockWarning = vi.fn();
  const _mockError = vi.fn();
  const _mockDebug = vi.fn();
  const _mockGetPR = vi.fn();
  const _mockGetIssueComments = vi.fn();
  const _mockGetBotReviewThreads = vi.fn();
  const _mockPostReview = vi.fn();
  const _mockSetLabels = vi.fn();
  const _mockRemoveLabel = vi.fn();
  const _mockCreateComment = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  const _mockGatherContext = vi.fn();
  const _mockReviewPR = vi.fn();
  const _mockRunFix = vi.fn();
  const _mockGetReviewThreads = vi.fn();
  const _mockResolveReviewThread = vi.fn();
  const _mockMinimizeReviewComment = vi.fn();
  return {
    mockGetInput: _mockGetInput,
    mockSetOutput: _mockSetOutput,
    mockSetFailed: _mockSetFailed,
    mockInfo: _mockInfo,
    mockWarning: _mockWarning,
    mockError: _mockError,
    mockDebug: _mockDebug,
    mockGetPR: _mockGetPR,
    mockGetIssueComments: _mockGetIssueComments,
    mockGetBotReviewThreads: _mockGetBotReviewThreads,
    mockPostReview: _mockPostReview,
    mockSetLabels: _mockSetLabels,
    mockRemoveLabel: _mockRemoveLabel,
    mockCreateComment: _mockCreateComment,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
    mockGatherContext: _mockGatherContext,
    mockReviewPR: _mockReviewPR,
    mockRunFix: _mockRunFix,
    mockGetReviewThreads: _mockGetReviewThreads,
    mockResolveReviewThread: _mockResolveReviewThread,
    mockMinimizeReviewComment: _mockMinimizeReviewComment,
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
      issue: { number: 42, pull_request: {} },
    },
    repo: { owner: 'owner', repo: 'repo' },
  },
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn().mockResolvedValue(0),
  getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

import { runAutofixLoop } from '../src/fix.js';

const mockGh = {
  getPR: mockGetPR,
  getIssueComments: mockGetIssueComments,
  getBotReviewThreads: mockGetBotReviewThreads,
  postReview: mockPostReview,
  setLabels: mockSetLabels,
  removeLabel: mockRemoveLabel,
  createComment: mockCreateComment,
  postOrUpdateComment: mockPostOrUpdateComment,
  gatherContext: mockGatherContext,
  getReviewThreads: mockGetReviewThreads,
  resolveReviewThread: mockResolveReviewThread,
  minimizeReviewComment: mockMinimizeReviewComment,
} as unknown as GitHubHelper;

const mockEngine = {
  reviewPR: mockReviewPR,
  runFix: mockRunFix,
} as unknown as ReviewEngine;

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'test-user',
    labels: [],
    changedFiles: [
      {
        path: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 2,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    ...overrides,
  };
}

describe('runAutofixLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'pr-number': '',
      };
      return inputs[name] || '';
    });

    mockGetBotReviewThreads.mockResolvedValue([]);
    mockGetIssueComments.mockResolvedValue([]);
    mockGetPR.mockResolvedValue(makePRContext());
    mockGatherContext.mockResolvedValue('## PR Context\nSome context');
    mockGetReviewThreads.mockResolvedValue([]);
  });

  it('approves on first iteration when all issues resolved', async () => {
    mockReviewPR.mockResolvedValue({
      summary: 'All good',
      verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    } as ReviewResult);

    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });

    await runAutofixLoop(
      {} as never,
      makeConfig({ maxIterations: 3, enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    expect(mockReviewPR).toHaveBeenCalledTimes(1);
    expect(mockSetLabels).toHaveBeenCalledWith(
      42,
      ['autofix:ready'],
      ['autofix', 'autofix:needs-fix'],
    );
    expect(mockCreateComment).toHaveBeenCalledWith(42, expect.stringContaining('Ready'));
    expect(mockSetOutput).toHaveBeenCalledWith('approved', 'true');
  });

  it('runs fix iteration when issues are found', async () => {
    const reviewWithIssues: ReviewResult = {
      summary: 'Found issues',
      verdict: {
        ready: false,
        reasoning: 'Issues remain',
        autoFixable: false,
        confidence: 'medium',
      },
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

    const reviewApproved: ReviewResult = {
      summary: 'All fixed',
      verdict: { ready: true, reasoning: 'Fixed', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
    };

    mockReviewPR.mockResolvedValueOnce(reviewWithIssues).mockResolvedValueOnce(reviewApproved);

    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [{ file: 'src/bug.ts', line: 10, commentId: 555 }],
    });

    mockRunFix.mockResolvedValue({
      changesMade: true,
      filesChanged: ['src/bug.ts'],
    } as FixResult);

    await runAutofixLoop(
      {} as never,
      makeConfig({ maxIterations: 3, enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    expect(mockReviewPR).toHaveBeenCalledTimes(2);
    expect(mockRunFix).toHaveBeenCalledTimes(1);
    expect(mockSetLabels).toHaveBeenCalledWith(
      42,
      ['autofix:ready'],
      ['autofix', 'autofix:needs-fix'],
    );
    expect(mockSetOutput).toHaveBeenCalledWith('approved', 'true');
  });

  it('stops when fix agent makes no changes', async () => {
    const reviewWithIssues: ReviewResult = {
      summary: 'Found issues',
      verdict: {
        ready: false,
        reasoning: 'Issues remain',
        autoFixable: false,
        confidence: 'medium',
      },
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

    mockReviewPR.mockResolvedValueOnce(reviewWithIssues);
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });
    mockRunFix.mockResolvedValue({
      changesMade: false,
      filesChanged: [],
    } as FixResult);

    await runAutofixLoop(
      {} as never,
      makeConfig({ maxIterations: 3, enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    expect(mockReviewPR).toHaveBeenCalledTimes(1);
    expect(mockRunFix).toHaveBeenCalledTimes(1);
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('Fix agent could not resolve'),
    );
  });

  it('exhausts max iterations when never approved and fix always makes changes', async () => {
    const reviewWithIssues: ReviewResult = {
      summary: 'Still issues',
      verdict: { ready: false, reasoning: 'Not ready', autoFixable: false, confidence: 'low' },
      strengths: [],
      issues: [
        {
          type: 'issue',
          severity: 'important',
          file: 'src/bug.ts',
          line: 10,
          message: 'Bug',
          inline: true,
        },
      ],
      stats: { total: 1, critical: 0, important: 1, minor: 0 },
    };

    mockReviewPR.mockResolvedValue(reviewWithIssues);
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });
    mockRunFix.mockResolvedValue({
      changesMade: true,
      filesChanged: ['src/bug.ts'],
    } as FixResult);

    await runAutofixLoop(
      {} as never,
      makeConfig({ maxIterations: 3, enableMCP: false, mcpServers: [] }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
    );

    expect(mockReviewPR).toHaveBeenCalledTimes(3);
    expect(mockRunFix).toHaveBeenCalledTimes(3);
    expect(mockSetOutput).toHaveBeenCalledWith('approved', 'false');
    expect(mockSetLabels).toHaveBeenCalledWith(
      42,
      ['autofix:needs-manual-review'],
      ['autofix', 'autofix:needs-fix'],
    );
  });
});
