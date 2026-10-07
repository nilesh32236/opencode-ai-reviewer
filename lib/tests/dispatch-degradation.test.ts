/**
 * A degraded review must say so.
 *
 * The symptom this exists to catch was observed in CI: the specialist
 * sub-agents fail to dispatch (surfaced as "free tier can only be used from
 * within OpenCode") and the orchestrator answers on their behalf. The run
 * succeeds, produces real findings, and reads exactly like a healthy
 * multi-agent review — except that nothing specialist ever ran.
 *
 * The existing dispatch guard could not see this: it fires only when the run
 * produced NO substance at all, and a direct review produces plenty. So the
 * check here is on a different signal — whether the dispatched specialists
 * reported — which holds in both cases.
 *
 * The error string is deliberately not matched. Provider messages change
 * between versions and tiers; the orchestrator's own contract (one
 * `agent_status` line per dispatched category) does not.
 */

import { describe, expect, it } from 'vitest';
import { ReviewEngine } from '../src/engine.js';
import type { ReviewIssue, ReviewResult } from '../src/types/index.js';

const CATEGORIES = 4;

function okStatusLines(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `{"type":"agent_status","agent":"cat${i}","status":"ok"}`,
  );
}

function cleanResult(summary = 'No issues found'): ReviewResult {
  return {
    summary,
    verdict: { ready: true, reasoning: summary, autoFixable: false, confidence: 'high' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
  };
}

describe('dispatch coverage', () => {
  it('counts the specialists that reported status', () => {
    expect(ReviewEngine.measureDispatchCoverage(okStatusLines(4), 4)).toEqual({
      dispatched: 4,
      reported: 4,
    });
    expect(ReviewEngine.measureDispatchCoverage(okStatusLines(2), 4)).toEqual({
      dispatched: 4,
      reported: 2,
    });
    // The silent-fallback shape: the run produced findings, but no specialist
    // ever reported.
    expect(ReviewEngine.measureDispatchCoverage([], 4)).toEqual({ dispatched: 4, reported: 0 });
    expect(ReviewEngine.measureDispatchCoverage(undefined, 4)).toEqual({
      dispatched: 4,
      reported: 0,
    });
  });

  it('ignores unrelated JSONL lines rather than counting them as status', () => {
    const lines = [
      '{"type":"issue","file":"a.ts","line":1,"message":"x"}',
      '{"type":"verdict","ready":true}',
    ];
    expect(ReviewEngine.measureDispatchCoverage(lines, 4).reported).toBe(0);
  });

  describe('applyDispatchDegradation', () => {
    const coverage = { dispatched: CATEGORIES, reported: 0 };

    it('says so in the summary a reader actually reads', () => {
      const degraded = ReviewEngine.applyDispatchDegradation(
        cleanResult('No issues found'),
        coverage,
        'specialist subagents did not report',
      );
      expect(degraded.summary).toContain('No issues found');
      expect(degraded.summary).toContain('Degraded review');
      expect(degraded.summary).toContain('4 specialist sub-agents');
      expect(degraded.summary).toContain('direct review');
    });

    it('says so in the verdict reasoning, not only the summary', () => {
      const degraded = ReviewEngine.applyDispatchDegradation(
        cleanResult('No issues found'),
        coverage,
        'specialist subagents did not report',
      );
      expect(degraded.verdict.reasoning).toContain('No issues found');
      expect(degraded.verdict.reasoning).toContain('specialist sub-agents did not report');
      expect(degraded.verdict.reasoning).toContain('direct review');
    });

    it('counts the non-reporting specialists as failed agents', () => {
      // This is what makes the pre-existing "Partial review — N/M agent(s)
      // failed" banner render, so the degradation is visible in two places.
      const degraded = ReviewEngine.applyDispatchDegradation(cleanResult(), coverage, 'r');
      expect(degraded.failedAgents).toBe(CATEGORIES);
      expect(degraded.totalAgents).toBe(CATEGORIES);
    });

    it('does NOT turn the verdict red', () => {
      // A run that found nothing without its specialists is not evidence of a
      // defect. Blocking on every dispatch hiccup would train operators to
      // ignore the very banner this adds.
      const degraded = ReviewEngine.applyDispatchDegradation(cleanResult(), coverage, 'r');
      expect(degraded.verdict.ready).toBe(true);
    });

    it('keeps the findings — a direct review is still a review', () => {
      const issues: ReviewIssue[] = [
        { type: 'issue', severity: 'minor', file: 'a.ts', line: 3, message: 'nit' },
      ];
      const degraded = ReviewEngine.applyDispatchDegradation(
        {
          ...cleanResult('Found one nit'),
          issues,
          stats: { total: 1, critical: 0, important: 0, minor: 1 },
        },
        coverage,
        'r',
      );
      expect(degraded.issues).toHaveLength(1);
      expect(degraded.issues[0].message).toBe('nit');
    });

    it('does not invent findings when the run reported nothing', () => {
      const degraded = ReviewEngine.applyDispatchDegradation(cleanResult(), coverage, 'r');
      expect(degraded.issues).toEqual([]);
      expect(degraded.stats.total).toBe(0);
    });
  });
});
