import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('StateCacheManager mtime comparison (issue #188 regression)', () => {
  const srcPath = path.join(__dirname, '../src/index.ts');

  it('does not use strict equality on floating-point mtime timestamps', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    expect(src).not.toMatch(/currentMtime\s*===\s*this\.learningDbMtimeMs/);
  });

  it('uses an epsilon-based comparison (Math.abs < 1)', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    expect(src).toMatch(/Math\.abs\(\s*currentMtime\s*-\s*this\.learningDbMtimeMs\s*\)\s*<\s*1/);
  });
});
