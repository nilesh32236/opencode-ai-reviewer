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

import { resolveGitLabMrIid, resolvePrNumber } from '../src/utils.js';

describe('resolvePrNumber()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockGetInput.mockReturnValue('12abc');
    await expect(resolvePrNumber()).resolves.toBeNull();
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
});

describe('resolveGitLabMrIid()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a canonical IID string', () => {
    expect(resolveGitLabMrIid('42')).toBe(42);
    expect(resolveGitLabMrIid('  7  ')).toBe(7);
  });

  it.each(['12abc', '1.5', '0x10', '1e2', '-1', '0', 'NaN', 'Infinity', '9999999999'])(
    'rejects %s with undefined',
    (raw) => {
      expect(resolveGitLabMrIid(raw)).toBeUndefined();
    },
  );

  it('returns undefined when unset or blank', () => {
    expect(resolveGitLabMrIid('')).toBeUndefined();
    expect(resolveGitLabMrIid('   ')).toBeUndefined();
  });
});
