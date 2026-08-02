import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentConfigSchema,
  ReviewBudgetConfigSchema,
  parseReviewOutput,
} from '../src/types/schemas.js';
import { mulberry32, randomBytes } from './helpers/seeded-random.js';

describe('parseReviewOutput', () => {
  it('parses valid JSONL with all entry types', () => {
    const jsonl = `{"type":"summary","text":"Good PR overall."}
{"type":"verdict","ready":true,"reasoning":"No issues found."}
{"type":"strength","file":"src/foo.ts","line":10,"message":"Clean code."}
{"type":"issue","severity":"minor","file":"src/foo.ts","line":20,"message":"Use const.","suggestion":"Replace let with const.","inline":true}`;

    const result = parseReviewOutput(jsonl);

    expect(result.valid.length).toBe(4);
    expect(result.invalid.length).toBe(0);
    expect(result.summary).toBe('Good PR overall.');
    expect(result.verdict?.ready).toBe(true);
    expect(result.strengths.length).toBe(1);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].severity).toBe('minor');
  });

  it('handles invalid lines gracefully', () => {
    const jsonl = `{"type":"summary","text":"Valid summary."}
{invalid json}
{"type":"verdict","ready":false,"reasoning":"Has issues."}`;

    const result = parseReviewOutput(jsonl);

    expect(result.valid.length).toBe(2);
    expect(result.invalid.length).toBe(1);
    expect(result.invalid[0].line).toBe(2);
    expect(result.summary).toBe('Valid summary.');
  });

  it('handles empty content', () => {
    const result = parseReviewOutput('');

    expect(result.valid.length).toBe(0);
    expect(result.invalid.length).toBe(0);
    expect(result.summary).toBeUndefined();
    expect(result.verdict).toBeUndefined();
  });

  it('parses strength without file or line', () => {
    const jsonl = `{"type":"strength","message":"Great overall structure."}`;
    const result = parseReviewOutput(jsonl);
    expect(result.valid.length).toBe(1);
    expect(result.invalid.length).toBe(0);
    expect(result.strengths[0].message).toBe('Great overall structure.');
    expect(result.strengths[0].file).toBeUndefined();
    expect(result.strengths[0].line).toBeUndefined();
  });

  it('parses sample fixture file correctly', () => {
    const fixturePath = path.join(__dirname, 'fixtures/sample-review-output.jsonl');
    const content = fs.readFileSync(fixturePath, 'utf-8');

    const result = parseReviewOutput(content);

    expect(result.summary).toContain('JWT authentication');
    expect(result.verdict?.ready).toBe(false);
    expect(result.strengths.length).toBe(2);
    expect(result.issues.length).toBe(3);

    const critical = result.issues.filter((i) => i.severity === 'critical');
    const important = result.issues.filter((i) => i.severity === 'important');
    const minor = result.issues.filter((i) => i.severity === 'minor');
    expect(critical.length).toBe(1);
    expect(important.length).toBe(1);
    expect(minor.length).toBe(1);
  });
});

