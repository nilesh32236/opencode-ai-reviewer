import { describe, expect, it } from 'vitest';
import { buildInlineCommentsWithSpillover } from '../src/jsonl-parser.js';
import type { ReviewIssue, ReviewResult, Severity } from '../src/types/index.js';
import {
  applyNoiseBudget,
  computeSpilloverSummary,
  filterFindings,
  formatSpilloverLine,
  mergeSpilloverSummaries,
  normalizeNoiseBudget,
} from '../src/utils/filter-findings.js';
import {
  formatNotificationSpilloverLine,
  formatSlackMessage,
  formatTeamsMessage,
  getNotificationSpillover,
} from '../src/utils/notifier.js';
import { buildReviewBody } from '../src/utils/review-body.js';

function issue(partial: Partial<ReviewIssue> & { severity: Severity }): ReviewIssue {
  return {
    type: 'issue',
    file: 'src/foo.ts',
    line: 1,
    message: 'Finding message',
    ...partial,
  };
}

function makeResult(issues: ReviewIssue[]): ReviewResult {
  const stats = { total: issues.length, critical: 0, important: 0, minor: 0 };
  for (const i of issues) {
    if (i.severity === 'critical') stats.critical++;
    else if (i.severity === 'important') stats.important++;
    else stats.minor++;
  }
  return {
    summary: 'Summary.',
    verdict: { ready: false, reasoning: 'Because.', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues,
    stats,
  };
}

const CONTEXT = { number: 42, title: 'PR title', repo: 'owner/repo' };

describe('filterFindings spillover accounting', () => {
  it('records severity-ordered spillover on the total cap without changing kept issues', () => {
    const issues = [
      issue({ severity: 'minor', file: 'a.ts' }),
      issue({ severity: 'critical', file: 'b.ts' }),
      issue({ severity: 'important', file: 'c.ts' }),
      issue({ severity: 'minor', file: 'd.ts' }),
    ];
    const result = filterFindings(issues, { maxTotalFindings: 2 });
    expect(result.issues.map((i) => i.severity)).toEqual(['critical', 'important']);
    expect(result.dropped).toBe(2);
    expect(result.suppressed?.map((i) => i.severity)).toEqual(['minor', 'minor']);
    expect(result.spillover).toEqual({ count: 2, critical: 0, important: 0, minor: 2 });
  });

  it('records per-category cap spillover', () => {
    const issues = [
      issue({ severity: 'critical', file: 'a.ts', category: 'security' }),
      issue({ severity: 'important', file: 'b.ts', category: 'security' }),
      issue({ severity: 'minor', file: 'c.ts', category: 'security' }),
    ];
    const result = filterFindings(issues, {
      categories: { security: { maxFindings: 1 } },
    });
    expect(result.issues).toHaveLength(1);
    expect(result.spillover).toEqual({ count: 2, critical: 0, important: 1, minor: 1 });
  });

  it('omits spillover fields when caps cut nothing', () => {
    const result = filterFindings([issue({ severity: 'critical' })], { maxTotalFindings: 5 });
    expect(result.suppressed).toBeUndefined();
    expect(result.spillover).toBeUndefined();
  });
});

describe('spillover helpers', () => {
  it('formats a severity-breakdown spillover line', () => {
    expect(formatSpilloverLine({ count: 4, critical: 1, important: 2, minor: 1 })).toContain(
      'and 4 more',
    );
    expect(formatSpilloverLine({ count: 4, critical: 1, important: 2, minor: 1 })).toContain(
      '1 critical',
    );
  });

  it('returns undefined for empty spillover', () => {
    expect(formatSpilloverLine(undefined)).toBeUndefined();
    expect(formatSpilloverLine({ count: 0, critical: 0, important: 0, minor: 0 })).toBeUndefined();
    expect(formatSpilloverLine([])).toBeUndefined();
  });

  it('merges summaries and skips empties', () => {
    expect(
      mergeSpilloverSummaries({ count: 2, critical: 1, important: 1, minor: 0 }, undefined, {
        count: 1,
        critical: 0,
        important: 0,
        minor: 1,
      }),
    ).toEqual({ count: 3, critical: 1, important: 1, minor: 1 });
    expect(mergeSpilloverSummaries(undefined, null)).toBeUndefined();
  });

  it('computes spillover summaries from hidden issues', () => {
    expect(
      computeSpilloverSummary([issue({ severity: 'critical' }), issue({ severity: 'minor' })]),
    ).toEqual({ count: 2, critical: 1, important: 0, minor: 1 });
  });

  it('normalizes budgets (unlimited for unset/non-positive)', () => {
    expect(normalizeNoiseBudget(undefined)).toBeUndefined();
    expect(normalizeNoiseBudget(0)).toBeUndefined();
    expect(normalizeNoiseBudget(-3)).toBeUndefined();
    expect(normalizeNoiseBudget(2.7)).toBe(2);
  });

  it('applyNoiseBudget keeps the most severe first with tail accounting', () => {
    const issues = [
      issue({ severity: 'minor', file: 'a.ts' }),
      issue({ severity: 'critical', file: 'b.ts' }),
      issue({ severity: 'important', file: 'c.ts' }),
    ];
    const { visible, suppressed, spillover } = applyNoiseBudget(issues, 2);
    expect(visible.map((i) => i.severity)).toEqual(['critical', 'important']);
    expect(suppressed.map((i) => i.severity)).toEqual(['minor']);
    expect(spillover).toEqual({ count: 1, critical: 0, important: 0, minor: 1 });
  });

  it('applyNoiseBudget is a pass-through copy when unlimited', () => {
    const issues = [issue({ severity: 'minor' })];
    const result = applyNoiseBudget(issues, undefined);
    expect(result.visible).toEqual(issues);
    expect(result.visible).not.toBe(issues);
    expect(result.spillover).toBeUndefined();
  });
});

describe('buildReviewBody noise budget', () => {
  const issues = [
    issue({ severity: 'minor', file: 'a.ts', line: 1, message: 'minor one' }),
    issue({ severity: 'critical', file: 'b.ts', line: 2, message: 'critical one' }),
    issue({ severity: 'important', file: 'c.ts', line: 3, message: 'important one' }),
    issue({ severity: 'minor', file: 'd.ts', line: 4, message: 'minor two' }),
  ];

  it('caps rendered issues severity-first with a spillover line', () => {
    const body = buildReviewBody(makeResult(issues), { maxVisibleFindings: 2 });
    expect(body).toContain('critical one');
    expect(body).toContain('important one');
    expect(body).not.toContain('minor one');
    expect(body).toContain('and 2 more');
  });

  it('supports the noiseBudget alias', () => {
    const body = buildReviewBody(makeResult(issues), { noiseBudget: 1 });
    expect(body).toContain('critical one');
    expect(body).toContain('and 3 more');
  });

  it('renders incoming filter spillover even without a display budget', () => {
    const result = makeResult([issue({ severity: 'critical', message: 'kept' })]);
    result.spillover = { count: 2, critical: 0, important: 1, minor: 1 };
    const body = buildReviewBody(result);
    expect(body).toContain('kept');
    expect(body).toContain('and 2 more');
  });

  it('renders unchanged output when no budget or spillover applies', () => {
    const body = buildReviewBody(makeResult(issues));
    expect(body).not.toContain('and ');
    for (const i of issues) expect(body).toContain(i.message);
  });
});

describe('buildInlineCommentsWithSpillover', () => {
  function inlineIssue(severity: Severity, file: string, line: number): ReviewIssue {
    return issue({ severity, file, line, inline: true, message: `${severity} at ${file}` });
  }

  it('caps posted comments severity-first with tail accounting', () => {
    const result = makeResult([
      inlineIssue('minor', 'a.ts', 1),
      inlineIssue('critical', 'b.ts', 2),
      inlineIssue('important', 'c.ts', 3),
    ]);
    const build = buildInlineCommentsWithSpillover(result, new Set(), false, false, 2);
    expect(build.comments).toHaveLength(2);
    expect(build.comments[0].path).toBe('b.ts');
    expect(build.suppressed.map((i) => i.file)).toEqual(['a.ts']);
    expect(build.spillover).toEqual({ count: 1, critical: 0, important: 0, minor: 1 });
  });

  it('is unlimited by default with no spillover', () => {
    const result = makeResult([inlineIssue('minor', 'a.ts', 1)]);
    const build = buildInlineCommentsWithSpillover(result);
    expect(build.comments).toHaveLength(1);
    expect(build.spillover).toBeUndefined();
  });
});

describe('notification spillover', () => {
  function notifiedResult(): ReviewResult {
    return makeResult([
      issue({ severity: 'critical', message: 'c1' }),
      issue({ severity: 'critical', message: 'c2' }),
      issue({ severity: 'important', message: 'i1' }),
      issue({ severity: 'important', message: 'i2' }),
      issue({ severity: 'minor', message: 'm1' }),
    ]);
  }

  it('accounts the tail beyond the listed top findings', () => {
    const spillover = getNotificationSpillover(notifiedResult(), 3);
    expect(spillover).toEqual({ count: 2, critical: 0, important: 1, minor: 1 });
    expect(getNotificationSpillover(notifiedResult(), 10)).toBeUndefined();
  });

  it('Slack message appends a "+N more" line when findings exceed the top 3', () => {
    const payload = formatSlackMessage(notifiedResult(), CONTEXT);
    const text = JSON.stringify(payload.blocks);
    expect(text).toContain('c1');
    expect(text).toContain('and 2 more');
    expect(
      formatNotificationSpilloverLine(getNotificationSpillover(notifiedResult(), 3)),
    ).toContain('more');
  });

  it('Slack message has no spillover line when everything fits', () => {
    const payload = formatSlackMessage(
      makeResult([issue({ severity: 'critical', message: 'only' })]),
      CONTEXT,
    );
    expect(JSON.stringify(payload.blocks)).not.toContain('more');
  });

  it('Teams message appends a "+N more" line when findings exceed the top 3', () => {
    const message = formatTeamsMessage(notifiedResult(), CONTEXT);
    expect(JSON.stringify(message)).toContain('and 2 more');
  });
});
