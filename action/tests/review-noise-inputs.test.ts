import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetInput, mockWarning, mockSetSecret } = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockWarning = vi.fn();
  const _mockSetSecret = vi.fn();
  return { mockGetInput: _mockGetInput, mockWarning: _mockWarning, mockSetSecret: _mockSetSecret };
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
  setSecret: mockSetSecret,
}));

import { parseInputs } from '../src/inputs.js';

const BASE_INPUTS: Record<string, string> = {
  mode: 'review',
  github_token: 'ghs_token',
};

function setInputs(inputs: Record<string, string>): void {
  mockGetInput.mockImplementation((name: string) => inputs[name] ?? '');
}

describe('parseInputs() review noise inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses review_preset case-insensitively', () => {
    setInputs({ ...BASE_INPUTS, review_preset: ' Chill ' });
    expect(parseInputs().reviewPreset).toBe('chill');

    setInputs({ ...BASE_INPUTS, review_preset: 'DEFAULT' });
    expect(parseInputs().reviewPreset).toBe('default');
  });

  it('leaves both values unset when the inputs are omitted without warning', () => {
    setInputs({ ...BASE_INPUTS });
    const inputs = parseInputs();
    expect(inputs.reviewPreset).toBeUndefined();
    expect(inputs.noiseBudget).toBeUndefined();
    expect(mockWarning).not.toHaveBeenCalledWith(expect.stringContaining('review_preset'));
    expect(mockWarning).not.toHaveBeenCalledWith(expect.stringContaining('noise_budget'));
  });

  it('accepts in-range noise_budget integers', () => {
    for (const value of ['1', '10', '500']) {
      setInputs({ ...BASE_INPUTS, noise_budget: value });
      expect(parseInputs().noiseBudget).toBe(Number(value));
    }
  });

  it('warns and falls back to unset on invalid values', () => {
    for (const value of ['nope', '0', '501', '10.5']) {
      mockWarning.mockClear();
      setInputs({ ...BASE_INPUTS, noise_budget: value });
      expect(parseInputs().noiseBudget).toBeUndefined();
      expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('noise_budget'));
    }

    setInputs({ ...BASE_INPUTS, review_preset: 'nope' });
    expect(parseInputs().reviewPreset).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('review_preset'));
  });
});
