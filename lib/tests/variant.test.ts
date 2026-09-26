import { describe, expect, it } from 'vitest';

import { resolveStageVariant, sanitizeVariant } from '../src/opencode.js';

describe('sanitizeVariant()', () => {
  it('accepts a well-formed variant', () => {
    expect(sanitizeVariant('gpt-5-codex')).toBe('gpt-5-codex');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeVariant('  gpt-5  ')).toBe('gpt-5');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['contains a space', 'gpt 5'],
    ['contains a slash', 'openai/gpt-5'],
    ['contains a shell metacharacter', 'foo;rm -rf /'],
    ['command substitution', '$(id)'],
    ['backtick', '`id`'],
    ['pipe', 'a|b'],
    ['too long', 'a'.repeat(65)],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeVariant(value)).toBeUndefined();
  });

  it('accepts exactly 64 characters', () => {
    expect(sanitizeVariant('a'.repeat(64))).toHaveLength(64);
  });
});

describe('resolveStageVariant()', () => {
  it('prefers the per-stage variant over the global one', () => {
    expect(resolveStageVariant('per-stage', 'global')).toBe('per-stage');
  });

  it('falls back to the global variant when the per-stage value is absent', () => {
    expect(resolveStageVariant(undefined, 'global')).toBe('global');
  });

  // A typo in the per-stage input must not silently disable the flag the
  // operator set globally; failing open here would drop a deliberate setting.
  it('falls back to the global variant when the per-stage value is invalid', () => {
    expect(resolveStageVariant('not a variant', 'global')).toBe('global');
    expect(resolveStageVariant('', 'global')).toBe('global');
    expect(resolveStageVariant('a'.repeat(65), 'global')).toBe('global');
  });

  it('returns undefined when neither value is usable', () => {
    expect(resolveStageVariant(undefined, undefined)).toBeUndefined();
    expect(resolveStageVariant('bad value', 'also bad')).toBeUndefined();
  });

  it('never returns a value that sanitizeVariant would reject', () => {
    for (const [perStage, global] of [
      ['ok', 'ok2'],
      ['bad value', 'ok2'],
      [undefined, 'ok2'],
      ['ok', undefined],
      ['bad value', undefined],
    ] as const) {
      const resolved = resolveStageVariant(perStage, global);
      if (resolved !== undefined) expect(sanitizeVariant(resolved)).toBe(resolved);
    }
  });
});
