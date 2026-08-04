import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/utils/config.js';

const TOKEN_BUDGET_DEFAULT = DEFAULT_CONFIG.review.tokenBudget;

describe('buildConfig TOKEN_BUDGET override', () => {
  const envKeys = [
    'TOKEN_BUDGET',
    'REVIEW_MODEL',
    'FIX_MODEL',
    'BATCH_SIZE',
    'MAX_LINES_PER_FILE',
    'MAX_ITERATIONS',
    'ENABLE_MCP',
    'REVIEW_INLINE',
    'CONVERSATION_MAX_TURNS',
    'RATE_LIMIT_ENABLED',
  ];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it('falls back to the default token budget when TOKEN_BUDGET is malformed', () => {
    process.env.TOKEN_BUDGET = 'not-json';

    expect(() => buildConfig()).not.toThrow();
    expect(buildConfig().review.tokenBudget).toEqual(TOKEN_BUDGET_DEFAULT);
  });

  it('falls back to the default token budget when TOKEN_BUDGET is a JSON array', () => {
    process.env.TOKEN_BUDGET = '[1, 2, 3]';

    expect(() => buildConfig()).not.toThrow();
    expect(buildConfig().review.tokenBudget).toEqual(TOKEN_BUDGET_DEFAULT);
  });

  it('uses the parsed token budget when TOKEN_BUDGET is valid JSON', () => {
    process.env.TOKEN_BUDGET = JSON.stringify({
      enabled: true,
      maxLinesComplex: 400,
      maxLinesSimple: 40,
      complexityThreshold: 50,
      simpleThreshold: 20,
    });

    expect(() => buildConfig()).not.toThrow();
    expect(buildConfig().review.tokenBudget).toEqual({
      enabled: true,
      maxLinesComplex: 400,
      maxLinesSimple: 40,
      complexityThreshold: 50,
      simpleThreshold: 20,
    });
  });

  it('uses the default token budget when TOKEN_BUDGET is unset', () => {
    expect(buildConfig().review.tokenBudget).toEqual(TOKEN_BUDGET_DEFAULT);
  });
});

describe('buildConfig FAIL_ON_SEVERITY override', () => {
  afterEach(() => {
    process.env.FAIL_ON_SEVERITY = undefined;
  });

  it('defaults failOnSeverity to critical', () => {
    expect(buildConfig().review.failOnSeverity).toBe('critical');
  });

  it('honors a valid FAIL_ON_SEVERITY value', () => {
    process.env.FAIL_ON_SEVERITY = 'important';
    expect(buildConfig().review.failOnSeverity).toBe('important');
  });

  it('degrades gracefully to critical for an invalid FAIL_ON_SEVERITY value', () => {
    process.env.FAIL_ON_SEVERITY = 'blocker';
    expect(buildConfig().review.failOnSeverity).toBe('critical');
  });
});
