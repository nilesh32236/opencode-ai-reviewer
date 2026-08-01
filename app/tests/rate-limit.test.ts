import { DEFAULT_CONFIG, RateLimiter } from '@opencode-pr-agent/lib';
import type { GitHubEvent } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit, recordRateLimit } from '../src/utils/rate-limit.js';

const { mockPostOrUpdateComment, mockPostComment } = vi.hoisted(() => ({
  mockPostOrUpdateComment: vi.fn().mockResolvedValue({ action: 'created', commentId: 1 }),
  mockPostComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        postOrUpdateComment = mockPostOrUpdateComment;
        postComment = mockPostComment;
      },
    ),
  };
});

function makeEvent(body: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber: 123,
    payload: {
      comment: { body, user: { login: 'alice' } },
      sender: { login: 'alice' },
    },
  };
}

function makeLimiter(): { limiter: RateLimiter; rows: unknown[] } {
  const rows: unknown[] = [];
  const fakeStore = {
    countRateLimitActions: vi.fn().mockResolvedValue(0),
    sumRateLimitTokens: vi.fn().mockResolvedValue(0),
    getLastRateLimitTime: vi.fn().mockResolvedValue(null),
    recordRateLimitAction: vi.fn().mockImplementation(async () => {
      rows.push({});
      return 'res-1';
    }),
    completeRateLimitAction: vi.fn().mockResolvedValue(undefined),
    getRateLimitUsageByRepo: vi.fn().mockResolvedValue([]),
    getRateLimitUsageByUser: vi.fn().mockResolvedValue([]),
    resetRateLimits: vi.fn().mockResolvedValue(0),
    cleanupRateLimits: vi.fn().mockResolvedValue(0),
  } as never;
  return { limiter: new RateLimiter(DEFAULT_CONFIG.rateLimiting, fakeStore), rows };
}

describe('checkRateLimit / recordRateLimit', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
    mockPostComment.mockReset();
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('returns a result with a reservation ID when allowed', async () => {
    const { limiter, rows } = makeLimiter();
    const result = await checkRateLimit(limiter, makeEvent('/review'), 'command', 'review');

    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(true);
    expect(result?.reservationId).toBe('res-1');
    expect(rows).toHaveLength(1);
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('posts a single upserted 429 notice when denied and returns null', async () => {
    const { limiter } = makeLimiter();
    const denied = Object.create(limiter) as RateLimiter;
    denied.checkReview = vi.fn().mockResolvedValue({
      allowed: false,
      reason: 'repo_hourly',
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const result = await checkRateLimit(denied, makeEvent('/review'), 'command', 'review');

    expect(result).toBeNull();
    expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      123,
      '<!-- rate-limit-reached -->',
      expect.stringContaining('Rate Limit Reached'),
    );
  });

  it('does not post a denial comment when postDenialComment is false', async () => {
    const { limiter } = makeLimiter();
    const denied = Object.create(limiter) as RateLimiter;
    denied.checkReview = vi.fn().mockResolvedValue({
      allowed: false,
      reason: 'repo_hourly',
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const result = await checkRateLimit(denied, makeEvent('/review'), 'command', 'review', {
      postDenialComment: false,
    });

    expect(result).toBeNull();
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('reconciles the reservation with the limiter recordReview call', async () => {
    const { limiter } = makeLimiter();
    const recordReview = vi.fn().mockResolvedValue(undefined);
    const spyLimiter = Object.create(limiter) as RateLimiter;
    spyLimiter.recordReview = recordReview;

    const result = await checkRateLimit(spyLimiter, makeEvent('/review'), 'command', 'review');
    await recordRateLimit(spyLimiter, makeEvent('/review'), 'command', 'review', result);

    expect(recordReview).toHaveBeenCalledWith(
      'owner/repo',
      'alice',
      123,
      'review',
      'command',
      undefined,
      'res-1',
    );
  });

  it('returns a no-op result when the limiter is unavailable', async () => {
    const result = await checkRateLimit(null, makeEvent('/review'), 'command', 'review');

    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(true);
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });
});
