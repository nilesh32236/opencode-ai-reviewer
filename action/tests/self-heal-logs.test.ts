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

import { readConstrainedLogFile, redactCiLogsForLlm } from '../src/self-heal.js';

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

  it('rejects a symlink inside the workspace pointing outside', () => {
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'top-secret');
    const link = path.join(workspace, 'logs.txt');
    fs.symlinkSync(secret, link);
    expect(() => readConstrainedLogFile('logs.txt')).toThrow(/must not be a symlink/);
  });

  it('rejects a file reached through a symlinked directory escaping safe roots', () => {
    // os.tmpdir() nests under the /tmp safe root, so plant the secret in the
    // home directory, which lies outside workspace, /tmp, and cwd.
    const farOutside = fs.mkdtempSync(path.join(os.homedir(), 'sh-outside-'));
    try {
      fs.writeFileSync(path.join(farOutside, 'secret.txt'), 'top-secret');
      // The file path itself is not a symlink (lstat passes), but its
      // realpath resolves outside the safe roots — must be rejected, not
      // exfiltrated into the LLM prompt.
      const dirLink = path.join(workspace, 'linked-dir');
      fs.symlinkSync(farOutside, dirLink);
      expect(() => readConstrainedLogFile(path.join(dirLink, 'secret.txt'))).toThrow(
        /resolves outside/,
      );
    } finally {
      fs.rmSync(farOutside, { recursive: true, force: true });
    }
  });
});

describe('redactCiLogsForLlm()', () => {
  it('removes env-dump lines instead of forwarding them to the LLM', () => {
    const logs = [
      'npm run build',
      'export OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxx',
      'GITHUB_TOKEN=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'Error: build failed at src/index.ts:12',
    ].join('\n');
    const out = redactCiLogsForLlm(logs);
    expect(out).not.toContain('sk-xxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(out).not.toContain('ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(out).toContain('build failed');
  });

  it('redacts Bearer tokens and PEM blocks with a second scan', () => {
    const logs = [
      'request failed: Authorization: Bearer abcdef1234567890',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADAN',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const out = redactCiLogsForLlm(logs);
    expect(out).not.toContain('abcdef1234567890');
    expect(out).not.toContain('MIIEvQIBADAN');
  });
});
