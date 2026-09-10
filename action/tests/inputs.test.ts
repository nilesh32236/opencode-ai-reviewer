import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetInput, mockGetBooleanInput, mockWarning, mockSetSecret } = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  // Mirror the real core.getBooleanInput (YAML 1.2 core schema): only
  // true/True/TRUE and false/False/FALSE are accepted, anything else throws.
  const _mockGetBooleanInput = vi.fn((name: string) => {
    const val = _mockGetInput(name) ?? '';
    if (['true', 'True', 'TRUE'].includes(val)) return true;
    if (['false', 'False', 'FALSE'].includes(val)) return false;
    throw new TypeError(
      `Input does not meet YAML 1.2 "Core Schema" specification: ${name}`,
    );
  });
  const _mockWarning = vi.fn();
  const _mockSetSecret = vi.fn();
  return {
    mockGetInput: _mockGetInput,
    mockGetBooleanInput: _mockGetBooleanInput,
    mockWarning: _mockWarning,
    mockSetSecret: _mockSetSecret,
  };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  getBooleanInput: mockGetBooleanInput,
  info: vi.fn(),
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
  setSecret: mockSetSecret,
}));

import { parseInputs, parseStreamBatchSize } from '../src/inputs.js';

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

describe('parseInputs() enable_test_gap_detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to disabled when the input is omitted (not explicit)', () => {
    setInputs(BASE_INPUTS);
    const inputs = parseInputs();
    expect(inputs.enableTestGapDetection).toBe(false);
    expect(inputs.enableTestGapDetectionExplicit).toBe(false);
  });

  it('enables test-gap detection when the input is explicitly "true"', () => {
    setInputs({ ...BASE_INPUTS, enable_test_gap_detection: 'true' });
    const inputs = parseInputs();
    expect(inputs.enableTestGapDetection).toBe(true);
    expect(inputs.enableTestGapDetectionExplicit).toBe(true);
  });

  it('disables test-gap detection when the input is explicitly "false"', () => {
    setInputs({ ...BASE_INPUTS, enable_test_gap_detection: 'false' });
    const inputs = parseInputs();
    expect(inputs.enableTestGapDetection).toBe(false);
    expect(inputs.enableTestGapDetectionExplicit).toBe(true);
  });

  it('rejects an invalid enable_test_gap_detection value', () => {
    setInputs({ ...BASE_INPUTS, enable_test_gap_detection: 'yes' });
    expect(() => parseInputs()).toThrow(/Invalid enable_test_gap_detection/);
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

  it('leaves an already-prefixed model unchanged even with a default provider', () => {
    setInputs({ ...BASE_INPUTS, llm_default_provider: 'ollama', review_model: 'openai/gpt-4o' });
    const inputs = parseInputs();
    expect(inputs.reviewModel).toBe('openai/gpt-4o');
  });
});

describe('parseInputs() secret masking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers every secret input with core.setSecret', () => {
    setInputs({
      ...BASE_INPUTS,
      openai_api_key: 'sk-test-openai',
      anthropic_api_key: 'sk-ant-test',
      gemini_api_key: 'AIza-test',
      opencode_api_key: 'opencode-test',
      llm_api_key: 'llm-test',
      azure_openai_key: 'azure-test',
    });
    parseInputs();
    for (const secret of [
      'ghs_token',
      'sk-test-openai',
      'sk-ant-test',
      'AIza-test',
      'opencode-test',
      'llm-test',
      'azure-test',
    ]) {
      expect(mockSetSecret).toHaveBeenCalledWith(secret);
    }
  });

  it('skips setSecret for empty secret inputs', () => {
    setInputs({ ...BASE_INPUTS });
    parseInputs();
    expect(mockSetSecret).toHaveBeenCalledTimes(1);
    expect(mockSetSecret).toHaveBeenCalledWith('ghs_token');
  });
});

describe('parseStreamBatchSize()', () => {
  it('returns 0 for empty input', () => {
    expect(parseStreamBatchSize('')).toBe(0);
    expect(parseStreamBatchSize('   ')).toBe(0);
  });

  it('accepts boundary values 0 and 100', () => {
    expect(parseStreamBatchSize('0')).toBe(0);
    expect(parseStreamBatchSize('100')).toBe(100);
    expect(parseStreamBatchSize(' 5 ')).toBe(5);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseStreamBatchSize('101')).toThrow(/stream_batch_size/);
    expect(() => parseStreamBatchSize('-1')).toThrow(/stream_batch_size/);
  });

  it('rejects non-canonical numeric forms (hex, scientific, float, text)', () => {
    for (const raw of ['1e2', '0x10', '3.0', 'abc', '10px', '+5']) {
      expect(() => parseStreamBatchSize(raw)).toThrow(/stream_batch_size/);
    }
  });
});

