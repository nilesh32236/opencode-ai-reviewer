/**
 * Workflow secret-isolation boundary for autonomous workflows (REF-006).
 *
 * Same-repository PR branches are untrusted code. Workflow steps that touch a
 * PR checkout tree (`opencode run --auto`, `pnpm build/typecheck/test/lint`)
 * execute repository-controlled lifecycle scripts and must not inherit
 * `GITHUB_TOKEN`/`GH_TOKEN`, provider API keys, or persisted git credentials.
 *
 * This module is the `lib`-owned port of the `app/src/utils/exec.ts`
 * `buildRestrictedEnv`/`isolateEnv` semantics, so shell workflow steps can
 * consume it via `node -e` without importing an `app` module into workflows:
 *
 * - Trust boundary: the OpenCode agent process receives exactly ONE provider
 *   credential (resolved deterministically from the configured model string).
 *   Verification/build/test/lint commands receive ZERO secrets via an explicit
 *   allowlist environment. Credentialed git/GitHub operations (`git push`,
 *   `gh pr create`) run only in separate trusted steps with an ephemeral
 *   ask-pass credential, hooks disabled, and no PR-controlled code on PATH.
 * - Fail-closed: unknown provider, missing key, smuggled secret, or failed
 *   credential setup throws/denies instead of falling open. No paid fallback,
 *   no silent substitution, no model-routing changes.
 *
 * Workflows themselves (`.github/workflows/*.yml`) cannot be edited from this
 * change; the exact step-split patch is proposed in `.fix-summary.md`. This
 * module provides the deterministic primitive those steps must call.
 */

/** Default model preserved from all current workflows. */
export const WORKFLOW_DEFAULT_MODEL = 'opencode/muse-spark-1.3-contributor-free' as const;

/**
 * Explicit provider-to-credential mapping.
 *
 * Keys are lowercase provider segments (`model.split('/')[0]`). Values are the
 * single environment variable name forwarded to the agent for that provider.
 * Unknown providers fail closed (throw) — never guess, never substitute.
 */
export const WORKFLOW_PROVIDER_KEY_MAP: Readonly<Record<string, string>> = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  cohere: 'COHERE_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
};

/**
 * All provider/GitHub secret names that must never reach verification.
 * Enumerated explicitly so tests can assert absence per variable.
 */
export const WORKFLOW_FORBIDDEN_SECRET_NAMES: ReadonlyArray<string> = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_PAT',
  'OPENCODE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  'COHERE_API_KEY',
  'CEREBRAS_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'LLM_API_KEY',
  'OLLAMA_API_KEY',
  'CONTEXT7_API_KEY',
  'GIT_ASKPASS',
  'GIT_HTTP_EXTRAHEADER',
  'GIT_CONFIG_COUNT',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
];

/**
 * Secret-shaped fragments that must never pass the scoped-prefix copy.
 * Mirrors `app/src/utils/exec.ts` `SCOPED_PREFIX_DENY`.
 */
const WORKFLOW_SCOPED_PREFIX_DENY =
  /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|PROXY|CREDENTIAL|PRIVATE_KEY|COOKIE/i;

/**
 * Forbidden key shape for verification environments.
 * Matches any secret-bearing name even if a new provider is added later.
 */
const WORKFLOW_FORBIDDEN_KEY_PATTERN =
  /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTH/i;

/**
 * Explicit allowlist for verification/build/test/lint child environments.
 *
 * Deliberately excludes `HOME` (may carry `~/.config/opencode/auth.json`),
 * `GITHUB_*`/`GH_*`, `*_API_KEY`, `GIT_ASKPASS`, and npm auth material.
 * Callers that need `HOME` must supply an isolated temp dir via `extra`.
 * Mirrors `app/src/utils/exec.ts` `RESTRICTED_ENV_ALLOWLIST` minus `HOME`,
 * `USER`, `LOGNAME`, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT` (handled below).
 */
export const WORKFLOW_VERIFY_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'CI',
  'TERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'NPM_CONFIG_CACHE',
  'PNPM_HOME',
  'COREPACK_HOME',
  'RUNNER_TEMP',
  'RUNNER_TOOL_CACHE',
  'GITHUB_WORKSPACE',
]);

/**
 * Caller-override keys permitted through `buildWorkflowVerifyEnv`.
 * `extra` exists for isolated `HOME` and tool-config only — an unrestricted
 * override record would let a future caller smuggle secrets past isolation.
 */
