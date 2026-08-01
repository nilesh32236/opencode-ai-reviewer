import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonDbAdapter } from '../src/learning/db/json.js';
import { JsonDatabase } from '../src/learning/json-db.js';
import { QUALITY_SCORE_SQL_FRAGMENT, hasQualityScore } from '../src/learning/quality.js';
import { LearningStore } from '../src/learning/store.js';
import type { ReviewQualityRow } from '../src/learning/types.js';

const TEST_SQLITE = path.join(os.tmpdir(), `.test-quality-${Date.now()}.db`);
const TEST_JSON = path.join(os.tmpdir(), `.test-quality-${Date.now()}.json`);

/** A telemetry-only row: all scores 0 but carries token/duration data. */
function telemetryRow(overrides: Partial<ReviewQualityRow> = {}): ReviewQualityRow {
  return {
    id: 't1',
    pr_number: 0,
    actionability_score: 0,
    accuracy_score: 0,
    coverage_score: 0,
    consistency_score: 0,
    duration_ms: 1000,
    tokens_used: 500,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** A genuine quality row with real scores. */
function scoredRow(overrides: Partial<ReviewQualityRow> = {}): ReviewQualityRow {
  return {
    id: 's1',
    pr_number: 1,
    actionability_score: 0.8,
    accuracy_score: 0.7,
    coverage_score: 0.6,
    consistency_score: 0.9,
    duration_ms: 2000,
    tokens_used: 1000,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('hasQualityScore', () => {
  it('returns false for a telemetry-only row with all zero scores', () => {
    expect(hasQualityScore(telemetryRow())).toBe(false);
  });

  it('returns true when any score is positive', () => {
    expect(hasQualityScore(scoredRow())).toBe(true);
    expect(hasQualityScore({ ...telemetryRow(), actionability_score: 0.1 })).toBe(true);
  });

  it('exposes a SQL fragment referencing the same score columns', () => {
    expect(QUALITY_SCORE_SQL_FRAGMENT).toContain('actionability_score > 0');
    expect(QUALITY_SCORE_SQL_FRAGMENT).toContain('consistency_score > 0');
  });
});

describe('quality metrics backend parity', () => {
  let sqliteStore: LearningStore;
  let jsonAdapter: JsonDbAdapter;

  beforeEach(() => {
    for (const file of [TEST_SQLITE, TEST_SQLITE + '-wal', TEST_SQLITE + '-shm', TEST_JSON]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ok */
      }
    }
    sqliteStore = new LearningStore(TEST_SQLITE);
    jsonAdapter = new JsonDbAdapter(new JsonDatabase(TEST_JSON));
  });

  afterEach(async () => {
    await sqliteStore.close();
    for (const file of [TEST_SQLITE, TEST_SQLITE + '-wal', TEST_SQLITE + '-shm', TEST_JSON]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ok */
      }
    }
  });

  it('excludes telemetry-only rows from quality averages but counts their tokens in both backends', async () => {
    await sqliteStore.recordQuality({
      prNumber: 0,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 1000,
      tokensUsed: 500,
    });
    await sqliteStore.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.8,
      accuracyScore: 0.7,
      coverageScore: 0.6,
      consistencyScore: 0.9,
      durationMs: 2000,
      tokensUsed: 1000,
    });
    await jsonAdapter.recordQuality({
      prNumber: 0,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 1000,
      tokensUsed: 500,
    });
    await jsonAdapter.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.8,
      accuracyScore: 0.7,
      coverageScore: 0.6,
      consistencyScore: 0.9,
      durationMs: 2000,
      tokensUsed: 1000,
    });

    await sqliteStore.aggregateMetrics('daily');
    await jsonAdapter.aggregateMetrics('daily');

    const [sqliteMetrics] = await sqliteStore.getMetrics('daily', 1);
    const [jsonMetrics] = await jsonAdapter.getMetrics('daily', 1);

    // Tokens aggregate over ALL rows in the period (telemetry-only included).
    expect(sqliteMetrics.total_tokens_used).toBe(1500);
    expect(jsonMetrics.total_tokens_used).toBe(1500);
    expect(sqliteMetrics.avg_tokens_per_review).toBe(750);
    expect(jsonMetrics.avg_tokens_per_review).toBe(750);

    // Quality averages use scored rows only.
    expect(sqliteMetrics.avg_actionability_score).toBeCloseTo(0.8);
    expect(jsonMetrics.avg_actionability_score).toBeCloseTo(0.8);
    expect(sqliteMetrics.avg_accuracy_score).toBeCloseTo(0.7);
    expect(jsonMetrics.avg_accuracy_score).toBeCloseTo(0.7);
  });

  it('getQualityTrends excludes telemetry-only rows in both backends', async () => {
    await sqliteStore.recordQuality({
      prNumber: 0,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 1000,
      tokensUsed: 500,
    });
    await sqliteStore.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.8,
      accuracyScore: 0.7,
      coverageScore: 0.6,
      consistencyScore: 0.9,
      durationMs: 2000,
      tokensUsed: 1000,
    });
    await jsonAdapter.recordQuality({
      prNumber: 0,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 1000,
      tokensUsed: 500,
    });
    await jsonAdapter.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.8,
      accuracyScore: 0.7,
      coverageScore: 0.6,
      consistencyScore: 0.9,
      durationMs: 2000,
      tokensUsed: 1000,
    });

    const sqliteTrends = await sqliteStore.getQualityTrends();
    const jsonTrends = await jsonAdapter.getQualityTrends();

    expect(sqliteTrends).toHaveLength(1);
    expect(sqliteTrends[0].pr_number).toBe(1);
    expect(jsonTrends).toHaveLength(1);
    expect(jsonTrends[0].pr_number).toBe(1);
  });
});
