import * as core from '@actions/core';
import type { LLMConfig, LLMProviderConfig, PromptConfig } from '@opencode-pr-agent/lib';
import { stripUntrustedProviderEndpoints } from '@opencode-pr-agent/lib';
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
 * Warn-and-drop decision for a final endpoint value. Drops unparsable /
 * non-http(s) endpoints fail-closed, and drops cleartext http endpoints on
 * non-loopback hosts fail-closed unless the workflow explicitly opted in via
 * `llm_allow_insecure_http: true` (in which case it warns but keeps the
 * endpoint for backward compatibility with `http://ollama.corp`-style
 * gateways).
 * @param kind - Field label for the warning ('baseUrl' or 'endpoint').
 * @param value - Endpoint value.
 * @param providerId - Provider entry id (for the warning).
 * @param allowInsecureHttp - Explicit workflow opt-in for cleartext http.
 * @returns True when the value must be dropped.
 */
function shouldDropEndpoint(
  kind: string,
  value: string,
  providerId: string,
  allowInsecureHttp = false,
): boolean {
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
    if (allowInsecureHttp) {
      core.warning(
        `LLM endpoint for "${providerId}" uses cleartext http://${parsed.hostname} — apiKey values and full code diffs/prompts will be transmitted unencrypted on every run this opt-in is set (per-run acknowledgement via llm_allow_insecure_http: true). Migrate to https or a localhost/loopback gateway to expire this exposure.`,
      );
      return false;
    }
    core.warning(
      `Dropping ${providerId} ${kind}: cleartext http://${parsed.hostname} would transmit apiKey values and code diffs unencrypted — use https, a localhost/loopback gateway, or explicitly opt in with llm_allow_insecure_http: true`,
    );
    return true;
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
 * localhost/loopback); cleartext non-local http endpoints are dropped
 * fail-closed unless `inputs.llmAllowInsecureHttp` explicitly opts in
 * (warn-but-keep for `http://ollama.corp`-style gateways).
 * @param inputs - Parsed action inputs (may lack LLM fields).
 * @param loadedConfig - Parsed config file, or null.
 * @returns An LLMConfig, or undefined when nothing is configured.
 */
export function buildLLMConfig(
  inputs: ActionInputs,
  loadedConfig: PromptConfig | null,
): LLMConfig | undefined {
  // Strip PR-branch-controlled network destinations before merging. Shared with
  // the Probot app's `mergeRepoConfig` so the two wrappers cannot drift: the
  // guard previously existed only here, which is how `app/` shipped without one.
  // `rawProviders` keeps the pre-strip key set, which the default-provider
  // resolution below still needs in order to recognise a config-file provider id
  // even though its destination has been removed.
  const rawProviders = loadedConfig?.llm?.providers ?? {};
  const providers: Record<string, LLMProviderConfig> =
    stripUntrustedProviderEndpoints(
      rawProviders,
      (id) => {
        core.warning(
          `Ignoring config-file LLM endpoint for "${id}": network destinations from .opencode-reviewer.yml (PR branch) are not trusted — workflow inputs are authoritative`,
        );
      },
      (id, refName) => {
        core.warning(
          `Ignoring config-file LLM apiKey reference for "${id}": \`{env:${refName}}\` names a variable that is not allowlisted for LLM config references — workflow inputs are authoritative`,
        );
      },
    ) ?? {};
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

  // Ids present in `providers` at this point — after input registration but
  // BEFORE endpoint validation removes anything. Captured here because the
  // "is this default dangling?" check below has to distinguish a provider this
  // function actually registered and then dropped from a bare built-in name that
  // was never registered here. `rawProviders` alone cannot cover the input
  // registrations (custom-openai/ollama/azure/bedrock), and seeding the set with
  // literal built-in names cannot be used either: `bedrockModelId` registers the
  // provider as `bedrock` while the default name derived from it is
  // `amazon-bedrock`, and a bare `ollama` default with no ollama inputs is
  // deliberately left in place so a deployment/model-only config still selects
  // that provider.
  const registeredIds = new Set(Object.keys(providers));

  let defaultProvider =
    inputs.llmDefaultProvider || loadedConfig?.llm?.defaultProvider || undefined;
  if (!defaultProvider) {
    if (inputs.azureDeployment) defaultProvider = 'azure';
    else if (inputs.bedrockModelId) defaultProvider = 'amazon-bedrock';
  }

  // Fail-closed scheme validation on final workflow-authoritative endpoints:
  // unparsable, non-http(s), and (by default) cleartext non-local http
  // endpoints drop the provider entry so secrets never go to an unexpected
  // or unencrypted destination. The `llm_allow_insecure_http` opt-in
  // restores warn-but-keep for cleartext only. Dead OpenAI-compatible/Ollama
  // entries with no baseUrl after a drop are removed as well.
  const allowInsecureHttp = inputs.llmAllowInsecureHttp === true;
  for (const [id, entry] of Object.entries(providers)) {
    const baseUrl = (entry as LLMProviderConfig).baseUrl;
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
      if (shouldDropEndpoint('baseUrl', baseUrl, id, allowInsecureHttp)) {
        delete providers[id];
        continue;
      }
    }
    const endpoint = (entry as LLMProviderConfig).endpoint;
    if (typeof endpoint === 'string' && endpoint.trim()) {
      if (shouldDropEndpoint('endpoint', endpoint, id, allowInsecureHttp)) {
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
    // Clear a default that references a provider which no longer exists.
    //
    // Candidates are the ids this function could have registered and then lost:
    // the config-file ids (`rawProviders` — these are stripped before they ever
    // enter `providers`, so `registeredIds` cannot see them) plus the ids
    // registered from workflow inputs and captured in `registeredIds` before
    // endpoint validation ran.
    //
    // Considering only `rawProviders` meant a default naming an
    // input-registered provider survived the very drop this function performed —
    // e.g. `llm_default_provider: custom-openai` with `llm_base_url:
    // http://evil.example.com`, or `llm_default_provider: ollama` with
    // `ollama_model` alone (a model-only ollama entry has no baseUrl and is
    // removed as a dead entry). The dangling id was then emitted below and
    // `applyDefaultProvider` (lib/src/opencode.ts:2787) prefixed every bare
    // model with a provider that does not exist.
    //
    // Bare built-in names that were never registered here stay untouched: a
    // deployment/model-only configuration legitimately selects e.g. `ollama`
    // with no entry of its own.
    const knownCustomIds = new Set([...Object.keys(rawProviders), ...registeredIds]);
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
