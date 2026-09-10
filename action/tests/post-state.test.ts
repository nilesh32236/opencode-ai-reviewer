import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarning } = vi.hoisted(() => {
  const _mockWarning = vi.fn();
  return { mockWarning: _mockWarning };
});

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getState: vi.fn(),
  info: vi.fn(),
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
  setSecret: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
    write: vi.fn(),
  },
}));

import { parseFiniteState } from '../src/post.js';

describe('parseFiniteState()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a finite non-negative value', () => {
    expect(parseFiniteState('token_usage', '123')).toBe(123);
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('accepts zero', () => {
    expect(parseFiniteState('cost', '0')).toBe(0);
  });

  it('rejects NaN with a warning', () => {
    expect(parseFiniteState('token_usage', 'abc')).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });

  it('rejects Infinity with a warning', () => {
    expect(parseFiniteState('token_usage', 'Infinity')).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });

  it('rejects negative values with a warning', () => {
    expect(parseFiniteState('token_usage', '-5')).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });

  it('sanitizes the warning so embedded secrets are redacted', () => {
    const raw = 'sk-ant-0000000000000000000000000000000000000000';
    expect(parseFiniteState('token_usage', raw)).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledTimes(1);
    const warned = String(mockWarning.mock.calls[0]?.[0] ?? '');
    expect(warned).not.toContain(raw);
  });
});
