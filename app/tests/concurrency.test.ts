import { describe, expect, it } from 'vitest';
import {
  type ConcurrencyDecision,
  Semaphore,
  runSemaphore,
  runWithConcurrencyLimit,
} from '../src/utils/concurrency.js';
import { buildRepoFilter, isRepoAllowed } from '../src/utils/repo-filter.js';

describe('Semaphore', () => {
  it('limits concurrent executions to the configured limit', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const run = async (): Promise<void> => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      release();
    };
    await Promise.all([run(), run(), run(), run(), run()]);
    expect(peak).toBe(2);
  });

  it('rejects a limit below 1', () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

describe('runWithConcurrencyLimit', () => {
  it('runs work and reports acquired:true when a slot is free', async () => {
    const decision = await runWithConcurrencyLimit(async () => {
      await new Promise((r) => setTimeout(r, 5));
    }, 'test work');
    expect(decision.acquired).toBe(true);
  });

  it('skips work (acquired:false) when the wait elapses with no slot', async () => {
    // Occupy the single slot first.
    const release = await runSemaphoreAcquireDirect();
    try {
      const decision = await runWithConcurrencyLimit(async () => {}, 'test busy', 20);
      expect(decision.acquired).toBe(false);
      expect(decision.reason).toBe('Too many concurrent runs');
    } finally {
      release();
    }
  });

  it('is reentrant: nested acquisition inside a held slot does not deadlock', async () => {
    // A delegated call (e.g. /review -> handlePRReview) runs inside a held
    // slot; a nested runWithConcurrencyLimit must reuse the slot instead of
    // waiting on itself (which would busy-out after the wait window).
    const nested: ConcurrencyDecision[] = [];
    const decision = await runWithConcurrencyLimit(async () => {
      nested.push(await runWithConcurrencyLimit(async () => {}, 'nested', 200));
      nested.push(await runWithConcurrencyLimit(async () => {}, 'nested2', 200));
    }, 'outer');
    expect(decision.acquired).toBe(true);
    expect(nested).toHaveLength(2);
    expect(nested[0].acquired).toBe(true);
    expect(nested[1].acquired).toBe(true);
  });
});

// Helper to acquire the shared semaphore directly so a test can hold the slot.
async function runSemaphoreAcquireDirect(): Promise<() => void> {
  return runSemaphore.acquire();
}

describe('repo filter', () => {
  it('allows all repos when neither allowlist nor denylist is set', () => {
    const filter = buildRepoFilter({});
    expect(isRepoAllowed('owner/repo', filter)).toBe(true);
  });

  it('denies repos on the denylist regardless of allowlist', () => {
    const filter = buildRepoFilter({
      ALLOWED_REPOS: 'good/repo,owner/repo',
      DENIED_REPOS: 'owner/repo',
    });
    expect(isRepoAllowed('owner/repo', filter)).toBe(false);
    expect(isRepoAllowed('good/repo', filter)).toBe(true);
  });

  it('only allows repos on the allowlist when it is set', () => {
    const filter = buildRepoFilter({ ALLOWED_REPOS: 'good/repo,other/repo' });
    expect(isRepoAllowed('good/repo', filter)).toBe(true);
    expect(isRepoAllowed('unlisted/repo', filter)).toBe(false);
  });

  it('is case-insensitive and ignores malformed entries', () => {
    const filter = buildRepoFilter({ ALLOWED_REPOS: 'Good/Repo , no-slash, x/y' });
    expect(isRepoAllowed('good/repo', filter)).toBe(true);
    expect(isRepoAllowed('x/y', filter)).toBe(true);
    expect(isRepoAllowed('norepo', filter)).toBe(false);
  });

  it('rejects a missing repo string', () => {
    const filter = buildRepoFilter({});
    expect(isRepoAllowed(undefined, filter)).toBe(false);
  });

  it('fails closed when the allowlist is configured but all entries are malformed', () => {
    // No valid "owner/repo" entries — must deny everything rather than fail open.
    const filter = buildRepoFilter({ ALLOWED_REPOS: 'no-slash, anotherbad, ,,' });
    expect(filter.allowlistConfigured).toBe(true);
    expect(isRepoAllowed('anything/repo', filter)).toBe(false);
    expect(isRepoAllowed('good/repo', filter)).toBe(false);
  });

  it('allows all repos when ALLOWED_REPOS is empty or unset', () => {
    expect(buildRepoFilter({ ALLOWED_REPOS: '' }).allowlistConfigured).toBe(false);
    expect(buildRepoFilter({}).allowlistConfigured).toBe(false);
    expect(isRepoAllowed('x/y', buildRepoFilter({ ALLOWED_REPOS: '' }))).toBe(true);
  });
});
