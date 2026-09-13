import { describe, expect, it } from 'vitest';
import { buildInlineComments } from '../../src/jsonl-parser.js';
import type { ReviewIssue, ReviewResult } from '../../src/types/index.js';
import { looksLikeCode } from '../../src/utils/code-heuristic.js';
import {
  buildFixPayload,
  buildFixWithAiPrompt,
  formatFixPayloadMarkdown,
  isCodeLikeSuggestion,
} from '../../src/utils/fix-payload.js';

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    type: 'issue',
    severity: 'minor',
    file: 'src/a.ts',
    line: 10,
    message: 'Avoid magic numbers',
    inline: true,
    ...overrides,
  };
}

function makeResult(issues: ReviewIssue[]): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
    strengths: [],
    issues,
    stats: { total: issues.length, critical: 0, important: 0, minor: issues.length },
    rawLines: [],
    failedLines: 0,
  };
}

describe('buildFixPayload', () => {
  it('prefers suggestionCode over suggestion text', () => {
    const payload = buildFixPayload(
      makeIssue({ suggestionCode: 'const x = 1;', suggestion: 'Consider naming it' }),
    );
    expect(payload.suggestedChange).toBe('const x = 1;');
    expect(payload.files).toEqual(['src/a.ts']);
    expect(payload.prompt).toContain('src/a.ts:10');
  });

  it('falls back to code-like suggestion text', () => {
    const payload = buildFixPayload(makeIssue({ suggestion: 'const x = 1;' }));
    expect(payload.suggestedChange).toBe('const x = 1;');
  });

  it('omits the suggestion block for prose-only suggestions', () => {
    const payload = buildFixPayload(
      makeIssue({ suggestion: 'Consider renaming this for clarity' }),
    );
    expect(payload.suggestedChange).toBeUndefined();
    expect(payload.prompt.trim().length).toBeGreaterThan(0);
  });

  it('is fail-open on malformed input', () => {
    const payload = buildFixPayload(undefined as unknown as ReviewIssue);
    expect(payload.prompt.trim().length).toBeGreaterThan(0);
    expect(payload.suggestedChange).toBeUndefined();
  });

  it('buildFixWithAiPrompt is template-only and never throws without config', () => {
    expect(buildFixWithAiPrompt(makeIssue())).toContain('Keep the change minimal');
  });
});

describe('formatFixPayloadMarkdown', () => {
  it('neutralizes inner triple-backtick fence breakout', () => {
    const rendered = formatFixPayloadMarkdown({
      prompt: 'Fix it',
      suggestedChange: 'const a = 1;\n```\nevil\n```\nconst b = 2;',
      files: ['src/a.ts'],
    });
    // Only the outer open/close fences may remain as full ``` sequences.
    expect(rendered.match(/```/g)?.length).toBeLessThanOrEqual(3);
    expect(rendered).not.toContain('```\nevil');
    expect(rendered).toContain('Fix with AI');
  });

  it('renders prompt-only payload without a suggestion block', () => {
    const rendered = formatFixPayloadMarkdown({ prompt: 'Fix it', files: ['src/a.ts'] });
    expect(rendered).not.toContain('```suggestion');
    expect(rendered).toContain('Fix with AI');
  });

  it('is fail-open, returning empty string on unrenderable payload', () => {
    expect(formatFixPayloadMarkdown(null as unknown as { prompt: string; files: string[] })).toBe(
      '',
    );
  });
});

describe('shared code heuristic', () => {
  it('isCodeLikeSuggestion delegates to the shared looksLikeCode helper', () => {
    expect(isCodeLikeSuggestion('const x = 1;')).toBe(true);
    expect(isCodeLikeSuggestion('Consider renaming this for clarity')).toBe(false);
    expect(isCodeLikeSuggestion('const x = 1;')).toBe(looksLikeCode('const x = 1;'));
  });
});

describe('buildInlineComments emitFixPayload dedup', () => {
  it('emits a single suggestion block when legacy body already rendered one', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;' })]);
    const [comment] = buildInlineComments(result, undefined, false, true);
    expect(comment.body.match(/```suggestion/g)?.length).toBe(1);
    expect(comment.body).toContain('Fix with AI');
  });

  it('supports the options-object overload without misordering booleans', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;' })]);
    const [comment] = buildInlineComments(result, undefined, { emitFixPayload: true });
    expect(comment.body).toContain('Fix with AI');
    expect(comment.body.match(/```suggestion/g)?.length).toBe(1);
  });

  it('leaves legacy output byte-for-byte unchanged by default', () => {
    const result = makeResult([makeIssue({ suggestionCode: 'const x = 1;' })]);
    const [plain] = buildInlineComments(result);
    const [optOut] = buildInlineComments(result, undefined, false, false);
    expect(optOut.body).toBe(plain.body);
    expect(plain.body).not.toContain('Fix with AI');
  });
});
