import { describe, expect, it } from 'vitest';
import { compileGlobPatterns } from '../../src/utils/glob-match.js';

describe('compileGlobPatterns', () => {
  it('matches any of the compiled patterns', () => {
    const isExcluded = compileGlobPatterns(['dist/**', '*.lock', 'src/generated/**']);
    expect(isExcluded('dist/index.js')).toBe(true);
    expect(isExcluded('yarn.lock')).toBe(true);
    expect(isExcluded('src/generated/api.ts')).toBe(true);
    expect(isExcluded('src/index.ts')).toBe(false);
  });

  it('never matches for an absent, empty, or blank pattern list', () => {
    expect(compileGlobPatterns(undefined)('anything')).toBe(false);
    expect(compileGlobPatterns([])('anything')).toBe(false);
    expect(compileGlobPatterns(['', '   '.slice(0, 0)])('anything')).toBe(false);
  });

  it('drops non-string entries instead of throwing', () => {
    const isExcluded = compileGlobPatterns(['dist/**', 42, null, undefined] as unknown as string[]);
    expect(isExcluded('dist/index.js')).toBe(true);
    expect(isExcluded('src/index.ts')).toBe(false);
  });

  it('is reusable across many values (compiled once, then only regex tests)', () => {
    const isExcluded = compileGlobPatterns(['dist/**']);
    for (let i = 0; i < 1000; i++) {
      expect(isExcluded(`src/file-${i}.ts`)).toBe(false);
    }
    expect(isExcluded('dist/bundle.js')).toBe(true);
  });
});
