import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSpawn,
  mockExecFileSync,
  mockExecFile,
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
  const _mockExecFile = vi.fn();
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
    mockExecFile: _mockExecFile,
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
  execFile: mockExecFile,
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

import {
  checkHealth,
  configureGit,
  getGitStatus,
  isVersionCompatible,
  parseOpenCodeVersion,
  resetOpenCodeState,
  resolveOpenCodePath,
  runOpenCode,
  setupOpenCode,
  validateModelString,
} from '../src/opencode.js';

// Reset module-level OpenCode state (cached path / validation cache) between
// tests so the validated-once pre-flight behavior is deterministic.
beforeEach(() => {
  resetOpenCodeState();
});

// The health check probes the binary via child_process.execFile (callback
// style). These helpers simulate a successful version probe and a failing one.
function mockVersionOutput(output: string): void {
  mockExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void,
    ) => {
      cb(null, output, '');
    },
  );
}

function mockVersionError(err: Error): void {
  mockExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void,
    ) => {
      cb(err, '', '');
    },
  );
}

function makeMockProcess() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const makeStdio = () => ({
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[`_stdio_${event}`]) listeners[`_stdio_${event}`] = [];
      listeners[`_stdio_${event}`].push(handler);
    }),
  });
  return {
    pid: 12345,
    kill: vi.fn(),
    stdout: makeStdio(),
    stderr: makeStdio(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    emitClose: (code: number | null) => {
      const handlers = listeners.close || [];
      for (const h of handlers) h(code);
    },
    emitError: (err: Error) => {
      const handlers = listeners.error || [];
      for (const h of handlers) h(err);
    },
  };
}

describe('checkHealth()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns available true and compatible true when the binary is recent enough', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.2.3\n');

    const health = await checkHealth();

    expect(health.available).toBe(true);
    expect(health.compatible).toBe(true);
    expect(health.version).toEqual({
      raw: 'v1.2.3',
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
    expect(health.message).toContain('compatible');
  });

  it('returns available false when the binary is missing', async () => {
    mockIoWhich.mockResolvedValue(null);

    const health = await checkHealth();

    expect(health.available).toBe(false);
    expect(health.compatible).toBe(false);
    expect(health.version).toBeNull();
    expect(health.message).toContain('npm install -g opencode-ai');
  });

  it('returns compatible false when the version is too old', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.0.0\n');

    const health = await checkHealth();

    expect(health.available).toBe(true);
    expect(health.compatible).toBe(false);
    expect(health.message).toContain('1.1.1');
    expect(health.message).toContain('npm install -g opencode-ai@latest');
  });

  it('returns compatible false when the version output cannot be parsed', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('segmentation fault\n');

    const health = await checkHealth();

    expect(health.available).toBe(true);
    expect(health.compatible).toBe(false);
    expect(health.message).toContain('could not be determined');
  });

  it('returns compatible false when the version check throws', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionError(new Error('ETIMEDOUT'));

    const health = await checkHealth();

    expect(health.available).toBe(true);
    expect(health.compatible).toBe(false);
    expect(health.message).toContain('ETIMEDOUT');
  });

  it('reports an unexecutable binary as not available', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    const err = new Error('spawn ENOENT') as Error & { code?: string };
    err.code = 'ENOENT';
    mockVersionError(err);

    const health = await checkHealth();

    expect(health.available).toBe(false);
    expect(health.compatible).toBe(false);
    expect(health.version).toBeNull();
    expect(health.message).toContain('could not be executed');
  });

  it('honors a custom minimum version', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.0.0\n');

    const health = await checkHealth({ minimumVersion: '0.9.0' });

    expect(health.available).toBe(true);
    expect(health.compatible).toBe(true);
  });

  it('uses a custom upgrade hint when provided', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.0.0\n');

    const health = await checkHealth({
      upgradeHint: 'Set opencode_version to a newer tag and re-run',
    });

    expect(health.compatible).toBe(false);
    expect(health.message).toContain('Set opencode_version to a newer tag and re-run');
    expect(health.message).not.toContain('npm install -g opencode-ai@latest');
  });
});

