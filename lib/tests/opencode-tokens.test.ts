import { describe, expect, it } from 'vitest';
import { parseTokenUsage, parseTokenUsageDetailed } from '../src/opencode.js';

describe('parseTokenUsageDetailed', () => {
  it('parses total_tokens with prompt/completion breakdown in JSON format', () => {
    const output =
      '{"usage": {"total_tokens": 1234, "prompt_tokens": 1000, "completion_tokens": 234}}';
    expect(parseTokenUsageDetailed(output)).toEqual({
      totalTokens: 1234,
      promptTokens: 1000,
      completionTokens: 234,
    });
  });

  it('captures prompt/completion from Anthropic input/output tokens', () => {
    const output = 'Anthropic response: {"input_tokens": 800, "output_tokens": 200}';
    expect(parseTokenUsageDetailed(output)).toEqual({
      totalTokens: 1000,
      promptTokens: 800,
      completionTokens: 200,
    });
  });

  it('leaves prompt/completion undefined when only total is present', () => {
    const output = 'Execution completed. total tokens: 5678';
    expect(parseTokenUsageDetailed(output)).toEqual({ totalTokens: 5678 });
  });

  it('returns zero breakdown when no token usage pattern matches', () => {
    expect(parseTokenUsageDetailed('no stats here')).toEqual({ totalTokens: 0 });
  });
});

describe('parseTokenUsage', () => {
  it('parses total_tokens in JSON format', () => {
    const output =
      '{"usage": {"total_tokens": 1234, "prompt_tokens": 1000, "completion_tokens": 234}}';
    expect(parseTokenUsage(output)).toBe(1234);
  });

  it('parses total tokens with space separator', () => {
    const output = 'Execution completed. total tokens: 5678';
    expect(parseTokenUsage(output)).toBe(5678);
  });

  it('sums input_tokens and output_tokens when total_tokens is absent', () => {
    const output = 'Anthropic response: {"input_tokens": 800, "output_tokens": 200}';
    expect(parseTokenUsage(output)).toBe(1000);
  });

  it('handles output with only input_tokens', () => {
    const output = 'Prompt processed: input_tokens: 500';
    expect(parseTokenUsage(output)).toBe(500);
  });

  it('handles output with only output_tokens', () => {
    const output = 'Response generated: output_tokens: 350';
    expect(parseTokenUsage(output)).toBe(350);
  });

  it('returns 0 when no token usage pattern matches', () => {
    const output = 'Review finished with no token stats output';
    expect(parseTokenUsage(output)).toBe(0);
  });

  it('returns 0 for empty output', () => {
    expect(parseTokenUsage('')).toBe(0);
  });
});
