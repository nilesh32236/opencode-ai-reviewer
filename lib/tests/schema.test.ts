import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseReviewOutput } from '../src/types/schemas.js';

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
