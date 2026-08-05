import { describe, expect, it } from 'vitest';
import {
  clearTokenCache,
  jaccardSimilarity,
  jaccardSimilarityWithThreshold,
  tokenizeMessage,
} from '../src/pattern-detector/minhash-optimized.js';

describe('jaccardSimilarityWithThreshold', () => {
  it('returns a similarity >= threshold for identical sets', () => {
    const a = new Set([
      'foo',
      'bar',
      'baz',
      'qux',
      'quux',
      'corge',
      'grault',
      'garply',
      'waldo',
      'fred',
    ]);
    const result = jaccardSimilarityWithThreshold(a, new Set(a), 0.5);
    expect(result).toBeGreaterThanOrEqual(0.5);
  });

  it('returns a value at least the threshold and never above the exact similarity', () => {
    const a = new Set(['foo', 'bar', 'baz', 'qux']);
    const b = new Set(['foo', 'bar', 'baz', 'qux', 'extra']);
    const exact = jaccardSimilarity(a, b);
    const withThreshold = jaccardSimilarityWithThreshold(a, b, 0.5);
    expect(withThreshold).toBeGreaterThanOrEqual(0.5);
    expect(withThreshold).toBeLessThanOrEqual(exact);
  });

  it('returns -1 when similarity is below the threshold', () => {
    const a = new Set(['foo', 'bar', 'baz']);
    const b = new Set(['qux', 'quux', 'corge', 'grault', 'garply']);
    expect(jaccardSimilarityWithThreshold(a, b, 0.5)).toBe(-1);
  });
});

describe('tokenizeMessage cache', () => {
  it('caches token sets for identical messages', () => {
    clearTokenCache();
    const first = tokenizeMessage('Missing error handling in async function');
    const second = tokenizeMessage('Missing error handling in async function');
    expect(second).toBe(first);
    clearTokenCache();
  });
});
