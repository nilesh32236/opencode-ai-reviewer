import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  mockBuildMissingChecksumError,
  mockMarkIntegrityError,
  mockFetch,
  mockIsNetworkError,
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
  const _mockBuildMissingChecksumError = vi
    .fn()
    .mockImplementation((version: string, assetName: string, arch: string) =>
      Object.assign(
        new Error(
          `OpenCode integrity verification failed: no checksum available for ${assetName} ` +
            `(version ${version}, arch ${arch}) and require_opencode_checksum is enabled.`,
        ),
        { status: 422 },
      ),
    );
  const _mockMarkIntegrityError = vi.fn().mockImplementation((err: Error) => err);
  const _mockFetch = vi.fn();
  // Faithful subset of the real isNetworkError classifier (the real one is
  // covered in retry.test.ts); sufficient for exercising the resume wiring.
  const _mockIsNetworkError = vi.fn().mockImplementation((err: unknown) => {
    const text =
      typeof err === 'string'
        ? err
        : err instanceof Error
          ? `${err.message} ${(err as Error & { code?: unknown }).code ?? ''}`
          : String(err);
    return /network[_\s-]?error|fetch failed|econnrefused|econnreset|enotfound|etimedout|eai_again|socket|timed out|timeout/i.test(
      text,
    );
  });

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
    mockBuildMissingChecksumError: _mockBuildMissingChecksumError,
    mockMarkIntegrityError: _mockMarkIntegrityError,
    mockFetch: _mockFetch,
    mockIsNetworkError: _mockIsNetworkError,
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
  withRetryAndTimeout: vi.fn(
    async (fn: (signal: AbortSignal) => Promise<unknown>, _timeoutMs?: unknown, _opts?: unknown) =>
      fn(new AbortController().signal),
  ),
  isNetworkError: mockIsNetworkError,
}));

vi.mock('../src/utils/checksum.js', () => ({
  computeSha256: mockComputeSha256,
  findChecksumAsset: mockFindChecksumAsset,
  getKnownChecksum: mockGetKnownChecksum,
  parseChecksumFile: mockParseChecksumFile,
  verifyChecksum: mockVerifyChecksum,
  buildMissingChecksumError: mockBuildMissingChecksumError,
  markIntegrityError: mockMarkIntegrityError,
}));

