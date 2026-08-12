import * as core from '@actions/core';

/**
 * Known model providers accepted (without warning) by validateModelString().
 * This is an informational allowlist: models with a provider outside this list
 * still pass validation but log a warning, since the OpenCode CLI supports many
 * more providers than listed here and the CLI remains the authority on whether
 * a provider/model combination is actually available.
 */
export const KNOWN_PROVIDERS = [
  'opencode',
  'opencode-go',
  'anthropic',
  'openai',
  'google',
  'gemini',
  'openrouter',
  'together',
  'groq',
  'mistral',
  'xai',
  'deepseek',
  'azure',
  'bedrock',
  'amazon-bedrock',
  'ollama',
  'custom-openai',
  'cohere',
  'cerebras',
  'fireworks',
  'perplexity',
] as const;

/**
 * Regex validating the "provider/model-name" model string format.
 *
 * The provider is the first slash-delimited segment and may contain hyphens.
 * Every subsequent path segment (including the final one) must start and end
 * with a valid model-name character, so trailing slashes such as
 * "openai/gpt-4/" or "openrouter/anthropic/" are rejected. A second slash is
 * permitted so nested model ids (e.g. "openrouter/anthropic/claude-3.5") work.
 */
export const MODEL_STRING_REGEX = /^[a-zA-Z][a-zA-Z0-9-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.\-+:]*)+$/;

/**
 * Validate a model string before invoking the OpenCode CLI.
 *
 * Fails fast with a clear error when the model is empty or malformed (not in
 * "provider/model-name" format) so an invalid configuration is reported before
 * any CLI cold-start cost is incurred. Unknown providers only log a warning:
 * the OpenCode CLI supports many providers and is the authority on whether a
 * given provider/model combination is available.
 *
 * The input is trimmed before validation so whitespace-padded values
 * (e.g. " openai/gpt-4o ") validate successfully.
 *
 * @param model - The model identifier to validate (e.g. "anthropic/claude-sonnet-4-20250514").
 * @throws {Error} When the model string is empty or malformed.
 */
export function validateModelString(model: string): void {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new Error(
      `Invalid model: "${String(model)}". Model must be a non-empty string in "provider/model-name" format. ` +
        `Examples: "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "opencode/deepseek-v4-flash-free".`,
    );
  }

  if (!MODEL_STRING_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid model format: "${trimmed}". Model must match "provider/model-name" pattern. ` +
        `Allowed characters: alphanumeric, hyphens, underscores, dots, colons, plus signs. ` +
        `Examples: "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "opencode/deepseek-v4-flash-free".`,
    );
  }

  const provider = trimmed.split('/')[0].toLowerCase();
  if (!KNOWN_PROVIDERS.includes(provider as (typeof KNOWN_PROVIDERS)[number])) {
    core.warning(
      `Unknown provider "${provider}" for model "${trimmed}". ` +
        `Known providers: ${KNOWN_PROVIDERS.join(', ')}. The model will still be attempted — ` +
        `if it fails, verify the provider name against the OpenCode CLI.`,
    );
  }
}
