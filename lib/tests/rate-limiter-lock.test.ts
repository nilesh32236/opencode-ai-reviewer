import { describe, expect, it, vi } from 'vitest';
import type { RateLimitActionInput, RateLimitCountFilter } from '../src/learning/types.js';
import type { RateLimitingConfig } from '../src/types/index.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';
import type { RateLimitStore } from '../src/utils/rate-limiter.js';

/**
 * The reservation lock is module-level state, so this suite lives in its own
 * file on purpose: the wedged holder below never settles, and its parked queue
 * must not leak into the other rate-limiter tests.
 */
const CONFIG: RateLimitingConfig = {
  enabled: true,
  reviewsPerRepoPerHour: 10,
  reviewsPerUserPerDay: 50,
  prCooldownMinutes: 2,
  conversationCooldownSeconds: 30,
  dailyTokenBudget: 500000,
  estimatedTokensPerCommand: 25000,
  estimatedTokensPerInteractive: 5000,
  adminUsers: [],
  retentionHours: 48,
};

/** Store whose count read never settles — a wedged connection. */
const WEDGED_STORE: RateLimitStore = {
  countRateLimitActions: (_filter: RateLimitCountFilter) => new Promise<number>(() => {}),
  sumRateLimitTokens: () => Promise.resolve(0),
  getLastRateLimitTime: () => Promise.resolve(null),
  recordRateLimitAction: (_input: RateLimitActionInput) => Promise.resolve('never'),
  completeRateLimitAction: () => Promise.resolve(),
  getRateLimitUsageByRepo: () => Promise.resolve([]),
  getRateLimitUsageByUser: () => Promise.resolve([]),
  resetRateLimits: () => Promise.resolve(0),
  cleanupRateLimits: () => Promise.resolve(0),
};

describe('RateLimiter reservation lock', () => {
  it('fails closed instead of hanging forever when the critical section never settles', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(CONFIG, WEDGED_STORE);
      const pending = limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });

      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      // Still parked one tick before the deadline — the check has not resolved
      // or rejected on its own.
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
