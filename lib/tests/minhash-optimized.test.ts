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

  it('handles empty sets and near-1 thresholds without crashing', () => {
    expect(jaccardSimilarityWithThreshold(new Set(), new Set(), 0.9)).toBe(0);
    const a = new Set(['foo', 'bar']);
    expect(jaccardSimilarityWithThreshold(a, new Set(), 0.9)).toBe(-1);
    const exact = jaccardSimilarity(a, new Set(a));
    expect(jaccardSimilarityWithThreshold(a, new Set(a), 0.99)).toBeGreaterThanOrEqual(0.99);
    expect(jaccardSimilarityWithThreshold(a, new Set(a), 0.99)).toBeLessThanOrEqual(exact);
  });

  it('returns values in [threshold, exact] across varied set sizes', () => {
    const pools = [
      ['foo', 'bar', 'baz', 'qux', 'quux'],
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
      ['red', 'green', 'blue'],
    ];
    for (const pool of pools) {
      for (const sizeA of [1, 3, pool.length]) {
        for (const sizeB of [1, 2, pool.length]) {
          const a = new Set(pool.slice(0, sizeA));
          const b = new Set(pool.slice(pool.length - sizeB));
          const exact = jaccardSimilarity(a, b);
          for (const threshold of [0.1, 0.3, 0.5, 0.8]) {
            const result = jaccardSimilarityWithThreshold(a, b, threshold);
            if (result === -1) {
              expect(exact).toBeLessThan(threshold);
            } else {
              expect(result).toBeGreaterThanOrEqual(threshold);
              expect(result).toBeLessThanOrEqual(exact);
            }
          }
        }
      }
    }
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
