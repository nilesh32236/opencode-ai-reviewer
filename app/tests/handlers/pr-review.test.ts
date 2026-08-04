import type { AgentConfig, ReviewResult } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetMR,
  mockGetBotReviewThreads,
  mockPostOrUpdateComment,
  mockPostReview,
  mockCreateCheckRun,
  mockReviewPR,
  mockCleanup,
} = vi.hoisted(() => {
  const _mockGetMR = vi.fn();
  const _mockGetBotReviewThreads = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  const _mockPostReview = vi.fn();
  const _mockCreateCheckRun = vi.fn();
  const _mockReviewPR = vi.fn();
  const _mockCleanup = vi.fn();
  return {
    mockGetMR: _mockGetMR,
    mockGetBotReviewThreads: _mockGetBotReviewThreads,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
    mockPostReview: _mockPostReview,
    mockCreateCheckRun: _mockCreateCheckRun,
    mockReviewPR: _mockReviewPR,
    mockCleanup: _mockCleanup,
  };
});

const mockGitHubHelperCtor = vi.fn();
const mockReviewEngineCtor = vi.fn();
const mockMergeRepoConfig = vi.fn();

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: class {
      constructor(...args: unknown[]) {
        mockGitHubHelperCtor(...args);
      }
      getMR = mockGetMR;
      getBotReviewThreads = mockGetBotReviewThreads;
      postOrUpdateComment = mockPostOrUpdateComment;
      postReview = mockPostReview;
      createCheckRun = mockCreateCheckRun;
    },
    ReviewEngine: class {
      constructor(...args: unknown[]) {
        mockReviewEngineCtor(...args);
      }
      reviewPR = mockReviewPR;
      cleanup = mockCleanup;
    },
  };
});

vi.mock('../src/utils/config.js', () => ({
  mergeRepoConfig: mockMergeRepoConfig,
}));

vi.mock('../src/handlers/autofix.js', () => ({
  handleAutofixLoop: vi.fn(),
}));

import { handlePRReview } from '../../src/handlers/pr-review.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    ...overrides,
  };
}

function makePR(): { number: number; headSha: string; labels: string[]; author: string } {
  return { number: 42, headSha: 'abc123', labels: [], author: 'test-user' };
}

function cleanReview(): ReviewResult {
  return {
    summary: 'Looks good.',
    verdict: { ready: true, reasoning: 'LGTM', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
  };
}

describe('handlePRReview check run reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMR.mockResolvedValue(makePR());
    mockGetBotReviewThreads.mockResolvedValue([]);
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockPostReview.mockResolvedValue({ success: true, method: 'full', reviewId: 1 });
    mockCreateCheckRun.mockResolvedValue({ id: 77 });
    mockReviewPR.mockResolvedValue(cleanReview());
    mockCleanup.mockResolvedValue(undefined);
  });

  it('creates a success check run when no finding reaches the threshold', async () => {
    await handlePRReview(42, 'owner/repo', 'token', makeConfig());

    expect(mockCreateCheckRun).toHaveBeenCalledWith(
      'OpenCode AI Reviewer',
      'abc123',
      'success',
      expect.objectContaining({ title: 'All clear' }),
    );
  });

  it('creates a failure check run when critical findings exist (default threshold)', async () => {
    mockReviewPR.mockResolvedValue({
      ...cleanReview(),
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

    await handlePRReview(42, 'owner/repo', 'token', makeConfig());

    expect(mockCreateCheckRun).toHaveBeenCalledWith(
      'OpenCode AI Reviewer',
      'abc123',
      'failure',
      expect.objectContaining({ title: 'Issues found' }),
    );
  });

  it('skips the check run when failOnSeverity is off', async () => {
    mockReviewPR.mockResolvedValue({
      ...cleanReview(),
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    });

    await handlePRReview(
      42,
      'owner/repo',
      'token',
      makeConfig({
        review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'off' },
      } as AgentConfig),
    );

    expect(mockCreateCheckRun).not.toHaveBeenCalled();
  });

  it('does not create check runs for non-GitHub platforms', async () => {
    await handlePRReview(
      42,
      'owner/repo',
      'token',
      makeConfig({ platform: 'gitlab' } as AgentConfig),
    );

    expect(mockCreateCheckRun).not.toHaveBeenCalled();
  });
});
