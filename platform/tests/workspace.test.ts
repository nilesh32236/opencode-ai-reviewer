import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobIdFor } from '../src/queue/types.js';
import { WorkspaceManager } from '../src/workspace/manager.js';

describe('WorkspaceManager', () => {
  let baseDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-test-'));
    manager = new WorkspaceManager(baseDir);
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('computes a nested workspace path from owner/repo/id', () => {
    const p = manager.workspacePath('nilesh32236/repo', 42);
    expect(p).toContain(path.join('nilesh32236', 'repo', '42'));
  });

  it('creates and cleans up a workspace directory', async () => {
    const ws = manager.workspacePath('acme/app', 7);
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'file.txt'), 'hello');

    const size = await manager.dirSize(ws);
    expect(size).toBeGreaterThan(0);

    await manager.cleanup({ path: ws, owner: 'acme', repo: 'app', id: 7 });
    await expect(fs.access(ws)).rejects.toThrow();
  });

  it('measures directory size recursively', async () => {
    const dir = path.join(baseDir, 'a');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'one.txt'), '12345');
    await fs.writeFile(path.join(dir, 'sub', 'two.txt'), '1234567890');
    expect(await manager.dirSize(dir)).toBe(15);
  });

  it('reclaims stale workspaces', async () => {
    const stale = path.join(baseDir, 'o', 'r', 'stale');
    const fresh = path.join(baseDir, 'o', 'r', 'fresh');
    await fs.mkdir(stale, { recursive: true });
    await fs.mkdir(fresh, { recursive: true });
    await fs.writeFile(path.join(stale, 'f'), 'x');
    await fs.writeFile(path.join(fresh, 'f'), 'y');
    // Backdate the stale dir's mtime.
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(stale, past, past);

    const result = await manager.cleanupStale(5 * 60 * 1000);
    expect(result.reclaimed).toBe(1);
    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
  });
});

describe('queue job ids', () => {
  it('produces a deterministic id from repo/type/pr/sha', () => {
    const a = jobIdFor({ repo: 'o/r', type: 'review', prNumber: 5, headSha: 'abc' });
    const b = jobIdFor({ repo: 'o/r', type: 'review', prNumber: 5, headSha: 'abc' });
    expect(a).toBe(b);
  });

  it('distinguishes different PRs and SHAs', () => {
    const pr5 = jobIdFor({ repo: 'o/r', type: 'review', prNumber: 5, headSha: 'abc' });
    const pr6 = jobIdFor({ repo: 'o/r', type: 'review', prNumber: 6, headSha: 'abc' });
    const otherSha = jobIdFor({ repo: 'o/r', type: 'review', prNumber: 5, headSha: 'def' });
    expect(pr5).not.toBe(pr6);
    expect(pr5).not.toBe(otherSha);
  });
});
