import { describe, expect, it } from 'vitest';
import { normalizeAgentConfidence, parseJsonlString } from '../src/jsonl-parser.js';

describe('jsonl-parser string lines', () => {
  const jsonlInput =
    '{"type":"issue","severity":"minor","confidence":"high","file":"a.ts","line":1,"message":"test"}\n';

  it('handles standard input', () => {
    const result = parseJsonlString(jsonlInput);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].message).toBe('test');
  });

  it('handles empty input', () => {
    const result = parseJsonlString('');
    expect(result.issues.length).toBe(0);
  });

  it('handles trailing newline', () => {
    const result = parseJsonlString(jsonlInput + '\n\n');
    expect(result.issues.length).toBe(1);
  });

  it('handles CRLF input', () => {
    const crlfInput = jsonlInput.replace('\n', '\r\n');
    const result = parseJsonlString(crlfInput);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].message).toBe('test');
  });
});
