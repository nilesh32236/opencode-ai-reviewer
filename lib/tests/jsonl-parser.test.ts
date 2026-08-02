import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import {
  buildInlineComments,
  parseJsonlFile,
  parseJsonlString,
  stripMarkdownFences,
} from '../src/jsonl-parser.js';
import type { ReviewResult } from '../src/types/index.js';
import { parseReviewOutput } from '../src/types/schemas.js';
import { mulberry32, randomBytes } from './helpers/seeded-random.js';

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

    it('parses issue with confidence field', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        file: 'src/a.ts',
        line: 10,
        message: 'High confidence issue.',
        confidence: 'high',
      });
      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].confidence).toBe('high');
    });

    it('parses issue with medium confidence', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'important',
        file: 'src/b.ts',
        line: 20,
        message: 'Medium confidence issue.',
        confidence: 'medium',
      });
      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].confidence).toBe('medium');
    });

    it('parses issue with low confidence', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'minor',
        file: 'src/c.ts',
        line: 30,
        message: 'Low confidence issue.',
        confidence: 'low',
      });
      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].confidence).toBe('low');
    });

    it('parses issue without confidence as undefined', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        file: 'src/d.ts',
        line: 40,
        message: 'No confidence.',
      });
      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].confidence).toBeUndefined();
    });

    it('parses multiple issues with mixed confidence', () => {
      const input = [
        JSON.stringify({
          type: 'issue',
          severity: 'critical',
          file: 'a.ts',
          line: 1,
          message: 'High.',
          confidence: 'high',
        }),
        JSON.stringify({
          type: 'issue',
          severity: 'important',
          file: 'b.ts',
          line: 2,
          message: 'Medium.',
          confidence: 'medium',
        }),
        JSON.stringify({
          type: 'issue',
          severity: 'minor',
          file: 'c.ts',
          line: 3,
          message: 'Low.',
          confidence: 'low',
        }),
      ].join('\n');
      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(3);
      expect(result.issues[0].confidence).toBe('high');
      expect(result.issues[1].confidence).toBe('medium');
      expect(result.issues[2].confidence).toBe('low');
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

  describe('edge cases — malformed JSON', () => {
    it('counts truncated JSON as a failed line', () => {
      const result = parseJsonlString('{"type":"summary","text":"Truncated');
      expect(result.failedLines).toBe(1);
      expect(result.summary).toBe('');
    });

    it('counts JSON with a trailing comma as a failed line', () => {
      const input = [
        '{"type":"summary","text":"Good.",}',
        '{"type":"verdict","ready":true,"reasoning":"OK"}',
      ].join('\n');
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(1);
      expect(result.verdict.ready).toBe(true);
    });

    it('counts unquoted string keys as a failed line', () => {
      const result = parseJsonlString('{type:"summary",text:"Good."}');
      expect(result.failedLines).toBe(1);
      expect(result.summary).toBe('');
    });

    it('counts single-quoted JSON as a failed line', () => {
      const result = parseJsonlString("{'type':'summary','text':'Good.'}");
      expect(result.failedLines).toBe(1);
    });

    it('counts undefined literal values as a failed line', () => {
      const result = parseJsonlString('{"type":"summary","text":undefined}');
      expect(result.failedLines).toBe(1);
    });

    it('counts NaN numeric values as a failed line', () => {
      const input =
        '{"type":"issue","severity":"critical","file":"a.ts","line":NaN,"message":"bad"}';
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(1);
      expect(result.issues).toHaveLength(0);
    });

    it('counts trailing garbage after valid JSON as a failed line', () => {
      const result = parseJsonlString('{"type":"summary","text":"Good."} trailing garbage');
      expect(result.failedLines).toBe(1);
      expect(result.summary).toBe('');
    });
  });

  describe('edge cases — missing/extra fields', () => {
    it('rejects a summary with empty text', () => {
      const result = parseJsonlString('{"type":"summary","text":""}');
      expect(result.failedLines).toBe(1);
      expect(result.summary).toBe('');
    });

    it('rejects a summary with missing text', () => {
      const result = parseJsonlString('{"type":"summary"}');
      expect(result.failedLines).toBe(1);
    });

    it('rejects a verdict with a non-boolean ready field', () => {
      const result = parseJsonlString('{"type":"verdict","ready":"yes","reasoning":"reason"}');
      expect(result.failedLines).toBe(1);
      expect(result.verdict.ready).toBe(false);
    });

    it('rejects a strength with a missing message', () => {
      const result = parseJsonlString('{"type":"strength","file":"a.ts"}');
      expect(result.failedLines).toBe(1);
      expect(result.strengths).toHaveLength(0);
    });

    it('rejects an issue with a missing severity', () => {
      const result = parseJsonlString('{"type":"issue","file":"a.ts","line":1,"message":"x"}');
      expect(result.failedLines).toBe(1);
    });

    it('rejects an issue with a missing line', () => {
      const result = parseJsonlString(
        '{"type":"issue","severity":"minor","file":"a.ts","message":"x"}',
      );
      expect(result.failedLines).toBe(1);
    });

    it('rejects an issue with a negative line', () => {
      const result = parseJsonlString(
        '{"type":"issue","severity":"minor","file":"a.ts","line":-1,"message":"x"}',
      );
      expect(result.failedLines).toBe(1);
      expect(result.issues).toHaveLength(0);
    });

    it('accepts entries with extra unknown fields', () => {
      const input = [
        '{"type":"summary","text":"Good.","extra":"field","nested":{"a":1}}',
        '{"type":"issue","severity":"minor","file":"a.ts","line":1,"message":"x","unknown":true}',
      ].join('\n');
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(0);
      expect(result.issues).toHaveLength(1);
      expect(result.summary).toBe('Good.');
    });

    it('routes executive_summary entries to executiveSummary', () => {
      const input = JSON.stringify({
        type: 'executive_summary',
        purpose: 'Adds auth middleware',
        riskLevel: 'high',
        riskRationale: 'Public endpoint without rate limiting',
        breakingChanges: ['DB migration', 'Env var required'],
      });
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(0);
      expect(result.executiveSummary?.purpose).toBe('Adds auth middleware');
      expect(result.executiveSummary?.riskLevel).toBe('high');
      expect(result.executiveSummary?.breakingChanges).toEqual([
        'DB migration',
        'Env var required',
      ]);
    });

    it('defaults malformed executive_summary fields', () => {
      const input =
        '{"type":"executive_summary","purpose":5,"riskLevel":"urgent","breakingChanges":[1,"ok"]}';
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(0);
      expect(result.executiveSummary?.purpose).toBe('');
      expect(result.executiveSummary?.riskLevel).toBe('low');
      expect(result.executiveSummary?.breakingChanges).toEqual(['ok']);
    });
  });

  describe('edge cases — unicode, emoji, encoding', () => {
    it('preserves CJK characters', () => {
      const result = parseJsonlString('{"type":"summary","text":"审查通过，整体代码质量良好。"}');
      expect(result.summary).toContain('审查通过');
    });

    it('preserves Arabic characters', () => {
      const result = parseJsonlString('{"type":"summary","text":"التعليمات البرمجية واضحة"}');
      expect(result.summary).toBe('التعليمات البرمجية واضحة');
    });

    it('preserves Cyrillic characters', () => {
      const result = parseJsonlString('{"type":"strength","message":"Отличная обработка ошибок"}');
      expect(result.strengths[0].message).toBe('Отличная обработка ошибок');
    });

    it('preserves emoji in messages and suggestions', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'minor',
        file: 'a.ts',
        line: 1,
        message: 'Fix 🐛 please',
        suggestion: 'Use ⚡️ here',
      });
      const result = parseJsonlString(input);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toBe('Fix 🐛 please');
      expect(result.issues[0].suggestion).toBe('Use ⚡️ here');
    });

    it('preserves zero-width joiners in emoji sequences', () => {
      const result = parseJsonlString(
        '{"type":"summary","text":"Family 👨\u200d👩\u200d👧\u200d👦"}',
      );
      expect(result.summary).toBe('Family 👨\u200d👩\u200d👧\u200d👦');
    });

    it('skips lines containing only unicode whitespace', () => {
      const input = ['\u00a0', '\u2003\u3000', '{"type":"summary","text":"Real."}'].join('\n');
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(0);
      expect(result.summary).toBe('Real.');
    });

    it('treats a zero-width-space-only line as a failed line', () => {
      const input = ['\u200b', '{"type":"summary","text":"Real."}'].join('\n');
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(1);
      expect(result.summary).toBe('Real.');
    });

    it('strips a BOM prefix at the very start of the string', () => {
      const input = '\uFEFF{"type":"summary","text":"BOM at start."}';
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(0);
      expect(result.summary).toBe('BOM at start.');
    });

    it('accepts a BOM prefix on a mid-content line', () => {
      const input = [
        '{"type":"summary","text":"First."}',
        '\uFEFF{"type":"verdict","ready":true,"reasoning":"BOM on this line"}',
        '{"type":"strength","message":"Last line survives."}',
      ].join('\n');
      const result = parseJsonlString(input);
      expect(result.failedLines).toBe(0);
      expect(result.summary).toBe('First.');
      expect(result.verdict.ready).toBe(true);
      expect(result.strengths).toHaveLength(1);
    });
  });

  describe('edge cases — large input', () => {
    it('parses a single line larger than 100KB', () => {
      const longMessage = 'x'.repeat(100 * 1024);
      const line = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        file: 'big.ts',
        line: 1,
        message: longMessage,
      });
      expect(line.length).toBeGreaterThan(100 * 1024);
      const result = parseJsonlString(line);
      expect(result.failedLines).toBe(0);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message.length).toBe(longMessage.length);
    });

    it('parses a file with more than 1000 valid lines', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonl-test-'));
      const filePath = path.join(tmpDir, 'large.jsonl');
      const lines = Array.from({ length: 1200 }, (_, i) =>
        JSON.stringify({
          type: 'issue',
          severity: i % 3 === 0 ? 'critical' : 'minor',
          file: `src/file-${i % 10}.ts`,
          line: (i % 100) + 1,
          message: `Issue number ${i}`,
        }),
      );
      fs.writeFileSync(filePath, lines.join('\n'));
      try {
        const result = await parseJsonlFile(filePath);
        expect(result.failedLines).toBe(0);
        expect(result.issues).toHaveLength(1200);
        expect(result.stats.total).toBe(1200);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('parses a file with more than 1000 lines where some are invalid', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonl-test-'));
      const filePath = path.join(tmpDir, 'mixed.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 1200; i++) {
        if (i % 50 === 0) {
          lines.push('{not valid json');
        } else {
          lines.push(
            JSON.stringify({
              type: 'issue',
              severity: 'minor',
              file: 'a.ts',
              line: 1,
              message: `Issue ${i}`,
            }),
          );
        }
      }
      fs.writeFileSync(filePath, lines.join('\n'));
      try {
        const result = await parseJsonlFile(filePath);
        expect(result.issues).toHaveLength(1176);
        expect(result.failedLines).toBe(24);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases — parseJsonlFile', () => {
    it('returns an empty result for an empty file', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonl-test-'));
      const filePath = path.join(tmpDir, 'empty.jsonl');
      fs.writeFileSync(filePath, '');
      try {
        const result = await parseJsonlFile(filePath);
        expect(result.summary).toBe('');
        expect(result.issues).toHaveLength(0);
        expect(result.failedLines).toBe(0);
        expect(result.stats.total).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns an empty result for a whitespace-only file', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonl-test-'));
      const filePath = path.join(tmpDir, 'whitespace.jsonl');
      fs.writeFileSync(filePath, '\n\n   \n\t\n');
      try {
        const result = await parseJsonlFile(filePath);
        expect(result.failedLines).toBe(0);
        expect(result.summary).toBe('');
        expect(result.issues).toHaveLength(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns an empty result for a file with only BOM and whitespace', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonl-test-'));
      const filePath = path.join(tmpDir, 'bom-only.jsonl');
      fs.writeFileSync(filePath, '\uFEFF\n');
      try {
        const result = await parseJsonlFile(filePath);
        expect(result.failedLines).toBe(0);
        expect(result.summary).toBe('');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('parses a BOM-prefixed fixture file', async () => {
      const fixturePath = path.join(__dirname, 'fixtures/bom-prefixed.jsonl');
      const result = await parseJsonlFile(fixturePath);
      expect(result.failedLines).toBe(0);
      expect(result.summary).toBe('BOM prefixed summary.');
      expect(result.verdict.ready).toBe(true);
    });

    it('parses a unicode fixture file', async () => {
      const fixturePath = path.join(__dirname, 'fixtures/unicode-sample.jsonl');
      const result = await parseJsonlFile(fixturePath);
      expect(result.failedLines).toBe(0);
      expect(result.summary).toContain('审查通过');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toContain('👨\u200d👩\u200d👧\u200d👦');
    });

    it('returns an empty result for a file with only invalid lines', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jsonl-test-'));
      const filePath = path.join(tmpDir, 'invalid.jsonl');
      fs.writeFileSync(filePath, ['not json', '{broken', 'still not json'].join('\n'));
      try {
        const result = await parseJsonlFile(filePath);
        expect(result.failedLines).toBe(3);
        expect(result.summary).toBe('');
        expect(result.issues).toHaveLength(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns an empty result for a non-existent file (portable path)', async () => {
      const fixturePath = path.join(__dirname, 'fixtures/does-not-exist.jsonl');
      const result = await parseJsonlFile(fixturePath);
      expect(result.summary).toBe('');
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(0);
    });
  });

  describe('property-based schema validation', () => {
    const PROPERTY_SEED = 0xc0ffee;

    const validEntryArb = fc.oneof(
      fc.record({
        type: fc.constant('summary'),
        text: fc.string({ minLength: 10, maxLength: 500 }),
      }),
      fc.record({
        type: fc.constant('verdict'),
        ready: fc.boolean(),
        reasoning: fc.string({ minLength: 10, maxLength: 500 }),
        autoFixable: fc.boolean(),
        confidence: fc.constantFrom('high', 'medium', 'low'),
      }),
      fc.record({
        type: fc.constant('strength'),
        file: fc.string({ minLength: 1, maxLength: 200 }),
        line: fc.integer({ min: 1, max: 100000 }),
        message: fc.string({ minLength: 10, maxLength: 500 }),
      }),
      fc.record({
        type: fc.constant('issue'),
        severity: fc.constantFrom('critical', 'important', 'minor'),
        file: fc.string({ minLength: 1, maxLength: 200 }),
        line: fc.integer({ min: 1, max: 100000 }),
        message: fc.string({ minLength: 10, maxLength: 500 }),
      }),
    );

    it('parses every generated valid entry without failed lines', () => {
      fc.assert(
        fc.property(fc.array(validEntryArb, { minLength: 1, maxLength: 50 }), (entries) => {
          const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
          const result = parseJsonlString(jsonl);
          expect(result.failedLines).toBe(0);
          const expectedIssues = entries.filter((e) => e.type === 'issue').length;
          const expectedStrengths = entries.filter((e) => e.type === 'strength').length;
          expect(result.issues).toHaveLength(expectedIssues);
          expect(result.strengths).toHaveLength(expectedStrengths);
        }),
        { seed: PROPERTY_SEED, numRuns: 100 },
      );
    });

    it('preserves schema invariants on generated issue entries', () => {
      fc.assert(
        fc.property(fc.array(validEntryArb, { minLength: 1, maxLength: 50 }), (entries) => {
          const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
          const result = parseJsonlString(jsonl);
          for (const issue of result.issues) {
            expect(['critical', 'important', 'minor']).toContain(issue.severity);
            expect(issue.line).toBeGreaterThanOrEqual(1);
            expect(issue.file.length).toBeGreaterThan(0);
          }
        }),
        { seed: PROPERTY_SEED, numRuns: 100 },
      );
    });

    it('manual parser and Zod parser agree on valid entries', () => {
      fc.assert(
        fc.property(fc.array(validEntryArb, { minLength: 1, maxLength: 40 }), (entries) => {
          const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
          const manual = parseJsonlString(jsonl);
          const zod = parseReviewOutput(jsonl);
          expect(zod.invalid).toHaveLength(0);
          expect(manual.issues).toHaveLength(zod.issues.length);
          expect(manual.strengths).toHaveLength(zod.strengths.length);
        }),
        { seed: PROPERTY_SEED, numRuns: 50 },
      );
    });

    it('documents the strictness gap on boundary inputs', () => {
      // validEntryArb only samples the overlap region both parsers accept, so the
      // strictness gap is never exercised by the property oracle above. These
      // explicit assertions lock down the intentional asymmetry: the manual parser
      // accepts shorter text that the Zod parseReviewOutput rejects.
      const boundaryCases = [
        '{"type":"summary","text":"short"}',
        '{"type":"verdict","ready":true}',
        '{"type":"strength","message":"four"}',
        '{"type":"issue","severity":"minor","file":"a.ts","line":1,"message":"abc"}',
      ];

      for (const line of boundaryCases) {
        expect(parseJsonlString(line).failedLines).toBe(0);
        const zod = parseReviewOutput(line);
        expect(zod.valid).toHaveLength(0);
        expect(zod.invalid).toHaveLength(1);
      }
    });
  });

  describe('fuzz testing', () => {
    const FUZZ_SEED = 42;

    it('never throws on random byte sequences', () => {
      const rand = mulberry32(FUZZ_SEED);
      for (let i = 0; i < 200; i++) {
        const input = randomBytes(rand, Math.floor(rand() * 4096));
        expect(() => parseJsonlString(input)).not.toThrow();
        expect(() => parseReviewOutput(input)).not.toThrow();
      }
    });

    it('never throws on random truncations of valid JSONL', () => {
      const validJsonl = [
        JSON.stringify({ type: 'summary', text: 'A reasonable summary.' }),
        JSON.stringify({ type: 'verdict', ready: true, reasoning: 'Everything looks fine.' }),
        JSON.stringify({
          type: 'issue',
          severity: 'critical',
          file: 'a.ts',
          line: 42,
          message: 'Null dereference.',
        }),
        JSON.stringify({
          type: 'strength',
          file: 'b.ts',
          line: 7,
          message: 'Clean error handling.',
        }),
      ].join('\n');

      const result = parseJsonlString(validJsonl);
      expect(result.failedLines).toBe(0);

      const rand = mulberry32(FUZZ_SEED + 1);
      for (let i = 0; i < 200; i++) {
        const cut = Math.floor(rand() * validJsonl.length);
        const truncated = validJsonl.slice(0, cut);
        expect(() => parseJsonlString(truncated)).not.toThrow();
        expect(() => parseReviewOutput(truncated)).not.toThrow();
      }
    });

    it('never throws on binary garbage interleaved with valid lines', () => {
      const validLine = JSON.stringify({
        type: 'issue',
        severity: 'minor',
        file: 'a.ts',
        line: 1,
        message: 'Some finding.',
      });
      const rand = mulberry32(FUZZ_SEED + 2);
      for (let i = 0; i < 100; i++) {
        const parts: string[] = [];
        const count = 1 + Math.floor(rand() * 10);
        for (let j = 0; j < count; j++) {
          parts.push(validLine);
          parts.push(randomBytes(rand, Math.floor(rand() * 256)));
        }
        const input = parts.join('\n');
        expect(() => parseJsonlString(input)).not.toThrow();
        expect(() => parseReviewOutput(input)).not.toThrow();
      }
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
      expect(comments[0].body).toContain('How to fix:');
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
      expect(comments[0].body).toContain('```diff');
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

    it('suppresses low-confidence inline comments when suppressLowConfidence is true', () => {
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
            message: 'High confidence.',
            confidence: 'high',
            inline: true,
          },
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/b.ts',
            line: 20,
            message: 'Low confidence.',
            confidence: 'low',
            inline: true,
          },
        ],
        stats: { total: 2, critical: 1, important: 0, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };

      const comments = buildInlineComments(result, undefined, true);
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/a.ts');
      expect(comments[0].line).toBe(10);
    });
  });
});
