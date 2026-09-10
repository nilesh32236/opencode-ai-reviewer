import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateCacheManager, buildCacheKey } from '../src/state-cache.js';

const { mockRestoreCache, mockSaveCache, mockInfo, mockWarning } = vi.hoisted(() => {
  const _mockRestoreCache = vi.fn().mockResolvedValue(undefined);
  const _mockSaveCache = vi.fn().mockResolvedValue(undefined);
  const _mockInfo = vi.fn();
  const _mockWarning = vi.fn();
  return {
    mockRestoreCache: _mockRestoreCache,
    mockSaveCache: _mockSaveCache,
    mockInfo: _mockInfo,
    mockWarning: _mockWarning,
  };
});

vi.mock('@actions/cache', () => ({
  restoreCache: mockRestoreCache,
  saveCache: mockSaveCache,
}));

vi.mock('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
}));

const FIXED_MTIME_MS = 1_700_000_000_000;

describe('StateCacheManager mtime comparison (issue #188 regression)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-state-cache-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDb(): string {
    const stateDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'learning.db');
    fs.writeFileSync(dbPath, 'data');
    fs.utimesSync(dbPath, FIXED_MTIME_MS / 1000, FIXED_MTIME_MS / 1000);
    return dbPath;
  }

  function setMtime(dbPath: string, mtimeMs: number): void {
    fs.utimesSync(dbPath, mtimeMs / 1000, mtimeMs / 1000);
  }

  function makeManager(dbPath: string): StateCacheManager {
    return new StateCacheManager('state', {
      stateDir: path.dirname(dbPath),
      repo: 'owner/repo',
      branch: 'main',
    });
  }

  it('skips the cache save when the db mtime is unchanged within the 1ms epsilon', async () => {
    const dbPath = makeDb();
    const manager = makeManager(dbPath);
    await manager.restore();

    setMtime(dbPath, FIXED_MTIME_MS);
    await manager.save();

    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  it('skips the cache save when the db mtime changes by exactly 1ms (inclusive epsilon)', async () => {
    const dbPath = makeDb();
    const manager = makeManager(dbPath);
    await manager.restore();

    setMtime(dbPath, FIXED_MTIME_MS + 1);
    await manager.save();

    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  it('saves the cache when the db mtime changes by more than 1ms', async () => {
    const dbPath = makeDb();
    const manager = makeManager(dbPath);
    await manager.restore();

    setMtime(dbPath, FIXED_MTIME_MS + 2_000);
    await manager.save();

    expect(mockSaveCache).toHaveBeenCalledTimes(1);
    expect(mockSaveCache).toHaveBeenCalledWith([path.dirname(dbPath)], expect.any(String));
  });

  it('shares an in-flight save when concurrent callers save the same state', async () => {
    const dbPath = makeDb();
    const manager = makeManager(dbPath);
    await manager.restore();
    setMtime(dbPath, FIXED_MTIME_MS + 2_000);

    let resolveSave!: () => void;
    mockSaveCache.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const firstSave = manager.save();
    const secondSave = manager.save();

    expect(mockSaveCache).toHaveBeenCalledTimes(1);
    resolveSave();
    await Promise.all([firstSave, secondSave]);
  });

  it('builds a distinct cache key per branch (GitLab branch isolation)', () => {
    const keyFor = (branch: string) => buildCacheKey('state', 'group/project', branch);
    expect(keyFor('main')).not.toBe(keyFor('feature/foo'));
    expect(keyFor('main')).toBe('state-group/project-main');
    // Slashes are PR-author-controlled, so the branch segment is slugified
    // (with a disambiguating hash) instead of embedded raw. (The repo NWO
    // legitimately contains one slash; only the branch part is sanitized.)
    expect(keyFor('feature/foo')).toBe(keyFor('feature/foo'));
    expect(keyFor('feature/foo').split('group/project-')[1]).not.toContain('/');
    expect(keyFor('feature/foo')).not.toBe(keyFor('feature-foo'));
  });

  it('sanitizes hostile branch refs for cache keys', () => {
    const keyFor = (branch: string) => buildCacheKey('state', 'group/project', branch);
    expect(keyFor('feature/../../evil branch:name')).not.toContain('../');
    expect(keyFor('feature/../../evil branch:name')).not.toContain(' ');
    expect(keyFor('feature/../../evil branch:name')).not.toContain(':');
    expect(keyFor('a'.repeat(200)).length).toBeLessThanOrEqual(512);
  });

  it('restores with the exact primary key only, never a repo-wide prefix', async () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const manager = new StateCacheManager('state', {
      stateDir: path.join(tempDir, 'fresh-state'),
      repo: 'owner/repo',
      branch: 'main',
      sha,
    });
    await manager.restore();

    expect(mockRestoreCache).toHaveBeenCalledTimes(1);
    const [paths, primaryKey, restoreKeys] = mockRestoreCache.mock.calls[0] as [
      string[],
      string,
      string[],
    ];
    expect(paths).toEqual([path.join(tempDir, 'fresh-state')]);
    expect(primaryKey).toContain(sha);
    // Exact-key-only restore: no bare `prefix-repo-` fallback that would let
    // one ref restore another ref's cached state.
    expect(restoreKeys).toEqual([primaryKey]);
  });

  it('isolates cache keys per commit SHA', () => {
    const shaA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const shaB = 'ffffffffffffffffffffffffffffffffffffffff';
    expect(buildCacheKey('state', 'owner/repo', 'main', shaA)).not.toBe(
      buildCacheKey('state', 'owner/repo', 'main', shaB),
    );
    // Omitting the SHA keeps the stable branch-scoped key for existing callers.
    expect(buildCacheKey('state', 'group/project', 'main')).toBe('state-group/project-main');
  });
});
