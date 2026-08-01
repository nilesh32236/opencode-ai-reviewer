import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/utils/config.js';

const CONVERSATION_ENV_KEYS = [
  'CONVERSATION_MENTION_HANDLE',
  'CONVERSATION_MAX_TURNS',
  'CONVERSATION_SLIDING_WINDOW_SIZE',
  'CONVERSATION_CONTEXT_TOKEN_BUDGET',
  'CONVERSATION_SUMMARIZATION_MODEL',
] as const;

afterEach(() => {
  for (const key of CONVERSATION_ENV_KEYS) {
    delete process.env[key];
  }
});

describe('buildConfig conversation section', () => {
  it('falls back to the shared defaults when env vars are unset', () => {
    const config = buildConfig();
    expect(config.conversation.mentionHandle).toBe('opencode-reviewer');
    expect(config.conversation.maxTurns).toBe(50);
    expect(config.conversation.slidingWindowSize).toBe(20);
    expect(config.conversation.contextTokenBudget).toBe(32000);
    expect(config.conversation.summarizationModel).toBeUndefined();
  });

  it('normalizes a leading @ on the mention handle', () => {
    process.env.CONVERSATION_MENTION_HANDLE = '@my-bot';
    expect(buildConfig().conversation.mentionHandle).toBe('my-bot');
  });

  it('treats CONVERSATION_MAX_TURNS=0 as unlimited', () => {
    process.env.CONVERSATION_MAX_TURNS = '0';
    expect(buildConfig().conversation.maxTurns).toBe(0);
  });

  it('clamps out-of-range conversation env values', () => {
    process.env.CONVERSATION_MAX_TURNS = '-5';
    expect(buildConfig().conversation.maxTurns).toBe(0);
    process.env.CONVERSATION_MAX_TURNS = '99999';
    expect(buildConfig().conversation.maxTurns).toBe(1000);
    process.env.CONVERSATION_SLIDING_WINDOW_SIZE = '0';
    expect(buildConfig().conversation.slidingWindowSize).toBe(1);
    process.env.CONVERSATION_SLIDING_WINDOW_SIZE = '99999';
    expect(buildConfig().conversation.slidingWindowSize).toBe(500);
    process.env.CONVERSATION_CONTEXT_TOKEN_BUDGET = '10';
    expect(buildConfig().conversation.contextTokenBudget).toBe(1000);
    process.env.CONVERSATION_CONTEXT_TOKEN_BUDGET = '99999999';
    expect(buildConfig().conversation.contextTokenBudget).toBe(1000000);
  });

  it('falls back to the default when an env value is not a valid integer', () => {
    process.env.CONVERSATION_MAX_TURNS = 'abc';
    expect(buildConfig().conversation.maxTurns).toBe(50);
  });

  it('omits summarizationModel when the env var is blank', () => {
    process.env.CONVERSATION_SUMMARIZATION_MODEL = '   ';
    expect(buildConfig().conversation.summarizationModel).toBeUndefined();
  });

  it('sets summarizationModel when the env var is provided', () => {
    process.env.CONVERSATION_SUMMARIZATION_MODEL = 'opencode/deepseek-r1';
    expect(buildConfig().conversation.summarizationModel).toBe('opencode/deepseek-r1');
  });
});