describe('parseOpenCodeVersion() and isVersionCompatible()', () => {
  it('parses valid version strings correctly', () => {
    const v = parseOpenCodeVersion('opencode v1.2.3\n');
    expect(v).toEqual({ raw: 'v1.2.3', major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it('parses versions without a leading v prefix', () => {
    const v = parseOpenCodeVersion('1.1.1');
    expect(v?.major).toBe(1);
    expect(v?.minor).toBe(1);
    expect(v?.patch).toBe(1);
  });

  it('parses pre-release versions', () => {
    const v = parseOpenCodeVersion('opencode v1.1.1-rc.1');
    expect(v).toEqual({ raw: 'v1.1.1-rc.1', major: 1, minor: 1, patch: 1, prerelease: 'rc.1' });
  });

  it('returns null for garbage input', () => {
    expect(parseOpenCodeVersion('')).toBeNull();
    expect(parseOpenCodeVersion('not a version')).toBeNull();
    expect(parseOpenCodeVersion('opencode: unknown command')).toBeNull();
  });

  it('does not match version numbers embedded in paths or stack traces', () => {
    expect(
      parseOpenCodeVersion('TypeError: x\n    at /opt/app/node_modules/1.2.3/dist/cli.js:10:5'),
    ).toBeNull();
    expect(parseOpenCodeVersion('dl opencode 1.2.3.dmg')).toBeNull();
  });

  it('isVersionCompatible compares against the default minimum', () => {
    const mk = (
      raw: string,
      major: number,
      minor: number,
      patch: number,
      prerelease: string | null = null,
    ) => ({
      raw,
      major,
      minor,
      patch,
      prerelease,
    });
    expect(isVersionCompatible(mk('v1.2.3', 1, 2, 3))).toBe(true);
    expect(isVersionCompatible(mk('v1.1.0', 1, 1, 0))).toBe(false);
    expect(isVersionCompatible(mk('v2.0.0', 2, 0, 0))).toBe(true);
    // Pre-release 1.1.1-rc.1 sorts below the 1.1.1 release
    expect(isVersionCompatible(mk('v1.1.1-rc.1', 1, 1, 1, 'rc.1'))).toBe(false);
    expect(isVersionCompatible(mk('v1.2.0', 1, 2, 0), '1.0.0')).toBe(true);
    // Numeric pre-release segments compare numerically (rc.10 > rc.9)
    expect(isVersionCompatible(mk('v1.2.0-rc.10', 1, 2, 0, 'rc.10'), '1.2.0-rc.9')).toBe(true);
    expect(isVersionCompatible(mk('v1.2.0-rc.9', 1, 2, 0, 'rc.9'), '1.2.0-rc.10')).toBe(false);
    expect(isVersionCompatible(mk('v1.2.0-rc.2', 1, 2, 0, 'rc.2'), '1.2.0-rc.10')).toBe(false);
  });
});

describe('setupOpenCode() version validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a clear error when the existing binary version is too old', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.0.0\n');

    await expect(setupOpenCode()).rejects.toThrow(/1\.1\.1/);
  });

  it('throws a clear error when the existing binary version cannot be parsed', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('???\n');

    await expect(setupOpenCode()).rejects.toThrow(/version could not be determined/);
  });

  it('throws a clear error when an explicitly pinned download version is below the minimum', async () => {
    mockIoWhich.mockResolvedValue(null);

    await expect(setupOpenCode('v1.0.0')).rejects.toThrow(/below the minimum/);
    expect(mockDownloadTool).not.toHaveBeenCalled();
  });
});

