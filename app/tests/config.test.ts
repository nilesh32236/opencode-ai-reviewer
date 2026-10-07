import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_OPENCODE_INVOCATION_TIMEOUT_MINUTES,
  buildConfig,
  mergeRepoConfig,
} from '../src/utils/config.js';

const TOKEN_BUDGET_DEFAULT = DEFAULT_CONFIG.review.tokenBudget;

describe('buildConfig service timeout', () => {
  it('keeps the hosted App cap explicit', () => {
    expect(buildConfig().timeoutMinutes).toBe(APP_OPENCODE_INVOCATION_TIMEOUT_MINUTES);
  });
});

describe('buildConfig engine-critical integer env overrides', () => {
  // The Probot App builds its config with `buildConfig()` (app/src/index.ts:186)
  // and hands the result straight to the engine — nothing runs it through
  // `AgentConfigSchema`, so the `z.number().int().min(1).max(10)` bounds in
  // lib/src/types/schemas.ts are never applied to these values.
  //
  // `batchSize` is not cosmetic: lib/src/engine.ts:1383 reads it as
  // `this.config.batchSize || 3`, which only guards the FALSY case, and
  // lib/src/engine.ts:2044 then does
  //     for (let i = 0; i < files.length; i += batchSize)
  //       fileBatches.push(files.slice(i, i + batchSize));
  // A negative batchSize is truthy, so it survives and turns the counter into a
  // decrementing one that never terminates, growing `fileBatches` without bound
  // in a long-lived worker.
  //
  // Every other env-derived integer in this file already goes through clampInt;
  // these three did not.
  const envKeys = ['BATCH_SIZE', 'MAX_LINES_PER_FILE', 'MAX_ITERATIONS'];

  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  it('clamps a negative BATCH_SIZE into the valid range', () => {
    process.env.BATCH_SIZE = '-1';

    const { batchSize } = buildConfig();

    expect(batchSize).toBeGreaterThanOrEqual(1);
    expect(batchSize).toBeLessThanOrEqual(10);
  });

  it('clamps an absurdly large BATCH_SIZE into the valid range', () => {
    process.env.BATCH_SIZE = '999999';

    const { batchSize } = buildConfig();

    expect(batchSize).toBeLessThanOrEqual(10);
  });

  it('clamps a zero BATCH_SIZE instead of letting the engine divide by it', () => {
    process.env.BATCH_SIZE = '0';

    // 0 is falsy so the engine's `|| 3` would cover it, but buildConfig must
    // still hand over a valid positive integer rather than 0.
    expect(buildConfig().batchSize).toBeGreaterThanOrEqual(1);
  });

  it('still accepts an ordinary in-range BATCH_SIZE unchanged', () => {
    // Guards against a clamp that silently pins everything to the default.
    process.env.BATCH_SIZE = '7';

    expect(buildConfig().batchSize).toBe(7);
  });

  it('leaves an unset BATCH_SIZE at the documented default', () => {
    expect(buildConfig().batchSize).toBe(DEFAULT_CONFIG.batchSize);
  });

  it('clamps the neighbouring engine-critical integers the same way', () => {
    process.env.MAX_LINES_PER_FILE = '-5';
    process.env.MAX_ITERATIONS = '-1';

    const config = buildConfig();

    expect(config.maxLinesPerFile).toBeGreaterThanOrEqual(0);
    expect(config.maxIterations).toBeGreaterThanOrEqual(1);
    expect(config.maxIterations).toBeLessThanOrEqual(10);
  });
});

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

describe('buildConfig ENABLE_REVIEWS_ARRAY_INLINE override', () => {
  const ENV_KEY = 'ENABLE_REVIEWS_ARRAY_INLINE';
  const ORIGINAL = process.env[ENV_KEY];

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = ORIGINAL;
    }
  });

  it('leaves enableReviewsArrayInline unset when env is absent', () => {
    delete process.env[ENV_KEY];
    expect(buildConfig().review.enableReviewsArrayInline).toBeUndefined();
  });

  it('honors ENABLE_REVIEWS_ARRAY_INLINE=true', () => {
    process.env.ENABLE_REVIEWS_ARRAY_INLINE = 'true';
    expect(buildConfig().review.enableReviewsArrayInline).toBe(true);
  });

  it('honors ENABLE_REVIEWS_ARRAY_INLINE=false', () => {
    process.env.ENABLE_REVIEWS_ARRAY_INLINE = 'false';
    expect(buildConfig().review.enableReviewsArrayInline).toBe(false);
  });
});

