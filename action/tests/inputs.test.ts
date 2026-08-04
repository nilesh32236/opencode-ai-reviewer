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
