import { describe, expect, it } from 'vitest';
import { buildInlineComments } from '../src/jsonl-parser.js';
import {
  buildCommittableSuggestion,
  isSuggestionEligible,
  resolveEnableSuggestions,
} from '../src/review/suggestions.js';
import type { ReviewResult } from '../src/types/index.js';
import { buildReviewBody } from '../src/utils/review-body.js';

function inlineBodyFor(
  issue: {
    suggestion?: string;
    suggestionCode?: string;
  },
  enableSuggestions?: boolean,
): string {
  const result: ReviewResult = {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
    strengths: [],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/a.ts',
        line: 1,
        message: 'msg',
        inline: true,
        ...issue,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
  };
  const comments = buildInlineComments(
    result,
    undefined,
    enableSuggestions === undefined ? undefined : { enableSuggestions },
  );
  return comments[0].body;
}

function summaryBodyFor(suggestionCode: string, enableSuggestions?: boolean): string {
  const result: ReviewResult = {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
    strengths: [],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/a.ts',
        line: 1,
        message: 'msg',
        suggestionCode,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
  };
  return buildReviewBody(
    result,
    enableSuggestions === undefined ? undefined : { enableSuggestions },
  );
}

describe('isSuggestionEligible', () => {
  it('accepts a short single-hunk replacement', () => {
    expect(isSuggestionEligible({ code: 'const x = 1;' })).toBe(true);
  });

  it('rejects replacements over 20 lines', () => {
    const code = Array.from({ length: 21 }, (_, i) => `const v${i} = ${i};`).join('\n');
    expect(isSuggestionEligible({ code })).toBe(false);
  });

  it('rejects multi-hunk input', () => {
    expect(isSuggestionEligible({ code: 'const x = 1;', hunkCount: 2 })).toBe(false);
    expect(isSuggestionEligible({ code: '@@ -1,2 +1,2 @@\n const x = 1;' })).toBe(false);
  });

  it('rejects non-contiguous ranges', () => {
    expect(isSuggestionEligible({ code: 'const x = 1;', startLine: 5, endLine: 3 })).toBe(false);
  });

  it('rejects empty input without throwing', () => {
    expect(isSuggestionEligible({})).toBe(false);
    expect(isSuggestionEligible({ code: '   ' })).toBe(false);
  });

  it('returns false when disabled', () => {
    expect(isSuggestionEligible({ code: 'const x = 1;', enabled: false })).toBe(false);
  });
});

describe('buildCommittableSuggestion', () => {
  it('emits a suggestion fence for an eligible fix', () => {
    const rendered = buildCommittableSuggestion({ code: 'const x = 1;' });
    expect(rendered.kind).toBe('suggestion');
    expect(rendered.body).toContain('```suggestion');
    expect(rendered.body).toContain('const x = 1;');
  });

  it('falls back to a plain fence for multi-hunk input', () => {
    const rendered = buildCommittableSuggestion({ code: 'const x = 1;', hunkCount: 3 });
    expect(rendered.kind).toBe('code');
    expect(rendered.body).not.toContain('```suggestion');
  });

  it('keeps diff-shaped input in a diff fence', () => {
    const rendered = buildCommittableSuggestion({ code: '+const x = 1;\n-const x = 0;' });
    expect(rendered.kind).toBe('code');
    expect(rendered.body).toContain('```diff');
  });

  it('falls back to prose for empty input', () => {
    expect(buildCommittableSuggestion({})).toEqual({ kind: 'prose', body: '' });
  });

  it('never pushes or commits: output is markdown only', () => {
    const rendered = buildCommittableSuggestion({ code: 'const x = 1;' });
    expect(rendered.body).not.toMatch(/exec|push|commit/i);
  });
});

describe('resolveEnableSuggestions', () => {
  it('defaults to enabled', () => {
    expect(resolveEnableSuggestions(undefined)).toBe(true);
  });

  it('honours explicit opt-out', () => {
    expect(resolveEnableSuggestions(false)).toBe(false);
    expect(resolveEnableSuggestions('false')).toBe(false);
  });
});

describe('committable suggestions acceptance criteria', () => {
  it('AC1: single-hunk fix under 20 lines renders a suggestion fence with the exact replacement', () => {
    const body = inlineBodyFor({ suggestionCode: 'const user = data?.user ?? null;' });
    expect(body).toContain('```suggestion');
    expect(body).toContain('const user = data?.user ?? null;');
  });

  it('AC2: multi-hunk fix renders a plain code fence, no suggestion block', () => {
    const code = '@@ -1,1 +1,1 @@\n-const x = 0;\n+const x = 1;';
    const body = inlineBodyFor({ suggestionCode: code });
    expect(body).not.toContain('```suggestion');
  });

  it('AC3: enableSuggestions false emits no suggestion blocks (inline and summary)', () => {
    const inline = inlineBodyFor({ suggestionCode: 'const x = 1;' }, false);
    expect(inline).not.toContain('```suggestion');
    expect(inline).toContain('const x = 1;');
    const summary = summaryBodyFor('const x = 1;', false);
    expect(summary).not.toContain('```suggestion');
    expect(summary).toContain('const x = 1;');
  });

  it('AC4: formatter error falls back to prose (no throw, exit 0 path)', () => {
    const throwing = {
      trim() {
        throw new Error('boom');
      },
    } as unknown as string;
    const rendered = buildCommittableSuggestion({ code: throwing });
    expect(rendered).toEqual({ kind: 'prose', body: '' });
    expect(isSuggestionEligible({ code: throwing })).toBe(false);
  });
});
