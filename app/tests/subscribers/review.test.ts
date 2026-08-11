import type { EventBus, GitHubEvent, LearningStore } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG, EventBus as RealEventBus } from '@opencode-pr-agent/lib';
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
    correlationId: 'event-corr-id',
    payload: {
      pull_request: {
        number: prNumber,
        user: { login: 'octocat' },
      },
      ...payload,
    },
  };
}

function makeCommentCreatedEvent(prNumber: number, body: string): GitHubEvent {
  return {
    type: 'comment.created',
    category: 'comment',
    timestamp: Date.now(),
    repo: 'owner/repo',
    prNumber,
    correlationId: 'cmd-corr-id',
    payload: {
      comment: { body, user: { login: 'octocat' } },
      issue: { number: prNumber },
      pull_request: { number: prNumber, user: { login: 'octocat' } },
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
    const sub = createReviewSubscriber({} as LearningStore, bus, undefined, DEFAULT_CONFIG);

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
      bus,
      'event-corr-id',
      { forceReview: false },
    );
  });

  it('falls back to pull_request.before when the top-level before is missing', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as LearningStore, bus, undefined, DEFAULT_CONFIG);

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
      bus,
      'event-corr-id',
      { forceReview: false },
    );
  });

  it('serializes concurrent events for the same PR into one review invocation', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as LearningStore, bus, undefined, DEFAULT_CONFIG);

    let resolveHandler: (value: unknown) => void = () => {};
    let resolveFirstInvocation: () => void = () => {};
    const firstInvocation = new Promise<void>((resolve) => {
      resolveFirstInvocation = resolve;
    });
    mockedHandlePRReview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirstInvocation();
          resolveHandler = resolve;
        }),
    );

    const first = sub.handle(makeSynchronizeEvent(42, { before: 'abcdef123456' }));
    // Wait until the first invocation has actually registered as in-flight
    // instead of guessing with a fixed timeout.
    await firstInvocation;
    const second = sub.handle(makeSynchronizeEvent(42, { before: 'abcdef123456' }));

    expect(mockedHandlePRReview).toHaveBeenCalledTimes(1);

    resolveHandler(null);
    await Promise.all([first, second]);

    expect(mockedHandlePRReview).toHaveBeenCalledTimes(1);
  });

  it('queues an explicit /review command behind an in-flight auto review, then executes it', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as LearningStore, bus, undefined, DEFAULT_CONFIG);

    const pendingHandlers: Array<(value: unknown) => void> = [];
    let resolveFirstInvocation: () => void = () => {};
    let resolveSecondInvocation: () => void = () => {};
    const firstInvocation = new Promise<void>((resolve) => {
      resolveFirstInvocation = resolve;
    });
    const secondInvocation = new Promise<void>((resolve) => {
      resolveSecondInvocation = resolve;
    });
    mockedHandlePRReview.mockImplementation(
      () =>
        new Promise((resolve) => {
          const idx = pendingHandlers.length;
          pendingHandlers.push(resolve);
          if (idx === 0) resolveFirstInvocation();
          if (idx === 1) resolveSecondInvocation();
        }),
    );

    const sync = sub.handle(makeSynchronizeEvent(42, { before: 'abcdef123456' }));
    await firstInvocation;
    const command = sub.handle(makeCommentCreatedEvent(42, '/review'));
    // The explicit /review must NOT be deduplicated by the in-flight auto run.
    expect(mockedHandlePRReview).toHaveBeenCalledTimes(1);

    pendingHandlers[0](null);
    await sync;
    // After the auto run settles, the queued /review starts its own review
    // with forceReview: true.
    await secondInvocation;
    expect(mockedHandlePRReview).toHaveBeenCalledTimes(2);
    expect(mockedHandlePRReview).toHaveBeenLastCalledWith(
      42,
      'owner/repo',
      'test-token',
      expect.any(Object),
      expect.anything(),
      undefined,
      undefined,
      bus,
      'cmd-corr-id',
      { forceReview: true },
    );

    pendingHandlers[1](null);
    await command;
  });

  it('allows a subsequent event after the previous run finished', async () => {
    const bus: EventBus = new RealEventBus();
    const sub = createReviewSubscriber({} as LearningStore, bus, undefined, DEFAULT_CONFIG);
    mockedHandlePRReview.mockResolvedValue(null);

    await sub.handle(makeSynchronizeEvent(42, { before: 'abcdef123456' }));
    await sub.handle(makeSynchronizeEvent(42, { before: 'abcdef123456' }));

    expect(mockedHandlePRReview).toHaveBeenCalledTimes(2);
  });
});