const WORKFLOW_VERIFY_EXTRA_ALLOWLIST: ReadonlySet<string> = new Set([
  'HOME',
  'GIT_TERMINAL_PROMPT',
  'NPM_CONFIG_CACHE',
  'PNPM_HOME',
  'COREPACK_HOME',
]);

/** Git config args that neutralize repo-controlled hooks in trusted steps. */
export const WORKFLOW_TRUSTED_GIT_CONFIG_ARGS: ReadonlyArray<string> = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];

/**
 * Resolve the single provider credential name for a model string.
 * @param model - Model string in `provider/model` format (defaults preserved by callers).
 * @returns Lowercase provider and required env var name.
 * @throws When the model is empty, malformed, or the provider is unmapped.
 */
export function resolveWorkflowProviderKey(model: string): { provider: string; keyName: string } {
  const trimmed = (model ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'workflow-isolation: empty model string — set vars.OPENCODE_MODEL or the default; refusing to guess a credential',
    );
  }
  const segments = trimmed.split('/');
  if (segments.length < 2 || !segments[0] || !segments[1]) {
    throw new Error(
      `workflow-isolation: malformed model "${trimmed}" — expected "provider/model"; refusing to guess a credential`,
    );
  }
  const provider = segments[0].toLowerCase();
  const keyName = WORKFLOW_PROVIDER_KEY_MAP[provider];
  if (!keyName) {
    throw new Error(
      `workflow-isolation: unknown provider "${provider}" for model "${trimmed}" — no credential mapping; refusing to substitute (no paid fallback)`,
    );
  }
  return { provider, keyName };
}

/**
 * Check whether an env key is forbidden in a verification environment.
 * @param key - Environment variable name.
 * @returns True when the key must never reach repo-controlled commands.
 */
export function isForbiddenWorkflowEnvKey(key: string): boolean {
  if (WORKFLOW_FORBIDDEN_SECRET_NAMES.includes(key)) return true;
  if (key === 'GH_TOKEN' || key.startsWith('GH_') || key.startsWith('GITHUB_')) {
    // GITHUB_WORKSPACE is an explicit safe path override, not a secret.
    if (key === 'GITHUB_WORKSPACE') return false;
    return true;
  }
  if (key === 'GIT_ASKPASS' || key === 'GIT_HTTP_EXTRAHEADER') return true;
  if (key.endsWith('_API_KEY') || key.endsWith('_APIKEY')) return true;
  if (WORKFLOW_FORBIDDEN_KEY_PATTERN.test(key)) return true;
  return false;
}

/**
 * Assert that an environment contains no secret-bearing keys.
 * @param env - Candidate child environment.
 * @throws When any forbidden key is present (fail-closed).
 */
export function assertWorkflowSafeEnv(env: Record<string, string | undefined>): void {
  const violations = Object.keys(env).filter((key) => isForbiddenWorkflowEnvKey(key));
  if (violations.length > 0) {
    throw new Error(
      `workflow-isolation: refusing to run repo-controlled command with secret-bearing env: ${violations.sort().join(', ')}`,
    );
  }
  // Scoped npm/pnpm auth material must never slip through either.
  const scopedViolations = Object.keys(env).filter(
    (key) =>
      (key.startsWith('NPM_CONFIG_') || key.startsWith('PNPM_') || key.startsWith('COREPACK_')) &&
      WORKFLOW_SCOPED_PREFIX_DENY.test(key),
  );
  if (scopedViolations.length > 0) {
    throw new Error(
      `workflow-isolation: refusing to run repo-controlled command with scoped auth env: ${scopedViolations.sort().join(', ')}`,
    );
  }
}

/**
 * Build an explicit allowlist environment for verification commands.
 *
 * Copies only safe tool-config vars from `source`, plus caller overrides for
 * isolated `HOME`/tool config. Fails closed when a forbidden var would pass.
 * @param source - Source environment (typically `process.env`).
 * @param extra - Caller overrides (only isolated HOME/tool-config accepted).
 * @returns Restricted env record for repo-controlled commands (zero secrets).
 */
export function buildWorkflowVerifyEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKFLOW_VERIFY_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = String(value);
  }
  // Scoped tool-config prefixes are safe by convention except secret-shaped keys.
  for (const [key, value] of Object.entries(source)) {
    if (
      (key.startsWith('NPM_CONFIG_') || key.startsWith('PNPM_') || key.startsWith('COREPACK_')) &&
      !WORKFLOW_SCOPED_PREFIX_DENY.test(key) &&
      !isForbiddenWorkflowEnvKey(key) &&
      value !== undefined &&
      !(key in env)
    ) {
      env[key] = String(value);
    }
  }
  // Verification never inherits ask-pass or git credential helpers (the
  // allowlist above excludes them, so no delete is needed).
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      if (!WORKFLOW_VERIFY_EXTRA_ALLOWLIST.has(key)) continue;
      if (isForbiddenWorkflowEnvKey(key)) continue;
      env[key] = String(value);
    }
  }
  // Deterministic safe default: git must never prompt for credentials.
  if (env.GIT_TERMINAL_PROMPT === undefined) env.GIT_TERMINAL_PROMPT = '0';
  assertWorkflowSafeEnv(env);
  return env;
}

