import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveChangelogPath } from '../src/changelog.js';

describe('resolveChangelogPath()', () => {
  let workspace: string;
  let prevWorkspace: string | undefined;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-changelog-'));
    prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspace;
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    // Assign rather than `delete` (biome noDelete): an empty value falls back
    // to process.cwd() in resolveChangelogPath, matching an unset variable.
    process.env.GITHUB_WORKSPACE = prevWorkspace ?? '';
  });

  it('accepts a plain filename inside the workspace', () => {
    expect(resolveChangelogPath('CHANGELOG.md')).toBe(path.join(workspace, 'CHANGELOG.md'));
  });

  it('accepts a nested path inside the workspace', () => {
    expect(resolveChangelogPath('docs/CHANGELOG.md')).toBe(
      path.join(workspace, 'docs', 'CHANGELOG.md'),
    );
  });

  it.each(['../outside.md', '../../tmp/evil.md', '/etc/passwd', '..'])('rejects %s', (raw) => {
    expect(() => resolveChangelogPath(raw)).toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => resolveChangelogPath('')).toThrow();
    expect(() => resolveChangelogPath('   ')).toThrow();
  });
});
