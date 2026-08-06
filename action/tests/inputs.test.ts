import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetInput, mockWarning } = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockWarning = vi.fn();
  return { mockGetInput: _mockGetInput, mockWarning: _mockWarning };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  info: vi.fn(),
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
}));

import { parseInputs } from '../src/inputs.js';

const BASE_INPUTS: Record<string, string> = {
  mode: 'review',
  github_token: 'ghs_token',
};

function setInputs(inputs: Record<string, string>): void {
  mockGetInput.mockImplementation((name: string) => inputs[name] ?? '');
}

describe('parseInputs() model validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an invalid review model', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'gpt-4o' });
    expect(() => parseInputs()).toThrow(/Invalid model format/);
  });

  it('rejects an invalid audit model when audit is enabled', () => {
    setInputs({ ...BASE_INPUTS, mode: 'audit', audit_model: 'gpt-4o' });
    expect(() => parseInputs()).toThrow(/Invalid model format/);
  });

  it('rejects an invalid verification model when meta-verification is enabled', () => {
    setInputs({
      ...BASE_INPUTS,
      enable_meta_verification: 'true',
      verification_model: 'gpt-4o',
    });
    expect(() => parseInputs()).toThrow(/Invalid model format/);
  });

  it('warns (does not throw) for an invalid model of a disabled feature', () => {
    setInputs({ ...BASE_INPUTS, audit_model: 'gpt-4o' });
    const inputs = parseInputs();
    expect(inputs.auditModel).toBe('gpt-4o');
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('disabled feature'));
  });

  it('trims whitespace-padded model values', () => {
    setInputs({ ...BASE_INPUTS, review_model: '  openai/gpt-4o  ' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('openai/gpt-4o');
  });

  it('accepts valid provider/model values', () => {
    setInputs({
      ...BASE_INPUTS,
      review_model: 'anthropic/claude-sonnet-4',
      verification_model: 'openai/gpt-4o',
    });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('anthropic/claude-sonnet-4');
    expect(inputs.verificationModel).toBe('openai/gpt-4o');
  });

  it('passes through models with an unrecognized provider without failing', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'custom-provider/custom-model' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('custom-provider/custom-model');
  });
});

describe('parseInputs() enable_mcp default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables MCP by default (opt-in)', () => {
    setInputs(BASE_INPUTS);
    const inputs = parseInputs();
    expect(inputs.enableMCP).toBe(false);
  });

  it('enables MCP only when enable_mcp is explicitly "true"', () => {
    setInputs({ ...BASE_INPUTS, enable_mcp: 'true' });
    const inputs = parseInputs();
    expect(inputs.enableMCP).toBe(true);
  });

  it('treats any non-"true" value as disabled', () => {
    setInputs({ ...BASE_INPUTS, enable_mcp: 'yes' });
    const inputs = parseInputs();
    expect(inputs.enableMCP).toBe(false);
  });

  it('accepts case-insensitive and trimmed "true" values', () => {
    setInputs({ ...BASE_INPUTS, enable_mcp: ' TRUE ' });
    const inputs = parseInputs();
    expect(inputs.enableMCP).toBe(true);
  });
});

describe('parseInputs() fail_on_severity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to off when the input is omitted', () => {
    setInputs(BASE_INPUTS);
    const inputs = parseInputs();
    expect(inputs.failOnSeverity).toBe('off');
    expect(inputs.failOnSeverityExplicit).toBe(false);
  });

  it('accepts every valid severity value', () => {
    for (const value of ['off', 'critical', 'important', 'minor']) {
      setInputs({ ...BASE_INPUTS, fail_on_severity: value });
      const inputs = parseInputs();
      expect(inputs.failOnSeverity).toBe(value);
      expect(inputs.failOnSeverityExplicit).toBe(true);
    }
  });

  it('trims surrounding whitespace and lowercases', () => {
    setInputs({ ...BASE_INPUTS, fail_on_severity: ' Critical ' });
    expect(parseInputs().failOnSeverity).toBe('critical');
  });

  it('rejects an invalid severity value', () => {
    setInputs({ ...BASE_INPUTS, fail_on_severity: 'blocker' });
    expect(() => parseInputs()).toThrow(/Invalid fail_on_severity/);
  });
});

