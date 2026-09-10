import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetInput, mockSetFailed } = vi.hoisted(() => {
  const _mockGetInput = vi.fn();
  const _mockSetFailed = vi.fn();
  return { mockGetInput: _mockGetInput, mockSetFailed: _mockSetFailed };
});

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setFailed: mockSetFailed,
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
}));

import * as github from '@actions/github';

import { resolvePrNumber } from '../src/utils.js';

describe('resolvePrNumber()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    github.context.payload.issue = undefined as never;
    github.context.payload.pull_request = undefined as never;
    delete (github.context.payload as Record<string, unknown>).issue;
    delete (github.context.payload as Record<string, unknown>).pull_request;
  });

  it('accepts a valid PR number', async () => {
    mockGetInput.mockReturnValue('42');
    await expect(resolvePrNumber()).resolves.toBe(42);
  });

  it('rejects zero', async () => {
    mockGetInput.mockReturnValue('0');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('rejects negative numbers', async () => {
    mockGetInput.mockReturnValue('-1');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('rejects floats and trailing garbage', async () => {
    mockGetInput.mockReturnValue('1.5');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
    mockGetInput.mockClear();
    mockSetFailed.mockClear();
    mockGetInput.mockReturnValue('12abc');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('rejects numbers above 2^31-1', async () => {
    mockGetInput.mockReturnValue('9999999999');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('rejects non-numeric input', async () => {
    mockGetInput.mockReturnValue('abc');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('falls back to event context when input is empty', async () => {
    mockGetInput.mockReturnValue('');
    github.context.payload.issue = { number: 123 } as never;
    delete (github.context.payload as Record<string, unknown>).pull_request;
    await expect(resolvePrNumber()).resolves.toBe(123);
    github.context.payload.pull_request = { number: 456 } as never;
    await expect(resolvePrNumber()).resolves.toBe(456);
    delete (github.context.payload as Record<string, unknown>).issue;
    delete (github.context.payload as Record<string, unknown>).pull_request;
    await expect(resolvePrNumber()).resolves.toBeNull();
  });

  it('accepts 2^31-1 but rejects 2^31', async () => {
    mockGetInput.mockReturnValue('2147483647');
    await expect(resolvePrNumber()).resolves.toBe(2147483647);
    expect(mockSetFailed).not.toHaveBeenCalled();
    mockGetInput.mockReturnValue('2147483648');
    await expect(resolvePrNumber()).resolves.toBeNull();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('rejects invalid numbers from event context', async () => {
    mockGetInput.mockReturnValue('');
    github.context.payload.issue = { number: 0 } as never;
    await expect(resolvePrNumber()).resolves.toBeNull();
    github.context.payload.issue = { number: -5 } as never;
    await expect(resolvePrNumber()).resolves.toBeNull();
    github.context.payload.issue = { number: 1.5 } as never;
    await expect(resolvePrNumber()).resolves.toBeNull();
    github.context.payload.issue = { number: 2147483648 } as never;
    await expect(resolvePrNumber()).resolves.toBeNull();
    delete (github.context.payload as Record<string, unknown>).issue;
  });
});
