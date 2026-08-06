import * as core from '@actions/core';
import type { LLMConfig, LLMProviderConfig, PromptConfig } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';

/**
 * Merge action-input overrides into the first existing provider of the same
 * `type` (regardless of its map id), creating the canonical entry only when no
 * such provider exists. The config file may declare an Azure/Bedrock provider
 * under an arbitrary id (e.g. `myazure`); `applyLLMEnvOverrides` applies
 * providers in insertion order with first-wins semantics, so without this a
 * second same-type entry created by the action inputs would never override the
 * config-file endpoint/key — action inputs must win per field instead.
 * @param providers - The provider map being built (config-file providers seeded).
 * @param type - The provider type targeted by the action inputs.
 * @param canonicalId - The id to register under when no same-type provider exists.
 * @param overrides - The action-input field values to overlay.
 */
function mergeByType(
  providers: Record<string, LLMProviderConfig>,
  type: LLMProviderConfig['type'],
  canonicalId: string,
  overrides: Partial<LLMProviderConfig>,
): void {
  const existingId = Object.keys(providers).find((id) => providers[id]?.type === type);
  const targetId = existingId ?? canonicalId;
  providers[targetId] = { ...(providers[targetId] ?? {}), ...overrides };
}

/**
 * Build the custom LLM provider configuration for the review engine by merging
 * the `.opencode-reviewer.yml` `llm:` section with the dedicated action inputs.
 *
 * Action inputs take precedence per field over config-file providers of the
 * same type: an unset input leaves the config-file value intact instead of
 * replacing the whole provider block, so mixing the two sources cannot drop
 * fields like `endpoint`, `apiKey`, `apiVersion`, or a model list. Configuring
 * an Azure deployment name or Bedrock model id (via input or config file) also
 * defaults the provider so bare model names resolve to "azure/<deployment>" /
 * "amazon-bedrock/<model-id>" (a single-config-change provider selection).
 * @param inputs - Parsed action inputs (may lack LLM fields).
 * @param loadedConfig - Parsed config file, or null.
 * @returns An LLMConfig, or undefined when nothing is configured.
 */
export function buildLLMConfig(
  inputs: ActionInputs,
  loadedConfig: PromptConfig | null,
): LLMConfig | undefined {
  const providers: Record<string, LLMProviderConfig> = {
    ...(loadedConfig?.llm?.providers ?? {}),
  };
  if (inputs.llmBaseUrl || inputs.llmApiKey) {
    // Register the OpenAI-compatible provider under the same id ('custom-openai')
    // used by every other path (env vars, docs, model selection) so the
    // documented "custom-openai/<model>" model id resolves for action inputs too.
    // Unlike azure/bedrock, the provider-map id determines model selection here,
    // so the canonical id is preserved rather than merged into a same-type entry.
    providers['custom-openai'] = {
      ...(providers['custom-openai'] ?? {}),
      type: 'openai-compatible',
      ...(inputs.llmBaseUrl && { baseUrl: inputs.llmBaseUrl }),
      ...(inputs.llmApiKey && { apiKey: inputs.llmApiKey }),
    };
    if (
      inputs.llmApiKey &&
      !Object.values(providers)
        .find((p) => p?.type === 'openai-compatible')
        ?.baseUrl?.trim()
    ) {
      core.warning(
        'llm_api_key was set without llm_base_url: the OpenAI-compatible provider has no ' +
          'base URL and cannot be used.',
      );
    }
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
    mergeByType(providers, 'azure', 'azure', {
      type: 'azure',
      ...(inputs.azureEndpoint && { endpoint: inputs.azureEndpoint }),
      ...(inputs.azureKey && { apiKey: inputs.azureKey }),
      ...(inputs.azureDeployment && { deployment: inputs.azureDeployment }),
    });
    const merged = Object.values(providers).find((p) => p?.type === 'azure');
    if (inputs.azureKey && !merged?.endpoint?.trim() && !merged?.resourceName?.trim()) {
      core.warning(
        'azure_openai_key was set without azure_openai_endpoint: the Azure provider has no ' +
          'endpoint and cannot be used.',
      );
    }
  }
  if (inputs.bedrockModelId || inputs.bedrockRegion) {
    mergeByType(providers, 'bedrock', 'bedrock', {
      type: 'bedrock',
      ...(inputs.bedrockModelId && { modelId: inputs.bedrockModelId }),
      ...(inputs.bedrockRegion && { region: inputs.bedrockRegion }),
    });
  }

  let defaultProvider =
    inputs.llmDefaultProvider?.trim() || loadedConfig?.llm?.defaultProvider?.trim() || undefined;
  if (!defaultProvider) {
    // Mirror parseInputs' effectiveDefaultProvider inference (including
    // config-file deployment/modelId) so llm.defaultProvider stays consistent
    // with the already-prefixed model strings the action computed at parse time.
    const configAzureDeployment = Object.values(loadedConfig?.llm?.providers ?? {})
      .find((p) => p?.type === 'azure' && p.deployment?.trim())
      ?.deployment?.trim();
    const configBedrockModelId = Object.values(loadedConfig?.llm?.providers ?? {})
      .find((p) => p?.type === 'bedrock' && p.modelId?.trim())
      ?.modelId?.trim();
    if (inputs.azureDeployment || configAzureDeployment) defaultProvider = 'azure';
    else if (inputs.bedrockModelId || configBedrockModelId) defaultProvider = 'amazon-bedrock';
    else if (inputs.ollamaModel || inputs.ollamaBaseUrl) defaultProvider = 'ollama';
    else if (inputs.llmBaseUrl) defaultProvider = 'custom-openai';
  }

  if (Object.keys(providers).length === 0 && !defaultProvider) return undefined;
  const llm: LLMConfig = {};
  if (defaultProvider) llm.defaultProvider = defaultProvider;
  if (Object.keys(providers).length > 0) llm.providers = providers;
  return llm;
}