describe('runOpenCode()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.2.3\n');
    mockExecGetExecOutput.mockResolvedValue({ stdout: 'opencode v1.0.0\n', stderr: '' });
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

  it('throws before spawning when the model string fails validation', async () => {
    await expect(runOpenCode('test', { model: 'gpt-4' })).rejects.toThrow(/Invalid model format/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects with the health message when the installed binary is too old', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.0.0\n');

    await expect(runOpenCode('test', { model: 'openai/gpt-4' })).rejects.toThrow(/1\.1\.1/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects via the pre-flight check when a pre-set PATH binary is too old', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.0.0\n');

    await resolveOpenCodePath();

    await expect(runOpenCode('test', { model: 'openai/gpt-4' })).rejects.toThrow(/1\.1\.1/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('probes the binary only once when setupOpenCode validated it in the same call', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    // setupOpenCode ran the health check; runOpenCode's redundant probe was skipped.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns success on normal completion with exit code 0', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('review this PR', {
      model: 'anthropic/claude-sonnet-4',
      timeoutMinutes: 5,
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        'run',
        '--auto',
        '--model',
        'anthropic/claude-sonnet-4',
        'review this PR',
      ]),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('returns failure on non-zero exit code', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test prompt', { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(1);
    const result = await resultPromise;

    expect(result.success).toBe(false);
  });

  it('returns failure on process error', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test prompt', { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitError(new Error('ENOENT'));
    const result = await resultPromise;

    expect(result.success).toBe(false);
  });

  it('handles timeout by sending SIGTERM then SIGKILL', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('test prompt', {
        model: 'openai/gpt-4',
        timeoutMinutes: 0.001,
      });

      // Advance past setupOpenCode microtasks, then spawn runs synchronously
      await vi.advanceTimersByTimeAsync(0);

      const start = Date.now();
      while (mockSpawn.mock.calls.length === 0 && Date.now() - start < 1000) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');

      proc.emitClose(null);
      const result = await resultPromise;
      expect(result.success).toBe(false);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 20000);

  it('does not send SIGKILL if process exits after SIGTERM', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('test prompt', {
        model: 'openai/gpt-4',
        timeoutMinutes: 0.001,
      });

      // Advance past setupOpenCode microtasks, then spawn runs synchronously
      await vi.advanceTimersByTimeAsync(0);

      const start = Date.now();
      while (mockSpawn.mock.calls.length === 0 && Date.now() - start < 1000) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

      proc.emitClose(0);
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(killSpy).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 20000);

  it('catches exceptions during process execution', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn error');
    });

    await expect(runOpenCode('test', { model: 'openai/gpt-4' })).rejects.toThrow('spawn error');
  });

  it('passes env vars from options', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      env: { CUSTOM_VAR: 'custom-value' },
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.CUSTOM_VAR).toBe('custom-value');
  });

  it('sets OPENCODE_CONFIG_CONTENT env var', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('"permission":"allow"');
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('"autoupdate":false');
  });

  it('sets OPENCODE_DISABLE_AUTOUPDATE env var', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('true');
  });
});

describe('validateModelString()', () => {
  it.each([
    'opencode/deepseek-v4-flash-free',
    'anthropic/claude-sonnet-4-20250514',
    'openai/gpt-4o',
    'google/gemini-2.0-flash',
    'gemini/gemini-pro',
    'groq/llama-3.3-70b-versatile',
    'together/llama-3.1-8b-instruct',
    'openrouter/anthropic/claude-3.5',
  ])('accepts a valid model string: %s', (model) => {
    expect(() => validateModelString(model)).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => validateModelString('')).toThrow(/Invalid model/);
  });

  it('rejects a model string missing the provider prefix', () => {
    expect(() => validateModelString('gpt-4o')).toThrow(/Invalid model format/);
  });

  it('rejects an unknown provider', () => {
    expect(() => validateModelString('unknown-provider/gpt-4o')).toThrow(
      /Unknown provider: "unknown-provider"/,
    );
  });

  it('rejects characters that are not allowed', () => {
    expect(() => validateModelString('openai/gpt 4o')).toThrow(/Invalid model format/);
    expect(() => validateModelString('openai/gpt<4o>')).toThrow(/Invalid model format/);
    expect(() => validateModelString('openai/')).toThrow(/Invalid model format/);
  });

  it('rejects a whitespace-only string', () => {
    expect(() => validateModelString('   ')).toThrow(/Invalid model format/);
  });
});

