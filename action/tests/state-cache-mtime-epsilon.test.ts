import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateCacheManager } from '../src/state-cache.js';

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

  it('saves the cache when the db mtime changes by more than 1ms', async () => {
    const dbPath = makeDb();
    const manager = makeManager(dbPath);
    await manager.restore();

    setMtime(dbPath, FIXED_MTIME_MS + 2_000);
    await manager.save();

    expect(mockSaveCache).toHaveBeenCalledTimes(1);
    expect(mockSaveCache).toHaveBeenCalledWith([path.dirname(dbPath)], expect.any(String));
  });
});
