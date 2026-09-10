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

describe('parseInputs() review_effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses lite/balanced case-insensitively', () => {
    setInputs({ ...BASE_INPUTS, review_effort: ' Lite ' });
    const lite = parseInputs();
    expect(lite.reviewEffort).toBe('lite');
    expect(lite.reviewEffortExplicit).toBe(true);

    setInputs({ ...BASE_INPUTS, review_effort: 'BALANCED' });
    const balanced = parseInputs();
    expect(balanced.reviewEffort).toBe('balanced');
    expect(balanced.reviewEffortExplicit).toBe(true);
  });

  it('leaves reviewEffort unset when the input is omitted', () => {
    setInputs({ ...BASE_INPUTS });
    const inputs = parseInputs();
    expect(inputs.reviewEffort).toBeUndefined();
    expect(inputs.reviewEffortExplicit).toBe(false);
    expect(mockWarning).not.toHaveBeenCalledWith(expect.stringContaining('review_effort'));
  });

  it('warns and falls back to unset on invalid values while keeping the explicit flag', () => {
    setInputs({ ...BASE_INPUTS, review_effort: 'turbo' });
    const inputs = parseInputs();
    expect(inputs.reviewEffort).toBeUndefined();
    expect(inputs.reviewEffortExplicit).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('review_effort'));
  });

  it('tracks explicit-set flags for preset-overridable settings', () => {
    setInputs({
      ...BASE_INPUTS,
      max_files_per_batch: '2',
      max_lines_per_file: '200',
      enable_meta_verification: 'true',
    });
    const inputs = parseInputs();
    expect(inputs.maxFilesPerBatchExplicit).toBe(true);
    expect(inputs.maxLinesPerFileExplicit).toBe(true);
    expect(inputs.enableMetaVerificationExplicit).toBe(true);

    setInputs({ ...BASE_INPUTS });
    const defaults = parseInputs();
    expect(defaults.maxFilesPerBatchExplicit).toBe(false);
    expect(defaults.maxLinesPerFileExplicit).toBe(false);
    expect(defaults.enableMetaVerificationExplicit).toBe(false);
  });
});
