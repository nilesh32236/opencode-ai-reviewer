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

  it('safely processes inputs containing lone surrogates without failing or violating limits', () => {
    // A string with a lone surrogate (invalid UTF-16, technically shouldn't appear, but we must handle it without panicking or creating garbage)
    const textWithSurrogate = 'hello\uD800world';
    const maxBytesList = [1, 5, 6, 7, 8, 9, 10, 11, 15];

    // Normalize the input string as Node.js would when casting to UTF-8
    const normalizedInput = Buffer.from(textWithSurrogate, 'utf8').toString('utf8');

    for (const maxBytes of maxBytesList) {
      const result = truncateUtf8Bytes(textWithSurrogate, maxBytes);

      // Invariant 1: result is exactly the byte-budget truncation of the normalized input
      const normBuf = Buffer.from(normalizedInput, 'utf8');
      let end = Math.min(maxBytes, normBuf.length);
      while (end > 0 && (normBuf[end] & 0xc0) === 0x80) end--;
      // Because we restored the fast path, if maxBytes >= full length, we return the original string
      if (Buffer.byteLength(textWithSurrogate, 'utf8') <= maxBytes) {
        expect(result).toBe(textWithSurrogate);
      } else {
        expect(result).toBe(normBuf.toString('utf8', 0, end));
      }

      // Invariant 2: Result length is strictly within budget
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('never injects U+FFFD into well-formed inputs during truncation', () => {
    // Well-formed input: truncation must never inject U+FFFD.
    const clean = 'aé€𝌆b';
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      const r = truncateUtf8Bytes(clean, m);
      expect(r.includes('\uFFFD')).toBe(false);
      expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(m);
    }
  });
});
