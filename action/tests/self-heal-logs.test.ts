import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn().mockReturnValue(''),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
}));

vi.mock('@actions/exec', () => ({ exec: vi.fn() }));

import { readConstrainedLogFile } from '../src/self-heal.js';

describe('readConstrainedLogFile()', () => {
  let workspace: string;
  let outside: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    process.env.GITHUB_WORKSPACE = workspace;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('reads a file inside the workspace', () => {
    const file = path.join(workspace, 'logs.txt');
    fs.writeFileSync(file, 'build failed');
    expect(readConstrainedLogFile('logs.txt')).toBe('build failed');
    expect(readConstrainedLogFile(file)).toBe('build failed');
  });

  it('rejects path traversal outside the workspace', () => {
    // A `..` escape that resolves outside every safe root (workspace, /tmp,
    // cwd) must be rejected rather than read. /tmp itself is a safe root, so
    // the traversal has to climb out of it entirely.
    expect(() => readConstrainedLogFile(path.join('..', '..', 'etc', 'passwd'))).toThrow(
      /must point inside/,
    );
  });

  it('rejects absolute paths outside the safe roots', () => {
    expect(() => readConstrainedLogFile('/etc/passwd')).toThrow(/must point inside/);
  });

  it('truncates oversized files at 1 MiB', () => {
    const file = path.join(workspace, 'big.log');
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    expect(readConstrainedLogFile('big.log')).toHaveLength(1024 * 1024);
  });
});
