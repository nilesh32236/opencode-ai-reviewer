import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig, PRContext, ReviewResult } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAutofixLoop } from '../../src/handlers/autofix.js';

const {
  mockGetMR,
  mockGetBotReviewThreads,
  mockPostReview,
  mockSetLabels,
  mockCreateComment,
  mockPostOrUpdateComment,
  mockUpdateMR,
  mockReviewPR,
  mockRunFix,
  mockMergeRepoConfig,
  mockExecFileSync,
} = vi.hoisted(() => {
  const _mockGetMR = vi.fn();
  const _mockGetBotReviewThreads = vi.fn();
  const _mockPostReview = vi.fn();
  const _mockSetLabels = vi.fn();
  const _mockCreateComment = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  const _mockUpdateMR = vi.fn();
  const _mockReviewPR = vi.fn();
  const _mockRunFix = vi.fn();
  const _mockMergeRepoConfig = vi.fn();
  const _mockExecFileSync = vi.fn();
  return {
    mockGetMR: _mockGetMR,
    mockGetBotReviewThreads: _mockGetBotReviewThreads,
    mockPostReview: _mockPostReview,
    mockSetLabels: _mockSetLabels,
    mockCreateComment: _mockCreateComment,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
    mockUpdateMR: _mockUpdateMR,
    mockReviewPR: _mockReviewPR,
    mockRunFix: _mockRunFix,
    mockMergeRepoConfig: _mockMergeRepoConfig,
    mockExecFileSync: _mockExecFileSync,
  };
});

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: class {
      getMR = mockGetMR;
      getBotReviewThreads = mockGetBotReviewThreads;
      postReview = mockPostReview;
      setLabels = mockSetLabels;
      createComment = mockCreateComment;
      postOrUpdateComment = mockPostOrUpdateComment;
      updateMR = mockUpdateMR;
    },
    GitLabAdapter: class {
      getMR = mockGetMR;
      getBotReviewThreads = mockGetBotReviewThreads;
      postReview = mockPostReview;
      setLabels = mockSetLabels;
      createComment = mockCreateComment;
      postOrUpdateComment = mockPostOrUpdateComment;
      updateMR = mockUpdateMR;
    },
    ReviewEngine: class {
      reviewPR = mockReviewPR;
      runFix = mockRunFix;
      cleanup = vi.fn();
    },
  };
});

vi.mock('../../src/utils/config.js', () => ({
  mergeRepoConfig: mockMergeRepoConfig,
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    maxIterations: 2,
    review: { ...DEFAULT_CONFIG.review, inline: false },
    ...overrides,
  } as AgentConfig;
}

function makePR(): PRContext {
  return {
    number: 42,
    title: 'Fix the bug',
    body: 'Issue body',
    headRef: 'fix-branch',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'test-user',
    labels: [],
    changedFiles: [],
  };
}

function needsFixReview(): ReviewResult {
  return {
    summary: 'There are issues to fix.',
    verdict: { ready: false, reasoning: 'Needs fixes', autoFixable: true, confidence: 'medium' },
    strengths: [],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/bug.ts',
        line: 1,
        message: 'Bug',
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

describe('autofix verification flag reset per iteration (issue #186 regression)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-autofix-test-'));
    vi.clearAllMocks();
    mockGetMR.mockResolvedValue(makePR());
    mockGetBotReviewThreads.mockResolvedValue([]);
    mockPostReview.mockResolvedValue({ success: true, method: 'full', commentIds: [] });
    mockSetLabels.mockResolvedValue(undefined);
    mockCreateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockUpdateMR.mockResolvedValue({ success: true });
    mockMergeRepoConfig.mockImplementation((c: AgentConfig) => c);
    // git add/commit/push succeed
    mockExecFileSync.mockImplementation((program: string) => {
      if (program === 'npm') {
        return Buffer.from('tests passed');
      }
      return Buffer.alloc(0);
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports hasTests=false in the PR body when verification fails in a later iteration', async () => {
    // Iteration 1 passes verification; iteration 2's verification command fails
    // on every attempt. The pre-fix code declared `verificationPassed` outside
    // the loop, so the stale `true` leaked into iteration 2's PR body.
    mockReviewPR.mockResolvedValue(needsFixReview());
    mockRunFix.mockResolvedValue({
      changesMade: true,
      summary: 'Fixed the bug',
      filesChanged: ['src/bug.ts'],
    });
    let npmRuns = 0;
    mockExecFileSync.mockImplementation((program: string) => {
      if (program === 'npm') {
        npmRuns++;
        if (npmRuns >= 2) throw new Error('npm test failed');
        return Buffer.from('tests passed');
      }
      return Buffer.alloc(0);
    });

    await handleAutofixLoop({
      prNumber: 42,
      repo: 'owner/repo',
      token: 'token',
      config: makeConfig(),
      runChecksAfterFix: 'npm test',
      checkAllowlist: ['npm'],
      tempDir,
      initialGitEnv: {},
    });

    expect(mockUpdateMR).toHaveBeenCalledTimes(2);
    const firstBody = mockUpdateMR.mock.calls[0][1] as { body: string };
    const secondBody = mockUpdateMR.mock.calls[1][1] as { body: string };

    expect(firstBody.body).toContain('Automated tests were run and passed');
    expect(firstBody.body).not.toContain('Please verify the fix manually before merging');

    expect(secondBody.body).not.toContain('Automated tests were run and passed');
    expect(secondBody.body).toContain('Please verify the fix manually before merging');
  });
});
