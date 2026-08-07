import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, mergeRepoConfig } from '../src/utils/config.js';

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
  const ORIGINAL_FAIL_ON_SEVERITY = process.env.FAIL_ON_SEVERITY;

  afterEach(() => {
    if (ORIGINAL_FAIL_ON_SEVERITY === undefined) {
      process.env.FAIL_ON_SEVERITY = '';
    } else {
      process.env.FAIL_ON_SEVERITY = ORIGINAL_FAIL_ON_SEVERITY;
    }
  });

  it('defaults failOnSeverity to off', () => {
    process.env.FAIL_ON_SEVERITY = '';
    expect(buildConfig().review.failOnSeverity).toBe('off');
  });

  it('honors a valid FAIL_ON_SEVERITY value', () => {
    process.env.FAIL_ON_SEVERITY = 'important';
    expect(buildConfig().review.failOnSeverity).toBe('important');
  });

  it('normalizes case and surrounding whitespace in FAIL_ON_SEVERITY', () => {
    process.env.FAIL_ON_SEVERITY = ' CRITICAL ';
    expect(buildConfig().review.failOnSeverity).toBe('critical');
    process.env.FAIL_ON_SEVERITY = 'off';
    expect(buildConfig().review.failOnSeverity).toBe('off');
  });

  it('degrades gracefully to off for an invalid FAIL_ON_SEVERITY value', () => {
    process.env.FAIL_ON_SEVERITY = 'blocker';
    expect(buildConfig().review.failOnSeverity).toBe('off');
  });
});

describe('mergeRepoConfig sca merge', () => {
  it('applies a repo sca section on top of the base config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-sca-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        [
          'sca:',
          '  enabled: false',
          '  minSeverity: critical',
          '  excludePatterns:',
          '    - "**/vendor/**"',
          '',
        ].join('\n'),
      );

      const merged = mergeRepoConfig(buildConfig(), dir);

      expect(merged.sca).toBeDefined();
      expect(merged.sca?.enabled).toBe(false);
      expect(merged.sca?.minSeverity).toBe('critical');
      expect(merged.sca?.excludePatterns).toEqual(['**/vendor/**']);
      // Untouched SCA fields retain their defaults.
      expect(merged.sca?.lockFilePatterns).toEqual(DEFAULT_CONFIG.sca?.lockFilePatterns);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the base config untouched when the repo has no sca section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-nosca-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  failOnSeverity: important', ''].join('\n'),
      );
      const merged = mergeRepoConfig(buildConfig(), dir);
      expect(merged.sca).toEqual(DEFAULT_CONFIG.sca);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeRepoConfig suggestTitleAndLabels merge', () => {
  it('enables suggestions when the repo config sets review.suggestTitleAndLabels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-suggestion-on-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  suggestTitleAndLabels: true', ''].join('\n'),
      );
      const merged = mergeRepoConfig(buildConfig(), dir);
      expect(merged.review.suggestTitleAndLabels).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables suggestions when the repo config sets review.suggestTitleAndLabels: false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-suggestion-off-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  suggestTitleAndLabels: false', ''].join('\n'),
      );
      const merged = mergeRepoConfig(buildConfig(), dir);
      expect(merged.review.suggestTitleAndLabels).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
