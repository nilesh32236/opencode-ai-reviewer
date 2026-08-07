import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearningStore } from '../src/learning/store.js';
import { SuppressionSubscriber } from '../src/learning/suppression-subscriber.js';
import type { AgentConfig, GitHubEvent } from '../src/types/index.js';

const CONFIG = {
  learning: {
    suppressionRules: {
      enabled: true,
      minDismissals: 3,
      ttlDays: 30,
      maxReviews: 20,
      maxRules: 25,
      excludeSeverities: ['critical'],
    },
  },
} as AgentConfig;

const DISABLED_CONFIG = {
  learning: {
    suppressionRules: {
      enabled: false,
      minDismissals: 3,
      ttlDays: 30,
      maxReviews: 20,
      maxRules: 25,
      excludeSeverities: ['critical'],
    },
  },
} as AgentConfig;

function makeEvent(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    type: 'review.dismissed',
    category: 'review',
    payload: {},
    timestamp: Date.now(),
    prNumber: 42,
    ...overrides,
  };
}

function makeStore(): LearningStore {
  return {
    generateSuppressionRules: vi.fn().mockResolvedValue(0),
    expireSuppressionRules: vi.fn().mockResolvedValue(0),
  } as unknown as LearningStore;
}

describe('SuppressionSubscriber', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs an immediate sweep for an event outside the debounce window', async () => {
    const store = makeStore();
    const sub = new SuppressionSubscriber(store, CONFIG, 1000);
    await sub.handle(makeEvent());
    expect(store.generateSuppressionRules).toHaveBeenCalledTimes(1);
    expect(store.expireSuppressionRules).toHaveBeenCalledTimes(1);
  });

  it('debounces in-window events and runs a single trailing sweep after the window', async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const sub = new SuppressionSubscriber(store, CONFIG, 1000);

    await sub.handle(makeEvent({ prNumber: 1 }));
    expect(store.generateSuppressionRules).toHaveBeenCalledTimes(1);

    await sub.handle(makeEvent({ prNumber: 1 }));
    await sub.handle(makeEvent({ prNumber: 1 }));
    // Later in-window events are debounced, no additional immediate sweep.
    expect(store.generateSuppressionRules).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    // Trailing sweep reconciles the accumulated dismissals once quiet.
    expect(store.generateSuppressionRules).toHaveBeenCalledTimes(2);
    expect(store.expireSuppressionRules).toHaveBeenCalledTimes(2);
  });

  it('passes the configured thresholds to the store', async () => {
    const store = makeStore();
    const sub = new SuppressionSubscriber(store, CONFIG, 1000);
    await sub.handle(makeEvent({ prNumber: 2 }));
    expect(store.generateSuppressionRules).toHaveBeenCalledWith({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
      excludeSeverities: ['critical'],
    });
    expect(store.expireSuppressionRules).toHaveBeenCalledWith(20);
  });

  it('never touches the store when suppression rules are disabled', async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const sub = new SuppressionSubscriber(store, DISABLED_CONFIG, 1000);

    await sub.handle(makeEvent({ prNumber: 3 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.generateSuppressionRules).not.toHaveBeenCalled();
    expect(store.expireSuppressionRules).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the store throws', async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.generateSuppressionRules.mockRejectedValueOnce(new Error('boom'));
    const sub = new SuppressionSubscriber(store, CONFIG, 1000);

    await expect(sub.handle(makeEvent({ prNumber: 4 }))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    // Immediate sweep failed; the trailing sweep still runs and recovers.
    expect(store.generateSuppressionRules).toHaveBeenCalledTimes(2);
  });
});
