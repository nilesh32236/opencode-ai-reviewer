import * as cp from 'node:child_process';
import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

import {
  WINDOWS_TASKKILL_TIMEOUT_MS,
  activeManagedProcessCount,
  getWindowsTaskkillArgs,
  getWindowsTaskkillExecutable,
  registerManagedProcess,
  resetManagedProcessRegistryForTests,
  terminateAllManagedProcessGroups,
  terminateManagedProcessGroup,
} from '../src/utils/process-registry.js';

function fakeChild(pid: number): cp.ChildProcess {
  return { pid, kill: vi.fn() } as unknown as cp.ChildProcess;
}

describe('managed process-group registry', () => {
  afterEach(() => {
    resetManagedProcessRegistryForTests();
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(cp.execFileSync).mockReset();
    vi.restoreAllMocks();
  });

  it('tracks and removes active process groups', () => {
    const child = fakeChild(4242);
    const unregister = registerManagedProcess(child);
    expect(activeManagedProcessCount()).toBe(1);

    unregister();
    unregister();
    expect(activeManagedProcessCount()).toBe(0);
  });

  it('terminates every registered group with the requested signal', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    registerManagedProcess(fakeChild(4242));
    registerManagedProcess(fakeChild(4343));

    expect(terminateAllManagedProcessGroups('SIGTERM')).toBe(2);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-4343, 'SIGTERM');
  });

  it('uses the trusted System32 taskkill path and non-force SIGTERM arguments', () => {
    expect(getWindowsTaskkillExecutable('C:\\Windows')).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(getWindowsTaskkillArgs(4242, 'SIGTERM')).toEqual(['/PID', '4242', '/T']);
    expect(getWindowsTaskkillArgs(4242, 'SIGKILL')).toEqual(['/PID', '4242', '/T', '/F']);
    expect(WINDOWS_TASKKILL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WINDOWS_TASKKILL_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('never selects a repo-local taskkill executable', () => {
    const previousSystemRoot = process.env.SystemRoot;
    const previousPath = process.env.PATH;
    process.env.SystemRoot = 'C:\\Windows';
    process.env.PATH = '/repo/bin';
    vi.mocked(os.platform).mockReturnValue('win32');
    const execFileSync = vi.mocked(cp.execFileSync).mockReturnValue(Buffer.from(''));
    const child = fakeChild(4242);

    try {
      expect(terminateManagedProcessGroup(child, 'SIGTERM')).toBe(true);
      expect(execFileSync).toHaveBeenNthCalledWith(
        1,
        'C:\\Windows\\System32\\taskkill.exe',
        ['/PID', '4242', '/T'],
        expect.objectContaining({ timeout: WINDOWS_TASKKILL_TIMEOUT_MS }),
      );
      expect(terminateManagedProcessGroup(child, 'SIGKILL')).toBe(true);
      expect(execFileSync).toHaveBeenNthCalledWith(
        2,
        'C:\\Windows\\System32\\taskkill.exe',
        ['/PID', '4242', '/T', '/F'],
        expect.objectContaining({ timeout: WINDOWS_TASKKILL_TIMEOUT_MS }),
      );
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      process.env.SystemRoot = previousSystemRoot;
      process.env.PATH = previousPath;
    }
  });

  it('rejects taskkill resolution when SystemRoot is unavailable', () => {
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = undefined;
    try {
      expect(() => getWindowsTaskkillExecutable()).toThrow(/SystemRoot/);
    } finally {
      process.env.SystemRoot = previousSystemRoot;
    }
  });

  it('falls back to the child handle for a non-detached spawn', () => {
    const child = fakeChild(0);
    registerManagedProcess(child, { detached: false });
    expect(terminateAllManagedProcessGroups('SIGKILL')).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
