import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeManagedProcessCount,
  registerManagedProcess,
  resetManagedProcessRegistryForTests,
  terminateAllManagedProcessGroups,
} from '../src/utils/process-registry.js';

function fakeChild(pid: number): ChildProcess {
  return { pid, kill: vi.fn() } as unknown as ChildProcess;
}

describe('managed process-group registry', () => {
  afterEach(() => {
    resetManagedProcessRegistryForTests();
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

  it('falls back to the child handle for a non-detached spawn', () => {
    const child = fakeChild(0);
    registerManagedProcess(child, { detached: false });
    expect(terminateAllManagedProcessGroups('SIGKILL')).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
