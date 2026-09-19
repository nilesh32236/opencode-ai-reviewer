/**
 * Single owner for the workspace dependency-install matrix.
 *
 * Previously triplicated (`handleAutofixLoop` up-front install, pre-verify
 * install, `createAutofixPR` install) with drift: only the pre-verify copy
 * handled `lockfileVersion: 9` (`--frozen-lockfile`). A future
 * lockfile/pnpm-flag change needed 3 edits. All install flows must resolve
 * through {@link resolveInstallPlan} / {@link ensureWorkspaceDeps}.
 */

import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import * as path from 'node:path';

/** A single install step: program + args. */
export interface InstallPlan {
  program: 'pnpm' | 'npm';
  args: string[];
}

/** Options for {@link resolveInstallPlan}. */
export interface ResolveInstallPlanOptions {
  /** True when `pnpm-lock.yaml` exists in the workspace. */
  hasPnpmLock: boolean;
  /** True when `package-lock.json` exists in the workspace. */
  hasNpmLock: boolean;
  /** Raw `pnpm-lock.yaml` content (enables `lockfileVersion: 9` handling). */
  pnpmLockContent?: string;
}

/**
 * Resolve the install program/args for a workspace from its lockfiles.
 * Pure (no I/O) so unit tests cover the matrix without a filesystem.
 *
 * @param options - Lockfile presence + optional pnpm lock content.
 * @returns The install plan, or null when no supported lockfile exists.
 */
export function resolveInstallPlan(options: ResolveInstallPlanOptions): InstallPlan | null {
  if (options.hasPnpmLock) {
    const frozen = options.pnpmLockContent?.includes('lockfileVersion: 9') ?? false;
    return { program: 'pnpm', args: frozen ? ['install', '--frozen-lockfile'] : ['install'] };
  }
  if (options.hasNpmLock) {
    return { program: 'npm', args: ['ci'] };
  }
  return null;
}

/** Process runner seam (e.g. `app/src/utils/exec.ts#execProcess`). */
export type ExecProcessFn = (
  program: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
    isolateEnv?: boolean;
  },
) => Promise<unknown>;

/** Options for {@link ensureWorkspaceDeps}. */
export interface EnsureWorkspaceDepsOptions {
  /** Workspace root containing lockfiles. */
  cwd: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** Extra env merged into install/build processes. */
  env?: Record<string, string>;
  /**
   * When true, pass `isolateEnv` through to the `run` seam so the runner
   * must NOT merge `process.env` (repo-controlled install scripts never see
   * provider keys). Defaults to false for backward compatibility.
   */
  isolateEnv?: boolean;
  /** When true (default), build `@opencode-pr-agent/lib` after install. */
  buildLib?: boolean;
  /** Filesystem seams (tests). */
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, enc: string) => string;
  /** Process runner seam. Required when a lockfile exists. */
  run?: ExecProcessFn;
  /** Optional logger. */
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Install workspace dependencies per the single lockfile matrix, then build
 * the shared lib so workspace typechecks resolve `@opencode-pr-agent/lib`.
 *
 * @param options - Single options object (cwd, signal, seams).
 * @returns `{ installed: true }` when a lockfile was found and installed.
 */
export async function ensureWorkspaceDeps(
  options: EnsureWorkspaceDepsOptions,
): Promise<{ installed: boolean }> {
  const {
    cwd,
    signal,
    env,
    isolateEnv = false,
    buildLib = true,
    existsSync = defaultExistsSync,
    readFileSync = defaultReadFileSync as (p: string, enc: string) => string,
    run,
    logger,
  } = options;
  signal?.throwIfAborted();
  const pnpmLock = path.join(cwd, 'pnpm-lock.yaml');
  const npmLock = path.join(cwd, 'package-lock.json');
  const hasPnpmLock = existsSync(pnpmLock);
  const hasNpmLock = !hasPnpmLock && existsSync(npmLock);
  let pnpmLockContent: string | undefined;
  if (hasPnpmLock) {
    try {
      pnpmLockContent = readFileSync(pnpmLock, 'utf-8');
    } catch {
      pnpmLockContent = undefined;
    }
  }
  const plan = resolveInstallPlan({ hasPnpmLock, hasNpmLock, pnpmLockContent });
  if (!plan) {
    logger?.warn('No lockfile found in workspace — skipping dependency install');
    return { installed: false };
  }
  if (!run) return { installed: false };
  logger?.info(`Installing workspace dependencies (${plan.program} ${plan.args.join(' ')})...`);
  signal?.throwIfAborted();
  await run(plan.program, plan.args, {
    cwd,
    ...(env ? { env } : {}),
    timeout: 600_000,
    ...(signal ? { signal } : {}),
    ...(isolateEnv ? { isolateEnv: true as const } : {}),
  });
  if (buildLib) {
    logger?.info('Building lib for workspace...');
    signal?.throwIfAborted();
    await run('pnpm', ['--filter', '@opencode-pr-agent/lib', 'build'], {
      cwd,
      ...(env ? { env } : {}),
      timeout: 600_000,
      ...(signal ? { signal } : {}),
      ...(isolateEnv ? { isolateEnv: true as const } : {}),
    });
  }
  return { installed: true };
}