// Mock fs to allow chmodSync on our fake paths without throwing ENOENT
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // Unique temp dirs per mkdtempSync call so per-run store isolation can be
  // asserted (each opencode run must get its own HOME).
  let mkdtempCounter = 0;
  return {
    ...actual,
    chmodSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    mkdtempSync: vi
      .fn()
      .mockImplementation((prefix: string) => `${prefix}mock-${++mkdtempCounter}`),
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

import { toV1ServersMap, toV2ServersMap } from '../src/mcp/servers.js';
import {
  buildLLMProviderMap,
  buildMCPConfigBlock,
  buildResumeArgs,
  buildReviewSubagent,
  buildV2SubagentDenyPermissions,
  checkHealth,
  configureGit,
  extractTaskId,
  getGitStatus,
  isMCPConfigRejection,
  isNetworkErrorOutput,
  isValidResumeTaskId,
  isVersionCompatible,
  llmApiKeysForModel,
  mergeMCPConfig,
  normalizeMCPConfigForVersion,
  normalizeSubagentPermissionsForVersion,
  parseOpenCodeVersion,
  resetOpenCodeState,
  resolveDualEmitMCP,
  resolveDualEmitSubagentPermissions,
  resolveOpenCodePath,
  resolveRequireChecksum,
  resolveResumeOnNetworkError,
  runOpenCode,
  setDualEmitMCP,
  setDualEmitSubagentPermissions,
  setLLMProviderConfig,
  setupOpenCode,
  shouldUseV2MCPServers,
  shouldUseV2SubagentPermissions,
  stripLegacyMCPKeys,
  stripProviderTimeoutOptions,
  stripV2ServersKey,
  validateModelString,
} from '../src/opencode.js';
import { activeManagedProcessCount } from '../src/utils/process-registry.js';

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
    stdin: {
      on: vi.fn(),
      end: vi.fn(),
    },
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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 35_001])(
    'rejects invalid timeoutMinutes %s before any setup or spawn',
    async (timeoutMinutes) => {
      await expect(runOpenCode('test', { model: 'openai/gpt-4', timeoutMinutes })).rejects.toThrow(
        /positive integer/,
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    },
  );

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

  it('allows an active child to exceed the old 20-minute threshold when no timeout is supplied', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('long valid run', { model: 'openai/gpt-4' });
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
      expect(killSpy).not.toHaveBeenCalled();

      proc.emitClose(0);
      const result = await resultPromise;
      expect(result.success).toBe(true);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 20000);

  it('runs concurrently with an isolated store per run (no shared-store race, no global lock)', async () => {
    const first = makeMockProcess();
    const second = makeMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const firstPromise = runOpenCode('first', { model: 'openai/gpt-4' });
    const secondPromise = runOpenCode('second', { model: 'openai/gpt-4' });

    // Both spawns start without waiting for each other: batch fan-out stays
    // concurrent (no process-wide serialization).
    for (let i = 0; i < 10 && mockSpawn.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Each run gets its own isolated HOME-backed store, distinct from the
    // ambient HOME and from each other — so concurrent runs (even across
    // processes) cannot race the embedded-store migrations.
    const firstEnv = mockSpawn.mock.calls[0][2].env as Record<string, string>;
    const secondEnv = mockSpawn.mock.calls[1][2].env as Record<string, string>;
    for (const env of [firstEnv, secondEnv]) {
      expect(env.HOME).toBeDefined();
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(env.HOME).toContain('opencode-home-');
      expect(env.XDG_DATA_HOME).toBeDefined();
      expect(env.XDG_CONFIG_HOME).toBeDefined();
      expect(env.XDG_CACHE_HOME).toBeDefined();
    }
    expect(firstEnv.HOME).not.toBe(secondEnv.HOME);

    first.emitClose(0);
    second.emitClose(0);
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
  });

  it('trims whitespace-padded model values before spawning', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: '  openai/gpt-4o  ' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[1]).toEqual(expect.arrayContaining(['--model', 'openai/gpt-4o']));
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
        timeoutMinutes: 1,
      });

      // Advance past setupOpenCode microtasks, then spawn runs synchronously
      await vi.advanceTimersByTimeAsync(0);

      const start = Date.now();
      while (mockSpawn.mock.calls.length === 0 && Date.now() - start < 1000) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(60_000);
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

  it('does not retry a timed-out child even when its output looks retryable', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('network_error before timeout', {
        model: 'openai/gpt-4',
        timeoutMinutes: 1,
        resumeOnNetworkError: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(10);
      }

      const dataHandlers = (proc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
        .filter(([event]) => event === 'data')
        .map(([, handler]) => handler as (data: Buffer) => void);
      for (const handler of dataHandlers) {
        handler(Buffer.from('network_error fetch failed'));
      }

      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
      proc.emitClose(null);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
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
        timeoutMinutes: 1,
      });

      // Advance past setupOpenCode microtasks, then spawn runs synchronously
      await vi.advanceTimersByTimeAsync(0);

      const start = Date.now();
      while (mockSpawn.mock.calls.length === 0 && Date.now() - start < 1000) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

      proc.emitClose(0);
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.terminationKind).toBe('timeout');
      expect(killSpy).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 20000);

  it('marks an active run cancelled when parent shutdown begins', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('parent shutdown', { model: 'openai/gpt-4' });
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(10);
      }

      const handler = process
        .listeners('SIGTERM')
        .find((listener) => String(listener).includes('handleParentSignal'));
      expect(handler).toBeDefined();
      (handler as () => void)();
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

      proc.emitClose(0);
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.terminationKind).toBe('cancelled');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      resetOpenCodeState();
    }
  });

  it('retains process ownership and retries when SIGKILL delivery fails', async () => {
    vi.useFakeTimers();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid, signal) => signal !== 'SIGKILL');
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('kill failure', {
        model: 'openai/gpt-4',
        timeoutMinutes: 1,
      });
      let settled = false;
      void resultPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(settled).toBe(false);
      expect(activeManagedProcessCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(2);
      expect(settled).toBe(false);
      expect(activeManagedProcessCount()).toBe(1);

      proc.emitClose(null);
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.terminationKind).toBe('timeout');
      expect(activeManagedProcessCount()).toBe(0);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      resetOpenCodeState();
    }
  });

  it('cancels an active child, cleans the abort listener, and does not retry', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');
    try {
      const proc = makeMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runOpenCode('cancel me', {
        model: 'openai/gpt-4',
        signal: controller.signal,
        resumeOnNetworkError: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(10);
      }

      controller.abort(new DOMException('cancelled by caller', 'AbortError'));
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
      proc.emitClose(null);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      removeListenerSpy.mockRestore();
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 20000);

  it('rejects an already-cancelled run before spawning a child', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled before start', 'AbortError'));

    const result = await runOpenCode('do not start', {
      model: 'openai/gpt-4',
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

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

  it('skips DATABASE_URL and non-Bedrock AWS_* from options.env with a warning', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      env: {
        CUSTOM_VAR: 'custom-value',
        DATABASE_URL: 'postgres://localhost/testdb',
        AWS_ACCESS_KEY_ID: 'AKIA-test',
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.CUSTOM_VAR).toBe('custom-value');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('AWS_ACCESS_KEY_ID'));
  });

  it('forwards options.env AWS_* when a Bedrock provider is configured', async () => {
    setLLMProviderConfig({
      providers: {
        bedrock: {
          type: 'bedrock',
          region: 'us-east-1',
          modelId: 'us.anthropic.claude-sonnet-4-5-v2:0',
        },
      },
    });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', {
      model: 'bedrock/my-model',
      env: {
        AWS_ACCESS_KEY_ID: 'AKIA-test',
        AWS_FOO_BAR: 'arbitrary',
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    // Allowlisted Bedrock key is forwarded with no skip warning for that key.
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA-test');
    expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('AWS_ACCESS_KEY_ID'));
    // Arbitrary AWS_* outside the Bedrock allowlist is still skipped.
    expect(env.AWS_FOO_BAR).toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('AWS_FOO_BAR'));
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

  it('dual-emits subagent permissions in OPENCODE_CONFIG_CONTENT by default, V2-only when disabled', async () => {
    // Probed CLI is 2.x here (V2-capable): both keys present by default.
    mockVersionOutput('opencode v2.0.0\n');
    const subagents = {
      'sec-reviewer': {
        description: 'reviewer',
        mode: 'subagent',
        permission: { edit: 'deny', bash: 'deny' },
      },
    };

    // Default: both keys present on a V2-capable CLI.
    const defaultProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(defaultProc);
    const defaultPromise = runOpenCode('test', { model: 'openai/gpt-4', subagents });
    await new Promise((resolve) => setImmediate(resolve));
    defaultProc.emitClose(0);
    await defaultPromise;
    const defaultEnv = mockSpawn.mock.calls[0][2].env;
    const defaultConfig = JSON.parse(defaultEnv.OPENCODE_CONFIG_CONTENT);
    expect(defaultConfig.agent['sec-reviewer'].permission).toEqual({
      edit: 'deny',
      bash: 'deny',
    });
    expect(defaultConfig.agent['sec-reviewer'].permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ]);

    // Opt-out: only the V2 array is emitted on V2-capable CLIs.
    const singleProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(singleProc);
    const singlePromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      subagents,
      dualEmitSubagentPermissions: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    singleProc.emitClose(0);
    await singlePromise;
    const singleEnv = mockSpawn.mock.calls[1][2].env;
    const singleConfig = JSON.parse(singleEnv.OPENCODE_CONFIG_CONTENT);
    expect(singleConfig.agent['sec-reviewer'].permission).toBeUndefined();
    expect(singleConfig.agent['sec-reviewer'].permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ]);
  });

  it('pipes a large prompt via stdin instead of argv (E2BIG prevention)', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    // 100 KiB prompt — exceeds the 96 KiB threshold
    const largePrompt = 'x'.repeat(100 * 1024);

    const resultPromise = runOpenCode(largePrompt, { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnArgs = spawnCall[1] as string[];
    const spawnOpts = spawnCall[2] as { stdio: string[] };

    // The large prompt must NOT be in argv
    expect(spawnArgs).not.toContain(largePrompt);
    // argv should still have run --auto --model <model>
    expect(spawnArgs).toEqual(['run', '--auto', '--model', 'openai/gpt-4']);

    // stdio[0] must be 'pipe' so the caller can write to stdin
    expect(spawnOpts.stdio[0]).toBe('pipe');
    // stdout/stderr remain piped as before
    expect(spawnOpts.stdio[1]).toBe('pipe');
    expect(spawnOpts.stdio[2]).toBe('pipe');

    // The mock stdin.end must have been called with the full prompt
    expect(proc.stdin.end).toHaveBeenCalledWith(largePrompt, 'utf8');
    // The mock stdin.on must have been called to attach the EPIPE guard
    expect(proc.stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('keeps a small prompt in argv (no stdin piping)', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const smallPrompt = 'review this PR';

    const resultPromise = runOpenCode(smallPrompt, { model: 'openai/gpt-4' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnArgs = spawnCall[1] as string[];
    const spawnOpts = spawnCall[2] as { stdio: string[] };

    // Small prompt must be in argv
    expect(spawnArgs).toContain(smallPrompt);
    expect(spawnArgs).toEqual(['run', '--auto', '--model', 'openai/gpt-4', smallPrompt]);

    // stdio[0] must be 'ignore' (CI auto-approve path, small prompt)
    expect(spawnOpts.stdio[0]).toBe('ignore');

    // stdin.end must NOT have been called
    expect(proc.stdin.end).not.toHaveBeenCalled();
  });

  it('pipes large prompts via stdin regardless of autoApprove (E2BIG guard is size-gated)', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const largePrompt = 'x'.repeat(100 * 1024);

    const resultPromise = runOpenCode(largePrompt, {
      model: 'openai/gpt-4',
      autoApprove: false,
    });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnArgs = spawnCall[1] as string[];
    const spawnOpts = spawnCall[2] as { stdio: string[] };

    // Size-gated stdin piping: large prompts never ride argv (E2BIG), even
    // in interactive mode — piping takes precedence over TTY inherit.
    expect(spawnArgs).not.toContain(largePrompt);
    expect(spawnOpts.stdio[0]).toBe('pipe');
    expect(proc.stdin.end).toHaveBeenCalled();
  });
});

describe('LLM provider support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.2.3\n');
    mockExecGetExecOutput.mockResolvedValue({ stdout: 'opencode v1.0.0\n', stderr: '' });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v1.2.3' }),
    } as never);
    for (const key of [
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL',
      'OLLAMA_BASE_URL',
      'OLLAMA_MODEL',
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_API_VERSION',
      'DATABASE_URL',
    ]) {
      delete process.env[key];
    }
  });

  it('builds a provider map from openai-compatible and ollama providers in LLMConfig', () => {
    const map = buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          apiKey: '{env:INTERNAL_LLM_KEY}',
          models: ['qwen3-coder'],
        },
        ollama: { type: 'ollama', model: 'llama3' },
      },
    });
    expect(map).toEqual({
      gateway: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://llm.corp.example/v1', apiKey: '{env:INTERNAL_LLM_KEY}' },
        models: { 'qwen3-coder': {} },
      },
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://localhost:11434/v1' },
        models: { llama3: {} },
      },
    });
  });

  it('builds a provider map from LLM_BASE_URL / OLLAMA env vars', () => {
    process.env.LLM_BASE_URL = 'https://gateway.example/v1';
    process.env.LLM_API_KEY = 'secret';
    process.env.LLM_MODEL = 'qwen3-coder';
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434/v1';
    process.env.OLLAMA_MODEL = 'codellama';
    const map = buildLLMProviderMap(undefined);
    expect(map).toEqual({
      'custom-openai': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://gateway.example/v1', apiKey: '{env:LLM_API_KEY}' },
        models: { 'qwen3-coder': {} },
      },
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://localhost:11434/v1' },
        models: { codellama: {} },
      },
    });
  });

  it('merges the LLM provider map into OPENCODE_CONFIG_CONTENT', async () => {
    setLLMProviderConfig({
      providers: {
        ollama: { type: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      },
    });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'ollama/llama3' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(parsed.provider.ollama).toEqual({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://localhost:11434/v1' },
      models: { llama3: {} },
    });
  });

  it('forwards Azure credentials but not ambient AWS credentials to the subprocess', async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-test';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SESSION_TOKEN = 'token';
    process.env.AWS_PROFILE = 'test-profile';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'bearer-token';
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/tmp/token';
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123:role/test';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://res.openai.azure.com';
    // An azure run must forward AZURE_* but must NOT carry ambient AWS_*
    // credentials into the agent subprocess (audit authz).
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'azure/my-deployment' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.AWS_REGION).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.AWS_ROLE_ARN).toBeUndefined();
    expect(env.AZURE_OPENAI_API_KEY).toBe('azure-key');
    expect(env.AZURE_OPENAI_ENDPOINT).toBe('https://res.openai.azure.com');
  });

  it('forwards ambient AWS credentials only for bedrock provider runs', async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-test';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SESSION_TOKEN = 'token';
    process.env.AWS_PROFILE = 'test-profile';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'bearer-token';
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/tmp/token';
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123:role/test';
    setLLMProviderConfig({
      providers: {
        bedrock: {
          type: 'bedrock',
          region: 'us-east-1',
          modelId: 'us.anthropic.claude-sonnet-4-5-v2:0',
        },
      },
    });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'bedrock/my-model' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA-test');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret');
    expect(env.AWS_SESSION_TOKEN).toBe('token');
    expect(env.AWS_PROFILE).toBe('test-profile');
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-token');
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBe('/tmp/token');
    expect(env.AWS_ROLE_ARN).toBe('arn:aws:iam::123:role/test');
  });

  it('does not forward DATABASE_URL to the subprocess', async () => {
    // Dummy fixture value (no real credential): the test only asserts the key
    // is absent from the subprocess env.
    process.env.DATABASE_URL = 'postgres://localhost/testdb';
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'ollama/llama3' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('prefixes a bare model with the configured default provider', async () => {
    setLLMProviderConfig({ defaultProvider: 'ollama', providers: {} });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: '  llama3  ' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[1]).toEqual(expect.arrayContaining(['--model', 'ollama/llama3']));
  });

  it('translates an azure config block into AZURE_* env vars for the subprocess', async () => {
    // Ambient AWS credentials must not leak into a non-Bedrock run even when
    // an azure config block is present (audit authz).
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-test';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    setLLMProviderConfig({
      providers: {
        azure: {
          type: 'azure',
          endpoint: 'https://res.openai.azure.com',
          apiKey: 'azure-key',
          apiVersion: '2024-02-15-preview',
          deployment: 'my-deployment',
        },
      },
    });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'azure/my-deployment' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.AZURE_OPENAI_ENDPOINT).toBe('https://res.openai.azure.com');
    expect(env.AZURE_OPENAI_API_KEY).toBe('azure-key');
    expect(env.AZURE_OPENAI_API_VERSION).toBe('2024-02-15-preview');
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('forwards only allowlisted {env:VAR} references into the subprocess env', async () => {
    process.env.LLM_API_KEY = 'allowed-secret';
    process.env.INTERNAL_LLM_KEY = 'should-not-leak';
    setLLMProviderConfig({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          apiKey: '{env:LLM_API_KEY}',
        },
      },
    });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'gateway/qwen3-coder' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2].env;
    expect(env.LLM_API_KEY).toBe('allowed-secret');
    expect(env.INTERNAL_LLM_KEY).toBeUndefined();
  });

  it('warns and skips a {env:VAR} reference that is not on the forwarded allowlist', async () => {
    process.env.INTERNAL_LLM_KEY = 'secret';
    setLLMProviderConfig({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          apiKey: '{env:INTERNAL_LLM_KEY}',
        },
      },
    });
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'gateway/qwen3-coder' });

    await new Promise((resolve) => setImmediate(resolve));
    proc.emitClose(0);
    await resultPromise;

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('not on the allowlist'));
    const env = mockSpawn.mock.calls[0][2].env;
    expect(env.INTERNAL_LLM_KEY).toBeUndefined();
  });

  it('merges env-var providers into a config-file provider instead of replacing it', () => {
    process.env.OLLAMA_MODEL = 'codellama';
    process.env.OLLAMA_BASE_URL = 'http://ollama.corp:11434/v1';
    const map = buildLLMProviderMap({
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434/v1',
          models: ['llama3'],
        },
      },
    });
    expect(map).toEqual({
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://localhost:11434/v1' },
        models: { llama3: {}, codellama: {} },
      },
    });
  });

  it('warns when an openai-compatible provider apiKey is a literal value', () => {
    buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          apiKey: 'literal-secret',
        },
      },
    });
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('literal value and will be embedded'),
    );
  });

  it('does not warn when the openai-compatible provider apiKey uses {env:VAR}', () => {
    buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          apiKey: '{env:LLM_API_KEY}',
        },
      },
    });
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('literal value and will be embedded'),
    );
  });

  it('omits headerTimeout/chunkTimeout keys when no timeouts are configured', () => {
    const map = buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          models: ['qwen3-coder'],
        },
      },
    }) as Record<string, { options: Record<string, unknown> }>;
    expect(map.gateway.options).toEqual({ baseURL: 'https://llm.corp.example/v1' });
    expect(map.gateway.options).not.toHaveProperty('headerTimeout');
    expect(map.gateway.options).not.toHaveProperty('chunkTimeout');
  });

  it('emits headerTimeout/chunkTimeout options when timeouts are configured', () => {
    const map = buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          headerTimeoutMs: 30000,
          chunkTimeoutMs: 60000,
          models: ['qwen3-coder'],
        },
      },
    });
    expect(map).toEqual({
      gateway: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://llm.corp.example/v1',
          headerTimeout: 30000,
          chunkTimeout: 60000,
        },
        models: { 'qwen3-coder': {} },
      },
    });
  });

  it('omits timeout keys for invalid values and continues without error', () => {
    const map = buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          headerTimeoutMs: -1,
          chunkTimeoutMs: Number.NaN,
        },
      },
    }) as Record<string, { options: Record<string, unknown> }>;
    expect(map.gateway.options).toEqual({ baseURL: 'https://llm.corp.example/v1' });
  });

  it('rounds fractional timeouts to integers when emitting options', () => {
    const map = buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          headerTimeoutMs: 30000.6,
          chunkTimeoutMs: 60000.4,
          models: ['qwen3-coder'],
        },
      },
    }) as Record<string, { options: Record<string, unknown> }>;
    expect(map.gateway.options.headerTimeout).toBe(30001);
    expect(map.gateway.options.chunkTimeout).toBe(60000);
  });

  it('drops sub-millisecond timeouts that round to zero', () => {
    const map = buildLLMProviderMap({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          headerTimeoutMs: 0.4,
          chunkTimeoutMs: 0.2,
        },
      },
    }) as Record<string, { options: Record<string, unknown> }>;
    expect(map.gateway.options).toEqual({ baseURL: 'https://llm.corp.example/v1' });
  });

  it('stripProviderTimeoutOptions removes timeout keys and leaves other options intact', () => {
    const config = JSON.stringify({
      provider: {
        gateway: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'https://llm.corp.example/v1',
            headerTimeout: 30000,
            chunkTimeout: 60000,
          },
        },
      },
    });
    const stripped = JSON.parse(stripProviderTimeoutOptions(config)) as Record<
      string,
      Record<string, { options: Record<string, unknown> }>
    >;
    expect(stripped.provider.gateway.options).toEqual({
      baseURL: 'https://llm.corp.example/v1',
    });
    // No-op when no timeout keys are present (byte-identical output).
    const plain = JSON.stringify({ provider: {} });
    expect(stripProviderTimeoutOptions(plain)).toBe(plain);
    // Malformed JSON is returned unchanged (fail open).
    expect(stripProviderTimeoutOptions('not-json')).toBe('not-json');
  });

  it('retries once without timeout keys when the CLI rejects them', async () => {
    setLLMProviderConfig({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          headerTimeoutMs: 30000,
          chunkTimeoutMs: 60000,
          models: ['qwen3-coder'],
        },
      },
    });
    const firstProc = makeMockProcess();
    const secondProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const resultPromise = runOpenCode('test', { model: 'gateway/qwen3-coder' });
    await new Promise((resolve) => setImmediate(resolve));

    // First attempt emits the timeout keys.
    const firstEnv = mockSpawn.mock.calls[0][2].env;
    const firstConfig = JSON.parse(firstEnv.OPENCODE_CONFIG_CONTENT) as Record<
      string,
      Record<string, { options: Record<string, unknown> }>
    >;
    expect(firstConfig.provider.gateway.options.headerTimeout).toBe(30000);

    // Simulate an older CLI rejecting the unknown keys, then fail fast.
    const dataHandlers = (firstProc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === 'data')
      .map(([, handler]) => handler as (data: Buffer) => void);
    expect(dataHandlers.length).toBeGreaterThan(0);
    for (const handler of dataHandlers) {
      handler(Buffer.from('Error: Configuration is invalid: Unrecognized key "headerTimeout"'));
    }
    firstProc.emitClose(1);

    // Wait for the retry spawn, then succeed it.
    const start = Date.now();
    while (mockSpawn.mock.calls.length < 2 && Date.now() - start < 2000) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    secondProc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const secondEnv = mockSpawn.mock.calls[1][2].env;
    const secondConfig = JSON.parse(secondEnv.OPENCODE_CONFIG_CONTENT) as Record<
      string,
      Record<string, { options: Record<string, unknown> }>
    >;
    expect(secondConfig.provider.gateway.options).not.toHaveProperty('headerTimeout');
    expect(secondConfig.provider.gateway.options).not.toHaveProperty('chunkTimeout');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('retrying once without them'),
    );
  });

  it('uses one absolute deadline across provider compatibility retries', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      setLLMProviderConfig({
        providers: {
          gateway: {
            type: 'openai-compatible',
            baseUrl: 'https://llm.corp.example/v1',
            headerTimeoutMs: 30_000,
            models: ['qwen3-coder'],
          },
        },
      });
      const firstProc = makeMockProcess();
      const secondProc = makeMockProcess();
      mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

      const resultPromise = runOpenCode('test', {
        model: 'gateway/qwen3-coder',
        timeoutMinutes: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length === 0) {
        await vi.advanceTimersByTimeAsync(10);
      }

      // Consume most of the original budget before asking the compatibility
      // path to retry. A fresh per-attempt timer would reset the budget.
      await vi.advanceTimersByTimeAsync(40);
      const dataHandlers = (firstProc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
        .filter(([event]) => event === 'data')
        .map(([, handler]) => handler as (data: Buffer) => void);
      for (const handler of dataHandlers) {
        handler(Buffer.from('Error: Configuration is invalid: Unrecognized key "headerTimeout"'));
      }
      firstProc.emitClose(1);
      await vi.advanceTimersByTimeAsync(0);
      while (mockSpawn.mock.calls.length < 2) {
        await vi.advanceTimersByTimeAsync(1);
      }

      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      secondProc.emitClose(null);
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 20000);

  it('does not retry when CLI output merely mentions timeout keys without error context', async () => {
    setLLMProviderConfig({
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.corp.example/v1',
          headerTimeoutMs: 30000,
          models: ['qwen3-coder'],
        },
      },
    });
    const firstProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(firstProc);

    const resultPromise = runOpenCode('test', { model: 'gateway/qwen3-coder' });
    await new Promise((resolve) => setImmediate(resolve));

    const dataHandlers = (firstProc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === 'data')
      .map(([, handler]) => handler as (data: Buffer) => void);
    for (const handler of dataHandlers) {
      handler(Buffer.from('review note: headerTimeout mentioned in user code'));
    }
    firstProc.emitClose(1);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('resumeOnNetworkError', () => {
  const RESUME_ENV = 'INPUT_RESUME_ON_NETWORK_ERROR';
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.2.3\n');
    mockExecGetExecOutput.mockResolvedValue({ stdout: 'opencode v1.0.0\n', stderr: '' });
    savedEnv = process.env[RESUME_ENV];
    delete process.env[RESUME_ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[RESUME_ENV];
    } else {
      process.env[RESUME_ENV] = savedEnv;
    }
  });

  function emitStdout(proc: ReturnType<typeof makeMockProcess>, text: string): void {
    const dataHandlers = (proc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === 'data')
      .map(([, handler]) => handler as (data: Buffer) => void);
    expect(dataHandlers.length).toBeGreaterThan(0);
    for (const handler of dataHandlers) {
      handler(Buffer.from(text));
    }
  }

  async function waitForSpawns(count: number): Promise<void> {
    const start = Date.now();
    while (mockSpawn.mock.calls.length < count && Date.now() - start < 2000) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(mockSpawn).toHaveBeenCalledTimes(count);
  }

  it('resolveResumeOnNetworkError prefers the explicit option over the env fallback', () => {
    process.env[RESUME_ENV] = 'true';
    expect(resolveResumeOnNetworkError(true)).toBe(true);
    expect(resolveResumeOnNetworkError(false)).toBe(false);
    expect(resolveResumeOnNetworkError(undefined)).toBe(true);
    expect(resolveResumeOnNetworkError()).toBe(true);
    delete process.env[RESUME_ENV];
    expect(resolveResumeOnNetworkError(undefined)).toBe(false);
    expect(resolveResumeOnNetworkError()).toBe(false);
  });

  it('extractTaskId parses labeled and bare session ids and rejects unsafe input', () => {
    expect(extractTaskId('failed with network_error, task_id: abcd1234xyz')).toBe('abcd1234xyz');
    expect(extractTaskId('session_id=ses_abc12345 extra')).toBe('ses_abc12345');
    expect(extractTaskId('resuming ses_abc12345-def')).toBe('ses_abc12345-def');
    expect(extractTaskId('task_id: abc')).toBeUndefined();
    expect(extractTaskId('task_id: foo; rm -rf /')).toBeUndefined();
    expect(extractTaskId('plain output without ids')).toBeUndefined();
    expect(extractTaskId('')).toBeUndefined();
    expect(extractTaskId(undefined)).toBeUndefined();
    expect(extractTaskId(null)).toBeUndefined();
  });

  it('isValidResumeTaskId allowlists CLI-safe ids only', () => {
    expect(isValidResumeTaskId('ses_abc12345')).toBe(true);
    expect(isValidResumeTaskId('abcd1234')).toBe(true);
    expect(isValidResumeTaskId('abc')).toBe(false);
    expect(isValidResumeTaskId('foo;bar-baz01')).toBe(false);
    expect(isValidResumeTaskId('ses_abc 123')).toBe(false);
    expect(isValidResumeTaskId('')).toBe(false);
    expect(isValidResumeTaskId(undefined)).toBe(false);
  });

  it('buildResumeArgs inserts --session after run and preserves other flags', () => {
    expect(
      buildResumeArgs(['run', '--auto', '--model', 'openai/gpt-4', 'prompt'], 'ses_abc12345'),
    ).toEqual(['run', '--session', 'ses_abc12345', '--auto', '--model', 'openai/gpt-4', 'prompt']);
  });

  it('isNetworkErrorOutput delegates to the classifier and rejects empty input', () => {
    expect(isNetworkErrorOutput('boom: network_error fetching')).toBe(true);
    expect(isNetworkErrorOutput('review finished cleanly')).toBe(false);
    expect(isNetworkErrorOutput('')).toBe(false);
    expect(isNetworkErrorOutput(undefined)).toBe(false);
  });

  it('resumes by explicit taskId on network_error instead of a full rerun', async () => {
    const firstProc = makeMockProcess();
    const secondProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      resumeOnNetworkError: true,
      taskId: 'ses_abc12345',
    });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(firstProc, 'Error: network_error — fetch failed mid-run');
    firstProc.emitClose(1);

    await waitForSpawns(2);
    secondProc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const firstArgs = mockSpawn.mock.calls[0][1] as string[];
    const secondArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(firstArgs).not.toContain('--session');
    expect(secondArgs).toContain('--session');
    expect(secondArgs).toContain('ses_abc12345');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('resuming session'));
  });

  it('parses the taskId from failed output when no explicit taskId is given', async () => {
    const firstProc = makeMockProcess();
    const secondProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      resumeOnNetworkError: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(firstProc, 'network_error ECONNRESET (session_id: ses_xyz98765)');
    firstProc.emitClose(1);

    await waitForSpawns(2);
    secondProc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const secondArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(secondArgs).toContain('--session');
    expect(secondArgs).toContain('ses_xyz98765');
  });

  it('performs a normal full rerun when no taskId can be determined', async () => {
    const firstProc = makeMockProcess();
    const secondProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      resumeOnNetworkError: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(firstProc, 'network_error ECONNRESET before any session started');
    firstProc.emitClose(1);

    await waitForSpawns(2);
    secondProc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const secondArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(secondArgs).not.toContain('--session');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('retrying once as a full run'),
    );
  });

  it('fails open to a full run when the resume attempt does not recover', async () => {
    const firstProc = makeMockProcess();
    const resumeProc = makeMockProcess();
    const fullProc = makeMockProcess();
    mockSpawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(resumeProc)
      .mockReturnValueOnce(fullProc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      resumeOnNetworkError: true,
      taskId: 'ses_abc12345',
    });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(firstProc, 'network_error ECONNRESET');
    firstProc.emitClose(1);

    await waitForSpawns(2);
    // The resume attempt fails (e.g. unknown session): fail open to a full run.
    emitStdout(resumeProc, 'Error: session not found');
    resumeProc.emitClose(1);

    await waitForSpawns(3);
    fullProc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    const resumeArgs = mockSpawn.mock.calls[1][1] as string[];
    const fullArgs = mockSpawn.mock.calls[2][1] as string[];
    expect(resumeArgs).toContain('--session');
    expect(fullArgs).not.toContain('--session');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
  });

  it('does not retry when the flag is off, even on network_error output', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', { model: 'openai/gpt-4' });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(proc, 'network_error ECONNRESET');
    proc.emitClose(1);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-network failures when the flag is on', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const resultPromise = runOpenCode('test', {
      model: 'openai/gpt-4',
      resumeOnNetworkError: true,
      taskId: 'ses_abc12345',
    });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(proc, 'Error: prompt validation failed');
    proc.emitClose(1);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('picks up the flag from INPUT_RESUME_ON_NETWORK_ERROR when no explicit option is set', async () => {
    process.env[RESUME_ENV] = 'true';
    const firstProc = makeMockProcess();
    const secondProc = makeMockProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const resultPromise = runOpenCode('test', { model: 'openai/gpt-4' });
    await new Promise((resolve) => setImmediate(resolve));

    emitStdout(firstProc, 'network_error ECONNRESET');
    firstProc.emitClose(1);

    await waitForSpawns(2);
    secondProc.emitClose(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('validateModelString()', () => {
  it.each([
    'opencode/muse-spark-1.3-contributor-free',
    'opencode-go/muse-spark-1.3-contributor',
    'anthropic/claude-sonnet-4-20250514',
    'openai/gpt-4o',
    'google/gemini-2.0-flash',
    'gemini/gemini-pro',
    'groq/llama-3.3-70b-versatile',
    'together/llama-3.1-8b-instruct',
    'openrouter/anthropic/claude-3.5',
    'mistral/mistral-large',
    'xai/grok-4',
  ])('accepts a valid model string: %s', (model) => {
    expect(() => validateModelString(model)).not.toThrow();
  });

  it('accepts a valid model string with surrounding whitespace', () => {
    expect(() => validateModelString('  openai/gpt-4o  ')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => validateModelString('')).toThrow(/Invalid model/);
  });

  it('rejects a model string missing the provider prefix', () => {
    expect(() => validateModelString('gpt-4o')).toThrow(/Invalid model format/);
  });

  it('warns (without throwing) for a provider outside the known list', () => {
    expect(() => validateModelString('custom-provider/custom-model')).not.toThrow();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unknown provider "custom-provider"'),
    );
  });

  it('rejects characters that are not allowed', () => {
    expect(() => validateModelString('openai/gpt 4o')).toThrow(/Invalid model format/);
    expect(() => validateModelString('openai/gpt<4o>')).toThrow(/Invalid model format/);
    expect(() => validateModelString('openai/')).toThrow(/Invalid model format/);
  });

  it.each(['openai/gpt-4/', 'openrouter/anthropic/'])('rejects a trailing slash: %s', (model) => {
    expect(() => validateModelString(model)).toThrow(/Invalid model format/);
  });

  it('rejects a whitespace-only string', () => {
    expect(() => validateModelString('   ')).toThrow(/Invalid model/);
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
      const result = await setupOpenCode('v1.2.0', 'some-token');
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

  it('produces an actionable error message when the download times out', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockDownloadTool.mockRejectedValue(new Error('Download timed out after 120s'));

    const promise = setupOpenCode('v1.2.0');

    await expect(promise).rejects.toThrow(/network error/i);
    await expect(promise).rejects.toThrow(/re-run the workflow/i);
    await expect(promise).rejects.toThrow(/https:\/\/example\.com/);
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('Download timed out after 120s'),
    );
  });

  it('produces an actionable error message on an HTTP 5xx download failure', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockDownloadTool.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

    const promise = setupOpenCode('v1.2.0');

    await expect(promise).rejects.toThrow(/HTTP 503/);
    await expect(promise).rejects.toThrow(/transient server error/i);
    await expect(promise).rejects.toThrow(/re-run the workflow/i);
  });

  it('produces an actionable error message on an HTTP 4xx download failure', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockDownloadTool.mockRejectedValue(new Error('HTTP 404: Not Found'));

    const promise = setupOpenCode('v1.2.0');

    await expect(promise).rejects.toThrow(/HTTP 404/);
    await expect(promise).rejects.toThrow(/version tag exists/i);
  });

  it('produces an actionable error message on a checksum mismatch', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');

    mockFindChecksumAsset.mockReturnValue({
      name: 'opencode-linux-x64.tar.gz.sha256',
      browser_download_url: 'https://example.com/checksum.sha256',
    });
    mockParseChecksumFile.mockReturnValue('expected-hash-value');
    mockVerifyChecksum.mockRejectedValue(new Error('Checksum mismatch'));

    const promise = setupOpenCode('v1.2.0');

    await expect(promise).rejects.toThrow(/failed checksum verification/i);
    await expect(promise).rejects.toThrow(/corrupted download/i);
    await expect(promise).rejects.toThrow(/re-run the workflow/i);
  });

  it('produces an actionable error message when the release asset is missing', async () => {
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.2.0',
          assets: [
            {
              name: 'some-other-asset.tar.gz',
              browser_download_url: 'https://example.com/other.tar.gz',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const promise = setupOpenCode('v1.2.0');

    await expect(promise).rejects.toThrow(/Could not find asset/i);
    expect(core.error).toHaveBeenCalledWith(expect.stringContaining('Could not find asset'));
    expect(mockDownloadTool).not.toHaveBeenCalled();
  });

  it('fetches release metadata via withRetryAndTimeout with a 30s per-attempt timeout', async () => {
    const retry = await import('../src/utils/retry.js');
    const { RELEASE_FETCH_TIMEOUT_MS } = await import('../src/opencode.js');
    expect(RELEASE_FETCH_TIMEOUT_MS).toBe(30_000);
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
    mockDownloadTool.mockResolvedValue('/tmp/opencode.tar.gz');
    mockCacheDir.mockResolvedValue('/tmp/opencode-cached');
    mockFindChecksumAsset.mockReturnValue(null);
    mockGetKnownChecksum.mockReturnValue(null);
    mockComputeSha256.mockResolvedValue('stored-checksum');

    await setupOpenCode('v1.2.0');

    // Full per-attempt timeout/retry semantics are covered by retry.test.ts;
    // here we assert the release-metadata path is wired to that policy and
    // forwards a live AbortSignal to fetch.
    const mocked = retry.withRetryAndTimeout as ReturnType<typeof vi.fn>;
    expect(mocked).toHaveBeenCalled();
    const timeoutArg = mocked.mock.calls[0][1];
    expect(timeoutArg).toBe(RELEASE_FETCH_TIMEOUT_MS);
    const fetchInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('requireChecksum integrity gate', () => {
  const ENV_KEY = 'INPUT_REQUIRE_OPENCODE_CHECKSUM';
  let prevEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    mockVersionOutput('opencode v1.2.3\n');
    mockIoWhich.mockResolvedValue(null);
    mockToolFind.mockReturnValue('');
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
    mockComputeSha256.mockResolvedValue('stored-checksum');
    mockFindChecksumAsset.mockReturnValue(null);
    mockGetKnownChecksum.mockReturnValue(null);
    mockVerifyChecksum.mockResolvedValue(true);
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prevEnv;
    }
  });

  describe('resolveRequireChecksum()', () => {
    it('defaults to false when neither option nor env is set', () => {
      expect(resolveRequireChecksum()).toBe(false);
      expect(resolveRequireChecksum({})).toBe(false);
    });

    it('follows the INPUT_REQUIRE_OPENCODE_CHECKSUM env var', () => {
      process.env[ENV_KEY] = 'true';
      expect(resolveRequireChecksum()).toBe(true);
      expect(resolveRequireChecksum({})).toBe(true);
    });

    it('treats the env var case-insensitively with surrounding whitespace', () => {
      process.env[ENV_KEY] = ' True ';
      expect(resolveRequireChecksum()).toBe(true);
    });

    it('treats other env values as false', () => {
      process.env[ENV_KEY] = '1';
      expect(resolveRequireChecksum()).toBe(false);
    });

    it('lets an explicit option win over the env var', () => {
      process.env[ENV_KEY] = 'true';
      expect(resolveRequireChecksum({ requireChecksum: false })).toBe(false);
      process.env[ENV_KEY] = 'false';
      expect(resolveRequireChecksum({ requireChecksum: true })).toBe(true);
    });
  });

  describe('setupOpenCode() strict mode', () => {
    it('fails closed when no checksum is available and requireChecksum is set', async () => {
      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.toThrow(/no checksum available/);
      expect(mockBuildMissingChecksumError).toHaveBeenCalledWith(
        'v1.2.0',
        expect.any(String),
        expect.any(String),
      );
    });

    it('fails closed via the INPUT_REQUIRE_OPENCODE_CHECKSUM env var', async () => {
      process.env[ENV_KEY] = 'true';

      await expect(setupOpenCode('v1.2.0')).rejects.toThrow(/no checksum available/);
    });

    it('lets an explicit requireChecksum:false override the env var (warn-and-continue)', async () => {
      process.env[ENV_KEY] = 'true';

      const result = await setupOpenCode('v1.2.0', undefined, undefined, {
        requireChecksum: false,
      });

      expect(result).toBe('/tmp/opencode-cached/opencode');
      expect(mockBuildMissingChecksumError).not.toHaveBeenCalled();
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Skipping integrity verification'),
      );
    });

    it('tags checksum mismatches via markIntegrityError', async () => {
      mockFindChecksumAsset.mockReturnValue({
        name: 'opencode-linux-x64.tar.gz.sha256',
        browser_download_url: 'https://example.com/checksum.sha256',
      });
      mockParseChecksumFile.mockReturnValue('expected-hash-value');
      const mismatch = new Error(
        'Checksum mismatch for /tmp/opencode.tar.gz: expected expected-hash-value, got deadbeef',
      );
      mockVerifyChecksum.mockRejectedValue(mismatch);

      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.toThrow(/failed checksum verification/i);
      expect(mockMarkIntegrityError).toHaveBeenCalledWith(mismatch);
    });

    it('reports pin-or-disable recovery (not a blind retry) for fail-closed errors', async () => {
      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.toThrow(/Pin opencode_version.*require_opencode_checksum disabled/s);
      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.not.toThrow(/Please re-run the workflow to retry/);
    });

    it('falls back to pinned checksums when the checksum-file download fails', async () => {
      mockFindChecksumAsset.mockReturnValue({
        name: 'opencode-linux-x64.tar.gz.sha256',
        browser_download_url: 'https://example.com/checksum.sha256',
      });
      mockDownloadTool.mockReset();
      mockDownloadTool.mockResolvedValueOnce('/tmp/opencode.tar.gz');
      mockDownloadTool.mockRejectedValueOnce(new Error('network down'));
      mockGetKnownChecksum.mockReturnValue('pinned-hash');
      mockVerifyChecksum.mockResolvedValue(true);

      const result = await setupOpenCode('v1.2.0', undefined, undefined, {
        requireChecksum: true,
      });

      expect(result).toBe('/tmp/opencode-cached/opencode');
      expect(mockVerifyChecksum).toHaveBeenCalledWith('/tmp/opencode.tar.gz', 'pinned-hash');
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('falling back to pinned checksums'),
      );
    });

    it('fails closed when the checksum-file download fails and no pinned entry exists', async () => {
      mockFindChecksumAsset.mockReturnValue({
        name: 'opencode-linux-x64.tar.gz.sha256',
        browser_download_url: 'https://example.com/checksum.sha256',
      });
      mockDownloadTool.mockReset();
      mockDownloadTool.mockResolvedValueOnce('/tmp/opencode.tar.gz');
      mockDownloadTool.mockRejectedValueOnce(new Error('network down'));
      mockGetKnownChecksum.mockReturnValue(null);

      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.toThrow(/no checksum available/);
    });
  });

  describe('pre-installed binary bypass', () => {
    it('fails closed for the PATH binary when strict mode is on', async () => {
      mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');

      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.toThrow(/require_opencode_checksum.*already on PATH/s);
      expect(mockDownloadTool).not.toHaveBeenCalled();
    });

    it('stays silent about checksums for PATH binaries in default mode', async () => {
      mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
      // Use the tested version so the untested-CLI warning tier stays silent
      // and this assertion isolates checksum warnings.
      mockVersionOutput('opencode v1.18.31\n');

      const result = await setupOpenCode('v1.2.0');

      expect(result).toBe('/usr/local/bin/opencode');
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('resolveOpenCodePath fails closed for PATH binaries in strict mode', async () => {
      mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');

      await expect(
        resolveOpenCodePath('v1.2.0', undefined, { requireChecksum: true }),
      ).rejects.toThrow(/require_opencode_checksum.*already on PATH/s);
    });
  });

  describe('tool-cache bypass', () => {
    async function mockCacheHit(): Promise<void> {
      mockToolFind.mockReturnValue('/cache/opencode/1.2.0/linux-x64');
      mockComputeSha256.mockResolvedValue('abc123');
      const fsModule = await import('fs');
      (fsModule.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
        (p: string) => p.endsWith('.checksum') || p.endsWith('opencode'),
      );
      (fsModule.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('abc123\n');
    }

    it('fails closed for the cached binary when strict mode is on', async () => {
      await mockCacheHit();

      await expect(
        setupOpenCode('v1.2.0', undefined, undefined, { requireChecksum: true }),
      ).rejects.toThrow(/require_opencode_checksum.*cached OpenCode/s);
      expect(mockDownloadTool).not.toHaveBeenCalled();
    });

    it('stays silent about checksums for cached binaries in default mode', async () => {
      await mockCacheHit();
      // Use the tested version so the untested-CLI warning tier stays silent
      // and this assertion isolates checksum warnings.
      mockVersionOutput('opencode v1.18.31\n');

      const result = await setupOpenCode('v1.2.0');

      expect(result).toBe('/cache/opencode/1.2.0/linux-x64/opencode');
      expect(core.warning).not.toHaveBeenCalled();
    });
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

describe('subagent V2 permissions gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dual-emits both permission shapes on CLI 2.x by default', () => {
    for (const version of ['2.0.0', 'v2.0.0', '2.1.3']) {
      expect(shouldUseV2SubagentPermissions(version)).toBe(true);
      const def = buildReviewSubagent('reviewer', undefined, version);
      expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
      expect(def.permissions).toEqual(buildV2SubagentDenyPermissions());
      expect(def.permissions).toEqual([
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'deny' },
      ]);
    }
  });

  it('emits V1-only config on the whole 1.x line (V1 CLIs strictly reject the V2 key)', () => {
    // Regression: 1.18.30 (V1) exited 1 with "V2 permissions are not
    // supported by OpenCode V1" when the V2 array was dual-emitted.
    for (const version of ['1.1.1', 'v1.1.1', '1.2.0', '1.2.3', '1.18.30', 'v1.18.30']) {
      expect(shouldUseV2SubagentPermissions(version)).toBe(false);
      const def = buildReviewSubagent('reviewer', undefined, version);
      expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
      expect(def.permissions).toBeUndefined();
    }
  });

  it('uses gated single-shape behavior when dual-emit is disabled', () => {
    for (const version of ['2.0.0', 'v2.3.1']) {
      const def = buildReviewSubagent('reviewer', undefined, version, false);
      expect(def.permission).toBeUndefined();
      expect(def.permissions).toEqual([
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'deny' },
      ]);
    }
    for (const version of ['1.1.0', '1.0.5', 'v1.0.0', '1.1.1', '1.18.30']) {
      const def = buildReviewSubagent('reviewer', undefined, version, false);
      expect(def.permissions).toBeUndefined();
      expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
    }
  });

  it('emits the legacy object shape unchanged on older CLIs', () => {
    for (const version of ['1.1.0', '1.0.5', 'v1.0.0', '1.1.1', '1.18.30']) {
      expect(shouldUseV2SubagentPermissions(version)).toBe(false);
      const def = buildReviewSubagent('reviewer', 'openai/gpt-4', version);
      expect(def.permissions).toBeUndefined();
      expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
      expect(def.model).toBe('openai/gpt-4');
    }
  });

  it('treats pre-release 1.1.1-rc.1 as older (legacy shape)', () => {
    expect(shouldUseV2SubagentPermissions('1.1.1-rc.1')).toBe(false);
    expect(buildReviewSubagent('reviewer', undefined, '1.1.1-rc.1').permission).toEqual({
      edit: 'deny',
      bash: 'deny',
    });
  });

  it('fails open to legacy with a warning on unparseable versions', () => {
    for (const version of [undefined, null, '', '   ', 'latest', 'garbage'] as const) {
      expect(shouldUseV2SubagentPermissions(version)).toBe(false);
      const def = buildReviewSubagent('reviewer', undefined, version);
      expect(def.permissions).toBeUndefined();
      expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
    }
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('legacy permission shape'));
  });

  it('defaults to the last probed version at the runOpenCode choke point', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v1.18.30\n');
    await checkHealth();

    // No explicit version: the cached probe result drives the shape. A 1.x
    // probe must yield V1-only config (no `permissions` key).
    const def = buildReviewSubagent('reviewer');
    expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
    expect(def.permissions).toBeUndefined();

    const upgraded = normalizeSubagentPermissionsForVersion({
      'sec-reviewer': {
        description: 'reviewer',
        mode: 'subagent',
        permission: { edit: 'deny', bash: 'deny' },
      },
    });
    expect(upgraded['sec-reviewer'].permissions).toBeUndefined();
    expect(upgraded['sec-reviewer'].permission).toEqual({ edit: 'deny', bash: 'deny' });
  });

  it('dual-emits at the runOpenCode choke point for a probed 2.x CLI', async () => {
    mockIoWhich.mockResolvedValue('/usr/local/bin/opencode');
    mockVersionOutput('opencode v2.0.1\n');
    await checkHealth();

    const def = buildReviewSubagent('reviewer');
    expect(def.permission).toEqual({ edit: 'deny', bash: 'deny' });
    expect(def.permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ]);

    const upgraded = normalizeSubagentPermissionsForVersion({
      'sec-reviewer': {
        description: 'reviewer',
        mode: 'subagent',
        permission: { edit: 'deny', bash: 'deny' },
      },
    });
    expect(upgraded['sec-reviewer'].permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ]);
    expect(upgraded['sec-reviewer'].permission).toEqual({ edit: 'deny', bash: 'deny' });
  });

  it('replaces the legacy key with the V2 array when dual-emit is disabled', () => {
    const upgraded = normalizeSubagentPermissionsForVersion(
      {
        'sec-reviewer': {
          description: 'reviewer',
          mode: 'subagent',
          permission: { edit: 'deny', bash: 'deny' },
        },
      },
      'v2.0.0',
      false,
    );
    expect(upgraded['sec-reviewer'].permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ]);
    expect(upgraded['sec-reviewer'].permission).toBeUndefined();
  });

  it('leaves 1.x definitions untouched when dual-emit is disabled (gate off)', () => {
    const upgraded = normalizeSubagentPermissionsForVersion(
      {
        'sec-reviewer': {
          description: 'reviewer',
          mode: 'subagent',
          permission: { edit: 'deny', bash: 'deny' },
        },
      },
      'v1.18.30',
      false,
    );
    expect(upgraded['sec-reviewer'].permissions).toBeUndefined();
    expect(upgraded['sec-reviewer'].permission).toEqual({ edit: 'deny', bash: 'deny' });
  });

  it('passes through already-dual definitions untouched', () => {
    const input = {
      'sec-reviewer': {
        description: 'reviewer',
        mode: 'subagent',
        permission: { edit: 'deny', bash: 'deny' },
        permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
      },
    };
    const out = normalizeSubagentPermissionsForVersion(input, 'v1.2.3');
    expect(out['sec-reviewer']).toBe(input['sec-reviewer']);
  });

  it('honors the module default and env override for dual-emit', () => {
    expect(resolveDualEmitSubagentPermissions()).toBe(true);
    setDualEmitSubagentPermissions(false);
    expect(resolveDualEmitSubagentPermissions()).toBe(false);
    // Explicit per-call argument wins over the module default.
    expect(resolveDualEmitSubagentPermissions(true)).toBe(true);
    const def = buildReviewSubagent('reviewer', undefined, 'v2.0.0');
    expect(def.permission).toBeUndefined();
    expect(def.permissions).toEqual(buildV2SubagentDenyPermissions());

    setDualEmitSubagentPermissions(undefined);
    vi.stubEnv('OPENCODE_DUAL_EMIT_SUBAGENT_PERMISSIONS', 'false');
    try {
      expect(resolveDualEmitSubagentPermissions()).toBe(false);
      const envDef = buildReviewSubagent('reviewer', undefined, 'v2.0.0');
      expect(envDef.permission).toBeUndefined();
      expect(envDef.permissions).toEqual(buildV2SubagentDenyPermissions());
      // Explicit per-call argument wins over the env var.
      expect(buildReviewSubagent('reviewer', undefined, 'v2.0.0', true).permissions).toEqual(
        buildV2SubagentDenyPermissions(),
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(resolveDualEmitSubagentPermissions()).toBe(true);
  });

  it('leaves legacy blocks untouched when no version was ever probed', () => {
    const input = {
      'sec-reviewer': {
        description: 'reviewer',
        mode: 'subagent',
        permission: { edit: 'deny', bash: 'deny' },
      },
    };
    const out = normalizeSubagentPermissionsForVersion(input);
    expect(out['sec-reviewer'].permission).toEqual({ edit: 'deny', bash: 'deny' });
    expect(out['sec-reviewer'].permissions).toBeUndefined();
  });

  it('never throws from the gate path', () => {
    expect(() =>
      normalizeSubagentPermissionsForVersion(
        undefined as unknown as Record<string, Record<string, unknown>>,
      ),
    ).not.toThrow();
  });
});

