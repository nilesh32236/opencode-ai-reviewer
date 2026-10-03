import * as os from 'node:os';
/**
 * The `budgetTruncated` input to the published trust block must mean "content
 * was actually dropped", not "a non-optional variable happens to be defined".
 *
 * `budgetTruncated` gates `exhaustive` in buildReviewTrust (coverage.ts), so a
 * value that can never be false makes every review declare itself
 * non-exhaustive and stamps the "Not an exhaustive review" banner on every
 * verdict — including reviews that missed nothing. A banner that is always on
 * is an alarm readers learn to ignore, which is the failure this file exists to
 * prevent.
 *
 * The bug: engine.ts passed `budgetMode !== undefined`. `budgetMode` is a closed
 * union typed `'full' | 'summary' | 'split'` with no optional member, and every
 * pipeline caller passes one, so the expression was a tautology.
 *
 * These assertions run through the real `verifyReviewResult` seam so they cover
 * the ASSIGNMENT SITE, not a helper in isolation. buildReviewTrust itself is
 * already covered by review-trust.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { BUDGETED_CONTEXT_WARNING, ReviewEngine } from '../src/engine.js';
import type { PlatformAdapter } from '../src/platform/adapter.js';
import type { AgentConfig, ReviewResult } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { CoverageLedger, KNOWN_ZERO_FINDING_PASSES } from '../src/utils/coverage.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
}));

interface EngineSeam {
  verifyReviewResult: (
    result: ReviewResult,
    prContext: string,
    workDir: string,
    timeoutMinutes?: number,
    prNumber?: number,
    budgetMode?: 'full' | 'summary' | 'split',
    totalDiffLines?: number,
    files?: unknown[],
    scaIssues?: unknown[],
    secretScanFiles?: unknown[],
    trust?: { coverage: CoverageLedger; headSha: string },
  ) => Promise<ReviewResult>;
}

/** A result with real content, so the trust block is worth publishing. */
function makeResult(): ReviewResult {
  return {
    summary: 'Reviewed the change.',
    issues: [],
    strengths: [],
    stats: { total: 0, bySeverity: {} },
    verdict: { ready: true, score: 80, reasoning: 'Looks fine.' },
  } as unknown as ReviewResult;
}

function makeConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    review: { ...DEFAULT_CONFIG.review, enableReachability: false },
  };
}

/**
 * A ledger with every expected pass recorded clean, so `uncovered` is empty.
 *
 * Without this the run reports `exhaustive: false` for an UNRELATED and correct
 * reason — passes it never recorded — which would mask the budgetTruncated
 * regression instead of exposing it. Isolating the boolean needs a ledger where
 * budgetTruncated is the only thing left that can turn exhaustive off.
 */
function fullyCoveredLedger(): CoverageLedger {
  const ledger = new CoverageLedger();
  for (const pass of KNOWN_ZERO_FINDING_PASSES) {
    ledger.recordCounts(pass, 1, 0, 0);
  }
  return ledger;
}

/**
 * Drive verifyReviewResult the way runReviewPipeline does at engine.ts:3002 —
 * including the budgetMode/totalDiffLines pair, which is what made the old
 * `budgetMode !== undefined` expression tautological.
 */
async function publishTrust(result: ReviewResult): Promise<NonNullable<ReviewResult['trust']>> {
  const engine = new ReviewEngine(makeConfig(), {} as unknown as PlatformAdapter);
  const seam = engine as unknown as EngineSeam;
  const out = await seam.verifyReviewResult(
    result,
    'pr context',
    os.tmpdir(),
    undefined,
    undefined,
    'full',
    145,
    undefined,
    undefined,
    undefined,
    { coverage: fullyCoveredLedger(), headSha: 'a'.repeat(40) },
  );
  const trust = out.trust;
  expect(trust).toBeDefined();
  return trust as NonNullable<ReviewResult['trust']>;
}

describe('budgetTruncated reports real context truncation', () => {
  it('does NOT declare truncation for a review that dropped nothing', async () => {
    // The regression, at the assignment site. Before the fix this was `true`
    // because budgetMode was simply present, so `exhaustive` was permanently
    // false and every verdict opened with the non-exhaustive banner.
    const trust = await publishTrust(makeResult());

    expect(trust.exhaustive).toBe(true);
    expect(trust.statement).not.toContain('Not an exhaustive review');
    expect(trust.statement).not.toContain('context budget truncated');
  });

  it('DOES declare truncation once the engine actually budgeted the context', async () => {
    // applyBudgetedContextDegradation is what runReviewPipeline calls when, and
    // only when, the orchestrator context exceeded SUBAGENT_REVIEW_CONTEXT_LIMIT.
    // The published block must still report that honestly.
    const budgeted = ReviewEngine.applyBudgetedContextDegradation(makeResult());
    expect(budgeted.summary).toContain(BUDGETED_CONTEXT_WARNING);

    const trust = await publishTrust(budgeted);

    expect(trust.exhaustive).toBe(false);
    expect(trust.statement).toContain('Not an exhaustive review');
  });

  it('is driven by the degradation record, not by a bare budget mode', () => {
    // Budget-mode adaptation ('summary'/'split') narrows WHICH findings are
    // reported; it does not drop context content. The trust classification is
    // unchanged by the fix, so that case must not claim truncation either.
    const plain = makeResult();
    expect(ReviewEngine.isContextBudgetDegraded(plain)).toBe(false);
    expect(
      ReviewEngine.isContextBudgetDegraded(ReviewEngine.applyBudgetedContextDegradation(plain)),
    ).toBe(true);
  });
});
