import type { LLMConfig, LLMProviderConfig, PromptConfig } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';

/**
 * Build the custom LLM provider configuration for the review engine by merging
 * the `.opencode-reviewer.yml` `llm:` section with the dedicated action inputs.
 *
 * Action inputs take precedence per field over config-file providers with the
 * same id: an unset input leaves the config-file value intact instead of
 * replacing the whole provider block, so mixing the two sources cannot drop
 * fields like `endpoint`, `apiKey`, `apiVersion`, or a model list. Configuring
 * an Azure deployment name or Bedrock model id also defaults the provider so
 * bare model names resolve to "azure/<deployment>" /
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
  if (inputs.llmBaseUrl) {
    // Register the OpenAI-compatible provider under the same id ('custom-openai')
    // used by every other path (env vars, docs, model selection) so the
    // documented "custom-openai/<model>" model id resolves for action inputs too.
    // Merge with any config-file entry so unset fields are preserved.
    providers['custom-openai'] = {
      ...(providers['custom-openai'] ?? {}),
      type: 'openai-compatible',
      ...(inputs.llmBaseUrl && { baseUrl: inputs.llmBaseUrl }),
      ...(inputs.llmApiKey && { apiKey: inputs.llmApiKey }),
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

  if (Object.keys(providers).length === 0 && !defaultProvider) return undefined;
  const llm: LLMConfig = {};
  if (defaultProvider) llm.defaultProvider = defaultProvider;
  if (Object.keys(providers).length > 0) llm.providers = providers;
  return llm;
}
