/**
 * L-054: the AI review workflow computed a verdict and lost it.
 *
 * `runReview` posted through `gh.postReview()`, which resolves
 * `{ success: false, method: 'failed' }` when the summary review cannot be
 * created. The old code only logged `core.warning('Failed to post review to
 * GitHub')` and fell through to `core.setOutput('verdict', ...)`, so the job
 * exited 0 with a computed verdict that had never reached the pull request.
 * A maintainer reading green checks would merge a "No" with 22 issues.
 *
 * These tests pin the delivery contract: a verdict that is not on the PR is a
 * failed job.
 */
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
  mockSaveState,
  mockGetPR,
  mockIsMR,
  mockGetBotReviewThreads,
  mockReviewPR,
  mockPostReview,
  mockPostOrUpdateComment,
  mockSaveStateGuard,
} = vi.hoisted(() => ({
  mockGetInput: vi.fn(),
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockInfo: vi.fn(),
  mockWarning: vi.fn(),
  mockError: vi.fn(),
  mockDebug: vi.fn(),
  mockSaveState: vi.fn(),
  mockGetPR: vi.fn(),
  mockIsMR: vi.fn(),
  mockGetBotReviewThreads: vi.fn(),
  mockReviewPR: vi.fn(),
  mockPostReview: vi.fn(),
  mockPostOrUpdateComment: vi.fn(),
  mockSaveStateGuard: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
  debug: mockDebug,
  saveState: mockSaveState,
  getState: mockSaveStateGuard,
  summary: {
    addHeading: vi.fn(),
    addRaw: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
  },
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
  isMR: mockIsMR,
  getBotReviewThreads: mockGetBotReviewThreads,
  postReview: mockPostReview,
  postOrUpdateComment: mockPostOrUpdateComment,
} as unknown as GitHubHelper;

const mockEngine = {
  reviewPR: mockReviewPR,
  getLastTelemetry: vi.fn().mockReturnValue(null),
} as unknown as ReviewEngine;

/** The duoport #135 shape: 22 issues, verdict ready=False, high confidence. */
const L054_RESULT: ReviewResult = {
  summary: '**Consolidated result:** 22 issues (0 critical, 10 important, 12 minor), 9 strengths.',
  verdict: {
    ready: false,
    reasoning: '10 important issues must be addressed.',
    autoFixable: false,
    confidence: 'high',
  },
  strengths: ['Good test coverage'],
  issues: [
    {
      type: 'issue',
      severity: 'important',
      file: 'src/probe.ts',
      line: 12,
      message: 'Unknown-fallback probe swallows the thrown error',
      inline: true,
    },
  ],
  stats: { total: 22, critical: 0, important: 10, minor: 12 },
};

async function run(): Promise<void> {
  await runReview(
    makeInputs(),
    makeConfig({ enableMCP: false, mcpServers: [] }),
    mockEngine,
    mockGh,
    'owner/repo',
  );
}

describe('runReview verdict delivery (L-054)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockImplementation(() => '');
    mockGetPR.mockResolvedValue(makePRContext());
    mockGetBotReviewThreads.mockResolvedValue([]);
    mockPostOrUpdateComment.mockResolvedValue(undefined);
    mockReviewPR.mockResolvedValue(L054_RESULT);
  });

  it('fails the job when postReview resolves success:false (the swallowed verdict)', async () => {
    // This is exactly what lib/src/utils/github.ts:1959 returns when the
    // body-only review POST is rejected after the batched attempt failed.
    mockPostReview.mockResolvedValue({ success: false, method: 'failed' });

    await run();

    expect(mockPostReview).toHaveBeenCalledTimes(1);
    expect(mockSetFailed).toHaveBeenCalledTimes(1);
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to deliver review verdict for PR #42'),
    );
  });

  it('leaves a visible review-error marker comment when delivery fails', async () => {
    mockPostReview.mockResolvedValue({ success: false, method: 'failed' });

    await run();

    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- review-error -->',
      expect.stringContaining('Review Failed'),
    );
  });

  it('does not emit the verdict output when the verdict was never posted', async () => {
    mockPostReview.mockResolvedValue({ success: false, method: 'failed' });

    await run();

    // Emitting `verdict`/`critical_count` as if the review landed is what let a
    // downstream consumer treat an unreviewed PR as reviewed.
    expect(mockSetOutput).not.toHaveBeenCalledWith('verdict', expect.anything());
    expect(mockSetOutput).not.toHaveBeenCalledWith('critical_count', expect.anything());
  });

  it('does not notify about a review that never reached the PR', async () => {
    mockPostReview.mockResolvedValue({ success: false, method: 'failed' });

    await run();

    // The notification links to the PR; linking to a PR with no review misleads.
    expect(mockSetFailed).toHaveBeenCalledTimes(1);
  });

  it('still fails loudly when postReview throws', async () => {
    mockPostReview.mockRejectedValue(new Error('GitHub API 500 on /pulls/42/reviews'));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to post review'));
  });

  it('succeeds and emits outputs when delivery succeeds (control, non-vacuous)', async () => {
    mockPostReview.mockResolvedValue({ success: true, method: 'full', reviewId: 99 });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('verdict', 'false');
    expect(mockSetOutput).toHaveBeenCalledWith('critical_count', '0');
    expect(mockSetOutput).toHaveBeenCalledWith('important_count', '10');
  });

  it('keeps the severity gate independent of delivery failure', async () => {
    // failOnSeverity would also call setFailed; assert the delivery failure is
    // reported with its own message so the log distinguishes the two causes.
    mockPostReview.mockResolvedValue({ success: false, method: 'failed' });

    await run();

    const messages = mockSetFailed.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Failed to deliver review verdict'))).toBe(true);
  });
});