describe('parseReviewOutput edge cases', () => {
  it('counts each type of malformed JSON as invalid', () => {
    const jsonl = [
      '{"type":"summary","text":"Truncated',
      '{type:"summary",text:"Unquoted"}',
      "{'type':'summary','text':'Single quoted'}",
      '{"type":"summary","text":"Good.",}',
      '{"type":"summary","text":"Good."} trailing',
    ].join('\n');

    const result = parseReviewOutput(jsonl);

    expect(result.valid.length).toBe(0);
    expect(result.invalid.length).toBe(5);
  });

  it('rejects entries with missing required fields', () => {
    const jsonl = [
      '{"type":"summary","text":"short"}',
      '{"type":"verdict","ready":true}',
      '{"type":"strength"}',
      '{"type":"issue","severity":"minor","file":"a.ts","line":0,"message":"nope"}',
    ].join('\n');

    const result = parseReviewOutput(jsonl);

    expect(result.invalid.length).toBe(4);
    expect(result.valid.length).toBe(0);
  });

  it('preserves unicode content', () => {
    const jsonl = '{"type":"summary","text":"审查通过，整体代码质量良好。"}';
    const result = parseReviewOutput(jsonl);
    expect(result.summary).toBe('审查通过，整体代码质量良好。');
  });

  it('handles a BOM prefix on the first line', () => {
    const jsonl = '\uFEFF{"type":"summary","text":"BOM handled by parser."}';
    const result = parseReviewOutput(jsonl);
    expect(result.invalid.length).toBe(0);
    expect(result.summary).toBe('BOM handled by parser.');
  });

  it('handles a BOM prefix on a later line', () => {
    const jsonl = [
      '{"type":"summary","text":"First line works."}',
      '\uFEFF{"type":"verdict","ready":true,"reasoning":"Verdict after BOM."}',
    ].join('\n');
    const result = parseReviewOutput(jsonl);
    expect(result.valid.length).toBe(2);
    expect(result.verdict?.ready).toBe(true);
  });

  it('tolerates extra unknown fields (Zod strips unknown keys)', () => {
    const jsonl =
      '{"type":"issue","severity":"minor","file":"a.ts","line":1,"message":"Real issue here.","extra":"x","nested":{"a":1}}';
    const result = parseReviewOutput(jsonl);
    expect(result.invalid.length).toBe(0);
    expect(result.issues).toHaveLength(1);
  });

  it('accepts executive_summary entries and routes them to executiveSummary', () => {
    const jsonl =
      '{"type":"executive_summary","purpose":"Adds auth middleware","riskLevel":"high","riskRationale":"Public endpoint without rate limiting","breakingChanges":["DB migration"]}';
    const result = parseReviewOutput(jsonl);
    expect(result.valid.length).toBe(1);
    expect(result.invalid.length).toBe(0);
    expect(result.executiveSummary?.purpose).toBe('Adds auth middleware');
    expect(result.executiveSummary?.riskLevel).toBe('high');
    expect(result.executiveSummary?.riskRationale).toBe('Public endpoint without rate limiting');
    expect(result.executiveSummary?.breakingChanges).toEqual(['DB migration']);
  });

  it('parses a single line larger than 100KB', () => {
    const longMessage = 'x'.repeat(100 * 1024);
    const jsonl = JSON.stringify({
      type: 'issue',
      severity: 'critical',
      file: 'big.ts',
      line: 1,
      message: longMessage,
    });
    const result = parseReviewOutput(jsonl);
    expect(result.valid.length).toBe(1);
    expect(result.issues[0].message.length).toBe(longMessage.length);
  });

  it('never throws on random byte sequences', () => {
    const rand = mulberry32(0xfeedface);
    for (let i = 0; i < 200; i++) {
      const input = randomBytes(rand, Math.floor(rand() * 4096));
      expect(() => parseReviewOutput(input)).not.toThrow();
    }
  });
});

describe('ReviewBudgetConfigSchema', () => {
  it('applies field defaults when an empty object is parsed', () => {
    expect(ReviewBudgetConfigSchema.parse({})).toEqual({
      enabled: false,
      summaryThreshold: 500,
      splitThreshold: 1000,
    });
  });

  it('defaults enabled to false (opt-in)', () => {
    expect(ReviewBudgetConfigSchema.parse({ summaryThreshold: 300 }).enabled).toBe(false);
  });

  it('rejects splitThreshold below summaryThreshold', () => {
    expect(() =>
      ReviewBudgetConfigSchema.parse({ summaryThreshold: 900, splitThreshold: 100 }),
    ).toThrow('splitThreshold must be >= summaryThreshold');
  });

  it('accepts splitThreshold equal to summaryThreshold', () => {
    expect(
      ReviewBudgetConfigSchema.parse({ summaryThreshold: 900, splitThreshold: 900 }),
    ).toMatchObject({ summaryThreshold: 900, splitThreshold: 900 });
  });
});

describe('AgentConfigSchema review budget default', () => {
  it('applies reviewBudget field defaults when omitted', () => {
    const config = AgentConfigSchema.parse({});
    expect(config.review.reviewBudget).toEqual({
      enabled: false,
      summaryThreshold: 500,
      splitThreshold: 1000,
    });
  });
});
