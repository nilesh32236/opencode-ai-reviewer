import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('autofix loop variable scoping (issue #186 regression)', () => {
  const srcPath = path.join(__dirname, '../../src/handlers/autofix.ts');

  it('declares verificationPassed inside the for-loop body, not outside', () => {
    const src = fs.readFileSync(srcPath, 'utf8');

    const loopIdx = src.indexOf('for (let i = 0; i < config.maxIterations; i++) {');
    expect(loopIdx).toBeGreaterThan(-1);

    const declIdx = src.indexOf('let verificationPassed = false;');
    expect(declIdx).toBeGreaterThan(-1);

    expect(declIdx).toBeGreaterThan(loopIdx);
  });

  it('declares verificationPassed exactly once', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    const matches = src.match(/let verificationPassed = false;/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});