describe('setupOpenCode()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVersionOutput('opencode v1.2.3\n');
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

  it('returns existing path if opencode is already installed', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');

    const result = await setupOpenCode();

    expect(result).toBe('/usr/local/bin/opencode');
  });

  it('uses cached binary when checksum matches', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.2.0/linux-x64');
    mockComputeSha256.mockResolvedValue('abc123');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('.checksum') || p.endsWith('opencode'),
    );
    (fsModule.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('abc123\n');

    const result = await setupOpenCode('v1.2.0');

    expect(result).toBe('/cache/opencode/1.2.0/linux-x64/opencode');
    expect(mockDownloadTool).not.toHaveBeenCalled();
  });

  it('re-downloads when cached binary checksum mismatches', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.2.0/linux-x64');
    mockComputeSha256.mockResolvedValue('def456');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('.checksum') || p.endsWith('opencode'),
    );
    (fsModule.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('abc123\n');

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

    const result = await setupOpenCode('v1.2.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalled();
  });

  it('re-downloads when cached binary has no checksum file', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.2.0/linux-x64');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

    const result = await setupOpenCode('v1.2.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalled();
  });

  it('degrades to an anonymous lookup when the authenticated release request returns 403', async () => {
    mockIoWhich.mockResolvedValue(null);
    const releaseBody = {
      tag_name: 'v1.2.0',
      assets: [
        {
          name: 'opencode-linux-x64.tar.gz',
          browser_download_url: 'https://example.com/opencode-linux-x64.tar.gz',
        },
      ],
    };
    mockFetch
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(releaseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');
    mockComputeSha256.mockResolvedValue('bin-checksum-123');

    const prevToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'some-token';
    try {
      const result = await setupOpenCode('v1.2.0');
      expect(result).toBe('/tmp/opencode-cached/opencode');
    } finally {
      if (prevToken === undefined) {
        process.env.GITHUB_TOKEN = undefined;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
    }

    // The first (authenticated) attempt fails fast, and the anonymous fallback succeeds.
    const firstInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(firstInit.headers).toMatchObject({ Authorization: 'Bearer some-token' });
    const secondInit = mockFetch.mock.calls[1][1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('downloads and verifies with release checksum asset', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

    const result = await setupOpenCode('v1.2.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalledTimes(2);
    expect(mockVerifyChecksum).toHaveBeenCalled();
  });

  it('throws when checksum does not match', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

    await expect(setupOpenCode('v1.2.0')).rejects.toThrow('Checksum mismatch');
  });

  it('falls back to known checksum when no release checksum asset', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

    const result = await setupOpenCode('v1.2.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockGetKnownChecksum).toHaveBeenCalled();
    expect(mockVerifyChecksum).toHaveBeenCalled();
  });

  it('continues with warning when no checksum is available', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
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

    const result = await setupOpenCode('v1.2.0');

    expect(result).toBe('/tmp/opencode-cached/opencode');
    expect(mockDownloadTool).toHaveBeenCalled();
  });

  it('throws after a fresh download when the binary reports a version below the minimum', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');
    mockComputeSha256.mockResolvedValue('bin-checksum-123');
    mockVersionOutput('opencode v1.0.0\n');

    await expect(setupOpenCode('v1.2.0')).rejects.toThrow(/below the minimum/);
    expect(mockDownloadTool).toHaveBeenCalled();
  });

  it('throws for a cached binary that reports a version below the minimum', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('/cache/opencode/1.2.0/linux-x64');
    mockComputeSha256.mockResolvedValue('abc123');

    const fsModule = await import('fs');
    (fsModule.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('.checksum') || p.endsWith('opencode'),
    );
    (fsModule.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('abc123\n');
    mockVersionOutput('opencode v1.0.0\n');

    await expect(setupOpenCode('v1.2.0')).rejects.toThrow(/below the minimum/);
    expect(mockDownloadTool).not.toHaveBeenCalled();
  });
});

describe('configureGit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures git user name and email', () => {
    mockExecFileSync.mockReturnValue('');

    configureGit('test-user', 'test@example.com');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['config', '--local', 'user.name', 'test-user'],
      {},
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['config', '--local', 'user.email', 'test@example.com'],
      {},
    );
  });

  it('returns env vars when cwd is provided (isolated mode)', () => {
    mockExecFileSync.mockReturnValue('');

    const result = configureGit('test-user', 'test@example.com', 'ghp_token', '/tmp/test');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['config', '--local', 'user.name', 'test-user'],
      { cwd: '/tmp/test' },
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['config', '--local', 'user.email', 'test@example.com'],
      { cwd: '/tmp/test' },
    );
    expect(result).toBeDefined();
    expect(result).toHaveProperty('GIT_ASKPASS');
    expect(result).toHaveProperty('OPENCODE_CREDENTIAL_TOKEN', 'ghp_token');
    expect(result).toHaveProperty('GIT_AUTHOR_NAME', 'test-user');
    expect(result).toHaveProperty('GIT_AUTHOR_EMAIL', 'test@example.com');
    expect(result).toHaveProperty('GIT_COMMITTER_NAME', 'test-user');
    expect(result).toHaveProperty('GIT_COMMITTER_EMAIL', 'test@example.com');
  });

  it('does not set global process.env when cwd is provided', () => {
    mockExecFileSync.mockReturnValue('');

    const result = configureGit('test-user', 'test@example.com', 'ghp_token', '/tmp/test');

    // Result should be an object (not undefined as in global mode)
    expect(result).toBeInstanceOf(Object);
    // The function returns the env instead of setting process.env
    expect(result?.GIT_AUTHOR_NAME).toBe('test-user');
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

  it('passes cwd to execFileSync when provided', () => {
    mockExecFileSync.mockReturnValue(' M src/test.ts\n');

    const result = getGitStatus('/tmp/test');

    expect(result).toBe(' M src/test.ts\n');
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      cwd: '/tmp/test',
    });
  });
});
