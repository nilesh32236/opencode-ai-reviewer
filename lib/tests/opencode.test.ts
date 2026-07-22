import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSpawn,
  mockExecFileSync,
  mockExecGetExecOutput,
  mockIoWhich,
  mockDownloadTool,
  mockExtractTar,
  mockExtractZip,
  mockCacheDir,
  mockToolFind,
  mockComputeSha256,
  mockFindChecksumAsset,
  mockGetKnownChecksum,
  mockParseChecksumFile,
  mockVerifyChecksum,
  mockFetch,
} = vi.hoisted(() => {
  const _mockSpawn = vi.fn();
  const _mockExecFileSync = vi.fn();
  const _mockExecGetExecOutput = vi.fn();
  const _mockIoWhich = vi.fn();
  const _mockDownloadTool = vi.fn().mockResolvedValue('/tmp/opencode.tar.gz');
  const _mockExtractTar = vi.fn().mockResolvedValue('/tmp/opencode-extracted');
  const _mockExtractZip = vi.fn().mockResolvedValue('/tmp/opencode-extracted');
  const _mockCacheDir = vi.fn().mockResolvedValue('/tmp/opencode-cached');
  const _mockToolFind = vi.fn().mockReturnValue('');
  const _mockComputeSha256 = vi.fn();
  const _mockFindChecksumAsset = vi.fn().mockReturnValue(null);
  const _mockGetKnownChecksum = vi.fn().mockReturnValue(null);
  const _mockParseChecksumFile = vi.fn();
  const _mockVerifyChecksum = vi.fn();
  const _mockFetch = vi.fn();

  return {
    mockSpawn: _mockSpawn,
    mockExecFileSync: _mockExecFileSync,
    mockExecGetExecOutput: _mockExecGetExecOutput,
    mockIoWhich: _mockIoWhich,
    mockDownloadTool: _mockDownloadTool,
    mockExtractTar: _mockExtractTar,
    mockExtractZip: _mockExtractZip,
    mockCacheDir: _mockCacheDir,
    mockToolFind: _mockToolFind,
    mockComputeSha256: _mockComputeSha256,
    mockFindChecksumAsset: _mockFindChecksumAsset,
    mockGetKnownChecksum: _mockGetKnownChecksum,
    mockParseChecksumFile: _mockParseChecksumFile,
    mockVerifyChecksum: _mockVerifyChecksum,
    mockFetch: _mockFetch,
  };
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  addPath: vi.fn(),
}));

vi.mock('@actions/exec', () => ({
  getExecOutput: mockExecGetExecOutput,
}));

vi.mock('@actions/io', () => ({
  which: mockIoWhich,
}));

vi.mock('@actions/tool-cache', () => ({
  downloadTool: mockDownloadTool,
  extractTar: mockExtractTar,
  extractZip: mockExtractZip,
  cacheDir: mockCacheDir,
  find: mockToolFind,
}));

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>, _opts?: unknown) => fn()),
}));

vi.mock('../src/utils/checksum.js', () => ({
  computeSha256: mockComputeSha256,
  findChecksumAsset: mockFindChecksumAsset,
  getKnownChecksum: mockGetKnownChecksum,
  parseChecksumFile: mockParseChecksumFile,
  verifyChecksum: mockVerifyChecksum,
}));

// Mock fs to allow chmodSync on our fake paths without throwing ENOENT
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    mkdtempSync: vi.fn().mockReturnValue('/tmp/opencode-askpass-xxx'),
    readFileSync: vi.fn().mockReturnValue(''),
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

// Mock global fetch for setupOpenCode's API call
vi.stubGlobal('fetch', mockFetch);

import { configureGit, getGitStatus, runOpenCode, setupOpenCode } from '../src/opencode.js';

function makeMockProcess() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    emitExit: (code: number | null) => {
      const handlers = listeners.exit || [];
      for (const h of handlers) h(code);
    },
    emitError: (err: Error) => {
      const handlers = listeners.error || [];
      for (const h of handlers) h(err);
    },
  };
}

describe('runOpenCode()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockExecGetExecOutput.mockResolvedValue({ stdout: 'opencode v1.0.0\n', stderr: '' });
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });

  it('returns success on normal completion with exit code 0', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('review this PR', {
      model: 'claude-sonnet-4',
      timeoutMinutes: 5,
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitExit(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['run', '--auto', '--model', 'claude-sonnet-4', 'review this PR']),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('returns failure on non-zero exit code', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test prompt', { model: 'gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitExit(1);
    const result = await resultPromise;

    expect(result.success).toBe(false);
  });

  it('returns failure on process error', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test prompt', { model: 'gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitError(new Error('ENOENT'));
    const result = await resultPromise;

    expect(result.success).toBe(false);
  });

  it('handles timeout by sending SIGTERM then SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('test prompt', {
        model: 'gpt-4',
        timeoutMinutes: 0.001,
      });

      // Advance past setupOpenCode microtasks, then spawn runs synchronously
      await vi.advanceTimersByTimeAsync(0);

      const start = Date.now();
      while (mockSpawn.mock.calls.length === 0 && Date.now() - start < 1000) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

      proc.emitExit(null);
      const result = await resultPromise;
      expect(result.success).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it('does not send SIGKILL if process exits after SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('test prompt', {
        model: 'gpt-4',
        timeoutMinutes: 0.001,
      });

      // Advance past setupOpenCode microtasks, then spawn runs synchronously
      await vi.advanceTimersByTimeAsync(0);

      const start = Date.now();
      while (mockSpawn.mock.calls.length === 0 && Date.now() - start < 1000) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      proc.emitExit(0);
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it('catches exceptions during process execution', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn error');
    });

    await expect(runOpenCode('test', { model: 'gpt-4' })).rejects.toThrow('spawn error');
  });

  it('passes env vars from options', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', {
      model: 'gpt-4',
      env: { CUSTOM_VAR: 'custom-value' },
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitExit(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.CUSTOM_VAR).toBe('custom-value');
  });

  it('sets OPENCODE_CONFIG_CONTENT env var', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitExit(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('"permission":"allow"');
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('"autoupdate":false');
  });

  it('sets OPENCODE_DISABLE_AUTOUPDATE env var', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitExit(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('true');
  });
});

