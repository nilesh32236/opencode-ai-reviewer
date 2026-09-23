import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateCacheManager, deriveJsonStatePath } from '../src/state-cache.js';

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

describe('StateCacheManager JSON fallback backend (issue #721 / REF-015)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-state-cache-json-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeManager(stateDir: string): StateCacheManager {
    return new StateCacheManager('state', {
      stateDir,
      repo: 'owner/repo',
      branch: 'main',
    });
  }

  function writeJson(stateDir: string, content = '{"tables":{}}'): string {
    fs.mkdirSync(stateDir, { recursive: true });
    const jsonPath = path.join(stateDir, 'learning.json');
    fs.writeFileSync(jsonPath, content);
    fs.utimesSync(jsonPath, FIXED_MTIME_MS / 1000, FIXED_MTIME_MS / 1000);
    return jsonPath;
  }

  function writeValidDb(stateDir: string): string {
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'learning.db');
    const header = Buffer.from('SQLite format 3\0');
    const padding = Buffer.alloc(128 - header.length, 0x61);
    fs.writeFileSync(dbPath, Buffer.concat([header, padding]));
    fs.utimesSync(dbPath, FIXED_MTIME_MS / 1000, FIXED_MTIME_MS / 1000);
    return dbPath;
  }

  it('derives the JSON fallback path exactly like connectDb (.db -> .json)', () => {
    expect(deriveJsonStatePath('/x/.opencode/learning.db')).toBe('/x/.opencode/learning.json');
    expect(deriveJsonStatePath('/x/other.dat')).toBe('/x/other.dat');
  });

  it('saves JSON-only state to the cache (round-trip via mocked cache)', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    const jsonPath = writeJson(stateDir);
    const manager = makeManager(stateDir);
    await manager.restore();

    // Restore found no usable db and no cache entry; bumping the mtime marks
    // the JSON state dirty so save() must upload the whole stateDir.
    fs.utimesSync(jsonPath, (FIXED_MTIME_MS + 2_000) / 1000, (FIXED_MTIME_MS + 2_000) / 1000);
    await manager.save();

    expect(mockSaveCache).toHaveBeenCalledTimes(1);
    expect(mockSaveCache).toHaveBeenCalledWith([stateDir], expect.any(String));
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('learning.json'));
  });

  it('skips the save when JSON state is unchanged within the 1ms epsilon', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    writeJson(stateDir);
    const manager = makeManager(stateDir);
    await manager.restore();
    await manager.save();

    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  it('skips restore when a valid learning.json already exists', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    writeJson(stateDir);
    const manager = makeManager(stateDir);
    await manager.restore();

    expect(mockRestoreCache).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('learning.json already exists'));
  });

  it('quarantines corrupt JSON (unparseable) and proceeds to restore', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    const jsonPath = writeJson(stateDir, 'not-json{{{');
    const manager = makeManager(stateDir);
    await manager.restore();

    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(mockRestoreCache).toHaveBeenCalledTimes(1);
  });

  it('quarantines zero-byte JSON and proceeds to restore', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    const jsonPath = writeJson(stateDir, '');
    const manager = makeManager(stateDir);
    await manager.restore();

    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(mockRestoreCache).toHaveBeenCalledTimes(1);
  });

  it('prefers learning.db when both backends are present', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    writeValidDb(stateDir);
    writeJson(stateDir);
    const manager = makeManager(stateDir);
    await manager.restore();

    expect(mockRestoreCache).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('learning.db already exists'));
  });

  it('skips the save when no state file exists (.db/.json)', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(stateDir, { recursive: true });
    const manager = makeManager(stateDir);
    await manager.restore();
    await manager.save();

    expect(mockSaveCache).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('No learning state file found (.db/.json)'),
    );
  });

  it('db behavior is unchanged: valid db saves after mtime change', async () => {
    const stateDir = path.join(tempDir, '.opencode');
    const dbPath = writeValidDb(stateDir);
    const manager = makeManager(stateDir);
    await manager.restore();

    fs.utimesSync(dbPath, (FIXED_MTIME_MS + 2_000) / 1000, (FIXED_MTIME_MS + 2_000) / 1000);
    await manager.save();

    expect(mockSaveCache).toHaveBeenCalledTimes(1);
    expect(mockSaveCache).toHaveBeenCalledWith([stateDir], expect.any(String));
  });
});
