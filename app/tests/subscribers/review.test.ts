import type { EventBus, GitHubEvent, LearningStore } from '@opencode-pr-agent/lib';
import { EventBus as RealEventBus } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePRReview } from '../../src/handlers/pr-review.js';
import { createReviewSubscriber } from '../../src/subscribers/review.js';

vi.mock('../../src/handlers/pr-review.js', () => ({
  handlePRReview: vi.fn(),
}));

const mockedHandlePRReview = vi.mocked(handlePRReview);

function makeSynchronizeEvent(prNumber: number, payload: Record<string, unknown>): GitHubEvent {
  return {
    type: 'pr.synchronize',
    category: 'pr',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber,
    payload: {
      pull_request: {
        number: prNumber,
        user: { login: 'octocat' },
      },
      ...payload,
    },
  };
}

describe('ReviewSubscriber', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockedHandlePRReview.mockReset();
    mockedHandlePRReview.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('passes the top-level before SHA to handlePRReview on pr.synchronize', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as LearningStore, bus);

    await sub.handle(makeSynchronizeEvent(42, { before: 'abcdef123456' }));

    expect(mockedHandlePRReview).toHaveBeenCalledTimes(1);
    expect(mockedHandlePRReview).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'test-token',
      expect.any(Object),
      expect.anything(),
      undefined,
      'abcdef123456',
    );
  });

  it('falls back to pull_request.before when the top-level before is missing', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as LearningStore, bus);

    await sub.handle(
      makeSynchronizeEvent(7, {
        pull_request: {
          number: 7,
          user: { login: 'octocat' },
          before: 'fallbacksha123',
        },
      }),
    );

    expect(mockedHandlePRReview).toHaveBeenCalledTimes(1);
    expect(mockedHandlePRReview).toHaveBeenCalledWith(
      7,
      'owner/repo',
      'test-token',
      expect.any(Object),
      expect.anything(),
      undefined,
      'fallbacksha123',
    );
  });
});
