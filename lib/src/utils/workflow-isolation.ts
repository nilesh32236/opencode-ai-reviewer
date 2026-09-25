/**
 * Fail-closed primitives for the workflow secret-isolation boundary (issue #776, REF-006).
 *
 * Same-job `env -i` on a same-UID runner is NOT a sufficient security boundary:
 * untrusted code can read a secret-bearing parent through `/proc`, poison
 * `GITHUB_ENV`/`GITHUB_PATH`/`BASH_ENV` and local git config for later
 * credentialed steps, and substitute objects via `git replace`. The only
 * approved end state is the separate-job/artifact redesign (SEC-001): agent,
 * verification, and publish run on isolated runners with patch/bundle
 * artifacts between them.
 *
 * This module is intentionally narrow and additive. It provides pure,
 * deterministic, testable helpers that the future separate-job workflows (and
 * their shell ports) can share, without changing model routing, free-model
 * policy, or paid-model behavior:
 *
 * - Verification child environments are BUILT from an explicit allowlist (never
 *   by rejecting secret-shaped names alone) and never carry a
 *   credential-bearing `HOME`/OpenCode auth directory into repo-controlled
 *   lifecycle commands.
 * - Trusted git operations use ephemeral auth, `GIT_NO_REPLACE_OBJECTS=1`, a
 *   clean git config context, and suppressed hooks (`core.hooksPath=/dev/null`).
 * - Provider-key selection for the model process is an explicit
 *   provider-to-key map that fails closed on unknown providers (no guessing
 *   from an untrusted model string, no silent substitution, no paid fallback).
 *
 * Residual risk (documented, not overstated): when the OpenCode model process
 * itself receives its one required provider key, OpenCode's own internal
 * model/tool subprocesses inherit that key. That inheritance is outside what
 * these helpers can prove away and is queued as a follow-up (SEC-001).
 */

/** Default model preserved by the workflows (no routing change). */
export const WORKFLOW_DEFAULT_MODEL = 'opencode/muse-spark-1.3-contributor-free';

/**
 * Exact environment variable names that must never reach verification or
 * lifecycle child environments.
 */
export const WORKFLOW_FORBIDDEN_ENV_NAMES: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'OPENCODE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  // Runner state-poisoning vectors: an agent-controlled step can append to
  // these files/vars to inject commands or PATH entries into later
  // credentialed steps in the same job. They must never be forwarded.
  'GITHUB_ENV',
  'GITHUB_PATH',
  'BASH_ENV',
  'ENV',
  // Credential-bearing git plumbing must stay on the trusted publish path only.
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'SSH_AUTH_SOCK',
]);

/**
 * Secret-shaped fragments that deny a scoped-prefix key even when it looks
 * like tool config (mirrors `app/src/utils/exec.ts` `SCOPED_PREFIX_DENY`).
 * Exact-allowlist keys are unaffected.
 */
export const WORKFLOW_SCOPED_PREFIX_DENY =
  /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|PROXY|CREDENTIAL|PRIVATE_KEY|COOKIE/i;

/**
 * Safe tool-config variables copied into verification child environments.
 * Deliberately excludes `HOME` (credential-bearing OpenCode auth dir risk —
 * callers pass a fresh `isolatedHome` instead), all `*TOKEN*`/`*SECRET*`/
 * `*KEY*` names, and every `GH_*`/`GITHUB_*` runner variable.
 */
export const WORKFLOW_VERIFY_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
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
  'GIT_TERMINAL_PROMPT',
  'NPM_CONFIG_CACHE',
  'PNPM_HOME',
  'COREPACK_HOME',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
]);

/**
 * Deterministic provider-to-key map for the single credential the OpenCode
 * model process receives. Unknown providers return null (fail closed). No
 * paid fallback, no silent substitution, no guessing from model substrings.
 */
export const WORKFLOW_PROVIDER_KEY_MAP: Readonly<Record<string, string>> = {
  opencode: 'OPENCODE_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/** Base env for trusted git operations (ephemeral-auth publish path only). */
export const TRUSTED_GIT_ENV_BASE: Readonly<Record<string, string>> = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * Git `-c` flags that disable repository-controlled hooks on the trusted
 * publish path. A PR-controlled workspace can replace hooks, so every trusted
 * `git commit`/`git push` must carry these (or run in a separate clean
 * workspace that never executed untrusted code).
 */
export const TRUSTED_GIT_CONFIG_ARGS: ReadonlyArray<string> = ['-c', 'core.hooksPath=/dev/null'];

/**
 * Options for {@link buildWorkflowVerifyEnv}.
 */
export interface WorkflowVerifyEnvOptions {
  /**
   * Fresh non-credential-bearing directory used as `HOME`/`XDG_CONFIG_HOME`/
   * `XDG_CACHE_HOME` for the child. Required: the source `HOME` is never
   * forwarded because it may contain OpenCode auth material.
   */
  isolatedHome: string;
}

/**
 * Options for {@link buildTrustedGitEnv}.
 */
export interface TrustedGitEnvOptions {
  /** Fresh non-credential-bearing home for the trusted git process. */
  isolatedHome: string;
  /** Path to an ephemeral askpass helper (never a persisted credential file). */
  askPassPath?: string;
}

/**
 * List forbidden secret-bearing keys present in a candidate environment.
 * @param env - Candidate child environment to inspect.
 * @returns Sorted forbidden key names present (empty when clean).
 */
export function getWorkflowForbiddenEnvKeys(env: Record<string, string | undefined>): string[] {
  const found: string[] = [];
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    if (WORKFLOW_FORBIDDEN_ENV_NAMES.has(key)) {
      found.push(key);
      continue;
    }
    const upper = key.toUpperCase();
    if (
      upper.includes('GITHUB_TOKEN') ||
      upper.includes('GH_TOKEN') ||
      upper === 'GITHUB_API_TOKEN'
    ) {
      found.push(key);
    }
  }
  return found.sort();
}

