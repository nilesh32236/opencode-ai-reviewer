/**
 * Single owner for the env allowlist applied to repo-controlled subprocesses.
 *
 * `app/src/utils/exec.ts` had this rule (and only this rule) while
 * `action/src/utils.ts#execWithTimeout` spawned verification subprocesses with
 * no `env` option at all, so every child inherited the full `process.env` —
 * GITHUB_TOKEN, OPENCODE_API_KEY, and every provider key the workflow exported
 * — even though the commands only ever need PATH plus a handful of tool-config
 * vars. Two wrappers, opposite isolation behavior, for the same class of
 * subprocess; verification commands execute repo-controlled scripts (postinstall
 * hooks, arbitrary `run_checks_after_fix`), which is precisely where a leaked
 * token is most damaging.
 *
 * Lives in `lib/` so `action/`, `app/`, and any future wrapper share one rule.
 */

/**
 * Env vars safe to expose to repo-controlled install/verify subprocesses.
 * Deliberately excludes provider keys (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * GEMINI_API_KEY, OPENCODE_API_KEY), GITHUB_TOKEN/GITLAB_TOKEN, and all other
 * secrets: installs run untrusted postinstall scripts, so only PATH,
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
 * safe tool-config vars from `process.env` plus caller overrides, so
 * provider API keys and GITHUB_TOKEN never reach untrusted code.
 * @param extra - Caller overrides (only GIT_ASKPASS/GIT_TERMINAL_PROMPT are
 * accepted; any other key is dropped) applied after the allowlist.
 * @returns Restricted env record for use with isolated subprocesses.
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
