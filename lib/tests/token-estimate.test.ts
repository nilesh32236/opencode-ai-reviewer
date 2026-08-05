import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../src/utils/token-estimate.js';

const ENGLISH_SENTENCE =
  'The quick brown fox jumps over the lazy dog near the river bank while the sun sets slowly behind the hills in the distance and the birds return home for the evening rest peacefully before night falls.';

const CODE_SNIPPET = `export function compute(xs, ys) {
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > 2 && ys[i] < 6) {
      total += xs[i] * 2;
    }
  }
  return { total: total, count: xs.length };
}`;

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates plain words with no symbols', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('scales up for symbol-heavy code', () => {
    const estimate = estimateTokens('const x = 1; console.log(x);');
    expect(estimate).toBeGreaterThan(5);
    expect(estimate).toBeLessThan(30);
  });

  it('approximates a 200-char English sentence near 50 tokens', () => {
    const estimate = estimateTokens(ENGLISH_SENTENCE);
    expect(estimate).toBeGreaterThanOrEqual(40);
    expect(estimate).toBeLessThanOrEqual(60);
  });

  it('estimates code as more token-dense than prose', () => {
    const englishEstimate = estimateTokens(ENGLISH_SENTENCE);
    const codeEstimate = estimateTokens(CODE_SNIPPET);
    expect(codeEstimate).toBeGreaterThan(englishEstimate);
  });

  it('does not fall back to the old characters-per-4 heuristic for code', () => {
    const codeEstimate = estimateTokens(CODE_SNIPPET);
    expect(codeEstimate).not.toBe(Math.ceil(CODE_SNIPPET.length / 4));
  });
});
