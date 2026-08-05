import { describe, expect, it } from 'vitest';
import { buildInlineComments } from '../src/jsonl-parser.js';
import type { ReviewResult } from '../src/types/index.js';

function commentBodyFor(suggestion: string): string {
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
        suggestion,
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
  };
  const comments = buildInlineComments(result);
  return comments[0].body;
}

function rendersAsCodeBlock(suggestion: string): boolean {
  return commentBodyFor(suggestion).includes('```suggestion');
}

describe('looksLikeCode heuristic', () => {
  it('returns false for a single weak paren match with no strong keyword', () => {
    expect(rendersAsCodeBlock('Add error handling (try/catch)')).toBe(false);
  });

  it('returns false for weak-only matches with no strong keyword', () => {
    expect(rendersAsCodeBlock('Refactor: (a) add logging (b) update tests')).toBe(false);
  });

  it('returns false for a single paren match with no strong keyword', () => {
    expect(rendersAsCodeBlock('Use the new fetch() API')).toBe(false);
  });

  it('returns true for a strong keyword match alone', () => {
    expect(rendersAsCodeBlock('const x = 1;')).toBe(true);
  });

  it('returns true for multiple matches (keyword + braces + parens + semicolon)', () => {
    expect(rendersAsCodeBlock('function foo() { return 1; }')).toBe(true);
  });

  it('returns true for import with braces, parens and semicolon', () => {
    expect(rendersAsCodeBlock("import { foo } from './bar.js';")).toBe(true);
  });

  it('returns true for an export declaration', () => {
    expect(rendersAsCodeBlock('export function calculate(): number { return 42; }')).toBe(true);
  });

  it('returns false for plain natural-language text', () => {
    expect(rendersAsCodeBlock('Just a normal English sentence with no code at all.')).toBe(false);
  });
});
