import { describe, expect, it } from 'vitest';
import { MAX_EXCERPT_CODE_POINTS, truncateOnCodePointBoundary } from '../src/utils.js';

describe('truncateOnCodePointBoundary()', () => {
  it('returns short strings untouched', () => {
    expect(truncateOnCodePointBoundary('short', MAX_EXCERPT_CODE_POINTS)).toBe('short');
    expect(truncateOnCodePointBoundary('', MAX_EXCERPT_CODE_POINTS)).toBe('');
  });

  it('keeps exactly maxCodePoints ASCII characters', () => {
    const text = 'a'.repeat(2500);
    const out = truncateOnCodePointBoundary(text, MAX_EXCERPT_CODE_POINTS);
    expect(out).toBe('a'.repeat(2000));
    expect(out.length).toBe(2000);
  });

  it('never splits a surrogate pair (emoji / astral code points)', () => {
    // 2500 astral code points: each is a 2-unit surrogate pair.
    const text = '🙂'.repeat(2500);
    const out = truncateOnCodePointBoundary(text, MAX_EXCERPT_CODE_POINTS);
    expect([...out]).toHaveLength(2000);
    expect(out.length).toBe(4000);
    // No lone surrogate may survive the cut.
    expect(out.includes('�')).toBe(false);
    for (let i = 0; i < out.length; i += 2) {
      const code = out.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(out.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(out.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  it('mixes BMP and astral code points and counts them as one each', () => {
    // 'a' is 1 unit / 1 code point; '🙂' is 2 units / 1 code point.
    const text = 'a🙂'.repeat(1500); // 3000 code points, 4500 units
    const out = truncateOnCodePointBoundary(text, MAX_EXCERPT_CODE_POINTS);
    expect([...out]).toHaveLength(2000);
    expect(out.length).toBe(3000);
  });

  it('handles a cut that lands exactly on a pair boundary', () => {
    const text = `${'a'.repeat(1999)}🙂tail`;
    const out = truncateOnCodePointBoundary(text, MAX_EXCERPT_CODE_POINTS);
    expect([...out]).toHaveLength(2000);
    expect(out.endsWith('🙂')).toBe(true);
  });

  it('returns an empty string for a non-positive limit', () => {
    expect(truncateOnCodePointBoundary('abc', 0)).toBe('');
    expect(truncateOnCodePointBoundary('abc', -1)).toBe('');
  });
});