/**
 * Build the minimal agent environment: safe base plus exactly one provider key.
 *
 * The agent process needs its provider credential to make model calls; it must
 * not receive `GITHUB_TOKEN`/`GH_TOKEN` or any other provider's key.
 * @param model - Configured model string (e.g. vars.OPENCODE_MODEL or default).
 * @param source - Source environment carrying secrets (workflow env).
 * @param options - Optional isolation settings.
 * @param options.isolatedHome - Isolated `OPENCODE_CONFIG_HOME`/HOME dir (never the runner HOME with auth.json).
 * @returns Agent child environment with exactly one credential.
 * @throws When the provider is unknown or its key is missing/empty.
 */
export function buildWorkflowAgentEnv(
  model: string,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { isolatedHome?: string } = {},
): Record<string, string> {
  const effectiveModel = (model ?? '').trim() || WORKFLOW_DEFAULT_MODEL;
  const { keyName } = resolveWorkflowProviderKey(effectiveModel);
  const raw = source[keyName];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new Error(
      `workflow-isolation: missing required credential ${keyName} for model "${effectiveModel}"; refusing to run agent without credentials (no fallback)`,
    );
  }
  const env = buildWorkflowVerifyEnv(source);
  env[keyName] = value;
  // Prove no other provider/GitHub secret leaked into the agent env.
  for (const forbidden of WORKFLOW_FORBIDDEN_SECRET_NAMES) {
    if (forbidden !== keyName && source[forbidden] !== undefined && env[forbidden] !== undefined) {
      throw new Error(
        `workflow-isolation: agent env must carry only ${keyName}; refusing with extra secret ${forbidden}`,
      );
    }
  }
  assertWorkflowSafeEnvExcept(env, new Set([keyName]));
  if (options.isolatedHome !== undefined) {
    if (!options.isolatedHome || options.isolatedHome.trim() === '') {
      throw new Error(
        'workflow-isolation: isolatedHome must be a non-empty directory when provided',
      );
    }
    env.HOME = options.isolatedHome;
  }
  return env;
}

/**
 * Assert safe env except for an explicit single-credential exception (agent case).
 * @param env - Candidate environment.
 * @param allowedSecrets - Exactly the provider keys permitted (size 0 or 1).
 */
function assertWorkflowSafeEnvExcept(
  env: Record<string, string | undefined>,
  allowedSecrets: ReadonlySet<string>,
): void {
  const violations = Object.keys(env).filter(
    (key) => !allowedSecrets.has(key) && isForbiddenWorkflowEnvKey(key),
  );
  if (violations.length > 0) {
    throw new Error(
      `workflow-isolation: agent env carries unexpected secrets: ${violations.sort().join(', ')}`,
    );
  }
}

/**
 * Build the trusted git/GitHub environment for post-agent push steps.
 *
 * Trusted steps run no repo-controlled code, disable hooks via
 * `WORKFLOW_TRUSTED_GIT_CONFIG_ARGS`, and use an ephemeral ask-pass helper.
 * @param token - GitHub token (must be non-empty; never logged).
 * @param askPassPath - Path to an ephemeral ask-pass script (must be non-empty).
 * @param source - Source env for safe tool-config passthrough.
 * @returns Trusted env for `git -c core.hooksPath=/dev/null push` / `gh` calls.
 * @throws When the token or ask-pass setup is missing (fail-closed, deny push).
 */
export function buildTrustedGitEnv(
  token: string,
  askPassPath: string,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!token || token.trim() === '') {
    throw new Error(
      'workflow-isolation: missing GitHub token for trusted push; refusing to push (fail-closed)',
    );
  }
  if (!askPassPath || askPassPath.trim() === '') {
    throw new Error(
      'workflow-isolation: missing GIT_ASKPASS path for trusted push; refusing to push (fail-closed)',
    );
  }
  const env = buildWorkflowVerifyEnv(source);
  env.GH_TOKEN = token;
  env.GIT_ASKPASS = askPassPath;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}
