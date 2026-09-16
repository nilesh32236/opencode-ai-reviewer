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
  mockGetHeadCIStatus,
  mockReviewPR,
  mockRunFix,
  mockMergeRepoConfig,
  mockExecFileSync,
  mockExecFile,
} = vi.hoisted(() => {
  const _mockGetMR = vi.fn();
  const _mockGetBotReviewThreads = vi.fn();
  const _mockPostReview = vi.fn();
  const _mockSetLabels = vi.fn();
  const _mockCreateComment = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  const _mockUpdateMR = vi.fn();
  const _mockGetHeadCIStatus = vi.fn();
  const _mockReviewPR = vi.fn();
  const _mockRunFix = vi.fn();
  const _mockMergeRepoConfig = vi.fn();
  const _mockExecFileSync = vi.fn();
  const _mockExecFile = vi.fn(
    (
      file: string,
      args: string[],
      opts: unknown,
      cb?: (err: unknown, stdout?: unknown, stderr?: unknown) => void,
    ) => {
      const callback = typeof opts === 'function' ? (opts as typeof cb) : cb;
      try {
        const out = _mockExecFileSync(file, args, opts);
        callback?.(null, out, '');
      } catch (err) {
        const e = err as Error & { stdout?: unknown; stderr?: unknown };
        callback?.(e);
      }
      return undefined;
    },
  );
  return {
    mockGetMR: _mockGetMR,
    mockGetBotReviewThreads: _mockGetBotReviewThreads,
    mockPostReview: _mockPostReview,
    mockSetLabels: _mockSetLabels,
    mockCreateComment: _mockCreateComment,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
    mockUpdateMR: _mockUpdateMR,
    mockGetHeadCIStatus: _mockGetHeadCIStatus,
    mockReviewPR: _mockReviewPR,
    mockRunFix: _mockRunFix,
    mockMergeRepoConfig: _mockMergeRepoConfig,
    mockExecFileSync: _mockExecFileSync,
    mockExecFile: _mockExecFile,
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
      getHeadCIStatus = mockGetHeadCIStatus;
    },
    GitLabAdapter: class {
      getMR = mockGetMR;
      getBotReviewThreads = mockGetBotReviewThreads;
      postReview = mockPostReview;
      setLabels = mockSetLabels;
      createComment = mockCreateComment;
      postOrUpdateComment = mockPostOrUpdateComment;
      updateMR = mockUpdateMR;
      getHeadCIStatus = mockGetHeadCIStatus;
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
  execFile: mockExecFile,
}));

