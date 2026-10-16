import { describe, expect, it } from 'vitest';
import { buildInlineComments } from '../../src/jsonl-parser.js';
import {
  MAX_SUGGESTION_LINES,
  buildCommittableSuggestion,
  isSuggestionEligible,
} from '../../src/review/suggestions.js';
import type { ReviewIssue, ReviewResult } from '../../src/types/index.js';
import { buildReviewBody } from '../../src/utils/review-body.js';

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    type: 'issue',
    severity: 'minor',
    file: 'src/a.ts',
    line: 10,
    message: 'Issue.',
    inline: true,
    ...overrides,
  };
}

function makeResult(issues: ReviewIssue[]): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '' },
    strengths: [],
    issues,
    stats: { total: issues.length, critical: 0, important: 0, minor: issues.length },
    rawLines: [],
    failedLines: 0,
  };
}

function codeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join('\n');
}

describe('isSuggestionEligible', () => {
  it('accepts a single-hunk fix under the line cap', () => {
    expect(
      isSuggestionEligible({
        suggestionCode: 'const x = 1;',
        line: 10,
        hunkCount: 1,
        enabled: true,
      }),
    ).toBe(true);
  });

  it('accepts exactly the maximum number of replacement lines', () => {
    expect(isSuggestionEligible({ suggestionCode: codeLines(MAX_SUGGESTION_LINES), line: 1 })).toBe(
      true,
    );
  });

  it('rejects fixes above the line cap', () => {
    expect(
      isSuggestionEligible({ suggestionCode: codeLines(MAX_SUGGESTION_LINES + 1), line: 1 }),
    ).toBe(false);
  });

  it('rejects multi-hunk fixes', () => {
    expect(isSuggestionEligible({ suggestionCode: 'const x = 1;', line: 3, hunkCount: 2 })).toBe(
      false,
    );
  });

  it('rejects when suggestions are disabled', () => {
    expect(isSuggestionEligible({ suggestionCode: 'const x = 1;', line: 3, enabled: false })).toBe(
      false,
    );
  });

  it('rejects an empty replacement', () => {
    expect(isSuggestionEligible({ suggestionCode: '   ', line: 3 })).toBe(false);
  });

  it('rejects a missing or invalid anchor line', () => {
    expect(isSuggestionEligible({ suggestionCode: 'const x = 1;' })).toBe(false);
    expect(isSuggestionEligible({ suggestionCode: 'const x = 1;', line: 0 })).toBe(false);
  });

  it('requires an exact anchor match when diff context is supplied', () => {
    expect(
      isSuggestionEligible({
        suggestionCode: 'const x = 1;',
        line: 10,
        file: 'src/a.ts',
        diffLines: new Set(['src/a.ts:9']),
      }),
    ).toBe(false);
    expect(
      isSuggestionEligible({
        suggestionCode: 'const x = 1;',
        line: 10,
        file: 'src/a.ts',
        diffLines: new Set(['src/a.ts:10']),
      }),
    ).toBe(true);
  });

  it('rejects a replacement range wider than the cap', () => {
    expect(
      isSuggestionEligible({
        suggestionCode: 'const x = 1;',
        line: 1,
        endLine: 1 + MAX_SUGGESTION_LINES,
      }),
    ).toBe(false);
  });
});

describe('buildCommittableSuggestion', () => {
  it('emits a suggestion fence with the exact replacement for an eligible fix', () => {
    const rendered = buildCommittableSuggestion({ suggestionCode: 'const x = 1;', line: 10 });
    expect(rendered.kind).toBe('suggestion');
    expect(rendered.eligible).toBe(true);
    expect(rendered.body).toBe('```suggestion\nconst x = 1;\n```');
  });

  it('falls back to a plain code fence for multi-hunk fixes', () => {
    const rendered = buildCommittableSuggestion({
      suggestionCode: 'const x = 1;',
      line: 10,
      hunkCount: 2,
    });
    expect(rendered.kind).toBe('code');
    expect(rendered.body).toContain('```\nconst x = 1;\n```');
    expect(rendered.body).not.toContain('```suggestion');
  });

  it('falls back to a plain code fence when disabled', () => {
    const rendered = buildCommittableSuggestion({
      suggestionCode: 'const x = 1;',
      line: 10,
      enabled: false,
    });
    expect(rendered.kind).toBe('code');
    expect(rendered.body).not.toContain('```suggestion');
  });

  it('falls back to a plain code fence above the line cap', () => {
    const rendered = buildCommittableSuggestion({
      suggestionCode: codeLines(MAX_SUGGESTION_LINES + 1),
      line: 1,
    });
    expect(rendered.kind).toBe('code');
    expect(rendered.body).not.toContain('```suggestion');
  });

  it('fails open to prose when the formatter throws', () => {
    const rendered = buildCommittableSuggestion(null as unknown as { suggestionCode: string });
    expect(rendered.kind).toBe('prose');
    expect(rendered.body).toBe('');
    expect(rendered.eligible).toBe(false);
  });
});

describe('buildInlineComments suggestion gating', () => {
  it('emits a suggestion fence for a safe single-hunk fix by default', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;', line: 10 })]);
    const [comment] = buildInlineComments(result, new Set(['src/a.ts:10']));
    expect(comment.body).toContain('```suggestion\nconst x = 1;\n```');
  });

  it('emits no suggestion block when enableSuggestions is false', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;', line: 10 })]);
    const [comment] = buildInlineComments(result, new Set(['src/a.ts:10']), {
      enableSuggestions: false,
    });
    expect(comment.body).not.toContain('```suggestion');
    expect(comment.body).toContain('```\nconst x = 1;\n```');
  });

  it('uses a plain fence for fixes above the line cap', () => {
    const result = makeResult([
      makeIssue({ suggestionCode: codeLines(MAX_SUGGESTION_LINES + 1), line: 10 }),
    ]);
    const [comment] = buildInlineComments(result, new Set(['src/a.ts:10']));
    expect(comment.body).not.toContain('```suggestion');
    expect(comment.body).toContain('```');
  });
});

describe('buildReviewBody suggestion gating', () => {
  it('renders a committable suggestion inside the details disclosure by default', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;', line: 10 })]);
    const body = buildReviewBody(result);
    expect(body).toContain('```suggestion');
    expect(body).toContain('const x = 1;');
  });

  it('omits the suggestion block when enableSuggestions is false', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;', line: 10 })]);
    const body = buildReviewBody(result, { enableSuggestions: false });
    expect(body).not.toContain('```suggestion');
    expect(body).toContain('const x = 1;');
  });
});
