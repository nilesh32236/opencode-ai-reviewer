import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveContainedPath } from '../src/utils/contained-path.js';

describe('resolveContainedPath()', () => {
  let base: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-contained-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-outside-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('resolves a plain filename inside the base directory', () => {
    expect(resolveContainedPath(base, 'CHANGELOG.md')).toBe(path.join(base, 'CHANGELOG.md'));
  });

  it('resolves a nested path that does not exist yet', () => {
    expect(resolveContainedPath(base, 'docs/notes/CHANGELOG.md')).toBe(
      path.join(base, 'docs', 'notes', 'CHANGELOG.md'),
    );
  });

  it.each(['../outside.md', '../../tmp/evil.md', '/etc/passwd', '..', '.', '  '])(
    'rejects %s',
    (raw) => {
      expect(resolveContainedPath(base, raw)).toBeNull();
    },
  );

  it('rejects a symlinked file that points outside the base directory', () => {
    const target = path.join(outside, 'secret.md');
    fs.writeFileSync(target, 'secret');
    const link = path.join(base, 'CHANGELOG.md');
    fs.symlinkSync(target, link);
    expect(resolveContainedPath(base, 'CHANGELOG.md')).toBeNull();
  });

  it('rejects a path whose parent directory symlinks outside the base directory', () => {
    const realDir = path.join(outside, 'nested');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, path.join(base, 'link'));
    expect(resolveContainedPath(base, 'link/CHANGELOG.md')).toBeNull();
  });

  it('accepts a path under a real subdirectory of the base directory', () => {
    fs.mkdirSync(path.join(base, 'docs'));
    expect(resolveContainedPath(base, 'docs/CHANGELOG.md')).toBe(
      path.join(base, 'docs', 'CHANGELOG.md'),
    );
  });
});
