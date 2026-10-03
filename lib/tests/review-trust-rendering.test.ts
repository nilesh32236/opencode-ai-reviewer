/**
 * The trust block has to survive all the way to the published comment, and it
 * has to stay honest on the way. These tests drive the real engine through the
 * failure modes that produced the false green, then assert on what a reader of
 * the review comment would actually see.
 *
 * The failure being guarded against is specific: a pass that could not read its
 * input, contributing zero findings, and a verdict that renders identically to
 * one where every pass ran and genuinely found nothing. Those two must never
 * produce the same comment.
 */

import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import {
  CoverageLedger,
  KNOWN_ZERO_FINDING_PASSES,
  PASS_LINTERS,
  PASS_SECRET_REVIEW,
  buildReviewTrust,
} from '../src/utils/coverage.js';
import { buildReviewBody, formatTrustSection } from '../src/utils/review-body.js';

const SHA = '3990d3891ff6dd0c0a14ba4ee68d49b4b8182694';

/**
 * A ledger in which every pass in {@link KNOWN_ZERO_FINDING_PASSES} recorded a
 * clean outcome.
 *
 * Tests that assert `exhaustive: true` need this rather than a two-pass
 * ledger: since the registry cross-check landed, a verdict that accounted for
 * two of fourteen passes is correctly reported as not exhaustive, because that
 * is exactly the partial ledger that must not read as complete.
 */
function fullCleanLedger(findingsPerPass = 0): CoverageLedger {
  const ledger = new CoverageLedger();
  for (const pass of KNOWN_ZERO_FINDING_PASSES) {
    ledger.recordCounts(pass, 1, 0, findingsPerPass);
  }
  return ledger;
}

function baseResult(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'Looks fine.',
    verdict: { ready: true, reasoning: 'No issues found.', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    ...over,
  };
}

/** Reproduce run 37090355702's secret-scan state exactly. */
function ledgerForUnreadableRun(): CoverageLedger {
  const ledger = new CoverageLedger();
  ledger.recordCounts(PASS_SECRET_REVIEW, 0, 19, 0, 'ENOENT');
  ledger.recordCounts(PASS_LINTERS, 0, 0, 0);
  return ledger;
}

describe('rendered verdict states its own coverage', () => {
  it('warns at the TOP of the body when inputs could not be read', () => {
    const trust = buildReviewTrust(ledgerForUnreadableRun(), { headSha: SHA });
    const body = buildReviewBody(baseResult({ trust }));

    const warningAt = body.indexOf('Not an exhaustive review');
    const verdictAt = body.indexOf('Ready to merge');
    expect(warningAt).toBeGreaterThanOrEqual(0);
    // The coverage caveat must not be buried below the verdict a reader scans
    // for. This is the whole point of rendering it first.
    expect(warningAt).toBeLessThan(verdictAt);
  });

  it('says UNSCANNED rather than clean when the scanner read nothing', () => {
    const trust = buildReviewTrust(ledgerForUnreadableRun(), { headSha: SHA });
    const body = buildReviewBody(baseResult({ trust }));
    expect(body).toContain('UNSCANNED');
    expect(body).toContain('19');
  });

  it('produces a visibly DIFFERENT comment for "read nothing" vs "read everything"', () => {
    const unreadable = buildReviewBody(
      baseResult({ trust: buildReviewTrust(ledgerForUnreadableRun(), { headSha: SHA }) }),
    );

    const cleanLedger = fullCleanLedger();
    const exhaustive = buildReviewBody(
      baseResult({
        trust: buildReviewTrust(cleanLedger, {
          headSha: SHA,
          candidatesConsidered: 0,
          delivered: 0,
        }),
      }),
    );

    expect(unreadable).not.toEqual(exhaustive);
    expect(unreadable).toContain('Not an exhaustive review');
    expect(exhaustive).not.toContain('Not an exhaustive review');
  });

  it('carries the candidate/retention figures into the body', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);
    const trust = buildReviewTrust(ledger, {
      headSha: SHA,
      candidatesConsidered: 50,
      delivered: 11,
    });
    const body = buildReviewBody(baseResult({ trust, issues: [] }));
    expect(body).toContain('50 considered');
    expect(body).toContain('39 dropped');
    expect(body).toContain('22% published');
  });

  it('renders unknown retention as unknown, never as 100%', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);
    const trust = buildReviewTrust(ledger, { headSha: SHA });
    const section = formatTrustSection(trust);
    expect(section).toContain('not tracked');
    expect(section).not.toContain('100% published');
  });

  it('lists every pass with its own read/not-read counts', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 27, 19, 2);
    ledger.record(PASS_LINTERS, 'skipped', 0, 0, 'not enabled');
    const section = formatTrustSection(buildReviewTrust(ledger, { headSha: SHA }));
    expect(section).toContain('`secrets.review`');
    expect(section).toContain('`linters`');
    expect(section).toContain('27');
    expect(section).toContain('19');
  });

  it('names the commit the anchors belong to', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);
    const section = formatTrustSection(buildReviewTrust(ledger, { headSha: SHA }));
    expect(section).toContain('3990d38');
  });

  it('reports stale anchors in the body when they exist', () => {
    const ledger = new CoverageLedger();
    ledger.recordCounts(PASS_SECRET_REVIEW, 46, 0, 0);
    // Driven through buildReviewTrust rather than hand-patched afterwards, so
    // the assertion covers the rule that actually produces the warning.
    const trust = buildReviewTrust(ledger, { headSha: SHA, anchorsChecked: 7, staleAnchors: 2 });
    const body = buildReviewBody(baseResult({ trust }));
    expect(trust.exhaustive).toBe(false);
    expect(body).toContain('stale line anchor');
    expect(body).toContain('7 verified');
    expect(body).toContain('2 stale');
  });

  it('leaves a legacy result with no trust block untouched', () => {
    // Results from paths that never ran a pass must still render — the block
    // is additive, never a new requirement on callers.
    const body = buildReviewBody(baseResult());
    expect(body).not.toContain('## Review coverage');
    expect(body).toContain('Looks fine.');
  });

  it('is not mistaken for a severity downgrade', () => {
    // The trust block describes the review, not the code. A non-exhaustive run
    // with no findings must not turn the verdict red — that would train people
    // to ignore it — and it must not leave it green either.
    const trust = buildReviewTrust(ledgerForUnreadableRun(), { headSha: SHA });
    const body = buildReviewBody(baseResult({ trust }));
    expect(body).toContain('**Ready to merge?** Yes');
    expect(body).toContain('Not an exhaustive review');
  });
});
