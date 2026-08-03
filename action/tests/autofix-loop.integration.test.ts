import type { FixResult, GitHubHelper, ReviewEngine, ReviewResult } from '@opencode-pr-agent/lib';
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
  mockAddLabels,
  mockEnsureLabels,
  mockCreatePR,
  mockGetDefaultBranch,
  mockGetIssue,
  mockExec,
  mockGetExecOutput,
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
  const _mockAddLabels = vi.fn();
  const _mockEnsureLabels = vi.fn();
  const _mockCreatePR = vi.fn();
  const _mockGetDefaultBranch = vi.fn();
  const _mockGetIssue = vi.fn();
  const _mockExec = vi.fn().mockResolvedValue(0);
  const _mockGetExecOutput = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args.includes('status')) {
      return { exitCode: 0, stdout: 'M src/fix.ts', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
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
    mockAddLabels: _mockAddLabels,
    mockEnsureLabels: _mockEnsureLabels,
    mockCreatePR: _mockCreatePR,
    mockGetDefaultBranch: _mockGetDefaultBranch,
    mockGetIssue: _mockGetIssue,
    mockExec: _mockExec,
    mockGetExecOutput: _mockGetExecOutput,
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
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));

import { runAutofixLoop, runFixIssue } from '../src/fix.js';

const mockGh = {
  getMR: mockGetPR,
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
  addLabels: mockAddLabels,
  ensureLabels: mockEnsureLabels,
  createPR: mockCreatePR,
  getDefaultBranch: mockGetDefaultBranch,
  getIssue: mockGetIssue,
} as unknown as GitHubHelper;

const mockEngine = {
  reviewPR: mockReviewPR,
  runFix: mockRunFix,
} as unknown as ReviewEngine;

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
      makeInputs(),
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
      makeInputs(),
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
      makeInputs(),
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

    mockReviewPR
      .mockResolvedValueOnce(reviewWithIssues)
      .mockResolvedValueOnce(reviewWithIssues)
      .mockResolvedValueOnce(reviewWithIssues);
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'full',
      reviewId: 1,
      commentIds: [],
    });
    mockRunFix
      .mockResolvedValueOnce({
        changesMade: true,
        filesChanged: ['src/bug.ts'],
      } as FixResult)
      .mockResolvedValueOnce({
        changesMade: true,
        filesChanged: ['src/bug.ts'],
      } as FixResult)
      .mockResolvedValueOnce({
        changesMade: true,
        filesChanged: ['src/bug.ts'],
      } as FixResult);

    await runAutofixLoop(
      makeInputs(),
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

describe('runFixIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockReturnValue('42');
    mockGetDefaultBranch.mockResolvedValue('main');
    mockGatherContext.mockResolvedValue('<!-- issue-analysis-plan -->\n### Implementation Plan');
    mockGetIssue.mockResolvedValue({
      number: 42,
      title: 'Fix sample bug',
      body: 'Bug description',
      labels: [],
      comments: [],
    });
    mockRunFix.mockResolvedValue({
      changesMade: true,
      summary: 'Applied fix',
      filesChanged: ['src/fix.ts'],
    });
    mockEnsureLabels.mockResolvedValue(undefined);
    mockCreatePR.mockResolvedValue({ number: 99, url: 'https://github.com/owner/repo/pull/99' });
    mockAddLabels.mockResolvedValue(undefined);
    mockGetExecOutput.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status')) {
        return { exitCode: 0, stdout: 'M src/fix.ts', stderr: '' };
      }
      if (cmd === 'git' && args.includes('log')) {
        return { exitCode: 0, stdout: 'bot@users.noreply.github.com', stderr: '' };
      }
      if (cmd === 'git' && args.includes('rev-parse')) {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  });

  it('creates PR from issue and adds autofix label to the created PR', async () => {
    await runFixIssue(
      makeInputs({ mode: 'fix' }),
      makeConfig({ timeoutMinutes: 20 }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
      'bot@users.noreply.github.com',
    );

    expect(mockCreatePR).toHaveBeenCalledWith(
      '[Autofix] Fix sample bug',
      expect.stringContaining('Fixes #42'),
      'autofix/issue-42',
      'main',
    );
    expect(mockAddLabels).toHaveBeenCalledWith(99, ['autofix']);
    expect(mockSetOutput).toHaveBeenCalledWith('pr_url', 'https://github.com/owner/repo/pull/99');
    expect(mockSetOutput).toHaveBeenCalledWith('changes_made', 'true');
  });

  it('reuses the existing autofix branch when its tip is bot-authored', async () => {
    await runFixIssue(
      makeInputs({ mode: 'fix' }),
      makeConfig({ timeoutMinutes: 20 }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
      'bot@users.noreply.github.com',
    );

    expect(mockExec).toHaveBeenCalledWith('git', [
      'checkout',
      '-B',
      'autofix/issue-42',
      'origin/autofix/issue-42',
    ]);
    expect(mockCreatePR).toHaveBeenCalled();
  });

  it('recreates the branch from the default branch when the existing tip is not bot-authored', async () => {
    mockGetExecOutput.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('log')) {
        return { exitCode: 0, stdout: 'attacker@example.com', stderr: '' };
      }
      if (cmd === 'git' && args.includes('status')) {
        return { exitCode: 0, stdout: 'M src/fix.ts', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await runFixIssue(
      makeInputs({ mode: 'fix' }),
      makeConfig({ timeoutMinutes: 20 }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
      'bot@users.noreply.github.com',
    );

    expect(mockExec).toHaveBeenCalledWith('git', [
      'checkout',
      '-b',
      'autofix/issue-42',
      'origin/main',
    ]);
    expect(mockCreatePR).toHaveBeenCalled();
  });
});
