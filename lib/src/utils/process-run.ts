/**
 * Single owner for child-process defaults shared by `app/` exec helpers.
 *
 * `app/src/utils/exec.ts#execProcess` and `app/src/utils/git.ts#execGit`
 * previously duplicated env-merge / timeout / maxBuffer plumbing, so a
 * timeout/buffer/abort fix in one left the other hanging webhooks or
 * truncating output. These pure helpers own the defaults; both `app/`
 * wrappers thin-wrap them.
 */

/** Default kill timeout for generic child processes (10 minutes). */
export const DEFAULT_PROCESS_TIMEOUT_MS = 600_000;

/** Default kill timeout for git child processes (2 minutes). */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Default stdout/stderr buffer (20 MiB) before the process is killed. */
export const DEFAULT_PROCESS_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Merge extra env over `process.env` for a child process.
 * @param env - Extra variables (undefined returns `process.env` as-is).
 * @returns The merged environment map.
 */
export function mergeProcessEnv(
  env?: NodeJS.ProcessEnv | Record<string, string>,
): NodeJS.ProcessEnv {
  return env ? { ...process.env, ...env } : process.env;
}

/**
 * Resolve the effective timeout, falling back to the supplied default.
 * @param timeout - Caller-supplied timeout in milliseconds (or undefined).
 * @param fallback - Default applied when no timeout is given.
 * @returns The effective timeout in milliseconds.
 */
export function resolveProcessTimeout(timeout: number | undefined, fallback: number): number {
  return timeout ?? fallback;
}
