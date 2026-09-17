import * as core from '@actions/core';
import type { LLMConfig, LLMProviderConfig, PromptConfig } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';

/**
 * Whether a hostname is a loopback/local address where cleartext http is
 * acceptable (local dev / sidecar gateways).
 * @param hostname - Lowercased hostname from URL parsing.
 * @returns True for localhost and loopback IPs.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  if (/^127\./.test(h)) {
    const parts = h.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return true;
  }
  return false;
}

/**
 * Whether an endpoint URL uses an allowed scheme: https always, http only for
 * loopback hosts. Unparsable URLs and non-http(s) schemes are rejected.
 * @param urlStr - Candidate endpoint URL.
 * @returns True when the scheme/host combination is acceptable.
 */
export function isAllowedEndpointScheme(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return isLoopbackHost(parsed.hostname);
  return false;
}

/**
 * Warn-and-drop decision for a final endpoint value. Emits a cleartext
 * warning for http on non-loopback hosts (kept for backward compatibility)
 * and drops unparsable / non-http(s) endpoints fail-closed.
 * @param kind - Field label for the warning ('baseUrl' or 'endpoint').
 * @param value - Endpoint value.
 * @param providerId - Provider entry id (for the warning).
 * @returns True when the value must be dropped.
 */
function shouldDropEndpoint(kind: string, value: string, providerId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    core.warning(
      `Dropping ${providerId} ${kind}: not a valid URL — workflow inputs are authoritative for LLM endpoints`,
    );
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    core.warning(
      `Dropping ${providerId} ${kind}: unsupported scheme "${parsed.protocol}" — expected https (http allowed only for localhost/loopback)`,
    );
    return true;
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    core.warning(
      `LLM endpoint for "${providerId}" uses cleartext http://${parsed.hostname} — apiKey values and code diffs will be transmitted unencrypted. Use https or a localhost/loopback gateway.`,
    );
    return false;
  }
  return false;
}

/**
 * Build the custom LLM provider configuration for the review engine.
 *
 * TRUST BOUNDARY: the `.opencode-reviewer.yml` `llm:` section lives in the PR
 * branch, so a PR author controls it. Network destinations from the config
 * file (`baseUrl`, `endpoint`, `resourceName`) are therefore IGNORED with a
 * warning — workflow inputs (`llm_base_url`, `ollama_base_url`,
 * `azure_openai_endpoint`) are authoritative. This guarantees a
 * workflow-secret `apiKey` is never paired with a config-file-supplied host
 * (LLM prompt/diff/key exfiltration). Non-network config fields (`type`,
 * `models`, `model`, `deployment`, `modelId`, `apiVersion`, timeouts,
 * `{env:}` apiKey refs) are preserved.
 *
 * Final `baseUrl`/`endpoint` values require https (http allowed only for
 * localhost/loopback); cleartext non-local http endpoints emit a warning.
 * @param inputs - Parsed action inputs (may lack LLM fields).
 * @param loadedConfig - Parsed config file, or null.
 * @returns An LLMConfig, or undefined when nothing is configured.
 */
