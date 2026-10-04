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
    // Valid SQLite fixture: header + padding past the 100-byte validity
    // threshold so the resolver treats it as usable state (mirrors a real db).
    const header = Buffer.from('SQLite format 3\0');
    const padding = Buffer.alloc(128 - header.length, 0x61);
    fs.writeFileSync(dbPath, Buffer.concat([header, padding]));
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

    // Content hashing is async (streamed file I/O), so wait until the
    // debounced saveCache call lands exactly once before resolving it.
    await vi.waitFor(() => expect(mockSaveCache).toHaveBeenCalledTimes(1));
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

  it('restores with a branch-scoped key so the cache can actually hit across commits', async () => {
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
    // The SHA must NOT be in the restore key: every new commit minted a key
    // nothing had been saved under, so restore was a permanent miss.
    expect(primaryKey).not.toContain(sha);
    // Still ref-scoped: another branch/repo must never restore this state, so
    // no bare `state-owner/repo-` prefix fallback is offered.
    expect(primaryKey).toContain('owner/repo-main');
    expect(restoreKeys).toEqual([primaryKey]);
    expect(restoreKeys[0]).not.toBe('state-owner/repo-');
    // A schema/version segment retires stale-format snapshots by construction.
    expect(primaryKey).toMatch(/-v\d+-/);
  });

  it('saves under a per-commit snapshot key that the next run can prefix-match', async () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const stateDir = path.join(tempDir, 'snapshot-state');
    // Reset any implementation installed by the in-flight-save test above
    // (clearAllMocks does not clear implementations) so save() can settle.
    mockSaveCache.mockResolvedValue(undefined);
    // Restore first (no state on disk yet) so the restore key is observable,
    // then create the db that the save below uploads.
    const manager = new StateCacheManager('state', {
      stateDir,
      repo: 'owner/repo',
      branch: 'main',
      sha,
    });
    await manager.restore();
    const [, primaryKey] = mockRestoreCache.mock.calls[0] as [string[], string, string[]];

    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'learning.db');
    const header = Buffer.from('SQLite format 3\0');
    const padding = Buffer.alloc(128 - header.length, 0x61);
    fs.writeFileSync(dbPath, Buffer.concat([header, padding]));
    fs.utimesSync(dbPath, FIXED_MTIME_MS / 1000, FIXED_MTIME_MS / 1000);
    await manager.save();

    expect(mockSaveCache).toHaveBeenCalledTimes(1);
    const [, saveKey] = mockSaveCache.mock.calls[0] as [string[], string];
    // The snapshot keeps the SHA for immutability, and — crucially — starts
    // with the restore key so the next run's prefix match finds it.
    expect(saveKey).toContain(sha);
    expect(saveKey.startsWith(primaryKey)).toBe(true);
  });

  it('terminates the restore key so no other ref key is a prefix-extension of it', async () => {
    const restoreKeyFor = async (branch: string): Promise<string> => {
      const manager = new StateCacheManager('state', {
        stateDir: path.join(tempDir, `state-${branch}`),
        repo: 'owner/repo',
        branch,
      });
      await manager.restore();
      const calls = mockRestoreCache.mock.calls;
      const [, primaryKey] = calls[calls.length - 1] as [string[], string, string[]];
      return primaryKey;
    };

    // `sanitizeBranchForCacheKey` leaves an already-valid branch name as-is, so
    // without a fixed-length terminator `...-main` is a strict prefix of
    // `...-main-x`. A backend that resolved restore keys purely by prefix
    // (without per-branch scoping) would then hand one ref's learning state to
    // another. The terminator makes that impossible by construction.
    const main = await restoreKeyFor('main');
    const mainX = await restoreKeyFor('main-x');
    expect(main).not.toBe(mainX);
    expect(mainX.startsWith(main)).toBe(false);
    expect(main.startsWith(mainX)).toBe(false);
    expect(main).toMatch(/-[a-f0-9]{12}$/);
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
