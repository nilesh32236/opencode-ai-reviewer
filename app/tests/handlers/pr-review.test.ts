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
  mockMergeRepoConfig,
} = vi.hoisted(() => {
  const _mockGetMR = vi.fn();
  const _mockGetBotReviewThreads = vi.fn();
  const _mockPostOrUpdateComment = vi.fn();
  const _mockPostReview = vi.fn();
  const _mockCreateCheckRun = vi.fn();
  const _mockReviewPR = vi.fn();
  const _mockCleanup = vi.fn();
  const _mockMergeRepoConfig = vi.fn();
  return {
    mockGetMR: _mockGetMR,
    mockGetBotReviewThreads: _mockGetBotReviewThreads,
    mockPostOrUpdateComment: _mockPostOrUpdateComment,
    mockPostReview: _mockPostReview,
    mockCreateCheckRun: _mockCreateCheckRun,
    mockReviewPR: _mockReviewPR,
    mockCleanup: _mockCleanup,
    mockMergeRepoConfig: _mockMergeRepoConfig,
  };
});

const mockGitHubHelperCtor = vi.fn();
const mockGitLabAdapterCtor = vi.fn();
const mockReviewEngineCtor = vi.fn();

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
    GitLabAdapter: class {
      constructor(...args: unknown[]) {
        mockGitLabAdapterCtor(...args);
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

vi.mock('../../src/utils/config.js', () => ({
  mergeRepoConfig: mockMergeRepoConfig,
}));

vi.mock('../../src/handlers/autofix.js', () => ({
  handleAutofixLoop: vi.fn(),
}));

import { handlePRReview } from '../../src/handlers/pr-review.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'critical' },
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
    mockMergeRepoConfig.mockImplementation((c: AgentConfig) => c);
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

  it('creates a failure check run when critical findings exist (critical threshold)', async () => {
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

  it('uses the merged repository failOnSeverity for the check-run gate', async () => {
    // The base config disables the gate; the repo's merged config enables it.
    mockMergeRepoConfig.mockImplementation((c: AgentConfig) => ({
      ...c,
      review: { ...c.review, failOnSeverity: 'critical' },
    }));
    mockReviewPR.mockResolvedValue({
      ...cleanReview(),
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    });

    await handlePRReview(
      42,
      'owner/repo',
      'token',
      makeConfig({ review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'off' } }),
    );

    expect(mockCreateCheckRun).toHaveBeenCalledWith(
      'OpenCode AI Reviewer',
      'abc123',
      'failure',
      expect.objectContaining({ title: 'Issues found' }),
    );
  });

  it('truncates an oversized summary passed as check run text', async () => {
    const longSummary = 'x'.repeat(100_000);
    mockReviewPR.mockResolvedValue({ ...cleanReview(), summary: longSummary });

    await handlePRReview(42, 'owner/repo', 'token', makeConfig());

    const call = mockCreateCheckRun.mock.calls[0] as unknown[];
    const output = call[3] as { text?: string };
    expect(output.text?.length).toBe(60_000);
  });

  it('truncates multi-byte check run text by UTF-8 bytes, not code units', async () => {
    // 30001 two-byte characters = 60002 bytes but only 30001 code units, which
    // would slip past a code-unit cap while still exceeding the byte limit.
    const longSummary = 'é'.repeat(30_001);
    mockReviewPR.mockResolvedValue({ ...cleanReview(), summary: longSummary });

    await handlePRReview(42, 'owner/repo', 'token', makeConfig());

    const call = mockCreateCheckRun.mock.calls[0] as unknown[];
    const output = call[3] as { text?: string };
    expect(Buffer.byteLength(output.text ?? '', 'utf8')).toBeLessThanOrEqual(60_000);
    expect(Buffer.from(output.text ?? '', 'utf8').toString('utf8')).toBe(output.text);
  });

  it('reports a neutral check run when the PR carries a skip label', async () => {
    mockGetMR.mockResolvedValue({ ...makePR(), labels: ['skip-review'] });

    await handlePRReview(
      42,
      'owner/repo',
      'token',
      makeConfig({
        review: {
          ...DEFAULT_CONFIG.review,
          failOnSeverity: 'critical',
          skipLabels: ['skip-review'],
        },
      }),
    );

    expect(mockCreateCheckRun).toHaveBeenCalledWith(
      'OpenCode AI Reviewer',
      'abc123',
      'neutral',
      expect.objectContaining({ title: 'Review skipped' }),
    );
  });

  it('does not post a duplicate review or check run when the review was deduplicated', async () => {
    mockReviewPR.mockResolvedValue({
      ...cleanReview(),
      summary: '',
      skipped: true,
    });

    const result = await handlePRReview(42, 'owner/repo', 'token', makeConfig());

    expect(result).toBeNull();
    expect(mockPostReview).not.toHaveBeenCalled();
    expect(mockCreateCheckRun).not.toHaveBeenCalled();
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining('review-in-progress'),
      expect.stringContaining('already completed'),
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

    expect(mockGitLabAdapterCtor).toHaveBeenCalled();
    expect(mockCreateCheckRun).not.toHaveBeenCalled();
  });

  it('posts the title/label suggestion when a repo-level override enables it', async () => {
    mockMergeRepoConfig.mockImplementation((c: AgentConfig) => ({
      ...c,
      review: { ...c.review, suggestTitleAndLabels: true },
    }));
    mockGetMR.mockResolvedValue({
      ...makePR(),
      title: 'Add caching',
      body: '',
      headRef: 'feature/cache',
      baseRef: 'main',
      changedFiles: [{ path: 'api/cache.ts', status: 'added', additions: 100, deletions: 5 }],
    });

    await handlePRReview(
      42,
      'owner/repo',
      'token',
      makeConfig({ review: { ...DEFAULT_CONFIG.review, suggestTitleAndLabels: false } }),
    );

    const suggestionCall = mockPostOrUpdateComment.mock.calls.find(
      (call) => call[1] === '<!-- title-suggestion -->',
    );
    expect(suggestionCall).toBeDefined();
    expect(suggestionCall?.[0]).toBe(42);
  });

  it('does not post the title/label suggestion when a repo-level override disables it', async () => {
    mockMergeRepoConfig.mockImplementation((c: AgentConfig) => ({
      ...c,
      review: { ...c.review, suggestTitleAndLabels: false },
    }));

    await handlePRReview(
      42,
      'owner/repo',
      'token',
      makeConfig({ review: { ...DEFAULT_CONFIG.review, suggestTitleAndLabels: true } }),
    );

    const suggestionCall = mockPostOrUpdateComment.mock.calls.find(
      (call) => call[1] === '<!-- title-suggestion -->',
    );
    expect(suggestionCall).toBeUndefined();
  });
});