/**
 * Fail closed when a candidate child environment carries secrets.
 * @param env - Candidate child environment to inspect.
 * @throws {Error} When any forbidden secret-bearing key is present.
 */
export function assertNoWorkflowSecrets(env: Record<string, string | undefined>): void {
  const forbidden = getWorkflowForbiddenEnvKeys(env);
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to run repo-controlled command with secret-bearing env: ${forbidden.join(', ')}`,
    );
  }
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    if (
      (key.startsWith('NPM_CONFIG_') || key.startsWith('PNPM_') || key.startsWith('COREPACK_')) &&
      WORKFLOW_SCOPED_PREFIX_DENY.test(key)
    ) {
      throw new Error(
        `Refusing to run repo-controlled command with secret-shaped config key: ${key}`,
      );
    }
  }
}

/**
 * Build a verification child environment from an explicit allowlist.
 * Copies only safe tool-config variables from `source`, points `HOME` and
 * XDG locations at a fresh non-credential-bearing directory, disables
 * system/global git config lookup, and fails closed on any forbidden key or
 * secret-shaped scoped-config key that would otherwise be copied.
 * @param source - Source environment (e.g. `process.env`).
 * @param options - Requires `isolatedHome` (never forwards source `HOME`).
 * @returns Restricted child environment for repo-controlled lifecycle commands.
 * @throws {Error} When `isolatedHome` is missing or a forbidden key is present.
 */
export function buildWorkflowVerifyEnv(
  source: Record<string, string | undefined>,
  options: WorkflowVerifyEnvOptions,
): Record<string, string> {
  const isolatedHome = options?.isolatedHome?.trim() ?? '';
  if (isolatedHome === '') {
    throw new Error(
      'buildWorkflowVerifyEnv requires a fresh isolatedHome; source HOME is never forwarded.',
    );
  }
  const env: Record<string, string> = {};
  for (const key of WORKFLOW_VERIFY_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (WORKFLOW_VERIFY_ENV_ALLOWLIST.has(key)) continue;
    if (
      (key.startsWith('NPM_CONFIG_') || key.startsWith('PNPM_') || key.startsWith('COREPACK_')) &&
      !WORKFLOW_SCOPED_PREFIX_DENY.test(key)
    ) {
      env[key] = value;
    }
  }
  env.HOME = isolatedHome;
  env.XDG_CONFIG_HOME = `${isolatedHome}/.config`;
  env.XDG_CACHE_HOME = `${isolatedHome}/.cache`;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  assertNoWorkflowSecrets(env);
  return env;
}

/**
 * Resolve the single provider key name required for a model string.
 * Fails closed (null) for unknown providers so callers deny rather than fall
 * open with a guessed or substituted credential.
 * @param model - Model string in `provider/model` format (trusted workflow var).
 * @returns The required env-var name, or null when the provider is unknown.
 */
export function resolveWorkflowProviderKeyName(model: string): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (trimmed === '') return null;
  const provider = trimmed.split('/')[0]?.toLowerCase() ?? '';
  if (provider === '') return null;
  return WORKFLOW_PROVIDER_KEY_MAP[provider] ?? null;
}

/**
 * Build the minimal model-process environment: exactly one provider key plus
 * no GitHub/GitLab tokens. Fails closed when the provider is unknown or its
 * key value is missing/empty.
 * @param model - Model string in `provider/model` format (trusted workflow var).
 * @param source - Source environment holding the provider key value.
 * @returns Record with the single required provider key.
 * @throws {Error} When the provider is unknown or its key is missing/empty.
 */
export function buildWorkflowModelEnv(
  model: string,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const keyName = resolveWorkflowProviderKeyName(model);
  if (keyName === null) {
    throw new Error(
      `Unknown provider for model "${String(model)}": refusing to guess a credential (no fallback, no substitution).`,
    );
  }
  const value = source[keyName];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing required provider credential ${keyName}: failing closed.`);
  }
  return { [keyName]: value };
}

/**
 * Build the environment for trusted git publish operations (separate clean
 * step/job only — never in a workspace that executed untrusted code without
 * an artifact boundary). Disables `git replace` object substitution, system
 * git config, and terminal prompts; pins global/system config to `/dev/null`.
 * @param options - Requires `isolatedHome`; optional ephemeral `askPassPath`.
 * @returns Trusted git environment (no tokens embedded; auth via askpass only).
 * @throws {Error} When `isolatedHome` is missing.
 */
export function buildTrustedGitEnv(options: TrustedGitEnvOptions): Record<string, string> {
  const isolatedHome = options?.isolatedHome?.trim() ?? '';
  if (isolatedHome === '') {
    throw new Error('buildTrustedGitEnv requires a fresh isolatedHome.');
  }
  const env: Record<string, string> = {
    ...TRUSTED_GIT_ENV_BASE,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: `${isolatedHome}/.config`,
    XDG_CACHE_HOME: `${isolatedHome}/.cache`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  if (options?.askPassPath !== undefined && options.askPassPath.trim() !== '') {
    env.GIT_ASKPASS = options.askPassPath;
  }
  return env;
}

/**
 * Check that a trusted git argv suppresses repository-controlled hooks.
 * @param args - Full git argv (including `git` or starting at `-c`/subcommand).
 * @returns True when `core.hooksPath=/dev/null` suppression is present.
 */
export function hasTrustedGitHookSuppression(args: readonly string[]): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === '-c' && args[i + 1] === 'core.hooksPath=/dev/null') return true;
  }
  return false;
}