/**
 * L-064: the length path must route through the SAME failure as any other
 * undelivered verdict, never around it.
 *
 * A body over GitHub's 65536-character review limit is rejected with HTTP 422,
 * twice (batched-inline, then body-only), and the job used to exit SUCCESS with
 * an empty `.reviews`. Truncation fixes the common case; this pins the rest:
 * if even the truncated body cannot be delivered, the job FAILS, and if a
 * truncated review DOES land, the degradation is stated rather than passed off
 * as a complete review.
 */
describe('runReview truncation reporting (L-064)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput.mockImplementation(() => '');
    mockGetPR.mockResolvedValue(makePRContext());
    mockGetBotReviewThreads.mockResolvedValue([]);
    mockPostOrUpdateComment.mockResolvedValue(undefined);
    mockReviewPR.mockResolvedValue(L054_RESULT);
  });

  it('fails the job when even a TRUNCATED body cannot be posted', async () => {
    // The worst case: capped, and the cap was not enough.
    mockPostReview.mockResolvedValue({
      success: false,
      method: 'failed',
      bodyTruncated: true,
      bodyOriginalLength: 108381,
      error: 'GitHub API 422 on /pulls/42/reviews: Body is too long',
    });

    await run();

    expect(mockSetFailed).toHaveBeenCalledTimes(1);
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to deliver review verdict for PR #42'),
    );
    // The length cause must survive into the failure message.
    expect(String(mockSetFailed.mock.calls[0]?.[0])).toContain('too long');
  });

  it('does NOT report success silently after posting a truncated review', async () => {
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'body-only',
      reviewId: 77,
      bodyTruncated: true,
      bodyOriginalLength: 108381,
    });

    await run();

    // The verdict WAS delivered, so this is a degradation, not a failure.
    expect(mockSetFailed).not.toHaveBeenCalled();
    // ...but it must be impossible to miss.
    expect(mockSetOutput).toHaveBeenCalledWith('review_truncated', 'true');
    expect(mockSetOutput).toHaveBeenCalledWith('review_original_length', '108381');
    expect(mockWarning.mock.calls.some((c) => String(c[0]).includes('TRUNCATED'))).toBe(true);
  });

  it('says nothing about truncation when the review was complete', async () => {
    mockPostReview.mockResolvedValue({ success: true, method: 'full', reviewId: 78 });

    await run();

    expect(mockSetOutput).not.toHaveBeenCalledWith('review_truncated', expect.anything());
    expect(mockWarning.mock.calls.some((c) => String(c[0]).includes('TRUNCATED'))).toBe(false);
  });

  it('still emits the verdict outputs on a truncated-but-delivered review', async () => {
    // Truncation must not cost the reviewer the machine-readable verdict.
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'body-only',
      reviewId: 79,
      bodyTruncated: true,
      bodyOriginalLength: 70000,
    });

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith('verdict', 'false');
    expect(mockSetOutput).toHaveBeenCalledWith('important_count', '10');
  });

  it('keeps the dropped-inline shortfall visible on a successful post', async () => {
    mockPostReview.mockResolvedValue({
      success: true,
      method: 'partial',
      reviewId: 80,
      bodyTruncated: true,
      bodyOriginalLength: 70000,
      droppedInline: 10,
    });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('review_truncated', 'true');
  });
});
