import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger, resolveExecDefaults, sanitizeString } from '@opencode-pr-agent/lib';

const logger = new Logger('Exec');

/** Number of trailing chars of child-process output kept in logs. */
const EXEC_OUTPUT_TAIL_LIMIT = 2000;

/** Options for cancellable non-blocking child process execution. */
export interface ExecProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  /**
   * When true, do NOT merge `process.env` — only `env` is passed to the
   * child. Required for subprocesses that execute repo-controlled scripts
   * (dependency installs), so provider keys never reach untrusted code.
   */
  isolateEnv?: boolean;
}

/** Result of {@link execProcess}. */
export interface ExecProcessResult {
  stdout: string;
  stderr: string;
}

/**
 * Env vars safe to expose to repo-controlled install subprocesses are built by
 * lib's `buildRestrictedEnv` (shared with `action/src/utils.ts#execWithTimeout`),
 * which owns the allowlist, the scoped-prefix deny rule, and the git-auth
 * override pair. It is re-exported here so existing importers keep working.
 */
export { buildRestrictedEnv } from '@opencode-pr-agent/lib';

/**
 * Redact secret patterns from a subprocess output tail before logging, so
 * tokens embedded in URLs, npm auth errors, and diffs/PII never reach log
 * pipelines in the clear.
 * @param tail - Raw output tail (already truncated).
 * @returns The redacted tail.
 */
export function redactExecOutput(tail: string): string {
  return sanitizeString(tail);
}

/**
 * Run a binary asynchronously (non-blocking) with timeout + AbortSignal
 * support, so long install/build/verification steps never stall the webhook
 * event loop.
 *
 * stdout/stderr tails are logged (debug on success, warn tail on failure) so
 * callers that ignore the return value don't lose debuggability. All logged
 * tails and the interpolated command line are passed through
 * `sanitizeString` so secrets (tokens in URLs, npm auth errors) and PII
 * never reach operational log pipelines.
 *
 * Falls back to `execFileSync` when only the sync mock exists (tests).
 * @param file - Binary to execute (e.g. 'git').
 * @param args - Arguments passed to the binary.
 * @param options - Execution options (timeout, env, AbortSignal, isolateEnv).
 * @returns The process stdout and stderr tails.
 */
export async function execProcess(
  file: string,
  args: string[],
  options: ExecProcessOptions = {},
): Promise<ExecProcessResult> {
  options.signal?.throwIfAborted();
  // Shared defaults (env merge, 20 MiB buffer, abort passthrough) live in
  // lib/; the 10-minute caller default is preserved via the fallback arg.
  // `isolateEnv: true` skips the `process.env` merge for repo-controlled
  // install scripts (see autofix handler).
  const { env, maxBuffer, timeout } = resolveExecDefaults(options, 600_000);
  if (typeof execFile === 'function') {
    const execFileAsync = promisify(execFile);
    try {
      const res = (await execFileAsync(file, args, {
        cwd: options.cwd,
        env,
        timeout,
        signal: options.signal,
        maxBuffer,
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
      if (stdout)
        logger.debug(
          `exec ${file} stdout tail: ${redactExecOutput(stdout.slice(-EXEC_OUTPUT_TAIL_LIMIT))}`,
        );
      if (stderr)
        logger.debug(
          `exec ${file} stderr tail: ${redactExecOutput(stderr.slice(-EXEC_OUTPUT_TAIL_LIMIT))}`,
        );
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
      const outTail = redactExecOutput(String(e?.stdout ?? '').slice(-EXEC_OUTPUT_TAIL_LIMIT));
      const errTail = redactExecOutput(String(e?.stderr ?? '').slice(-EXEC_OUTPUT_TAIL_LIMIT));
      const safeCommand = sanitizeString(`${file} ${args.join(' ')}`);
      const safeMessage = sanitizeString(err instanceof Error ? err.message : String(err));
      logger.warn(
        `exec ${safeCommand} failed: ${safeMessage}${outTail ? ` stdout: ${outTail}` : ''}${errTail ? ` stderr: ${errTail}` : ''}`,
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
    maxBuffer,
  });
  const stdout = String(out ?? '');
  if (stdout)
    logger.debug(
      `exec ${file} stdout tail: ${redactExecOutput(stdout.slice(-EXEC_OUTPUT_TAIL_LIMIT))}`,
    );
  return { stdout, stderr: '' };
}