describe('MCP dual-emit (mcp.servers)', () => {
  const servers = [
    {
      name: 'context7',
      type: 'local' as const,
      command: ['npx', '-y', 'ctx'],
      environment: { CONTEXT7_API_KEY: 'k' },
    },
  ];

  it('emits dual shape on unknown version and legacy-only on known V1', () => {
    const dual = buildMCPConfigBlock(servers, null);
    expect(dual.context7).toBeDefined();
    expect(dual.servers).toBeDefined();
    expect((dual.servers as Record<string, Record<string, unknown>>).context7.disabled).toBe(false);

    const legacy = buildMCPConfigBlock(servers, 'v1.9.0');
    expect(legacy.context7).toBeDefined();
    expect(legacy.servers).toBeUndefined();
  });

  it('emits dual by default on V2 and servers-only with dualEmit=false', () => {
    const dual = buildMCPConfigBlock(servers, 'v2.0.0');
    expect(dual.context7).toBeDefined();
    expect(dual.servers).toBeDefined();

    const single = buildMCPConfigBlock(servers, 'v2.0.0', false);
    expect(single.context7).toBeUndefined();
    expect(single.servers).toBeDefined();
  });

  it('gates shouldUseV2MCPServers fail-open for unknown versions', () => {
    expect(shouldUseV2MCPServers(null)).toBe(false);
    expect(shouldUseV2MCPServers('')).toBe(false);
    expect(shouldUseV2MCPServers('v1.9.0')).toBe(false);
    expect(shouldUseV2MCPServers('v2.0.0')).toBe(true);
  });

  it('passes empty mcp:{} through untouched', () => {
    const base = JSON.stringify({ mcp: {} });
    expect(normalizeMCPConfigForVersion(base, null)).toBe(base);
    expect(normalizeMCPConfigForVersion(base, 'v2.0.0')).toBe(base);
  });

  it('upgrades legacy-only blocks on unknown/V2 and leaves V1 alone', () => {
    const legacy = JSON.stringify({
      mcp: { context7: { type: 'local', command: ['npx'] } },
    });
    const upgraded = JSON.parse(normalizeMCPConfigForVersion(legacy, null));
    expect(upgraded.mcp.context7).toBeDefined();
    expect(upgraded.mcp.servers.context7.disabled).toBe(false);

    const v1 = JSON.parse(normalizeMCPConfigForVersion(legacy, 'v1.9.0'));
    expect(v1.mcp.servers).toBeUndefined();

    const single = JSON.parse(normalizeMCPConfigForVersion(legacy, 'v2.0.0', false));
    expect(single.mcp.context7).toBeUndefined();
    expect(single.mcp.servers.context7).toBeDefined();
  });

  it('downgrades already-dual inputs to servers-only with dualEmit=false on V2', () => {
    const dualInput = JSON.stringify({
      mcp: {
        context7: { type: 'local', command: ['npx'] },
        servers: { context7: { type: 'local', command: ['npx'], disabled: false } },
      },
    });
    const downgraded = JSON.parse(normalizeMCPConfigForVersion(dualInput, 'v2.0.0', false));
    expect(downgraded.mcp.context7).toBeUndefined();
    expect(downgraded.mcp.servers.context7).toBeDefined();
    // Default dual-emit keeps already-dual inputs unchanged.
    expect(normalizeMCPConfigForVersion(dualInput, 'v2.0.0')).toBe(dualInput);
  });

  it('merges a server list into a base config', () => {
    const out = JSON.parse(mergeMCPConfig(JSON.stringify({ model: 'x' }), servers, null));
    expect(out.mcp.context7).toBeDefined();
    expect(out.mcp.servers.context7.disabled).toBe(false);
    expect(mergeMCPConfig('not-json', servers, null)).toBe('not-json');
  });

  it('strips the correct side for retry', () => {
    const dualInput = JSON.stringify({
      mcp: {
        context7: { type: 'local' },
        servers: { context7: { type: 'local', disabled: false } },
      },
    });
    const serversOnly = JSON.parse(stripLegacyMCPKeys(dualInput));
    expect(serversOnly.mcp.context7).toBeUndefined();
    expect(serversOnly.mcp.servers.context7).toBeDefined();

    const legacyOnly = JSON.parse(stripV2ServersKey(dualInput));
    expect(legacyOnly.mcp.context7).toBeDefined();
    expect(legacyOnly.mcp.servers).toBeUndefined();
    // No servers key → unchanged.
    const legacyInput = JSON.stringify({ mcp: { context7: { type: 'local' } } });
    expect(stripV2ServersKey(legacyInput)).toBe(legacyInput);
  });

  it('matches only MCP-specific rejections', () => {
    expect(isMCPConfigRejection('strict: configuration is invalid for mcp block')).toBe(true);
    expect(isMCPConfigRejection('strict unknown field mcp.servers')).toBe(true);
    expect(isMCPConfigRejection('strict: unknown field disabled in mcp')).toBe(true);
    // Generic servers/permissions mentions without mcp must not trigger an MCP retry.
    expect(isMCPConfigRejection('strict: unknown field servers in agent config')).toBe(false);
    expect(isMCPConfigRejection('strict: unknown field permissions in subagent config')).toBe(
      false,
    );
    expect(isMCPConfigRejection('some unrelated error')).toBe(false);
    expect(isMCPConfigRejection(undefined)).toBe(false);
  });

  it('serializes V1 without disabled and V2 with disabled:false', () => {
    const v1 = toV1ServersMap(servers);
    expect(v1.context7.disabled).toBeUndefined();
    const v2 = toV2ServersMap(servers);
    expect(v2.context7.disabled).toBe(false);
  });

  it('resolves the OPENCODE_DUAL_EMIT_MCP opt-out', () => {
    expect(resolveDualEmitMCP()).toBe(true);
    vi.stubEnv('OPENCODE_DUAL_EMIT_MCP', 'false');
    try {
      expect(resolveDualEmitMCP()).toBe(false);
      expect(resolveDualEmitMCP(true)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    setDualEmitMCP(false);
    expect(resolveDualEmitMCP()).toBe(false);
    setDualEmitMCP(undefined);
    expect(resolveDualEmitMCP()).toBe(true);
  });
});

describe('llmApiKeysForModel (issue #544)', () => {
  it('scopes stock providers to their single key', () => {
    expect(llmApiKeysForModel('opencode/muse-spark-1.3')).toEqual(['OPENCODE_API_KEY']);
    expect(llmApiKeysForModel('openai/gpt-5')).toEqual(['OPENAI_API_KEY']);
    expect(llmApiKeysForModel('anthropic/claude-4')).toEqual(['ANTHROPIC_API_KEY']);
    expect(llmApiKeysForModel('gemini/gemini-3')).toEqual(['GEMINI_API_KEY']);
    expect(llmApiKeysForModel('google/gemini-3')).toEqual(['GEMINI_API_KEY']);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(llmApiKeysForModel('  OpenAI/gpt-5 ')).toEqual(['OPENAI_API_KEY']);
  });

  it('returns empty for custom/self-hosted providers (caller falls back)', () => {
    expect(llmApiKeysForModel('ollama/llama3')).toEqual([]);
    expect(llmApiKeysForModel('amazon-bedrock/anthropic.claude')).toEqual([]);
    expect(llmApiKeysForModel('azure/my-deployment')).toEqual([]);
    expect(llmApiKeysForModel('bare-model-no-slash')).toEqual([]);
  });
});
