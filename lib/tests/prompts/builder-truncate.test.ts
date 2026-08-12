import { describe, expect, it } from 'vitest';
import { truncateUtf8Bytes } from '../../src/prompts/builder.js';

describe('truncateUtf8Bytes', () => {
  it('returns unchanged if within budget', () => {
    expect(truncateUtf8Bytes('hello', 10)).toBe('hello');
  });

  it('handles empty string and zero maxBytes', () => {
    expect(truncateUtf8Bytes('', 0)).toBe('');
    expect(truncateUtf8Bytes('hello', 0)).toBe('');
    expect(truncateUtf8Bytes('hello', -5)).toBe('');
  });

  it('rejects non-integers', () => {
    expect(truncateUtf8Bytes('€x', 2.5)).toBe('');
  });

  it('truncates exactly on boundary', () => {
    // '€' is 3 bytes: e2 82 ac
    expect(truncateUtf8Bytes('€€', 3)).toBe('€');
    expect(truncateUtf8Bytes('€€', 6)).toBe('€€');
  });

  it('walks back to avoid mid-sequence cut', () => {
    expect(truncateUtf8Bytes('€a', 2)).toBe('');
    expect(truncateUtf8Bytes('ab€', 4)).toBe('ab');
    expect(truncateUtf8Bytes('ab€', 5)).toBe('ab€');
    // '€' is 3 bytes. Budget of 4 should return 1 '€' (3 bytes), dropping the 2nd one.
    expect(truncateUtf8Bytes('€€', 4)).toBe('€');
    // Budget of 5 should also return 1 '€'
    expect(truncateUtf8Bytes('€€', 5)).toBe('€');
  });

  it('handles 4-byte astral characters', () => {
    // '𝌆' is 4 bytes: f0 9d 8c 86
    expect(truncateUtf8Bytes('𝌆𝌆', 4)).toBe('𝌆');
    expect(truncateUtf8Bytes('𝌆𝌆', 5)).toBe('𝌆');
    expect(truncateUtf8Bytes('𝌆𝌆', 6)).toBe('𝌆');
    expect(truncateUtf8Bytes('𝌆𝌆', 7)).toBe('𝌆');
    expect(truncateUtf8Bytes('𝌆𝌆', 8)).toBe('𝌆𝌆');
  });
});
