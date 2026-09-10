import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import {
  buildFunctionScoreOptions,
  buildFunctionScoreTable,
  collectFunctionScoreInputs,
  computeFunctionScores,
} from '../src/utils/function-scores.js';
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

  it('escapes trailing backslashes so cells cannot break out of code spans', () => {
    const table = buildFunctionScoreTable(
      computeFunctionScores([
        { file: 'a.ts', name: 'trail\\', line: 1, churnLines: 5, hasTestGap: false },
      ]),
    );
    expect(table).toContain('trail\\\\');
  });

  it('normalizes non-finite churn/nesting to 0', () => {
    const [scored] = computeFunctionScores([
      {
        file: 'a.ts',
        name: 'f',
        line: 1,
        churnLines: Number.NaN,
        nestingDepth: Number.POSITIVE_INFINITY,
        hasTestGap: false,
      },
    ]);
    expect(scored.churnLines).toBe(0);
    expect(scored.nestingDepth).toBe(0);
    expect(scored.score).toBe(0);
  });

  it('orders equal scores deterministically by file then name', () => {
    const table = buildFunctionScoreTable([
      { file: 'b.ts', name: 'z', line: 1, churnLines: 5, hasTestGap: false },
      { file: 'a.ts', name: 'a', line: 1, churnLines: 5, hasTestGap: false },
    ]);
    expect(table.indexOf('a.ts')).toBeLessThan(table.indexOf('b.ts'));
  });

  it('falls back to line 1 for invalid line numbers', () => {
    const table = buildFunctionScoreTable(
      computeFunctionScores([
        { file: 'a.ts', name: 'f', line: Number.NaN, churnLines: 5, hasTestGap: false },
      ]),
    );
    expect(table).toContain('`a.ts:1`');
  });
});

describe('collectFunctionScoreInputs', () => {
  const patch = [
    '@@ -1,3 +1,6 @@ function risky() {',
    ' context',
    '+  if (x) {',
    '+    doThing();',
    '+  }',
    '@@ -10,2 +13,3 @@ function calm() {',
    '+  return 1;',
  ].join('\n');

  it('produces one row per hunk with churn and hunk context', () => {
    const inputs = collectFunctionScoreInputs([
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 0, patch },
    ]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      file: 'src/a.ts',
      name: 'function risky() {',
      line: 1,
      churnLines: 3,
    });
    expect(inputs[1]).toMatchObject({ line: 13, churnLines: 1 });
    expect(inputs[0].nestingDepth).toBeGreaterThan(0);
  });

  it('marks source files without test changes as a test gap', () => {
    const inputs = collectFunctionScoreInputs([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+x',
      },
    ]);
    expect(inputs[0].hasTestGap).toBe(true);
    const withTest = collectFunctionScoreInputs([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+x',
      },
      {
        path: 'src/a.test.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+y',
      },
    ]);
    expect(withTest[0].hasTestGap).toBe(false);
  });

  it('skips removed files and empty input', () => {
    expect(collectFunctionScoreInputs([])).toEqual([]);
    expect(collectFunctionScoreInputs(undefined)).toEqual([]);
    expect(
      collectFunctionScoreInputs([
        { path: 'old.ts', status: 'removed', additions: 0, deletions: 5 },
      ]),
    ).toEqual([]);
  });

  it('skips deletion-only hunks with zero added lines', () => {
    const inputs = collectFunctionScoreInputs([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 0,
        deletions: 2,
        patch: ['@@ -1,2 +1,0 @@ function gone() {', '-  old();', '-}'].join('\n'),
      },
    ]);
    expect(inputs).toEqual([]);
  });

  it('skips non-source files so docs-only PRs yield no table', () => {
    const inputs = collectFunctionScoreInputs([
      {
        path: 'docs/guide.md',
        status: 'modified',
        additions: 3,
        deletions: 0,
        patch: '@@ -1 +1,3 @@\n+line1\n+line2\n+line3',
      },
    ]);
    expect(inputs).toEqual([]);
  });

  it('recognizes underscore/dash test affixes as test files', () => {
    for (const testPath of ['pkg/foo_test.go', 'tests/test_foo.py', 'src/foo-test.ts']) {
      const inputs = collectFunctionScoreInputs([
        {
          path: 'src/a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: '@@ -1 +1 @@\n+x',
        },
        { path: testPath, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+y' },
      ]);
      expect(inputs[0].hasTestGap).toBe(false);
    }
    // A similarly-named source file must not count as a test change.
    const inputs = collectFunctionScoreInputs([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+x',
      },
      {
        path: 'src/contest.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+y',
      },
    ]);
    expect(inputs[0].hasTestGap).toBe(true);
  });
});

describe('buildFunctionScoreOptions', () => {
  it('returns undefined when the flag is off and options when on', () => {
    expect(buildFunctionScoreOptions(false, [])).toBeUndefined();
    expect(buildFunctionScoreOptions(undefined, [])).toBeUndefined();
    const options = buildFunctionScoreOptions(true, [
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+x',
      },
    ]);
    expect(options?.showFunctionScores).toBe(true);
    expect(options?.functionScores).toHaveLength(1);
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
