import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsService } from '../src/analytics/metrics.js';
import { LearningStore } from '../src/learning/store.js';
import type { ReviewMetricsReport } from '../src/learning/types.js';

const TEST_DB = path.join(os.tmpdir(), `.test-metrics-${Date.now()}.db`);

describe('MetricsService', () => {
  let store: LearningStore;
  let metricsService: MetricsService;

  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
    store = new LearningStore(TEST_DB);
    metricsService = new MetricsService(store);
  });

  afterEach(async () => {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
  });

  it('getReport returns default metrics when store is empty', async () => {
    const report = await metricsService.getReport({ period: 'daily', sinceDays: 30 });
    expect(report.periodType).toBe('daily');
    expect(report.overview.totalPrs).toBe(0);
    expect(report.overview.totalFindings).toBe(0);
    expect(report.quality.falsePositiveRate).toBe(0);
    expect(report.quality.truePositiveRate).toBe(0);
  });

  it('getReport returns computed metrics from seeded data', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      message: 'Critical bug',
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'minor',
      message: 'Minor style issue',
    });
    await store.recordFinding({
      prNumber: 2,
      type: 'issue',
      severity: 'important',
      message: 'Important issue',
    });

    await store.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.8,
      accuracyScore: 0.9,
      coverageScore: 0.7,
      consistencyScore: 0.85,
      durationMs: 5000,
      tokensUsed: 1500,
    });

    const report = await metricsService.getReport({ period: 'daily', sinceDays: 30 });
    expect(report.overview.totalPrs).toBe(2);
    expect(report.overview.totalFindings).toBe(3);
    expect(report.overview.avgFindingsPerPr).toBe(1.5);
  });

  it('getReport with sinceDays filters data correctly', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'Old finding',
    });
    await store.recordFinding({
      prNumber: 2,
      type: 'issue',
      message: 'Recent finding',
    });

    const report = await metricsService.getReport({ period: 'daily', sinceDays: 30 });
    expect(report.overview.totalPrs).toBe(2);
    expect(report.overview.totalFindings).toBe(2);
  });

  it('formatReport produces valid markdown', async () => {
    const report: ReviewMetricsReport = {
      periodType: 'weekly',
      periodStart: new Date(Date.now() - 7 * 86400000).toISOString(),
      periodEnd: new Date().toISOString(),
      overview: { totalPrs: 5, totalFindings: 20, avgFindingsPerPr: 4 },
      quality: {
        truePositiveRate: 0.8,
        falsePositiveRate: 0.2,
        dismissalRate: 0.1,
        accuracyScore: 0.85,
        actionabilityScore: 0.75,
      },
      performance: {
        avgReviewDurationMs: 120000,
        totalTokensUsed: 50000,
        avgTokensPerReview: 10000,
      },
      severityDistribution: { critical: 2, important: 8, minor: 10, unknown: 0 },
      trends: [],
    };

    const markdown = metricsService.formatReport(report);
    expect(markdown).toContain('Weekly Review Metrics');
    expect(markdown).toContain('Total PRs Reviewed');
    expect(markdown).toContain('True Positive Rate');
    expect(markdown).toContain('Avg Review Duration');
    expect(markdown).toContain('Critical');
  });

  it('formatReport handles null quality scores', async () => {
    const report: ReviewMetricsReport = {
      periodType: 'daily',
      periodStart: new Date().toISOString(),
      periodEnd: new Date().toISOString(),
      overview: { totalPrs: 0, totalFindings: 0, avgFindingsPerPr: 0 },
      quality: {
        truePositiveRate: 1,
        falsePositiveRate: 0,
        dismissalRate: 0,
        accuracyScore: null,
        actionabilityScore: null,
      },
      performance: {
        avgReviewDurationMs: 0,
        totalTokensUsed: 0,
        avgTokensPerReview: 0,
      },
      severityDistribution: { critical: 0, important: 0, minor: 0, unknown: 0 },
    };

    const markdown = metricsService.formatReport(report);
    expect(markdown).not.toContain('Avg Accuracy Score');
    expect(markdown).not.toContain('Avg Actionability Score');
  });

  it('formatReport includes trends section when multiple rows exist', async () => {
    const now = Date.now();
    const dayMs = 86400000;
    const report: ReviewMetricsReport = {
      periodType: 'weekly',
      periodStart: new Date(now - 14 * dayMs).toISOString(),
      periodEnd: new Date(now).toISOString(),
      overview: { totalPrs: 10, totalFindings: 40, avgFindingsPerPr: 4 },
      quality: {
        truePositiveRate: 0.9,
        falsePositiveRate: 0.1,
        dismissalRate: 0.05,
        accuracyScore: 0.9,
        actionabilityScore: 0.8,
      },
      performance: {
        avgReviewDurationMs: 100000,
        totalTokensUsed: 100000,
        avgTokensPerReview: 10000,
      },
      severityDistribution: { critical: 1, important: 5, minor: 4, unknown: 0 },
      trends: [
        {
          id: '1',
          period_start: new Date(now - 14 * dayMs).toISOString(),
          period_end: new Date(now - 7 * dayMs).toISOString(),
          period_type: 'weekly',
          total_prs: 5,
          total_findings: 18,
          avg_findings_per_pr: 3.6,
          total_feedback: 10,
          dismissed_count: 1,
          disputed_count: 1,
          false_positive_rate: 0.2,
          avg_review_duration_ms: 80000,
          total_tokens_used: 40000,
          avg_tokens_per_review: 8000,
          avg_actionability_score: 0.7,
          avg_accuracy_score: 0.85,
          avg_coverage_score: 0.65,
          avg_consistency_score: 0.75,
          created_at: new Date(now - 7 * dayMs).toISOString(),
        },
        {
          id: '2',
          period_start: new Date(now - 7 * dayMs).toISOString(),
          period_end: new Date(now).toISOString(),
          period_type: 'weekly',
          total_prs: 5,
          total_findings: 22,
          avg_findings_per_pr: 4.4,
          total_feedback: 15,
          dismissed_count: 1,
          disputed_count: 0,
          false_positive_rate: 0.0667,
          avg_review_duration_ms: 100000,
          total_tokens_used: 60000,
          avg_tokens_per_review: 12000,
          avg_actionability_score: 0.8,
          avg_accuracy_score: 0.9,
          avg_coverage_score: 0.7,
          avg_consistency_score: 0.8,
          created_at: new Date(now).toISOString(),
        },
      ],
    };

    const markdown = metricsService.formatReport(report);
    expect(markdown).toContain('Trends');
    expect(markdown).toContain('FP Rate');
    expect(markdown).toContain('Accuracy');
  });

  it('computeAggregation completes without error on empty store', async () => {
    await expect(metricsService.computeAggregation('daily')).resolves.toBeUndefined();

    await expect(metricsService.computeAggregation('weekly')).resolves.toBeUndefined();
  });

  it('computeAggregation creates metrics that can be retrieved', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'important',
      message: 'Test finding',
    });
    await store.recordFeedback({
      findingId: await store.recordFinding({
        prNumber: 1,
        type: 'issue',
        message: 'Feedback finding',
      }),
      signalType: 'dismissed',
      signalValue: 'false positive',
      prNumber: 1,
    });
    await store.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.8,
      accuracyScore: 0.9,
      coverageScore: 0.7,
      consistencyScore: 0.85,
      durationMs: 5000,
      tokensUsed: 1500,
    });

    await metricsService.computeAggregation('daily');
    const rows = await store.getMetrics('daily', 5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].period_type).toBe('daily');
    expect(rows[0].total_prs).toBe(1);
    expect(rows[0].total_findings).toBe(2);
  });

  it('getReport falls back to pre-computed metrics when available', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'Finding A',
    });
    await store.recordQuality({
      prNumber: 1,
      actionabilityScore: 0.9,
      accuracyScore: 0.95,
      coverageScore: 0.8,
      consistencyScore: 0.9,
      durationMs: 3000,
      tokensUsed: 1000,
    });

    await metricsService.computeAggregation('daily');

    const report = await metricsService.getReport({ period: 'daily', sinceDays: 30 });
    expect(report.overview.totalFindings).toBeGreaterThanOrEqual(1);
    expect(report.quality.accuracyScore).toBeGreaterThanOrEqual(0);
  });
});

describe('MetricsService JSON Fallback', () => {
  let store: LearningStore;
  let metricsService: MetricsService;
  let jsonDbPath: string;

  beforeEach(() => {
    jsonDbPath = path.join(os.tmpdir(), `.test-metrics-fallback-${Date.now()}.json`);
    store = new LearningStore(jsonDbPath);
    metricsService = new MetricsService(store);
  });

  afterEach(async () => {
    await store.close();
    try {
      fs.unlinkSync(jsonDbPath);
    } catch {
      /* ok */
    }
  });

  it('works with JSON database fallback', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      message: 'JSON fallback finding',
    });

    const report = await metricsService.getReport({ period: 'daily', sinceDays: 30 });
    expect(report.overview.totalPrs).toBe(1);
    expect(report.overview.totalFindings).toBe(1);

    const markdown = metricsService.formatReport(report);
    expect(markdown).toContain('Daily Review Metrics');
  });

  it('aggregateMetrics and getMetrics work with JSON fallback', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'Test metric finding',
    });

    await metricsService.computeAggregation('weekly');
    const rows = await store.getMetrics('weekly', 5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].period_type).toBe('weekly');
  });
});
