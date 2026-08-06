import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionInputs } from '../src/inputs.js';
import { buildLLMConfig } from '../src/llm.js';

const BASE_INPUTS = {
  mode: 'review',
  githubToken: 'ghs_token',
  reviewModel: 'opencode/deepseek-v4-flash-free',
  fixModel: 'opencode/deepseek-v4-flash-free',
  enableMetaVerification: false,
  includePreExisting: false,
  docStyle: 'auto',
  enableFix: true,
  maxFixIterations: 3,
  enableAudit: false,
  auditTargetDirs: [],
  maxFilesPerBatch: 3,
  maxLinesPerFile: 500,
  enableMCP: false,
  includeStrengths: true,
  reviewCommentSummary: true,
  checkAllowlist: [],
  auditLabels: [],
  opencodeVersion: 'latest',
  probeAllModels: false,
  timeoutMinutes: 20,
  reviewInline: true,
  failOnSeverity: 'off',
  failOnSeverityExplicit: false,
  enableStateCache: true,
  stateCacheKey: 'opencode-learning-state',
  costTrackingEnabled: false,
  costTrackingVerbosity: 'summary',
} as ActionInputs;

describe('buildLLMConfig()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined when neither providers nor a default provider is configured', () => {
    expect(buildLLMConfig(BASE_INPUTS, null)).toBeUndefined();
  });

  it('merges config-file providers with action-input overrides per field', () => {
    const inputs: ActionInputs = {
      ...BASE_INPUTS,
      azureEndpoint: 'https://action.openai.azure.com',
      azureDeployment: 'action-deployment',
    };
    const llm = buildLLMConfig(inputs, {
      llm: {
        defaultProvider: 'azure',
        providers: {
          azure: {
            type: 'azure',
            endpoint: 'https://config.openai.azure.com',
            apiKey: '{env:AZURE_OPENAI_API_KEY}',
            apiVersion: '2024-02-15-preview',
            deployment: 'config-deployment',
          },
        },
      },
    });
    // Action inputs win for the fields they set; config-file fields survive.
    expect(llm?.providers?.azure).toEqual({
      type: 'azure',
      endpoint: 'https://action.openai.azure.com',
      apiKey: '{env:AZURE_OPENAI_API_KEY}',
      apiVersion: '2024-02-15-preview',
      deployment: 'action-deployment',
    });
  });

  it('preserves the config-file ollama models list when only the base URL is overridden', () => {
    const inputs: ActionInputs = {
      ...BASE_INPUTS,
      ollamaBaseUrl: 'http://ollama.corp:11434/v1',
    };
    const llm = buildLLMConfig(inputs, {
      llm: {
        providers: {
          ollama: {
            type: 'ollama',
            baseUrl: 'http://localhost:11434/v1',
            models: ['llama3', 'codellama'],
          },
        },
      },
    });
    expect(llm?.providers?.ollama).toEqual({
      type: 'ollama',
      baseUrl: 'http://ollama.corp:11434/v1',
      models: ['llama3', 'codellama'],
    });
  });

  it('registers the custom-openai provider for llm_base_url action inputs', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmBaseUrl: 'https://gateway.example/v1', llmApiKey: 'secret' },
      null,
    );
    expect(llm?.providers?.['custom-openai']).toEqual({
      type: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'secret',
    });
  });

  it('defaults the provider to azure when only an azure deployment input is set', () => {
    const llm = buildLLMConfig({ ...BASE_INPUTS, azureDeployment: 'my-deployment' }, null);
    expect(llm?.defaultProvider).toBe('azure');
    expect(llm?.providers?.azure).toEqual({
      type: 'azure',
      deployment: 'my-deployment',
    });
  });

  it('defaults the provider to amazon-bedrock when only a bedrock model id input is set', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, bedrockModelId: 'us.mistral.mistral-large', bedrockRegion: 'us-east-1' },
      null,
    );
    expect(llm?.defaultProvider).toBe('amazon-bedrock');
    expect(llm?.providers?.bedrock).toEqual({
      type: 'bedrock',
      modelId: 'us.mistral.mistral-large',
      region: 'us-east-1',
    });
  });

  it('action default provider wins over the config-file defaultProvider', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmDefaultProvider: 'ollama' },
      { llm: { defaultProvider: 'azure', providers: {} } },
    );
    expect(llm?.defaultProvider).toBe('ollama');
  });

  it('warns when llm_api_key is set without llm_base_url', async () => {
    const warnSpy = vi.spyOn(await import('@actions/core'), 'warning').mockImplementation(() => {});
    const llm = buildLLMConfig({ ...BASE_INPUTS, llmApiKey: 'secret' }, null);
    expect(llm?.providers?.['custom-openai']).toEqual({
      type: 'openai-compatible',
      apiKey: 'secret',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('llm_api_key was set without llm_base_url'),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when llm_api_key is set alongside llm_base_url', async () => {
    const warnSpy = vi.spyOn(await import('@actions/core'), 'warning').mockImplementation(() => {});
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmApiKey: 'secret', llmBaseUrl: 'https://gateway.example/v1' },
      null,
    );
    expect(llm?.providers?.['custom-openai']?.baseUrl).toBe('https://gateway.example/v1');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('llm_api_key was set without llm_base_url'),
    );
    warnSpy.mockRestore();
  });

  it('warns when azure_openai_key is set without an endpoint', async () => {
    const warnSpy = vi.spyOn(await import('@actions/core'), 'warning').mockImplementation(() => {});
    buildLLMConfig({ ...BASE_INPUTS, azureKey: 'secret', azureDeployment: 'dep' }, null);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('azure_openai_key was set without azure_openai_endpoint'),
    );
    warnSpy.mockRestore();
  });

  it('infers the default provider from a config-file azure deployment', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS },
      {
        llm: {
          providers: {
            azure: {
              type: 'azure',
              endpoint: 'https://res.openai.azure.com',
              apiKey: 'key',
              deployment: 'my-deployment',
            },
          },
        },
      },
    );
    expect(llm?.defaultProvider).toBe('azure');
  });

  it('merges action azure inputs into a config-file azure provider under a different id', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, azureDeployment: 'input-dep' },
      {
        llm: {
          providers: {
            myazure: {
              type: 'azure',
              endpoint: 'https://config.openai.azure.com',
              apiKey: 'config-key',
              deployment: 'config-dep',
            },
          },
        },
      },
    );
    // No duplicate same-type provider: the action's deployment merges into the
    // config-file entry so applyLLMEnvOverrides' first-wins ordering cannot let
    // the config-file value silently win over the action input.
    expect(llm?.providers?.myazure).toEqual({
      type: 'azure',
      endpoint: 'https://config.openai.azure.com',
      apiKey: 'config-key',
      deployment: 'input-dep',
    });
    expect(llm?.providers?.azure).toBeUndefined();
  });

  it('merges action bedrock inputs into a config-file bedrock provider under a different id', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, bedrockModelId: 'us.input.model', bedrockRegion: 'eu-west-1' },
      {
        llm: {
          providers: {
            bedrock: {
              type: 'bedrock',
              modelId: 'us.config.model',
              region: 'us-east-1',
            },
          },
        },
      },
    );
    expect(llm?.providers?.bedrock).toEqual({
      type: 'bedrock',
      modelId: 'us.input.model',
      region: 'eu-west-1',
    });
  });
});
