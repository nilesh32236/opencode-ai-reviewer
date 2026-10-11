import { describe, expect, it } from 'vitest';

import {
  coerceOpenCodeOutput,
  extractTextFromJsonOutput,
  isFormatFlagRejection,
  resolveOpenCodeFormat,
  sanitizeFormat,
} from '../src/opencode.js';

describe('sanitizeFormat()', () => {
  it('accepts json (case-insensitive, normalized to lowercase)', () => {
    expect(sanitizeFormat('json')).toBe('json');
    expect(sanitizeFormat('JSON')).toBe('json');
    expect(sanitizeFormat('  Json  ')).toBe('json');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['auto', 'auto'],
    ['AUTO', 'AUTO'],
    ['non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['text', 'text'],
    ['yaml', 'yaml'],
    ['injection', 'json; rm -rf /'],
    ['flag smuggling', 'json --variant x'],
  ])('resolves %s to undefined (legacy text path)', (_label, value) => {
    expect(sanitizeFormat(value)).toBeUndefined();
  });
});

describe('resolveOpenCodeFormat()', () => {
  it('prefers the explicit value over the environment', () => {
    process.env.OPENCODE_FORMAT = 'json';
    try {
      expect(resolveOpenCodeFormat('auto')).toBeUndefined();
    } finally {
      // biome-ignore lint/performance/noDelete: restore the unset state so later tests see the default
      delete process.env.OPENCODE_FORMAT;
    }
  });

  it('falls back to OPENCODE_FORMAT env', () => {
    process.env.OPENCODE_FORMAT = 'json';
    try {
      expect(resolveOpenCodeFormat()).toBe('json');
    } finally {
      // biome-ignore lint/performance/noDelete: restore the unset state so later tests see the default
      delete process.env.OPENCODE_FORMAT;
    }
  });

  it('an explicit empty string suppresses the env fallback (stripped retry)', () => {
    process.env.OPENCODE_FORMAT = 'json';
    try {
      expect(resolveOpenCodeFormat('')).toBeUndefined();
    } finally {
      // biome-ignore lint/performance/noDelete: restore the unset state so later tests see the default
      delete process.env.OPENCODE_FORMAT;
    }
  });

  it('returns undefined when unset', () => {
    // biome-ignore lint/performance/noDelete: restore the unset state so later tests see the default
    delete process.env.OPENCODE_FORMAT;
    // biome-ignore lint/performance/noDelete: restore the unset state so later tests see the default
    delete process.env.INPUT_OPENCODE_FORMAT;
    expect(resolveOpenCodeFormat()).toBeUndefined();
  });
});

describe('isFormatFlagRejection()', () => {
  it('detects unknown-format rejections', () => {
    expect(isFormatFlagRejection('error: unknown flag --format')).toBe(true);
    expect(isFormatFlagRejection("format 'json' is not supported")).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isFormatFlagRejection('error: unknown flag --variant')).toBe(false);
    expect(isFormatFlagRejection('model failed')).toBe(false);
  });
});

describe('extractTextFromJsonOutput()', () => {
  it('extracts known text keys', () => {
    expect(extractTextFromJsonOutput(JSON.stringify({ output: 'hello' }))).toBe('hello');
    expect(extractTextFromJsonOutput(JSON.stringify({ text: 'world' }))).toBe('world');
    expect(extractTextFromJsonOutput(JSON.stringify({ result: 'done' }))).toBe('done');
  });

  it('returns bare JSON strings as-is', () => {
    expect(extractTextFromJsonOutput(JSON.stringify('just text'))).toBe('just text');
  });

  it('joins JSON arrays', () => {
    expect(extractTextFromJsonOutput(JSON.stringify(['a', 'b']))).toBe('a\nb');
  });

  it('tolerates log prefixes around the JSON envelope', () => {
    const raw = `starting session...\n${JSON.stringify({ output: 'review body' })}\n`;
    expect(extractTextFromJsonOutput(raw)).toBe('review body');
  });

  it('returns undefined for non-JSON (text fallback)', () => {
    expect(extractTextFromJsonOutput('plain review text')).toBeUndefined();
    expect(extractTextFromJsonOutput('')).toBeUndefined();
  });
});

describe('coerceOpenCodeOutput()', () => {
  it('leaves the legacy text path untouched when no format was sent', () => {
    expect(coerceOpenCodeOutput('plain text', undefined)).toBe('plain text');
    expect(coerceOpenCodeOutput('{"output":"x"}', undefined)).toBe('{"output":"x"}');
  });

  it('unwraps JSON when --format json was sent', () => {
    expect(coerceOpenCodeOutput(JSON.stringify({ output: 'parsed' }), 'json')).toBe('parsed');
  });

  it('falls back to raw text on JSON parse error (fail-open)', () => {
    const raw = 'not json at all';
    expect(coerceOpenCodeOutput(raw, 'json')).toBe(raw);
  });
});