export function buildLLMConfig(
  inputs: ActionInputs,
  loadedConfig: PromptConfig | null,
): LLMConfig | undefined {
  // Strip PR-branch-controlled network destinations before merging.
  const rawProviders = loadedConfig?.llm?.providers ?? {};
  const providers: Record<string, LLMProviderConfig> = {};
  for (const [id, entry] of Object.entries(rawProviders)) {
    if (!entry || typeof entry !== 'object') continue;
    const { baseUrl, endpoint, resourceName, ...rest } = entry as LLMProviderConfig & {
      baseUrl?: string;
      endpoint?: string;
      resourceName?: string;
    };
    if (baseUrl !== undefined || endpoint !== undefined || resourceName !== undefined) {
      core.warning(
        `Ignoring config-file LLM endpoint for "${id}": network destinations from .opencode-reviewer.yml (PR branch) are not trusted — workflow inputs are authoritative`,
      );
    }
    providers[id] = { ...(rest as LLMProviderConfig) };
  }
  const hasTimeoutInputs =
    inputs.llmHeaderTimeoutMs !== undefined || inputs.llmChunkTimeoutMs !== undefined;
  // A timeout-only input (no llm_base_url) would register a dead provider
  // entry with no baseUrl — skip creation in that case. Config-file baseUrl
  // values are untrusted (stripped above) and must not resurrect the entry.
  const hasCustomBaseUrl = inputs.llmBaseUrl?.trim();
  if (inputs.llmBaseUrl || (hasTimeoutInputs && hasCustomBaseUrl)) {
    // Register the OpenAI-compatible provider under the same id ('custom-openai')
    // used by every other path (env vars, docs, model selection) so the
    // documented "custom-openai/<model>" model id resolves for action inputs too.
    // Merge with any config-file entry so unset fields are preserved.
    providers['custom-openai'] = {
      ...(providers['custom-openai'] ?? {}),
      type: 'openai-compatible',
      ...(inputs.llmBaseUrl && { baseUrl: inputs.llmBaseUrl }),
      ...(inputs.llmApiKey && { apiKey: inputs.llmApiKey }),
      ...(inputs.llmHeaderTimeoutMs !== undefined && {
        headerTimeoutMs: inputs.llmHeaderTimeoutMs,
      }),
      ...(inputs.llmChunkTimeoutMs !== undefined && { chunkTimeoutMs: inputs.llmChunkTimeoutMs }),
    };
  }
  if (inputs.ollamaBaseUrl || inputs.ollamaModel) {
    providers.ollama = {
      ...(providers.ollama ?? {}),
      type: 'ollama',
      ...(inputs.ollamaBaseUrl && { baseUrl: inputs.ollamaBaseUrl }),
      ...(inputs.ollamaModel && { model: inputs.ollamaModel }),
    };
  }
  if (inputs.azureEndpoint || inputs.azureKey || inputs.azureDeployment) {
    providers.azure = {
      ...(providers.azure ?? {}),
      type: 'azure',
      ...(inputs.azureEndpoint && { endpoint: inputs.azureEndpoint }),
      ...(inputs.azureKey && { apiKey: inputs.azureKey }),
      ...(inputs.azureDeployment && { deployment: inputs.azureDeployment }),
    };
  }
  if (inputs.bedrockModelId || inputs.bedrockRegion) {
    providers.bedrock = {
      ...(providers.bedrock ?? {}),
      type: 'bedrock',
      ...(inputs.bedrockModelId && { modelId: inputs.bedrockModelId }),
      ...(inputs.bedrockRegion && { region: inputs.bedrockRegion }),
    };
  }

  let defaultProvider =
    inputs.llmDefaultProvider || loadedConfig?.llm?.defaultProvider || undefined;
  if (!defaultProvider) {
    if (inputs.azureDeployment) defaultProvider = 'azure';
    else if (inputs.bedrockModelId) defaultProvider = 'amazon-bedrock';
  }

  // Fail-closed scheme validation on final workflow-authoritative endpoints:
  // cleartext non-local http warns (backward compatible); unparsable or
  // non-http(s) endpoints drop the provider entry so secrets never go to an
  // unexpected destination. Dead OpenAI-compatible/Ollama entries with no
  // baseUrl after a drop are removed as well.
  for (const [id, entry] of Object.entries(providers)) {
    const baseUrl = (entry as LLMProviderConfig).baseUrl;
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
      if (shouldDropEndpoint('baseUrl', baseUrl, id)) {
        delete providers[id];
        continue;
      }
    }
    const endpoint = (entry as LLMProviderConfig).endpoint;
    if (typeof endpoint === 'string' && endpoint.trim()) {
      if (shouldDropEndpoint('endpoint', endpoint, id)) {
        delete providers[id];
        continue;
      }
    }
    const p = providers[id];
    if (p && (p.type === 'openai-compatible' || p.type === 'ollama') && !p.baseUrl?.trim()) {
      delete providers[id];
    }
  }
  if (defaultProvider && providers[defaultProvider] === undefined) {
    // Only clear defaults that reference a dropped custom provider id; bare
    // built-in names (e.g. "azure", "ollama") intentionally survive so a
    // deployment/model-only configuration still selects the provider.
    const knownCustomIds = new Set(Object.keys(rawProviders));
    if (knownCustomIds.has(defaultProvider)) {
      core.warning(
        `Ignoring defaultProvider "${defaultProvider}": its provider entry was dropped during endpoint validation`,
      );
      defaultProvider = undefined;
    }
  }

  if (Object.keys(providers).length === 0 && !defaultProvider) return undefined;
  const llm: LLMConfig = {};
  if (defaultProvider) llm.defaultProvider = defaultProvider;
  if (Object.keys(providers).length > 0) llm.providers = providers;
  return llm;
}
