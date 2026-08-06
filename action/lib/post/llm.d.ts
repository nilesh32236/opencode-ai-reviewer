import type { LLMConfig, PromptConfig } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
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
export declare function buildLLMConfig(inputs: ActionInputs, loadedConfig: PromptConfig | null): LLMConfig | undefined;
