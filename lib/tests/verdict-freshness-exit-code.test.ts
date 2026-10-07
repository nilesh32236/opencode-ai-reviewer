/**
 * The guard's exit code is the machine's ONLY view of it.
 *
 * Case 3 (evidence unreadable) must never collapse into case 1 (verdict lost):
 * an API blip reported as "the verdict vanished" is a lie that trains people
 * to ignore the check. These tests pin the mapping and the wording.
 */
import { describe, expect, it, vi } from 'vitest';

import { exitCodeFor } from '../../.github/scripts/check-verdict-freshness.js';
import type { VerdictPull } from '../src/utils/verdict-freshness.js';
import { evaluateVerdictFreshness } from '../src/utils/verdict-freshness.js';

const HOUR = 60 * 60_000;
const HEAD = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** A PR whose verdict is genuinely fresh and correctly anchored. */
const HEALTHY: VerdictPull = {
  number: 1,
  head_ref: 'feature/ok',
  head_sha: HEAD,
  head_date: ago(3 * HOUR),
  reviews: [
    {
      id: 1,
      user: { login: 'opencode-ai-reviewer[bot]' },
      submitted_at: ago(2 * HOUR),
      commit_id: HEAD,
      body: '## MR Review Summary',
    },
  ],
  completedReviewRuns: 1,
};

/** Same PR, but the reviews endpoint blew up. */
const UNREADABLE: VerdictPull = {
  ...HEALTHY,
  reviewsFetchError: 'HTTP 502 Bad Gateway',
  reviews: [],
};

/** Same PR, but nothing was ever posted. */
const LOST: VerdictPull = { ...HEALTHY, reviews: [] };

describe('exitCodeFor()', () => {
  it('returns 0 when every PR is judged and fresh', () => {
    expect(exitCodeFor(evaluateVerdictFreshness([HEALTHY]))).toBe(0);
  });

  it('returns 1 when a verdict is genuinely lost', () => {
    expect(exitCodeFor(evaluateVerdictFreshness([LOST]))).toBe(1);
  });

  it('returns 1 when a verdict is stale (wrong commit read)', () => {
    const stale: VerdictPull = {
      ...HEALTHY,
      reviews: [{ ...HEALTHY.reviews![0]!, commit_id: 'ffffffff0000000' }],
    };
    expect(exitCodeFor(evaluateVerdictFreshness([stale]))).toBe(1);
  });

  it('returns 3 when reviews could not be read — NOT 1', () => {
    const code = exitCodeFor(evaluateVerdictFreshness([UNREADABLE]));

    expect(code).toBe(3);
    expect(code).not.toBe(1);
  });

  it('never claims a lost verdict on the unreadable path', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      exitCodeFor(evaluateVerdictFreshness([UNREADABLE]));
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('INCONCLUSIVE');
      expect(written).toContain('NOT a claim that any verdict was lost');
      expect(written).not.toContain('carry no usable verdict');
    } finally {
      spy.mockRestore();
    }
  });

  it('prefers 1 over 3 when a real loss and an unreadable PR coexist', () => {
    // The genuine failure is the more actionable signal and must not be
    // masked by an unrelated unreadable PR.
    const code = exitCodeFor(evaluateVerdictFreshness([LOST, UNREADABLE]));
    expect(code).toBe(1);
  });

  it('tolerates a report object with no indeterminate field', () => {
    // Back-compat: a report shaped by an older producer must not crash the
    // exit-code mapper.
    const legacy = { ...evaluateVerdictFreshness([HEALTHY]), indeterminate: undefined };
    expect(exitCodeFor(legacy as never)).toBe(0);
  });
});