describe('mergeRepoConfig enableReviewsArrayInline merge', () => {
  it('applies review.enableReviewsArrayInline from the repo config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-reviews-array-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  enableReviewsArrayInline: true', ''].join('\n'),
      );
      const merged = mergeRepoConfig(buildConfig(), dir);
      expect(merged.review.enableReviewsArrayInline).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns base config untouched when repo has no enableReviewsArrayInline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-no-reviews-array-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  failOnSeverity: important', ''].join('\n'),
      );
      const base = buildConfig();
      const merged = mergeRepoConfig(base, dir);
      expect(merged.review.enableReviewsArrayInline).toBe(base.review.enableReviewsArrayInline);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `REPO_CONFIG_MERGE_FIELDS` (lib/src/utils/repo-config-spec.ts) is the single
 * table both the presence guard (`hasRepoConfigOverrides`) and the merge body
 * derive from, precisely so a field cannot be in one and not the other. Two
 * ways that broke:
 *
 *  - `project.autoLoadConventions` was honoured by the merge body as a legacy
 *    alias of `project.autoLoadAgentsMd` (app/src/utils/config.ts:443) but was
 *    absent from the table, so the guard saw no overrides and returned the base
 *    config untouched. The opt-in silently did nothing.
 *  - `review.showEffortEstimate` and `review.showSelfReviewChecklist` were IN
 *    the table, so the guard reported "has overrides", but the merge body never
 *    extracted or spread them, so both keys were dropped.
 *
 * These tests assert the guard AND the merge agree, which is the property the
 * table claims to guarantee.
 */
describe('mergeRepoConfig guard/body agreement for spec-table fields', () => {
  it('honours project.autoLoadConventions when it is the ONLY project key set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-autoLoadConventions-'));
    try {
      // Only the legacy alias. `project.autoLoadAgentsMd` is deliberately absent:
      // if the guard table omits the alias this config has no recognised field,
      // mergeRepoConfig early-returns baseConfig, and the opt-in is dropped.
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['project:', '  autoLoadConventions: true', ''].join('\n'),
      );
      const base = buildConfig();
      expect(base.projectContext?.autoLoadConventions).not.toBe(true);

      const merged = mergeRepoConfig(base, dir);

      expect(merged.projectContext?.autoLoadConventions).toBe(true);
      expect(merged.projectContext?.autoLoadAgentsMd).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges review.showEffortEstimate, which the guard already accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-effort-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  showEffortEstimate: false', ''].join('\n'),
      );
      const base = buildConfig();

      // Default is `true`, so flipping to `false` is what makes "merged"
      // distinguishable from "silently dropped".
      expect(base.review.showEffortEstimate).toBe(true);

      const merged = mergeRepoConfig(base, dir);

      expect(merged.review.showEffortEstimate).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges review.showSelfReviewChecklist, which the guard already accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-checklist-'));
    try {
      // Both keys default to `true` (lib/src/types/index.ts:2312-2313), so a
      // repo config that also says `true` proves nothing — the merged value
      // would match the base either way and the test would be GREEN FOR THE
      // WRONG REASON. Flip to `false` so "merged" is distinguishable from
      // "silently dropped".
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  showSelfReviewChecklist: false', ''].join('\n'),
      );
      const base = buildConfig();
      expect(base.review.showSelfReviewChecklist).toBe(true);

      const merged = mergeRepoConfig(base, dir);

      expect(merged.review.showSelfReviewChecklist).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still honours the canonical project.autoLoadAgentsMd key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-autoLoadAgentsMd-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['project:', '  autoLoadAgentsMd: false', ''].join('\n'),
      );
      const merged = mergeRepoConfig(buildConfig(), dir);

      expect(merged.projectContext?.autoLoadAgentsMd).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges review.verdictMode, which the guard already accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-config-verdictMode-'));
    try {
      writeFileSync(
        join(dir, '.opencode-reviewer.yml'),
        ['review:', '  verdictMode: request-changes', ''].join('\n'),
      );
      const base = buildConfig();
      expect(base.review.verdictMode).toBeUndefined();

      const merged = mergeRepoConfig(base, dir);

      expect(merged.review.verdictMode).toBe('request-changes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads VERDICT_MODE from the environment, and leaves it absent when unset', () => {
    // Reaches the code it names: `normalizeVerdictMode` resolves anything
    // unrecognised (and an absent value) to 'comment', so assigning it
    // unconditionally would pin every App-hosted repo to COMMENT gating.
    // Absence must stay absence. `vi.stubEnv(name, undefined)` removes the var
    // and `unstubAllEnv` restores whatever the process actually had.
    try {
      vi.stubEnv('VERDICT_MODE', undefined);
      expect(buildConfig().review.verdictMode).toBeUndefined();

      vi.stubEnv('VERDICT_MODE', 'request-changes');
      expect(buildConfig().review.verdictMode).toBe('request-changes');

      // Invalid values fall back rather than propagating garbage.
      vi.stubEnv('VERDICT_MODE', 'nonsense');
      expect(buildConfig().review.verdictMode).toBe('comment');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