describe('parseInputs() describe_use_markers/describe_publish_as_comment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to markers off and comment on when inputs are omitted', () => {
    setInputs(BASE_INPUTS);
    const inputs = parseInputs();
    expect(inputs.describeUseMarkers).toBe(false);
    expect(inputs.describeUseMarkersExplicit).toBe(false);
    expect(inputs.describePublishAsComment).toBe(true);
    expect(inputs.describePublishAsCommentExplicit).toBe(false);
  });

  it('parses explicit true/false values', () => {
    setInputs({
      ...BASE_INPUTS,
      describe_use_markers: 'true',
      describe_publish_as_comment: 'false',
    });
    const inputs = parseInputs();
    expect(inputs.describeUseMarkers).toBe(true);
    expect(inputs.describeUseMarkersExplicit).toBe(true);
    expect(inputs.describePublishAsComment).toBe(false);
    expect(inputs.describePublishAsCommentExplicit).toBe(true);
  });

  it('parses explicit false/true values', () => {
    setInputs({
      ...BASE_INPUTS,
      describe_use_markers: 'false',
      describe_publish_as_comment: 'true',
    });
    const inputs = parseInputs();
    expect(inputs.describeUseMarkers).toBe(false);
    expect(inputs.describeUseMarkersExplicit).toBe(true);
    expect(inputs.describePublishAsComment).toBe(true);
    expect(inputs.describePublishAsCommentExplicit).toBe(true);
  });

  it('rejects invalid describe_use_markers values', () => {
    setInputs({ ...BASE_INPUTS, describe_use_markers: 'yes' });
    expect(() => parseInputs()).toThrow(/Invalid describe_use_markers/);
  });

  it('rejects invalid describe_publish_as_comment values', () => {
    setInputs({ ...BASE_INPUTS, describe_publish_as_comment: 'yes' });
    expect(() => parseInputs()).toThrow(/Invalid describe_publish_as_comment/);
  });
});

describe('parseInputs() audit_labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts labels containing spaces', () => {
    setInputs({ ...BASE_INPUTS, audit_labels: 'help wanted, good first issue' });
    const inputs = parseInputs();
    expect(inputs.auditLabels).toEqual(['help wanted', 'good first issue']);
  });

  it('rejects labels longer than 50 characters', () => {
    setInputs({ ...BASE_INPUTS, audit_labels: `${'a'.repeat(51)}` });
    expect(() => parseInputs()).toThrow(/Invalid audit label/);
  });

  it('rejects labels with control characters', () => {
    setInputs({ ...BASE_INPUTS, audit_labels: 'bad\tlabel' });
    expect(() => parseInputs()).toThrow(/Invalid audit label/);
  });
});

describe('parseInputs() require_opencode_checksum', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to false when the input is unset', () => {
    setInputs({ ...BASE_INPUTS });
    expect(parseInputs().requireOpencodeChecksum).toBe(false);
    expect(mockWarning).not.toHaveBeenCalledWith(
      expect.stringContaining('require_opencode_checksum'),
    );
  });

  it('parses true/TRUE as enabled', () => {
    setInputs({ ...BASE_INPUTS, require_opencode_checksum: 'true' });
    expect(parseInputs().requireOpencodeChecksum).toBe(true);
    setInputs({ ...BASE_INPUTS, require_opencode_checksum: 'TRUE' });
    expect(parseInputs().requireOpencodeChecksum).toBe(true);
  });

  it('parses false as disabled without warning', () => {
    setInputs({ ...BASE_INPUTS, require_opencode_checksum: 'false' });
    expect(parseInputs().requireOpencodeChecksum).toBe(false);
    expect(mockWarning).not.toHaveBeenCalledWith(
      expect.stringContaining('require_opencode_checksum'),
    );
  });

  it('warns and falls back to false on invalid values', () => {
    setInputs({ ...BASE_INPUTS, require_opencode_checksum: 'ture' });
    expect(parseInputs().requireOpencodeChecksum).toBe(false);
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid require_opencode_checksum "ture"'),
    );
  });
});
