import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChangelogPath } from '../../src/handlers/changelog.js';

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'wppo-changelog-test-'));
}

describe('resolveChangelogPath', () => {
  it('resolves a normal relative path inside the workspace', () => {
    const dir = makeTempDir();

    expect(resolveChangelogPath(dir, 'CHANGELOG.md')).toBe(path.resolve(dir, 'CHANGELOG.md'));
  });

  it('rejects traversal, absolute, and empty values', () => {
    const dir = makeTempDir();

    expect(resolveChangelogPath(dir, '../escape.md')).toBeNull();
    expect(resolveChangelogPath(dir, '/etc/passwd')).toBeNull();
    expect(resolveChangelogPath(dir, '')).toBeNull();
    expect(resolveChangelogPath(dir, '   ')).toBeNull();
  });

  it('rejects a symlinked filePath pointing outside the workspace', () => {
    const dir = makeTempDir();
    const outside = path.join(makeTempDir(), 'outside.md');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, path.join(dir, 'link.md'));

    expect(resolveChangelogPath(dir, 'link.md')).toBeNull();
  });

  it('rejects a symlinked parent dir inside the workspace pointing outside', () => {
    const dir = makeTempDir();
    const outsideDir = makeTempDir();
    symlinkSync(outsideDir, path.join(dir, 'sub'));

    expect(resolveChangelogPath(dir, path.join('sub', 'CHANGELOG.md'))).toBeNull();
  });

  it('accepts a real file inside a real subdirectory', () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(path.join(dir, 'docs', 'CHANGELOG.md'), 'x');

    expect(resolveChangelogPath(dir, path.join('docs', 'CHANGELOG.md'))).toBe(
      path.resolve(dir, 'docs', 'CHANGELOG.md'),
    );
  });
});