vi.mock('../../src/utils/git.js', () => ({
  execGit: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    maxIterations: 1,
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

function cleanReview(): ReviewResult {
  return {
    summary: 'All good',
    verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
  };
}

describe('autofix head-CI gate (Probot loop)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-autofix-ci-gate-'));
    vi.clearAllMocks();
    mockGetMR.mockResolvedValue(makePR());
    mockGetBotReviewThreads.mockResolvedValue([]);
    mockPostReview.mockResolvedValue({ success: true, method: 'full', commentIds: [] });
    mockSetLabels.mockResolvedValue(undefined);
    mockCreateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockUpdateMR.mockResolvedValue({ success: true });
    mockMergeRepoConfig.mockImplementation((c: AgentConfig) => c);
    mockExecFileSync.mockReturnValue(Buffer.alloc(0));
    mockReviewPR.mockResolvedValue(cleanReview());
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function dirtyReview(): ReviewResult {
    return {
      summary: 'Needs fixes',
      verdict: { ready: false, reasoning: 'Issues found', autoFixable: true, confidence: 'high' },
      strengths: [],
      issues: [
        {
          file: 'src/a.ts',
          line: 1,
          severity: 'important',
          message: 'Fix this',
          confidence: 'high',
        },
      ],
      stats: { total: 1, critical: 0, important: 1, minor: 0 },
    } as unknown as ReviewResult;
  }

  async function runLoop(configOverrides: Partial<AgentConfig> = {}): Promise<void> {
    await handleAutofixLoop({
      prNumber: 42,
      repo: 'owner/repo',
      token: 'token',
      config: makeConfig(configOverrides),
      tempDir,
      initialGitEnv: {},
    });
  }

  it('refuses autofix:ready when the head SHA has an empty CI rollup', async () => {
    mockGetHeadCIStatus.mockResolvedValue({
      commitSha: 'abc123',
      total: 0,
      successful: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      green: false,
      checks: [],
    });

    await runLoop();

    expect(mockGetHeadCIStatus).toHaveBeenCalledWith('abc123', undefined);
    // Never promotes to ready...
    expect(mockSetLabels).not.toHaveBeenCalledWith(42, ['autofix:ready'], expect.anything());
    expect(mockCreateComment).not.toHaveBeenCalledWith(42, expect.stringContaining('Ready'));
    // ...stays in `autofix`, posts the Waiting-on-CI status comment...
    expect(mockSetLabels).toHaveBeenCalledWith(42, ['autofix'], ['autofix:ready']);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      expect.anything(),
      expect.stringContaining('Waiting on CI'),
    );
    // ...and skips the needs-manual-review terminal.
    expect(mockSetLabels).not.toHaveBeenCalledWith(
      42,
      ['autofix:needs-manual-review'],
      expect.anything(),
    );
  });

  it('refuses autofix:ready when CI is skipped on the head SHA', async () => {
    mockGetHeadCIStatus.mockResolvedValue({
      commitSha: 'abc123',
      total: 2,
      successful: 1,
      failed: 0,
      pending: 0,
      skipped: 1,
      green: false,
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'skipped' },
      ],
    });

    await runLoop();

    expect(mockSetLabels).not.toHaveBeenCalledWith(42, ['autofix:ready'], expect.anything());
    expect(mockSetLabels).toHaveBeenCalledWith(42, ['autofix'], ['autofix:ready']);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      expect.anything(),
      expect.stringContaining('Waiting on CI'),
    );
    expect(mockSetLabels).not.toHaveBeenCalledWith(
      42,
      ['autofix:needs-manual-review'],
      expect.anything(),
    );
  });

  it('promotes to autofix:ready when the review is clean and CI is green', async () => {
    mockGetHeadCIStatus.mockResolvedValue({
      commitSha: 'abc123',
      total: 2,
      successful: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
      green: true,
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'success' },
      ],
    });

    await runLoop();

    expect(mockGetHeadCIStatus).toHaveBeenCalledWith('abc123', undefined);
    expect(mockSetLabels).toHaveBeenCalledWith(
      42,
      ['autofix:ready'],
      expect.arrayContaining(['autofix']),
    );
    expect(mockCreateComment).toHaveBeenCalledWith(42, expect.stringContaining('Ready'));
    expect(mockSetLabels).not.toHaveBeenCalledWith(
      42,
      ['autofix:needs-manual-review'],
      expect.anything(),
    );
  });

  it('resets ciWaiting so a CI-block followed by exhausted work reaches needs-manual-review', async () => {
    mockGetHeadCIStatus.mockResolvedValue({
      commitSha: 'abc123',
      total: 0,
      successful: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      green: false,
      checks: [],
    });
    // First iteration: clean review (CI-blocked). Second iteration: dirty
    // review that makes no fix progress, so the loop exhausts via no-changes
    // and must reach the needs-manual-review terminal.
    mockReviewPR.mockResolvedValueOnce(cleanReview()).mockResolvedValueOnce(dirtyReview());
    mockRunFix.mockResolvedValue({ changesMade: false });

    await runLoop({ maxIterations: 2 });

    // First iteration stayed in waiting state...
    expect(mockSetLabels).toHaveBeenCalledWith(42, ['autofix'], ['autofix:ready']);
    // ...but the terminal CI-block must not latch: exhausted work relabels.
    expect(mockSetLabels).toHaveBeenCalledWith(
      42,
      ['autofix:needs-manual-review'],
      expect.anything(),
    );
  });
});
