import type {
  FixResult,
  PlatformAdapter,
  ReviewEngine,
  ReviewResult,
} from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

const {
  mockCore,
  mockExec,
  mockGetExecOutput,
  mockGetMR,
  mockGetBotReviewThreads,
  mockPostReview,
  mockGatherContext,
  mockPostOrUpdateComment,
  mockSetLabels,
  mockRemoveLabel,
  mockGetHeadCIStatus,
  mockExecWithTimeout,
  mockReviewPR,
  mockRunFix,
} = vi.hoisted(() => ({
  mockCore: {
    getInput: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockExec: vi.fn(),
  mockGetExecOutput: vi.fn(),
  mockGetMR: vi.fn(),
  mockGetBotReviewThreads: vi.fn(),
  mockPostReview: vi.fn(),
  mockGatherContext: vi.fn(),
  mockPostOrUpdateComment: vi.fn(),
  mockSetLabels: vi.fn(),
  mockRemoveLabel: vi.fn(),
  mockGetHeadCIStatus: vi.fn(),
  mockExecWithTimeout: vi.fn(),
  mockReviewPR: vi.fn(),
  mockRunFix: vi.fn(),
}));

vi.mock('@actions/core', () => mockCore);
vi.mock('@actions/exec', () => ({
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));
vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    payload: { pull_request: { number: 42 } },
    repo: { owner: 'owner', repo: 'repo' },
  },
}));
vi.mock('../src/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils.js')>();
  return { ...actual, execWithTimeout: mockExecWithTimeout };
});

import { runAutofixLoop } from '../src/fix.js';
import { createRunAbortController } from '../src/utils.js';

const reviewWithIssues: ReviewResult = {
  summary: 'Found issues',
  verdict: {
    ready: false,
    reasoning: 'Issues remain',
    autoFixable: true,
    confidence: 'medium',
  },
  strengths: [],
  issues: [
    {
      type: 'issue',
      severity: 'critical',
      file: 'src/test.ts',
      line: 1,
      message: 'Fix this',
      inline: true,
    },
  ],
  stats: { total: 1, critical: 1, important: 0, minor: 0 },
};

const fixResult: FixResult = {
  changesMade: true,
  filesChanged: ['src/test.ts'],
  summary: 'attempted fix',
};

const mockGh = {
  getMR: mockGetMR,
  getBotReviewThreads: mockGetBotReviewThreads,
  postReview: mockPostReview,
  gatherContext: mockGatherContext,
  postOrUpdateComment: mockPostOrUpdateComment,
  setLabels: mockSetLabels,
  removeLabel: mockRemoveLabel,
  getHeadCIStatus: mockGetHeadCIStatus,
  listReviewComments: vi.fn().mockResolvedValue([]),
  listBotReviews: vi.fn().mockResolvedValue([]),
} as unknown as PlatformAdapter;

const mockEngine = {
  reviewPR: mockReviewPR,
  runFix: mockRunFix,
} as unknown as ReviewEngine;

describe('Action-wide orchestration deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCore.getInput.mockImplementation((name: string) => (name === 'pr-number' ? '42' : ''));
    mockGetMR.mockResolvedValue(makePRContext());
    mockGetBotReviewThreads.mockResolvedValue([]);
    mockGatherContext.mockResolvedValue('context');
    mockPostReview.mockResolvedValue({ success: true, commentIds: [] });
    mockPostOrUpdateComment.mockResolvedValue(undefined);
    mockSetLabels.mockResolvedValue(undefined);
    mockRemoveLabel.mockResolvedValue(undefined);
    mockGetHeadCIStatus.mockResolvedValue({
      commitSha: 'abc123',
      total: 1,
      successful: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      green: true,
      checks: [],
    });
    mockExec.mockResolvedValue(0);
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not grant review, fix, and verification retries a fresh budget', async () => {
    mockReviewPR.mockImplementation(async () => {
      vi.advanceTimersByTime(20_000);
      return reviewWithIssues;
    });
    mockRunFix
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(20_000);
        return fixResult;
      })
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(10_000);
        return fixResult;
      });
    mockExecWithTimeout.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(15_000);
      return { exitCode: 1, output: 'verification failed' };
    });

    const deadline = createRunAbortController(1);
    await runAutofixLoop(
      makeInputs({
        mode: 'fix',
        runChecksAfterFix: 'pnpm test',
        checkAllowlist: ['pnpm'],
      }),
      makeConfig({ timeoutMinutes: 1, maxIterations: 3 }),
      mockEngine,
      mockGh,
      'owner/repo',
      'token',
      deadline.signal,
    );
    deadline.dispose();

    expect(mockReviewPR).toHaveBeenCalledTimes(1);
    expect(mockRunFix).toHaveBeenCalledTimes(2);
    expect(mockExecWithTimeout).toHaveBeenCalledTimes(1);
    expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });
});
