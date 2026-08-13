import { execFile } from 'node:child_process';

/**
 * Options for {@link execGit}.
 */
export interface ExecGitOptions {
  /** Working directory for the git process. */
  cwd?: string;
  /** Extra environment variables merged over `process.env` for the git process. */
  env?: Record<string, string>;
  /** Maximum stdout/stderr buffer in bytes (default: 20 MiB). */
  maxBuffer?: number;
  /** Kill the git process after this many milliseconds (default: 120_000). */
  timeout?: number;
  /** AbortSignal that cancels the git process. */
  signal?: AbortSignal;
}

/** Result of a successful {@link execGit} invocation. */
export interface ExecGitResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a `git` command asynchronously via `child_process.execFile`, so long-
 * running operations (clone, push) never block the event loop.
 *
 * @param args - Arguments passed to the `git` binary.
 * @param options - Execution options (cwd, env, buffer, timeout, signal).
 * @returns The trimmed stdout and raw stderr on success.
 * @throws When git exits non-zero; the error carries `code`, `stdout`, and
 * `stderr` for diagnostics, and rethrows abort errors unmodified.
 */
export async function execGit(
  args: string[],
  options: ExecGitOptions = {},
): Promise<ExecGitResult> {
  const { cwd, env, maxBuffer = 20 * 1024 * 1024, timeout = 120_000, signal } = options;
  return new Promise<ExecGitResult>((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer,
        timeout,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as Error & { code?: number | string; stdout?: string; stderr?: string };
          if (!('stdout' in err)) err.stdout = stdout;
          if (!('stderr' in err)) err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
