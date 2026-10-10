/**
 * Single owner for restricted subprocess environments.
 *
 * Moved from `app/src/utils/exec.ts`: verification subprocesses execute
 * repo-controlled scripts, so they must receive only an allowlisted set of
 * environment variables — never the full `process.env` (which carries
 * `GITHUB_TOKEN`, provider API keys, and any workflow-exported secrets).
 * Both wrappers (`action/` via `execWithTimeout`, `app/` via `execProcess`)
 * must build child environments with {@link buildRestrictedEnv}.
 */

/** Env vars safe to expose to repo-controlled subprocesses. */
export const RESTRICTED_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
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

/** Caller-override keys permitted through {@link buildRestrictedEnv}. */
export const RESTRICTED_ENV_EXTRA_ALLOWLIST: ReadonlySet<string> = new Set([
  'GIT_ASKPASS',
  'GIT_TERMINAL_PROMPT',
]);

/**
 * Secret-shaped key fragments that must never pass the scoped-prefix copy.
 * `NPM_CONFIG_*` can carry auth material (scoped-registry tokens, proxy
 * credentials), so the prefix copy denies these explicitly. Exact-allowlist
 * keys above (e.g. `NPM_CONFIG_CACHE`) are unaffected.
 */
export const RESTRICTED_ENV_SCOPED_PREFIX_DENY =
  /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|PROXY|CREDENTIAL|PRIVATE_KEY|COOKIE/i;

/**
 * Build an explicit env allowlist for install/verify subprocesses that
 * execute repo-controlled lifecycle scripts (postinstall). Copies only
 * safe tool-config vars from `process.env` plus caller overrides, so
 * provider API keys and `GITHUB_TOKEN` never reach untrusted code.
 * @param extra - Caller overrides (only `GIT_ASKPASS`/`GIT_TERMINAL_PROMPT`
 * are accepted; any other key is dropped) applied after the allowlist.
 * @param source - Env source to copy from (defaults to `process.env`;
 * injectable for tests).
 * @returns Restricted env record for use as a subprocess `env`.
 */
export function buildRestrictedEnv(
  extra?: Record<string, string>,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RESTRICTED_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      (key.startsWith('NPM_CONFIG_') || key.startsWith('PNPM_') || key.startsWith('COREPACK_')) &&
      !RESTRICTED_ENV_SCOPED_PREFIX_DENY.test(key) &&
      value !== undefined
    ) {
      env[key] = value;
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && RESTRICTED_ENV_EXTRA_ALLOWLIST.has(key)) env[key] = value;
    }
  }
  return env;
}
