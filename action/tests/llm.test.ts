import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

import type { ActionInputs } from '../src/inputs.js';
import { buildLLMConfig, isAllowedEndpointScheme, isLoopbackHost } from '../src/llm.js';

const BASE_INPUTS = {
  mode: 'review',
  githubToken: 'ghs_token',
  reviewModel: 'opencode/muse-spark-1.3-contributor-free',
  fixModel: 'opencode/muse-spark-1.3-contributor-free',
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
  llmAllowInsecureHttp: false,
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
      llmAllowInsecureHttp: true,
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

  it('threads llm timeout inputs into the custom-openai provider entry', () => {
    const llm = buildLLMConfig(
      {
        ...BASE_INPUTS,
        llmBaseUrl: 'https://gateway.example/v1',
        llmHeaderTimeoutMs: 30000,
        llmChunkTimeoutMs: 60000,
      },
      null,
    );
    expect(llm?.providers?.['custom-openai']).toEqual({
      type: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
      headerTimeoutMs: 30000,
      chunkTimeoutMs: 60000,
    });
  });

  it('omits timeout fields when timeout inputs are unset', () => {
    const llm = buildLLMConfig({ ...BASE_INPUTS, llmBaseUrl: 'https://gateway.example/v1' }, null);
    expect(llm?.providers?.['custom-openai']).toEqual({
      type: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
    });
  });

  it('skips creating a custom-openai entry for timeout-only inputs without a baseUrl', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmHeaderTimeoutMs: 30000, llmChunkTimeoutMs: 60000 },
      null,
    );
    expect(llm).toBeUndefined();
  });

  it('ignores config-file endpoints: timeout-only inputs no longer resurrect a config-file baseUrl', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmHeaderTimeoutMs: 30000 },
      {
        llm: {
          providers: {
            'custom-openai': {
              type: 'openai-compatible',
              baseUrl: 'https://gateway.example/v1',
            },
          },
        },
      },
    );
    // Config-file network destinations are untrusted (PR branch) and stripped;
    // without a workflow llm_base_url there is no host, so no entry is created.
    expect(llm).toBeUndefined();
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

  it('drops a PR-branch config-file endpoint so workflow apiKey is never sent to an attacker host', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmApiKey: 'workflow-secret' },
      {
        llm: {
          providers: {
            'custom-openai': {
              type: 'openai-compatible',
              baseUrl: 'https://attacker.example/v1',
              models: ['evil-model'],
            },
          },
        },
      },
    );
    // No workflow llm_base_url → no custom-openai host; the attacker baseUrl
    // must not survive, and the workflow secret must not pair with it.
    expect(llm?.providers?.['custom-openai']).toBeUndefined();
  });

  it('never pairs a workflow apiKey with a config-file host when both are set', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmBaseUrl: 'https://workflow.example/v1', llmApiKey: 'workflow-secret' },
      {
        llm: {
          providers: {
            'custom-openai': {
              type: 'openai-compatible',
              baseUrl: 'https://attacker.example/v1',
            },
          },
        },
      },
    );
    expect(llm?.providers?.['custom-openai']?.baseUrl).toBe('https://workflow.example/v1');
    expect(llm?.providers?.['custom-openai']?.apiKey).toBe('workflow-secret');
  });

  it('drops unparsable workflow endpoints fail-closed', () => {
    const llm = buildLLMConfig(
      { ...BASE_INPUTS, llmBaseUrl: 'not a url', llmApiKey: 'secret' },
      null,
    );
    expect(llm?.providers?.['custom-openai']).toBeUndefined();
  });

  it('keeps https and loopback http endpoints, drops cleartext non-local http fail-closed', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isAllowedEndpointScheme('https://llm.example/v1')).toBe(true);
    expect(isAllowedEndpointScheme('http://localhost:11434/v1')).toBe(true);
    expect(isAllowedEndpointScheme('http://llm.example/v1')).toBe(false);
    expect(isAllowedEndpointScheme('ftp://llm.example/v1')).toBe(false);
    // Fail-closed by default: non-local http drops the provider entry so
    // apiKey values and code diffs are never transmitted unencrypted.
    const dropped = buildLLMConfig(
      { ...BASE_INPUTS, ollamaBaseUrl: 'http://ollama.corp:11434/v1' },
      null,
    );
    expect(dropped?.providers?.ollama).toBeUndefined();
    // Explicit opt-in restores warn-but-keep for http://ollama.corp gateways.
    const kept = buildLLMConfig(
      {
        ...BASE_INPUTS,
        ollamaBaseUrl: 'http://ollama.corp:11434/v1',
        llmAllowInsecureHttp: true,
      },
      null,
    );
    expect(kept?.providers?.ollama?.baseUrl).toBe('http://ollama.corp:11434/v1');
    // Loopback http still works without the opt-in.
    const loopback = buildLLMConfig(
      { ...BASE_INPUTS, ollamaBaseUrl: 'http://localhost:11434/v1' },
      null,
    );
    expect(loopback?.providers?.ollama?.baseUrl).toBe('http://localhost:11434/v1');
  });
});
