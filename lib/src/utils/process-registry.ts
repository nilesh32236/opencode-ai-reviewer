import * as cp from 'node:child_process';
import * as os from 'node:os';

/** Process signal used by the managed process-tree cleanup path. */
export type ManagedProcessSignal = 'SIGTERM' | 'SIGKILL';

interface ManagedProcessEntry {
  child: cp.ChildProcess;
  detached: boolean;
}

const managedProcesses = new Set<ManagedProcessEntry>();

/**
 * Register a child process group owned by this Node process.
 *
 * Callers must invoke the returned disposer when the child closes, errors, or
 * is otherwise reaped. The registry is process-wide so parent signal handlers
 * can terminate every active OpenCode and verification descendant.
 *
 * @param child - Child process returned by `spawn`.
 * @param options - Ownership metadata.
 * @param options.detached - Whether the child was spawned as a process-group leader.
 * @returns An idempotent disposer that removes the child from the registry.
 */
export function registerManagedProcess(
  child: cp.ChildProcess,
  options: { detached?: boolean } = {},
): () => void {
  const entry: ManagedProcessEntry = {
    child,
    detached: options.detached ?? true,
  };
  managedProcesses.add(entry);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    managedProcesses.delete(entry);
  };
  // ChildProcess normally emits `close`; the explicit disposer remains the
  // authoritative cleanup path for mocks and unusual stream implementations.
  child.once?.('close', dispose);
  child.once?.('error', dispose);
  return dispose;
}

/**
 * Terminate one managed child and its descendants when it owns a process group.
 * Falls back to the child handle when a test double or an unusual spawn path has
 * no usable process-group id.
 *
 * @param child - Child process to terminate.
 * @param signal - POSIX/Windows-compatible termination signal.
 * @returns True when a signal was delivered (or the child had already exited).
 */
export function terminateManagedProcessGroup(
  child: cp.ChildProcess,
  signal: ManagedProcessSignal,
): boolean {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  if (os.platform() === 'win32') {
    try {
      // /T includes descendants; /F is the Windows equivalent of SIGKILL.
      cp.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    } catch {
      try {
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    // OpenCode and verification commands are spawned detached, making pid a
    // process-group id. A negative pid targets the whole owned tree only.
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      // A mocked child or a process that lost its group id may still be alive.
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Terminate every currently registered process group.
 *
 * @param signal - Signal to deliver to all registered children.
 * @returns The number of children for which a signal was attempted.
 */
export function terminateAllManagedProcessGroups(signal: ManagedProcessSignal): number {
  let attempted = 0;
  for (const entry of [...managedProcesses]) {
    attempted += 1;
    if (entry.detached) {
      terminateManagedProcessGroup(entry.child, signal);
    } else {
      try {
        entry.child.kill(signal);
      } catch {
        // Best effort during process shutdown.
      }
    }
  }
  return attempted;
}

/** Return the number of active process groups owned by this process. */
export function activeManagedProcessCount(): number {
  return managedProcesses.size;
}

/** Clear registry bookkeeping for deterministic unit-test teardown. */
export function resetManagedProcessRegistryForTests(): void {
  managedProcesses.clear();
}
