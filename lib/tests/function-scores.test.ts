import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { buildFunctionScoreTable, computeFunctionScores } from '../src/utils/function-scores.js';
import { buildReviewBody } from '../src/utils/review-body.js';

function baseResult(): ReviewResult {
  return {
    summary: 'Summary.',
    verdict: { ready: true, reasoning: 'All good.' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
  };
}

describe('function-scores', () => {
  it('clamps scores to 0-100', () => {
    const [huge] = computeFunctionScores([
      { file: 'a.ts', name: 'f', line: 1, churnLines: 1000, nestingDepth: 100, hasTestGap: true },
    ]);
    expect(huge.score).toBe(100);
    const [zero] = computeFunctionScores([
      { file: 'a.ts', name: 'f', line: 1, churnLines: 0, nestingDepth: 0, hasTestGap: false },
    ]);
    expect(zero.score).toBe(0);
  });

  it('is monotonic in churn, nesting, and test-gap', () => {
    const base = { file: 'a.ts', name: 'f', line: 1, hasTestGap: false } as const;
    const [low, high] = [
      computeFunctionScores([{ ...base, churnLines: 1 }])[0].score,
      computeFunctionScores([{ ...base, churnLines: 10 }])[0].score,
    ];
    expect(high).toBeGreaterThan(low);
    expect(
      computeFunctionScores([{ ...base, churnLines: 1, nestingDepth: 3 }])[0].score,
    ).toBeGreaterThan(computeFunctionScores([{ ...base, churnLines: 1 }])[0].score);
    expect(
      computeFunctionScores([{ ...base, churnLines: 1, hasTestGap: true }])[0].score,
    ).toBeGreaterThan(computeFunctionScores([{ ...base, churnLines: 1 }])[0].score);
  });

  it('returns empty string for empty input and includes disclaimer otherwise', () => {
    expect(buildFunctionScoreTable([])).toBe('');
    const table = buildFunctionScoreTable(
      computeFunctionScores([
        { file: 'a.ts', name: 'f', line: 1, churnLines: 5, hasTestGap: true },
      ]),
    );
    expect(table).toContain('Function Quality Scores');
    expect(table).toContain('heuristic');
    expect(table).toContain('not verdicts');
  });

  it('caps the table at 10 rows', () => {
    const inputs = Array.from({ length: 15 }, (_, i) => ({
      file: `f${i}.ts`,
      name: `fn${i}`,
      line: i + 1,
      churnLines: i + 1,
      hasTestGap: false,
    }));
    const table = buildFunctionScoreTable(computeFunctionScores(inputs));
    const rows = table.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toHaveLength(10);
  });

  it('escapes hostile symbol names', () => {
    const table = buildFunctionScoreTable(
      computeFunctionScores([
        { file: 'a.ts', name: 'evil`name|pipe', line: 1, churnLines: 5, hasTestGap: false },
      ]),
    );
    expect(table).not.toContain('evil`name');
    expect(table).toContain('evil\\`name');
  });
});

describe('buildReviewBody function scores', () => {
  it('omits the table when the flag is unset', () => {
    const body = buildReviewBody(baseResult());
    expect(body).not.toContain('Function Quality Scores');
  });

  it('renders up to 10 scored functions with disclaimer when enabled', () => {
    const body = buildReviewBody(baseResult(), {
      showFunctionScores: true,
      functionScores: [
        { file: 'a.ts', name: 'risky', line: 10, churnLines: 20, hasTestGap: true },
        { file: 'b.ts', name: 'calm', line: 5, churnLines: 1, hasTestGap: false },
      ],
    });
    expect(body).toContain('Function Quality Scores');
    expect(body).toContain('risky');
    expect(body).toContain('not verdicts');
  });

  it('omits the table and still renders when scoring throws', () => {
    const hostile = {
      file: 'a.ts',
      name: 'f',
      line: 1,
      churnLines: 5,
      hasTestGap: false,
      get score(): number {
        throw new Error('boom');
      },
    };
    const body = buildReviewBody(baseResult(), {
      showFunctionScores: true,
      // Accessing `.score` throws, exercising the fail-open try/catch.
      functionScores: [hostile as never],
    });
    expect(body).toContain('MR Review Summary');
    expect(body).not.toContain('Function Quality Scores');
  });
});
