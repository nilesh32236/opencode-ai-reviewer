import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger, resolveExecDefaults, sanitizeString } from '@opencode-pr-agent/lib';

const logger = new Logger('Exec');

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
 * Env vars safe to expose to repo-controlled install subprocesses.
 * Deliberately excludes provider keys (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * GEMINI_API_KEY, OPENCODE_API_KEY), GITHUB_TOKEN/GITLAB_TOKEN, and all
 * other secrets: installs run untrusted postinstall scripts, so only PATH,
 * locale/temp tool config plus explicit git overrides are forwarded.
 */
const RESTRICTED_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'CI',
  'GIT_ASKPASS',
  'GIT_TERMINAL_PROMPT',
  'NPM_CONFIG_CACHE',
  'PNPM_HOME',
  'COREPACK_HOME',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
]);

/**
 * Caller-override keys permitted through {@link buildRestrictedEnv}.
 * `extra` exists for the git-auth pair only — an unrestricted override
 * record would let a future caller smuggle secrets past env isolation.
 */
const EXTRA_ENV_ALLOWLIST = new Set(['GIT_ASKPASS', 'GIT_TERMINAL_PROMPT']);

/**
 * Secret-shaped key fragments that must never pass the scoped-prefix copy
 * below. `NPM_CONFIG_*` can carry auth material (scoped-registry tokens,
 * proxy credentials), so the prefix copy denies these explicitly.
 * Exact-allowlist keys above (e.g. `NPM_CONFIG_CACHE`) are unaffected.
 */
const SCOPED_PREFIX_DENY = /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|PROXY|CREDENTIAL|PRIVATE_KEY|COOKIE/i;

/**
 * Build an explicit env allowlist for install/verify subprocesses that
 * execute repo-controlled lifecycle scripts (postinstall). Copies only
 * safe tool-config vars from process.env plus caller overrides, so
 * provider API keys and GITHUB_TOKEN never reach untrusted code.
 * @param extra - Caller overrides (only GIT_ASKPASS/GIT_TERMINAL_PROMPT are
 * accepted; any other key is dropped) applied after the allowlist.
 * @returns Restricted env record for use with isolateEnv subprocesses.
 */
export function buildRestrictedEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RESTRICTED_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Scoped tool-config prefixes (npm/pnpm/corepack) are safe by convention,
  // except secret-shaped keys (registry auth tokens, proxy credentials).
  for (const [key, value] of Object.entries(process.env)) {
    if (
      (key.startsWith('NPM_CONFIG_') || key.startsWith('PNPM_') || key.startsWith('COREPACK_')) &&
      !SCOPED_PREFIX_DENY.test(key) &&
      value !== undefined
    ) {
      env[key] = value;
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && EXTRA_ENV_ALLOWLIST.has(key)) env[key] = value;
    }
  }
  return env;
}

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
        logger.debug(`exec ${file} stdout tail: ${redactExecOutput(stdout.slice(-2000))}`);
      if (stderr)
        logger.debug(`exec ${file} stderr tail: ${redactExecOutput(stderr.slice(-2000))}`);
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
      const outTail = redactExecOutput(String(e?.stdout ?? '').slice(-2000));
      const errTail = redactExecOutput(String(e?.stderr ?? '').slice(-2000));
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
  if (stdout) logger.debug(`exec ${file} stdout tail: ${redactExecOutput(stdout.slice(-2000))}`);
  return { stdout, stderr: '' };
}
