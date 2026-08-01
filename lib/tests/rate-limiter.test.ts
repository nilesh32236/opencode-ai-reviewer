import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import type { RateLimitActionInput, RateLimitCountFilter } from '../src/learning/types.js';
import type { RateLimitingConfig } from '../src/types/index.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';
import type { RateLimitStore } from '../src/utils/rate-limiter.js';

const BASE_CONFIG: RateLimitingConfig = {
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

interface Row {
  id: string;
  repo: string;
  github_user: string;
  pr_number: number;
  action: string;
  tier: string;
  tokens_used: number;
  created_at: string;
}

class MockStore implements RateLimitStore {
  rows: Row[] = [];

  private iso(ts: number): string {
    return new Date(ts).toISOString();
  }

  async recordRateLimitAction(input: RateLimitActionInput): Promise<string> {
    const id = `row-${this.rows.length}`;
    this.rows.push({
      id,
      repo: input.repo,
      github_user: input.githubUser,
      pr_number: input.prNumber,
      action: input.action,
      tier: input.tier,
      tokens_used: input.tokensUsed,
      created_at: this.iso(Date.now()),
    });
    return id;
  }

  async completeRateLimitAction(id: string, tokensUsed: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.tokens_used = tokensUsed;
  }

  async countRateLimitActions(filter: RateLimitCountFilter): Promise<number> {
    return this.rows.filter((r) => {
      if (Date.parse(r.created_at) < filter.sinceMs) return false;
      if (filter.repo && r.repo !== filter.repo) return false;
      if (filter.user && r.github_user !== filter.user) return false;
      if (filter.tier && r.tier !== filter.tier) return false;
      return true;
    }).length;
  }

  async sumRateLimitTokens(sinceMs: number): Promise<number> {
    return this.rows
      .filter((r) => Date.parse(r.created_at) >= sinceMs)
      .reduce((sum, r) => sum + r.tokens_used, 0);
  }

  async getLastRateLimitTime(repo: string, prNumber: number, tier: string): Promise<number | null> {
    const times = this.rows
      .filter((r) => r.repo === repo && r.pr_number === prNumber && r.tier === tier)
      .map((r) => Date.parse(r.created_at));
    return times.length > 0 ? Math.max(...times) : null;
  }

  async getRateLimitUsageByRepo(
    sinceMs: number,
    limit = 10,
    tier?: string,
  ): Promise<Array<{ repo: string; count: number }>> {
    const counts = new Map<string, number>();
    for (const r of this.rows) {
      if (Date.parse(r.created_at) < sinceMs) continue;
      if (tier && r.tier !== tier) continue;
      counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([repo, count]) => ({ repo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  async getRateLimitUsageByUser(
    sinceMs: number,
    limit = 10,
  ): Promise<Array<{ user: string; count: number }>> {
    const counts = new Map<string, number>();
    for (const r of this.rows) {
      if (Date.parse(r.created_at) < sinceMs) continue;
      counts.set(r.github_user, (counts.get(r.github_user) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([user, count]) => ({ user, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  async resetRateLimits(repo?: string, user?: string): Promise<number> {
    const before = this.rows.length;
    if (!repo && !user) {
      this.rows = [];
    } else {
      this.rows = this.rows.filter((r) => {
        if (repo && r.repo === repo) return false;
        if (user && r.github_user === user) return false;
        return true;
      });
    }
    return before - this.rows.length;
  }

  async cleanupRateLimits(olderThanMs: number): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => {
      const ts = Date.parse(r.created_at);
      return Number.isNaN(ts) || ts >= olderThanMs;
    });
    return before - this.rows.length;
  }
}

function makeConfig(overrides: Partial<RateLimitingConfig> = {}): RateLimitingConfig {
  return { ...BASE_CONFIG, ...overrides };
}

describe('RateLimiter', () => {
  let store: MockStore;
  let limiter: RateLimiter;

  beforeEach(() => {
    store = new MockStore();
    limiter = new RateLimiter(makeConfig(), store);
  });

  it('allows when under all limits', async () => {
    const result = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it('reserves a rate-limit slot at check time so concurrent requests are counted', async () => {
    limiter = new RateLimiter(makeConfig({ reviewsPerRepoPerHour: 1 }), store);

    const first = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(first.allowed).toBe(true);
    expect(first.reservationId).toBeDefined();
    // The reservation is persisted before the (potentially slow) run finishes,
    // so a burst of concurrent events sees it immediately.
    expect(store.rows).toHaveLength(1);

    const second = await limiter.checkReview('org/repo', 'bob', 2, { tier: 'command' });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('repo_hourly');
  });

  it('reconciles the reserved row with actual token usage on completion', async () => {
    const result = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(result.allowed).toBe(true);
    expect(result.reservationId).toBeDefined();

    await limiter.recordReview(
      'org/repo',
      'alice',
      1,
      'review',
      'command',
      12000,
      result.reservationId,
    );

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].tokens_used).toBe(12000);
  });

  it('keeps the reserved estimate when a run fails, so failed attempts count', async () => {
    limiter = new RateLimiter(makeConfig({ reviewsPerRepoPerHour: 1 }), store);
    const result = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(result.allowed).toBe(true);

    // Simulate a failed run: no recordReview call completes the reservation.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].tokens_used).toBe(25000);

    const second = await limiter.checkReview('org/repo', 'alice', 2, { tier: 'command' });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('repo_hourly');
  });

  it('scopes the per-PR cooldown by repository', async () => {
    limiter = new RateLimiter(makeConfig({ prCooldownMinutes: 2 }), store);
    await limiter.recordReview('org/repo', 'alice', 42, 'review', 'command');

    const sameRepo = await limiter.checkReview('org/repo', 'bob', 42, { tier: 'command' });
    expect(sameRepo.allowed).toBe(false);
    expect(sameRepo.reason).toBe('pr_cooldown');

    const otherRepo = await limiter.checkReview('other/repo', 'bob', 42, { tier: 'command' });
    expect(otherRepo.allowed).toBe(true);
  });

  it('filters the status per-repo hourly usage to the command tier', async () => {
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    await limiter.recordReview('org/repo', 'alice', 2, 'conversation', 'interactive');

    const status = await limiter.getStatus();
    expect(status.repoHourly).toHaveLength(1);
    expect(status.repoHourly[0]).toEqual({ repo: 'org/repo', count: 1, limit: 10 });
  });

  it('denies when the per-repo hourly limit is reached (command tier)', async () => {
    limiter = new RateLimiter(makeConfig({ reviewsPerRepoPerHour: 2 }), store);
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    await limiter.recordReview('org/repo', 'bob', 2, 'review', 'command');

    const result = await limiter.checkReview('org/repo', 'carol', 3, { tier: 'command' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('repo_hourly');
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('does not apply the per-repo hourly limit to interactive actions', async () => {
    limiter = new RateLimiter(makeConfig({ reviewsPerRepoPerHour: 1 }), store);
    await limiter.recordReview('org/repo', 'alice', 1, 'conversation', 'interactive');
    await limiter.recordReview('org/repo', 'bob', 2, 'conversation', 'interactive');

    const result = await limiter.checkReview('org/repo', 'carol', 3, { tier: 'interactive' });
    expect(result.allowed).toBe(true);
  });

  it('denies when the per-user daily limit is reached across tiers', async () => {
    limiter = new RateLimiter(makeConfig({ reviewsPerUserPerDay: 2 }), store);
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    await limiter.recordReview('org/repo', 'alice', 1, 'conversation', 'interactive');

    const result = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('user_daily');
  });

  it('enforces the command-tier PR cooldown', async () => {
    limiter = new RateLimiter(makeConfig({ prCooldownMinutes: 2 }), store);
    await limiter.recordReview('org/repo', 'alice', 42, 'review', 'command');

    const result = await limiter.checkReview('org/repo', 'bob', 42, { tier: 'command' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('pr_cooldown');
  });

  it('enforces the interactive-tier PR cooldown', async () => {
    limiter = new RateLimiter(makeConfig({ conversationCooldownSeconds: 30 }), store);
    await limiter.recordReview('org/repo', 'alice', 42, 'conversation', 'interactive');

    const result = await limiter.checkReview('org/repo', 'alice', 42, { tier: 'interactive' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('pr_cooldown');
  });

  it('allows a new action once the cooldown window has expired', async () => {
    limiter = new RateLimiter(makeConfig({ prCooldownMinutes: 1 }), store);
    store.rows.push({
      id: 'old-row',
      repo: 'org/repo',
      github_user: 'alice',
      pr_number: 42,
      action: 'review',
      tier: 'command',
      tokens_used: 25000,
      created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });

    const result = await limiter.checkReview('org/repo', 'alice', 42, { tier: 'command' });
    expect(result.allowed).toBe(true);
  });

  it('denies when the daily token budget would be exceeded', async () => {
    limiter = new RateLimiter(
      makeConfig({ dailyTokenBudget: 50000, estimatedTokensPerCommand: 30000 }),
      store,
    );
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');

    const result = await limiter.checkReview('org/repo', 'alice', 2, { tier: 'command' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_budget');
  });

  it('shares the token budget across command and interactive tiers', async () => {
    limiter = new RateLimiter(
      makeConfig({
        dailyTokenBudget: 30000,
        estimatedTokensPerCommand: 25000,
        estimatedTokensPerInteractive: 5000,
      }),
      store,
    );
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    await limiter.recordReview('org/repo', 'alice', 1, 'conversation', 'interactive');

    const result = await limiter.checkReview('org/repo', 'alice', 2, { tier: 'interactive' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_budget');
  });

  it('allows when disabled and records nothing', async () => {
    limiter = new RateLimiter(
      makeConfig({ enabled: false, reviewsPerRepoPerHour: 0, reviewsPerUserPerDay: 0 }),
      store,
    );
    const result = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(result.allowed).toBe(true);

    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    expect(store.rows).toHaveLength(0);
  });

  it('formats a clear 429-style message with a reset time', async () => {
    limiter = new RateLimiter(makeConfig({ reviewsPerRepoPerHour: 0 }), store);
    const result = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    const message = limiter.formatLimitMessage(result);

    expect(result.allowed).toBe(false);
    expect(message).toContain('Rate Limit Reached');
    expect(message).toContain('per-repository hourly review limit');
    expect(message).toContain('Try again after:');
    expect(message).toContain('UTC');
  });

  it('returns an empty message for allowed results', () => {
    const message = limiter.formatLimitMessage({
      allowed: true,
      remaining: 10,
      resetAt: Date.now(),
    });
    expect(message).toBe('');
  });

  it('resets limits per repo, per user, and globally', async () => {
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    await limiter.recordReview('org/repo', 'bob', 2, 'review', 'command');
    await limiter.recordReview('other/repo', 'alice', 3, 'review', 'command');

    expect(await limiter.resetRepo('org/repo')).toBe(2);
    expect(store.rows).toHaveLength(1);

    await limiter.recordReview('org/repo', 'bob', 4, 'review', 'command');
    expect(await limiter.resetUser('alice')).toBe(1);
    expect(store.rows).toHaveLength(1);

    expect(await limiter.resetAll()).toBe(1);
    expect(store.rows).toHaveLength(0);
  });

  it('aggregates status for the admin command', async () => {
    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');
    await limiter.recordReview('org/repo', 'alice', 2, 'conversation', 'interactive');

    const status = await limiter.getStatus();
    expect(status.repoHourly[0]).toEqual({ repo: 'org/repo', count: 1, limit: 10 });
    expect(status.userDaily[0]).toEqual({ user: 'alice', count: 2, limit: 50 });
    expect(status.tokenUsageToday).toBeGreaterThan(0);
    expect(status.tokenBudget).toBe(500000);
  });

  it('cleans up stale records beyond the retention window', async () => {
    limiter = new RateLimiter(makeConfig({ retentionHours: 1 }), store);
    store.rows.push({
      id: 'stale-row',
      repo: 'org/repo',
      github_user: 'alice',
      pr_number: 1,
      action: 'review',
      tier: 'command',
      tokens_used: 25000,
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    store.rows.push({
      id: 'fresh-row',
      repo: 'org/repo',
      github_user: 'alice',
      pr_number: 2,
      action: 'review',
      tier: 'command',
      tokens_used: 25000,
      created_at: new Date().toISOString(),
    });

    expect(await limiter.cleanup()).toBe(1);
    expect(store.rows).toHaveLength(1);
  });
});

describe('LearningStore rate limit persistence', () => {
  let store: LearningStore;
  const TEST_DB = path.join(os.tmpdir(), `.test-rate-limits-${Date.now()}.db`);

  beforeEach(() => {
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
    store = new LearningStore(TEST_DB);
  });

  afterEach(async () => {
    await store.close();
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
  });

  it('records, counts, sums tokens, and tracks last PR time', async () => {
    await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'alice',
      prNumber: 7,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });
    await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'bob',
      prNumber: 7,
      action: 'conversation',
      tier: 'interactive',
      tokensUsed: 5000,
    });

    expect(
      await store.countRateLimitActions({ repo: 'org/repo', tier: 'command', sinceMs: 0 }),
    ).toBe(1);
    expect(await store.countRateLimitActions({ user: 'alice', sinceMs: 0 })).toBe(1);
    expect(await store.countRateLimitActions({ sinceMs: 0 })).toBe(2);
    expect(await store.countRateLimitActions({ sinceMs: Date.now() + 60_000 })).toBe(0);

    expect(await store.sumRateLimitTokens(Date.now() - 60_000)).toBe(30000);

    const last = await store.getLastRateLimitTime('org/repo', 7, 'command');
    expect(last).not.toBeNull();
    expect(last).toBeLessThanOrEqual(Date.now());
    expect(await store.getLastRateLimitTime('org/repo', 7, 'interactive')).not.toBeNull();
    expect(await store.getLastRateLimitTime('org/repo', 999, 'command')).toBeNull();
    // The cooldown lookup is scoped per repository.
    expect(await store.getLastRateLimitTime('other/repo', 7, 'command')).toBeNull();
  });

  it('aggregates usage by repo and user', async () => {
    await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'alice',
      prNumber: 1,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });
    await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'bob',
      prNumber: 2,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });

    const byRepo = await store.getRateLimitUsageByRepo(Date.now() - 60_000);
    expect(byRepo).toEqual([{ repo: 'org/repo', count: 2 }]);

    const byUser = await store.getRateLimitUsageByUser(Date.now() - 60_000);
    expect(byUser).toHaveLength(2);
    expect(byUser.map((u) => u.user).sort()).toEqual(['alice', 'bob']);
  });

  it('resets and cleans up rows', async () => {
    await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'alice',
      prNumber: 1,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });
    await store.recordRateLimitAction({
      repo: 'other/repo',
      githubUser: 'bob',
      prNumber: 2,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });

    expect(await store.resetRateLimits('org/repo')).toBe(1);
    expect(await store.countRateLimitActions({ sinceMs: 0 })).toBe(1);
    expect(await store.resetRateLimits()).toBe(1);

    await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'alice',
      prNumber: 1,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });
    expect(await store.cleanupRateLimits(Date.now() + 60_000)).toBe(1);
    expect(await store.countRateLimitActions({ sinceMs: 0 })).toBe(0);
  });

  it('reconciles a reserved row with actual token usage', async () => {
    const id = await store.recordRateLimitAction({
      repo: 'org/repo',
      githubUser: 'alice',
      prNumber: 9,
      action: 'review',
      tier: 'command',
      tokensUsed: 25000,
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    await store.completeRateLimitAction(id, 11000);
    expect(await store.sumRateLimitTokens(Date.now() - 60_000)).toBe(11000);
  });

  it('works end-to-end with the RateLimiter against the real store', async () => {
    const limiter = new RateLimiter(makeConfig({ reviewsPerRepoPerHour: 1 }), store);
    expect((await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' })).allowed).toBe(
      true,
    );

    await limiter.recordReview('org/repo', 'alice', 1, 'review', 'command');

    const second = await limiter.checkReview('org/repo', 'alice', 1, { tier: 'command' });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('repo_hourly');
  });
});