describe('setupOpenCode()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing path if opencode is already installed', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');

    const result = await setupOpenCode();

    expect(result).toBe('/usr/local/bin/opencode');
  });

  it('uses cached binary when checksum matches', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.0.0/linux-x64');
    mockComputeSha256.mockResolvedValue('abc123');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('.checksum') || p.endsWith('opencode'),
    );
    (fsModule.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('abc123\n');

    const result = await setupOpenCode('v1.0.0');

    expect(result).toBe('/cache/opencode/1.0.0/linux-x64/opencode');
    expect(mockDownloadTool).not.toHaveBeenCalled();
  });

  it('re-downloads when cached binary checksum mismatches', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.0.0/linux-x64');
    mockComputeSha256.mockResolvedValue('def456');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('.checksum') || p.endsWith('opencode'),
    );
    (fsModule.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('abc123\n');

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');

    mockFindChecksumAsset.mockReturnValue(null);
    mockGetKnownChecksum.mockReturnValue(null);
    mockComputeSha256.mockResolvedValue('bin-checksum-123');

    const result = await setupOpenCode('v1.0.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalled();
  });

  it('re-downloads when cached binary has no checksum file', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.0.0/linux-x64');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');
    mockComputeSha256.mockResolvedValue('bin-checksum-123');

    const result = await setupOpenCode('v1.0.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalled();
  });

  it('downloads and verifies with release checksum asset', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockDownloadTool.mockResolvedValueOnce('/tmp/opencode.tar.gz');
    mockDownloadTool.mockResolvedValueOnce('/tmp/checksum.txt');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');

    mockFindChecksumAsset.mockReturnValue({
      name: 'opencode-linux-x64.tar.gz.sha256',
      browser_download_url: 'https://example.com/checksum.sha256',
    });
    mockParseChecksumFile.mockReturnValue('abc123checksum');
    mockVerifyChecksum.mockResolvedValue(true);
    mockComputeSha256.mockResolvedValue('stored-checksum');

    const result = await setupOpenCode('v1.0.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalledTimes(2);
    expect(mockVerifyChecksum).toHaveBeenCalled();
  });

  it('throws when checksum does not match', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');

    mockFindChecksumAsset.mockReturnValue({
      name: 'opencode-linux-x64.tar.gz.sha256',
      browser_download_url: 'https://example.com/checksum.sha256',
    });
    mockParseChecksumFile.mockReturnValue('expected-hash-value');
    mockVerifyChecksum.mockRejectedValue(new Error('Checksum mismatch'));

    await expect(setupOpenCode('v1.0.0')).rejects.toThrow('Checksum mismatch');
  });

  it('falls back to known checksum when no release checksum asset', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');

    mockFindChecksumAsset.mockReturnValue(null);
    mockGetKnownChecksum.mockReturnValue('known-good-hash');
    mockVerifyChecksum.mockResolvedValue(true);
    mockComputeSha256.mockResolvedValue('stored-checksum');

    const result = await setupOpenCode('v1.0.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockGetKnownChecksum).toHaveBeenCalled();
    expect(mockVerifyChecksum).toHaveBeenCalled();
  });

  it('continues with warning when no checksum is available', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'opencode-linux-x64.tar.gz',
              browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');

    mockFindChecksumAsset.mockReturnValue(null);
    mockGetKnownChecksum.mockReturnValue(null);
    mockComputeSha256.mockResolvedValue('stored-checksum');

    const result = await setupOpenCode('v1.0.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalled();
  });
});

describe('configureGit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures git user name and email', () => {
    mockExecFileSync.mockReturnValue('');

    configureGit('test-user', 'test@example.com');

    expect(mockExecFileSync).toHaveBeenCalledWith('git', [
      'config',
      '--local',
      'user.name',
      'test-user',
    ]);
    expect(mockExecFileSync).toHaveBeenCalledWith('git', [
      'config',
      '--local',
      'user.email',
      'test@example.com',
    ]);
  });
});

describe('getGitStatus()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns git status output', () => {
    mockExecFileSync.mockReturnValue(' M src/test.ts\n');

    const result = getGitStatus();

    expect(result).toBe(' M src/test.ts\n');
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
    });
  });

  it('returns empty string on error', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('git failed');
    });

    const result = getGitStatus();

    expect(result).toBe('');
  });
});