describe('parseInputs() docs mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts docs as a valid mode', () => {
    setInputs({ ...BASE_INPUTS, mode: 'docs' });
    const inputs = parseInputs();
    expect(inputs.mode).toBe('docs');
  });

  it('parses doc_style with a default of auto', () => {
    setInputs({ ...BASE_INPUTS, mode: 'docs' });
    const inputs = parseInputs();
    expect(inputs.docStyle).toBe('auto');
  });

  it('parses an explicit doc_style', () => {
    setInputs({ ...BASE_INPUTS, mode: 'docs', doc_style: 'tsdoc' });
    const inputs = parseInputs();
    expect(inputs.docStyle).toBe('tsdoc');
  });

  it('rejects an invalid doc_style', () => {
    setInputs({ ...BASE_INPUTS, mode: 'docs', doc_style: 'yaml' });
    expect(() => parseInputs()).toThrow(/Invalid doc_style/);
  });

  it('rejects an invalid docs_model when mode is docs', () => {
    setInputs({ ...BASE_INPUTS, mode: 'docs', docs_model: 'gpt-4o' });
    expect(() => parseInputs()).toThrow(/Invalid model format/);
  });

  it('warns (does not throw) for an invalid docs_model in review mode', () => {
    setInputs({ ...BASE_INPUTS, docs_model: 'gpt-4o' });
    const inputs = parseInputs();
    expect(inputs.docsModel).toBe('gpt-4o');
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('disabled feature'));
  });

  it('falls back docs_model to the global model when omitted', () => {
    setInputs({ ...BASE_INPUTS, mode: 'docs', model: 'openai/gpt-4o' });
    const inputs = parseInputs();
    expect(inputs.docsModel).toBe('openai/gpt-4o');
  });
});

describe('parseInputs() LLM model resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefixes a bare model with llm_default_provider', () => {
    setInputs({ ...BASE_INPUTS, llm_default_provider: 'ollama', review_model: 'llama3' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('ollama/llama3');
  });

  it('falls back to the config file defaultProvider for a bare model', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'llama3' });
    const inputs = parseInputs({ defaultProvider: 'ollama', providers: {} });
    expect(inputs.reviewModel).toBe('ollama/llama3');
  });

  it('the action llm_default_provider input wins over the config defaultProvider', () => {
    setInputs({ ...BASE_INPUTS, llm_default_provider: 'azure', review_model: 'llama3' });
    const inputs = parseInputs({ defaultProvider: 'ollama', providers: {} });
    expect(inputs.reviewModel).toBe('azure/llama3');
  });

  it('routes a bare model to the config-file azure deployment', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'llama3' });
    const inputs = parseInputs({
      defaultProvider: 'azure',
      providers: { azure: { type: 'azure', deployment: 'my-deployment' } },
    });
    expect(inputs.reviewModel).toBe('azure/my-deployment');
  });

  it('the azure_deployment_name action input wins over the config deployment', () => {
    setInputs({ ...BASE_INPUTS, azure_deployment_name: 'input-dep', review_model: 'llama3' });
    const inputs = parseInputs({
      defaultProvider: 'azure',
      providers: { azure: { type: 'azure', deployment: 'config-dep' } },
    });
    expect(inputs.reviewModel).toBe('azure/input-dep');
  });

  it('infer azure provider from a config-file azure provider with a bare model', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'llama3' });
    const inputs = parseInputs({
      providers: { azure: { type: 'azure', deployment: 'my-deployment' } },
    });
    expect(inputs.reviewModel).toBe('azure/my-deployment');
  });

  it('routes a bare model to the config-file bedrock model id', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'llama3' });
    const inputs = parseInputs({
      defaultProvider: 'amazon-bedrock',
      providers: {
        bedrock: { type: 'bedrock', modelId: 'us.mistral.mistral-large', region: 'us-east-1' },
      },
    });
    expect(inputs.reviewModel).toBe('amazon-bedrock/us.mistral.mistral-large');
  });

  it('infer bedrock provider from a config-file model id with a bare model', () => {
    setInputs({ ...BASE_INPUTS, review_model: 'llama3' });
    const inputs = parseInputs({
      providers: { bedrock: { type: 'bedrock', modelId: 'us.mistral.mistral-large' } },
    });
    expect(inputs.reviewModel).toBe('amazon-bedrock/us.mistral.mistral-large');
  });

  it('infers the ollama provider from ollama_model with a bare model', () => {
    setInputs({ ...BASE_INPUTS, ollama_model: 'llama3', review_model: 'llama3' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('ollama/llama3');
  });

  it('infers the ollama provider from ollama_base_url with a bare model', () => {
    setInputs({
      ...BASE_INPUTS,
      ollama_base_url: 'http://ollama.corp:11434/v1',
      review_model: 'codellama',
    });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('ollama/codellama');
  });

  it('infers the custom-openai provider from llm_base_url with a bare model', () => {
    setInputs({
      ...BASE_INPUTS,
      llm_base_url: 'https://gateway.example/v1',
      review_model: 'qwen3-coder',
    });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('custom-openai/qwen3-coder');
  });

  it('does not infer custom-openai from a bare llm_api_key without llm_base_url', () => {
    // A key without a base URL cannot build a provider, so no inference happens
    // and an already-prefixed model passes through untouched (a bare model would
    // fail "Invalid model format", which is surfaced loudly instead of silently).
    setInputs({ ...BASE_INPUTS, llm_api_key: 'secret', review_model: 'custom-openai/qwen3-coder' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('custom-openai/qwen3-coder');
  });

  it('leaves an already-prefixed model unchanged even with a default provider', () => {
    setInputs({ ...BASE_INPUTS, llm_default_provider: 'ollama', review_model: 'openai/gpt-4o' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('openai/gpt-4o');
  });
});
