import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from '@opencode-pr-agent/lib';

const logger = new Logger('Exec');

/** Options for cancellable non-blocking child process execution. */
export interface ExecProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

/** Result of {@link execProcess}. */
export interface ExecProcessResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a binary asynchronously (non-blocking) with timeout + AbortSignal
 * support, so long install/build/verification steps never stall the webhook
 * event loop.
 *
 * stdout/stderr tails are logged (debug on success, warn tail on failure) so
 * callers that ignore the return value don't lose debuggability.
 *
 * Falls back to `execFileSync` when only the sync mock exists (tests).
 * @param file - Binary to execute (e.g. 'git').
 * @param args - Arguments passed to the binary.
 * @param options - Execution options (timeout, env, AbortSignal).
 * @returns The process stdout and stderr tails.
 */
export async function execProcess(
  file: string,
  args: string[],
  options: ExecProcessOptions = {},
): Promise<ExecProcessResult> {
  options.signal?.throwIfAborted();
  const timeout = options.timeout ?? 600_000;
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  if (typeof execFile === 'function') {
    const execFileAsync = promisify(execFile);
    try {
      const res = (await execFileAsync(file, args, {
        cwd: options.cwd,
        env,
        timeout,
        signal: options.signal,
        maxBuffer: 20 * 1024 * 1024,
      })) as unknown as { stdout?: unknown; stderr?: unknown } | string | Buffer;
      // Real execFile (custom promisify) resolves { stdout, stderr }; a
      // callback-style mock without the custom symbol resolves the raw
      // stdout value instead — accept both shapes.
      const stdout =
        typeof res === 'string' || Buffer.isBuffer(res)
          ? String(res)
          : String((res as { stdout?: unknown })?.stdout ?? '');
      const stderr =
        typeof res === 'string' || Buffer.isBuffer(res)
          ? ''
          : String((res as { stderr?: unknown })?.stderr ?? '');
      if (stdout) logger.debug(`exec ${file} stdout tail: ${stdout.slice(-2000)}`);
      if (stderr) logger.debug(`exec ${file} stderr tail: ${stderr.slice(-2000)}`);
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
      const outTail = String(e?.stdout ?? '').slice(-2000);
      const errTail = String(e?.stderr ?? '').slice(-2000);
      logger.warn(
        `exec ${file} ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}${outTail ? ` stdout: ${outTail}` : ''}${errTail ? ` stderr: ${errTail}` : ''}`,
      );
      throw err;
    }
  }
  // Fallback for environments/tests that mock only execFileSync.
  const out = execFileSync(file, args, {
    cwd: options.cwd,
    env,
    timeout,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: String(out ?? ''), stderr: '' };
}
