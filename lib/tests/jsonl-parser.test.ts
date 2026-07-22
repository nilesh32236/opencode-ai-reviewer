import * as path from 'path';
import {
  buildInlineComments,
  buildReviewBody,
  parseJsonlFile,
  parseJsonlString,
  stripMarkdownFences,
} from '../src/jsonl-parser.js';
import type { ReviewResult } from '../src/types/index.js';

describe('jsonl-parser', () => {
  describe('parseJsonlString', () => {
    it('parses a complete valid JSONL with all finding types', () => {
      const input = [
        JSON.stringify({ type: 'summary', text: 'Overall looks good.' }),
        JSON.stringify({ type: 'verdict', ready: true, reasoning: 'No issues found.' }),
        JSON.stringify({
          type: 'strength',
          file: 'src/foo.ts',
          line: 10,
          message: 'Good pattern.',
        }),
        JSON.stringify({
          type: 'issue',
          severity: 'critical',
          file: 'src/bar.ts',
          line: 42,
          message: 'Missing null check.',
          suggestion: 'Add if (!x) return;',
          inline: true,
        }),
        JSON.stringify({
          type: 'issue',
          severity: 'minor',
          file: 'src/baz.ts',
          line: 7,
          message: 'Unused import.',
        }),
      ].join('\n');

      const result = parseJsonlString(input);

      expect(result.summary).toContain('Overall looks good.');
      expect(result.verdict.ready).toBe(true);
      expect(result.strengths).toHaveLength(1);
      expect(result.strengths[0].message).toBe('Good pattern.');
      expect(result.issues).toHaveLength(2);
      expect(result.stats.critical).toBe(1);
      expect(result.stats.important).toBe(0);
      expect(result.stats.minor).toBe(1);
      expect(result.failedLines).toBe(0);
    });

    it('handles empty input', () => {
      const result = parseJsonlString('');
      expect(result.summary).toBe('');
      expect(result.verdict.ready).toBe(false);
      expect(result.strengths).toHaveLength(0);
      expect(result.issues).toHaveLength(0);
    });

    it('handles malformed lines gracefully', () => {
      const input = [
        JSON.stringify({ type: 'summary', text: 'Good.' }),
        'this is not json',
        JSON.stringify({ type: 'verdict', ready: false, reasoning: 'Issues.' }),
        '{broken json',
      ].join('\n');

      const result = parseJsonlString(input);
      expect(result.summary).not.toBe('');
      expect(result.verdict.ready).toBe(false);
      expect(result.failedLines).toBe(2);
    });

    it('handles blank lines', () => {
      const input = ['', '  ', JSON.stringify({ type: 'summary', text: 'Test.' }), ''].join('\n');

      const result = parseJsonlString(input);
      expect(result.summary).not.toBe('');
      expect(result.failedLines).toBe(0);
    });

    it('rejects invalid severity', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'blocker',
        file: 'f.ts',
        line: 1,
        message: 'bad',
      });

      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(1);
    });

    it('rejects issue without file', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        message: 'missing file',
      });

      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(1);
    });

    it('rejects issue with line <= 0', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        file: 'f.ts',
        line: 0,
        message: 'bad line',
      });

      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(1);
    });
  });

  describe('stripMarkdownFences', () => {
    it('removes ```jsonl fences', () => {
      const input = '```jsonl\n{"type":"summary","text":"Hello"}\n```';
      expect(stripMarkdownFences(input)).toBe('{"type":"summary","text":"Hello"}');
    });

    it('removes ```json fences', () => {
      const input = '```json\n{"type":"summary","text":"Hello"}\n```';
      expect(stripMarkdownFences(input)).toBe('{"type":"summary","text":"Hello"}');
    });

    it('removes fences without language specifier', () => {
      const input = '```\n{"type":"summary","text":"Hello"}\n```';
      expect(stripMarkdownFences(input)).toBe('{"type":"summary","text":"Hello"}');
    });

    it('handles content without fences', () => {
      const input = '{"type":"summary","text":"Hello"}';
      expect(stripMarkdownFences(input)).toBe('{"type":"summary","text":"Hello"}');
    });
  });

  describe('parseJsonlString with markdown fences', () => {
    it('parses JSONL wrapped in ```jsonl fences', () => {
      const input =
        '```jsonl\n{"type":"summary","text":"Good."}\n{"type":"verdict","ready":true,"reasoning":"OK"}\n```';
      const result = parseJsonlString(input);
      expect(result.summary).toBe('Good.');
      expect(result.verdict.ready).toBe(true);
      expect(result.failedLines).toBe(0);
    });

    it('parses JSONL wrapped in ``` fences', () => {
      const input =
        '```\n{"type":"summary","text":"Good."}\n{"type":"verdict","ready":true,"reasoning":"OK"}\n```';
      const result = parseJsonlString(input);
      expect(result.summary).toBe('Good.');
      expect(result.verdict.ready).toBe(true);
      expect(result.failedLines).toBe(0);
    });

    it('parses JSONL wrapped in ```json fences', () => {
      const input =
        '```json\n{"type":"summary","text":"Good."}\n{"type":"verdict","ready":true,"reasoning":"OK"}\n```';
      const result = parseJsonlString(input);
      expect(result.summary).toBe('Good.');
      expect(result.verdict.ready).toBe(true);
      expect(result.failedLines).toBe(0);
    });

    it('handles fences on same line as content', () => {
      const input = '```jsonl {"type":"summary","text":"Good."}';
      const result = parseJsonlString(input);
      expect(result.summary).toBe('Good.');
      expect(result.failedLines).toBe(0);
    });
  });

  describe('parseJsonlFile', () => {
    it('reads and parses a file', async () => {
      const fixturePath = path.join(__dirname, 'fixtures/sample-review-output.jsonl');
      const result = await parseJsonlFile(fixturePath);
      expect(result.summary).toContain('JWT authentication');
      expect(result.verdict.ready).toBe(false);
    });

    it('reads and parses a file wrapped in markdown fences', async () => {
      const fixturePath = path.join(__dirname, 'fixtures/sample-review-fenced.jsonl');
      const result = await parseJsonlFile(fixturePath);
      expect(result.summary).toContain('JWT authentication');
      expect(result.issues).toHaveLength(1);
      expect(result.failedLines).toBe(0);
    });

    it('returns empty result for non-existent file', async () => {
      const result = await parseJsonlFile('/nonexistent/path/file.jsonl');
      expect(result.summary).toBe('');
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('buildReviewBody', () => {
    it('builds a complete review body', () => {
      const result: ReviewResult = {
        summary: 'Good PR overall.',
        verdict: { ready: false, reasoning: 'One critical issue found.' },
        strengths: [{ type: 'strength', file: 'src/a.ts', line: 10, message: 'Clean function.' }],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/b.ts',
            line: 42,
            message: 'Missing auth check.',
            suggestion: 'Add requireAuth middleware.',
          },
        ],
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const body = buildReviewBody(result);

      expect(body).toContain('## AI Code Review Summary');
      expect(body).toContain('Good PR overall.');
      expect(body).toContain('**Ready to merge?** No');
      expect(body).toContain('One critical issue found.');
      expect(body).toContain('Clean function.');
      expect(body).toContain('CRITICAL');
      expect(body).toContain('Missing auth check.');
      expect(body).toContain('Add requireAuth middleware.');
    });

    it('handles empty result gracefully', () => {
      const emptyResult: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const body = buildReviewBody(emptyResult);
      expect(body).toContain('No summary provided');
      expect(body).toContain('No reasoning provided');
    });
  });

  describe('buildInlineComments', () => {
    it('only includes inline=true issues with valid lines', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'Bug here.',
            suggestion: 'Fix it.',
            inline: true,
          },
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/b.ts',
            line: 20,
            message: 'Style issue.',
            inline: false,
          },
          {
            type: 'issue',
            severity: 'important',
            file: 'src/c.ts',
            line: 30,
            message: 'No inline flag.',
          },
        ],
        stats: { total: 3, critical: 1, important: 1, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/a.ts');
      expect(comments[0].line).toBe(10);
      expect(comments[0].body).toContain('CRITICAL');
      expect(comments[0].body).toContain('Bug here.');
    });

    it('filters by diff lines when provided', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'In diff.',
            inline: true,
          },
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 999,
            message: 'Not in diff.',
            inline: true,
          },
        ],
        stats: { total: 2, critical: 2, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const diffLines = new Set(['src/a.ts:10', 'src/a.ts:11', 'src/a.ts:12']);
      const comments = buildInlineComments(result, diffLines);
      expect(comments).toHaveLength(1);
      expect(comments[0].line).toBe(10);
    });

    it('handles leading slash in file paths for diff matching', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'important',
            file: '/src/a.ts',
            line: 42,
            message: 'Leading slash.',
            inline: true,
          },
        ],
        stats: { total: 1, critical: 0, important: 1, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const diffLines = new Set(['src/a.ts:42']);
      const comments = buildInlineComments(result, diffLines);
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/a.ts');
    });

    it('includes suggestion as plain text when suggestion is a single line', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/a.ts',
            line: 5,
            message: 'Typo.',
            suggestion: 'Change "teh" to "the"',
            inline: true,
          },
        ],
        stats: { total: 1, critical: 0, important: 0, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain('Suggestion:');
      expect(comments[0].body).toContain('Change "teh" to "the"');
    });

    it('adds suggestion diff block when suggestion contains multiple lines', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'Missing null check.',
            suggestion: `-if (x) {
+if (x !== null) {`,
            inline: true,
          },
        ],
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain('```suggestion');
      expect(comments[0].body).toContain('-if (x) {');
      expect(comments[0].body).toContain('+if (x !== null) {');
      expect(comments[0].body).toContain('```');
    });

    it('returns empty array when no issues have inline=true', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/a.ts',
            line: 5,
            message: 'Nit.',
            inline: false,
          },
        ],
        stats: { total: 1, critical: 0, important: 0, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(0);
    });

    it('includes all inline issues when diff set is empty (no diff info available)', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'Not in empty diff.',
            inline: true,
          },
        ],
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result, new Set());
      expect(comments).toHaveLength(1);
    });

    it('includes all inline=true issues when diffLines is not provided', () => {
      const result: ReviewResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 1,
            message: 'Issue 1.',
            inline: true,
          },
          {
            type: 'issue',
            severity: 'important',
            file: 'src/b.ts',
            line: 2,
            message: 'Issue 2.',
            inline: true,
          },
        ],
        stats: { total: 2, critical: 1, important: 1, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result);
      expect(comments).toHaveLength(2);
    });
  });
});
