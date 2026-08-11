import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';

const TEST_DB = path.join(os.tmpdir(), `.test-learning-${Date.now()}.db`);

describe('LearningStore', () => {
  let store: LearningStore;

  beforeEach(() => {
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
    store = new LearningStore(TEST_DB);
  });

  afterEach(async () => {
    await store.close();
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
  });

  it('records and retrieves findings', async () => {
    const id = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      file: 'src/foo.ts',
      line: 42,
      message: 'Missing error handling',
    });

    const findings = await store.getFindings(1);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('Missing error handling');
    expect(findings[0].id).toBe(id);
  });

  it('records feedback and calculates false positive rate', async () => {
    const id = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test finding',
    });

    await store.recordFeedback({
      findingId: id,
      signalType: 'dismissed',
      signalValue: 'false positive',
      prNumber: 1,
    });

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });

  it('returns active custom rules as relevant lessons', async () => {
    await store.addCustomRule('Always handle async errors in Express routes', 'auto');
    const ruleId = await store.addCustomRule('Use strict equality', 'manual');
    await store.approveRule(ruleId);

    const lessons = await store.getRelevantLessons(['src/routes.ts']);
    expect(lessons).toContain('Use strict equality');
    expect(lessons).not.toContain('Always handle async errors in Express routes');
  });

  it('records and retrieves qualities', async () => {
    await store.recordQuality({
      prNumber: 1,
      actionabilityScore: 80,
      accuracyScore: 90,
      coverageScore: 70,
      consistencyScore: 85,
    });

    const trends = await store.getQualityTrends();
    expect(trends).toHaveLength(1);
    expect((trends[0] as Record<string, unknown>).actionability_score).toBe(80);
  });

  it('incrementAndCheckMetaReviewInterval triggers on interval', async () => {
    expect(await store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(await store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(await store.incrementAndCheckMetaReviewInterval(3)).toBe(true);
    expect(await store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(await store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(await store.incrementAndCheckMetaReviewInterval(3)).toBe(true);
  });

  it('records and retrieves patterns', async () => {
    await store.recordPattern({
      patternKey: 'missing-error-handling',
      messageCluster: ['Missing error handling in route', 'Unhandled promise rejection'],
      frequency: 3,
      fileTypes: ['.ts'],
    });

    const patterns = await store.getPatterns(3);
    expect(patterns).toHaveLength(1);
  });

  it('manages custom rule lifecycle', async () => {
    const id = await store.addCustomRule('Test rule', 'auto');
    expect(await store.getPendingRules()).toHaveLength(1);

    await store.approveRule(id);
    expect(await store.getPendingRules()).toHaveLength(0);

    const lessons = await store.getRelevantLessons(['test.ts']);
    expect(lessons).toContain('Test rule');
  });

  it('deleteFindings cascades to feedback', async () => {
    const id = await store.recordFinding({
      prNumber: 42,
      type: 'issue',
      severity: 'minor',
      message: 'Cascade test',
    });
    await store.recordFeedback({
      findingId: id,
      signalType: 'dismissed',
      signalValue: 'false positive',
      prNumber: 42,
    });

    const deleted = await store.deleteFindings(42);
    expect(deleted).toBe(1);

    const remaining = await store.getFindings(42);
    expect(remaining).toHaveLength(0);
  });

  it('getFindingsByType filters by type', async () => {
    await store.recordFinding({ prNumber: 1, type: 'issue', message: 'Issue A' });
    await store.recordFinding({ prNumber: 1, type: 'strength', message: 'Strength A' });
    await store.recordFinding({ prNumber: 1, type: 'issue', message: 'Issue B' });

    const issues = await store.getFindingsByType('issue');
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const strengths = await store.getFindingsByType('strength');
    expect(strengths.length).toBeGreaterThanOrEqual(1);
  });

  it('recordFindings batch inserts findings', async () => {
    const ids = await store.recordFindings([
      { prNumber: 99, type: 'issue', severity: 'minor', message: 'Batch 1' },
      { prNumber: 99, type: 'issue', severity: 'critical', message: 'Batch 2' },
    ]);
    expect(ids).toHaveLength(2);

    const findings = await store.getFindings(99);
    expect(findings).toHaveLength(2);
  });

  it('recordFindings returns empty for empty input', async () => {
    const ids = await store.recordFindings([]);
    expect(ids).toEqual([]);
  });

  it('deleteFindings returns 0 for non-existent PR', async () => {
    const deleted = await store.deleteFindings(99999);
    expect(deleted).toBe(0);
  });

  it('manages prompt override lifecycle', async () => {
    await store.addPromptOverride('general', 'Always check return types', 0.15);

    const lessons = await store.getRelevantLessons(['src/index.ts']);
    expect(lessons).toContain('Always check return types');

    await store.addPromptOverride('.ts', 'Be thorough with TypeScript types', 0.1);
    const tsLessons = await store.getRelevantLessons(['src/component.ts']);
    expect(tsLessons).toContain('Always check return types');
    expect(tsLessons).toContain('Be thorough with TypeScript types');

    await store.addPromptOverride('.rb', 'Check Ruby-specific patterns', 0.2);
    const rbLessons = await store.getRelevantLessons(['lib/helper.rb']);
    expect(rbLessons).toContain('Always check return types');
    expect(rbLessons).toContain('Check Ruby-specific patterns');
    expect(rbLessons).not.toContain('Be thorough with TypeScript types');
  });

  it('declineRule sets rule status to declined', async () => {
    const id = await store.addCustomRule('Test rule to decline', 'auto');
    await store.declineRule(id);

    const pending = await store.getPendingRules();
    expect(pending).toHaveLength(0);
  });

  it('getFindingMessages returns messages and files', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'important',
      file: 'src/bar.ts',
      line: 10,
      message: 'Test message A',
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'Test message B (no file)',
    });

    const messages = await store.getFindingMessages(100);
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const msgA = messages.find((m) => m.message === 'Test message A');
    expect(msgA).toBeDefined();
    expect(msgA!.file).toBe('src/bar.ts');

    const msgB = messages.find((m) => m.message === 'Test message B (no file)');
    expect(msgB).toBeDefined();
  });

  it('resetCounter resets meta review counter to zero', async () => {
    await store.incrementAndCheckMetaReviewInterval(5);
    await store.incrementAndCheckMetaReviewInterval(5);
    await store.resetCounter();

    // After reset, counter is 0, so next call should be false
    expect(await store.incrementAndCheckMetaReviewInterval(5)).toBe(false);
  });

  it('recordFeedbackBatch inserts feedback in bulk', async () => {
    const id1 = await store.recordFinding({
      prNumber: 10,
      type: 'issue',
      message: 'Batch feedback test 1',
    });
    const id2 = await store.recordFinding({
      prNumber: 10,
      type: 'issue',
      message: 'Batch feedback test 2',
    });

    await store.recordFeedbackBatch([
      { findingId: id1, signalType: 'dismissed', signalValue: 'fp', prNumber: 10 },
      { findingId: id2, signalType: 'dismissed', signalValue: 'not an issue', prNumber: 10 },
    ]);

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBeGreaterThan(0);
  });

  it('records quality telemetry and returns aggregated stats with date filtering', async () => {
    expect(await store.getTelemetryStats()).toEqual({
      avgDurationMs: 0,
      totalReviews: 0,
      totalTokensUsed: 0,
      avgTokensPerReview: 0,
    });

    await store.recordQuality({
      prNumber: 100,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 4000,
      tokensUsed: 1000,
    });

    await store.recordQuality({
      prNumber: 101,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 6000,
      tokensUsed: 2000,
    });

    const statsAll = await store.getTelemetryStats();
    expect(statsAll.totalReviews).toBe(2);
    expect(statsAll.avgDurationMs).toBe(5000);
    expect(statsAll.totalTokensUsed).toBe(3000);
    expect(statsAll.avgTokensPerReview).toBe(1500);

    const statsRecent = await store.getTelemetryStats(30);
    expect(statsRecent.totalReviews).toBe(2);
    expect(statsRecent.avgDurationMs).toBe(5000);

    // Update one record's created_at to 40 days ago to verify date filtering boundary
    const repo = await (
      store as unknown as { repoPromise: Promise<{ exec: (sql: string) => Promise<void> }> }
    ).repoPromise;
    await repo.exec(
      "UPDATE review_quality SET created_at = '2000-01-01 00:00:00' WHERE pr_number = 100",
    );
    const statsFiltered = await store.getTelemetryStats(30);
    expect(statsFiltered.totalReviews).toBe(1);
    expect(statsFiltered.avgDurationMs).toBe(6000);
  });

  it('ping() reports ok for a live database', async () => {
    const result = await store.ping();
    expect(result.ok).toBe(true);
    expect(typeof result.responseMs).toBe('number');
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
  });
});

describe('LearningStore Analytics', () => {
  let store: LearningStore;

  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
    store = new LearningStore(TEST_DB);
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

  it('getPerPRStats returns correct stats', async () => {
    const empty = await store.getPerPRStats();
    expect(empty.totalPrs).toBe(0);
    expect(empty.totalFindings).toBe(0);

    await store.recordFinding({ prNumber: 1, type: 'issue', message: 'F1' });
    await store.recordFinding({ prNumber: 1, type: 'issue', message: 'F2' });
    await store.recordFinding({ prNumber: 2, type: 'issue', message: 'F3' });

    const stats = await store.getPerPRStats();
    expect(stats.totalPrs).toBe(2);
    expect(stats.totalFindings).toBe(3);
    expect(stats.avgFindingsPerPr).toBe(1.5);
    expect(stats.maxFindingsInPr).toBe(2);
  });

  it('getFeedbackBreakdown groups correctly', async () => {
    const empty = await store.getFeedbackBreakdown();
    expect(empty.totalFeedback).toBe(0);

    const id1 = await store.recordFinding({ prNumber: 1, type: 'issue', message: 'F1' });
    const id2 = await store.recordFinding({ prNumber: 1, type: 'issue', message: 'F2' });

    await store.recordFeedback({
      findingId: id1,
      signalType: 'dismissed',
      signalValue: 'fp',
      prNumber: 1,
    });
    await store.recordFeedback({
      findingId: id2,
      signalType: 'disputed_comment',
      signalValue: 'disagree',
      prNumber: 1,
    });

    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.totalFeedback).toBe(2);
    expect(breakdown.dismissedCount).toBe(1);
    expect(breakdown.disputedCount).toBe(1);
    expect(breakdown.acceptedCount).toBe(0);
    expect(breakdown.bySignalType.dismissed).toBe(1);
    expect(breakdown.bySignalType.disputed_comment).toBe(1);
  });

  it('getLatencyStats returns correct stats', async () => {
    const empty = await store.getLatencyStats();
    expect(empty.totalReviews).toBe(0);

    await store.recordQuality({
      prNumber: 1,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 5000,
      tokensUsed: 100,
    });
    await store.recordQuality({
      prNumber: 2,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 15000,
      tokensUsed: 200,
    });

    const stats = await store.getLatencyStats();
    expect(stats.totalReviews).toBe(2);
    expect(stats.avgLatencyMs).toBe(10000);
    expect(stats.minLatencyMs).toBe(5000);
    expect(stats.maxLatencyMs).toBe(15000);
    expect(stats.medianLatencyMs).toBe(10000);
  });

  it('aggregateMetrics creates summary row', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      message: 'Critical issue',
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'minor',
      message: 'Minor issue',
    });
    await store.recordFinding({
      prNumber: 2,
      type: 'issue',
      severity: 'important',
      message: 'Important issue',
    });

    const fbId = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'Feedback target',
    });
    await store.recordFeedback({
      findingId: fbId,
      signalType: 'dismissed',
      signalValue: 'fp',
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

    await store.aggregateMetrics('daily');

    const rows = await store.getMetrics('daily', 5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].period_type).toBe('daily');
    expect(rows[0].total_prs).toBe(2);
    expect(rows[0].total_findings).toBe(4);
    expect(rows[0].total_feedback).toBe(1);
    expect(rows[0].dismissed_count).toBe(1);
  });

  it('aggregateMetrics excludes telemetry-only (zero-score) rows from quality averages', async () => {
    // Telemetry-only row written by TelemetrySubscriber/recordTelemetry fallback.
    await store.recordQuality({
      prNumber: 1,
      actionabilityScore: 0,
      accuracyScore: 0,
      coverageScore: 0,
      consistencyScore: 0,
      durationMs: 5000,
      tokensUsed: 1000,
    });
    // Real scored review.
    await store.recordQuality({
      prNumber: 2,
      actionabilityScore: 0.8,
      accuracyScore: 0.9,
      coverageScore: 0.7,
      consistencyScore: 0.85,
      durationMs: 5000,
      tokensUsed: 1500,
    });

    await store.aggregateMetrics('daily');

    const rows = await store.getMetrics('daily', 5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].avg_actionability_score).toBeCloseTo(0.8, 5);
    expect(rows[0].avg_accuracy_score).toBeCloseTo(0.9, 5);
    expect(rows[0].avg_coverage_score).toBeCloseTo(0.7, 5);
    expect(rows[0].avg_consistency_score).toBeCloseTo(0.85, 5);
  });

  it('getSeverityDistribution returns correct distribution', async () => {
    await store.recordFinding({ prNumber: 1, type: 'issue', severity: 'critical', message: 'A' });
    await store.recordFinding({ prNumber: 1, type: 'issue', severity: 'important', message: 'B' });
    await store.recordFinding({ prNumber: 1, type: 'issue', severity: 'important', message: 'C' });
    await store.recordFinding({ prNumber: 1, type: 'issue', severity: 'minor', message: 'D' });
    await store.recordFinding({ prNumber: 1, type: 'issue', message: 'E' });

    const dist = await store.getSeverityDistribution();
    expect(dist.critical).toBe(1);
    expect(dist.important).toBe(2);
    expect(dist.minor).toBe(1);
    expect(dist.unknown).toBe(1);
  });
});

describe('LearningStore getFalsePositiveRules', () => {
  let store: LearningStore;

  beforeEach(() => {
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-shm');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
    store = new LearningStore(TEST_DB);
  });

  afterEach(async () => {
    await store.close();
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB + '-shm');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
  });

  it('generates a DO NOT flag rule for a false_positive dismissal pattern', async () => {
    // A single dismissal is below the confidence threshold — rules require
    // minDismissals (default 3) for the same message::file pattern.
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 1,
        type: 'issue',
        file: 'src/a.ts',
        message: 'Missing null check',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 1,
      });
    }

    const created = await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(created).toBe(1);

    const rules = await store.getFalsePositiveRules(['src/a.ts']);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('Missing null check');
    expect(rules[0]).toContain('DO NOT flag');

    const stats = await store.getSuppressionRuleStats();
    expect(stats.totalActive).toBe(1);
    expect(stats.totalSuppressionHits).toBe(1);
  });

  it('does not generate a DO NOT flag rule for out_of_scope or other dismissals', async () => {
    const id1 = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      file: 'src/a.ts',
      message: 'Out of scope finding',
    });
    const id2 = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      file: 'src/a.ts',
      message: 'Other reason finding',
    });
    await store.recordFeedback({
      findingId: id1,
      signalType: 'dismissed',
      signalValue: 'out_of_scope',
      prNumber: 1,
    });
    await store.recordFeedback({
      findingId: id2,
      signalType: 'dismissed',
      signalValue: 'other',
      prNumber: 1,
    });

    const created = await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(created).toBe(0);

    const rules = await store.getFalsePositiveRules(['src/a.ts']);
    expect(rules).toHaveLength(0);
  });

  it('treats legacy review_dismissed feedback as suppression-worthy', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 1,
        type: 'issue',
        file: 'src/a.ts',
        message: 'Legacy dismissed finding',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'review_dismissed',
        prNumber: 1,
      });
    }

    await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    const rules = await store.getFalsePositiveRules(['src/a.ts']);
    expect(rules).toHaveLength(1);
  });

  it('gates rule generation at the confidence threshold', async () => {
    for (let i = 0; i < 2; i++) {
      const id = await store.recordFinding({
        prNumber: 2,
        type: 'issue',
        file: 'src/b.ts',
        message: 'Below threshold pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 2,
      });
    }

    const createdBelow = await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(createdBelow).toBe(0);
    expect(await store.getFalsePositiveRules(['src/b.ts'])).toHaveLength(0);

    const id3 = await store.recordFinding({
      prNumber: 2,
      type: 'issue',
      file: 'src/b.ts',
      message: 'Below threshold pattern',
    });
    await store.recordFeedback({
      findingId: id3,
      signalType: 'dismissed',
      signalValue: 'false_positive',
      prNumber: 2,
    });

    const createdAt = await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(createdAt).toBe(1);
    expect(await store.getFalsePositiveRules(['src/b.ts'])).toHaveLength(1);
  });

  it('scopes rules by file extension and refreshes the same pattern', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 3,
        type: 'issue',
        file: 'src/c.ts',
        message: 'Scoped pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 3,
      });
    }
    await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    // Rule generated for `.ts` files is not injected for `.py` reviews.
    expect(await store.getFalsePositiveRules(['src/other.py'])).toHaveLength(0);
    expect(await store.getFalsePositiveRules(['src/c.ts'])).toHaveLength(1);
  });

  it('expires rules by review budget (reviews_seen)', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 4,
        type: 'issue',
        file: 'src/d.ts',
        message: 'Budgeted pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 4,
      });
    }
    await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    // First injection consumes the review budget (maxReviews: 1).
    expect(await store.getFalsePositiveRules(['src/d.ts'])).toHaveLength(1);
    const expired = await store.expireSuppressionRules(1);
    expect(expired).toBe(1);
    expect(await store.getFalsePositiveRules(['src/d.ts'])).toHaveLength(0);

    const stats = await store.getSuppressionRuleStats();
    expect(stats.totalExpired).toBe(1);
    expect(stats.totalActive).toBe(0);
  });

  it('expires rules by ttlDays and reports suppression hit stats', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 5,
        type: 'issue',
        file: 'src/e.ts',
        message: 'Expiring pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'intentional',
        prNumber: 5,
      });
    }
    // ttlDays: 0 makes the rule expire immediately (expires_at in the past).
    await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 0,
      maxRules: 25,
    });

    // Read path never returns a time-expired rule.
    expect(await store.getFalsePositiveRules(['src/e.ts'])).toHaveLength(0);
    const expired = await store.expireSuppressionRules(20);
    expect(expired).toBe(1);
  });

  it('never generates suppression rules for excluded severities by default', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 6,
        type: 'issue',
        severity: 'critical',
        file: 'src/f.ts',
        message: 'Critical pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 6,
      });
    }

    const created = await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(created).toBe(0);
    expect(await store.getFalsePositiveRules(['src/f.ts'])).toHaveLength(0);
  });

  it('allows critical findings to generate rules when exclusion is opted out', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 8,
        type: 'issue',
        severity: 'critical',
        file: 'src/g.ts',
        message: 'Opt-in critical pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 8,
      });
    }

    const created = await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
      excludeSeverities: [],
    });
    expect(created).toBe(1);
    expect(await store.getFalsePositiveRules(['src/g.ts'])).toHaveLength(1);
  });

  it('re-generating a rule does not reset its review budget without new evidence', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await store.recordFinding({
        prNumber: 9,
        type: 'issue',
        file: 'src/h.ts',
        message: 'Monotonic budget pattern',
      });
      await store.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 9,
      });
    }
    await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    // First injection consumes the review budget (maxReviews: 1).
    expect(await store.getFalsePositiveRules(['src/h.ts'])).toHaveLength(1);

    // Re-running generation with unchanged evidence must not reset reviews_seen.
    await store.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    const expired = await store.expireSuppressionRules(1);
    expect(expired).toBe(1);
    expect(await store.getFalsePositiveRules(['src/h.ts'])).toHaveLength(0);
  });
});

describe('LearningStore JSON Fallback Smoke Test', () => {
  let jsonStore: LearningStore;
  let jsonDbPath: string;

  beforeEach(() => {
    jsonDbPath = path.join(__dirname, `.test-fallback-${Date.now()}.json`);
    jsonStore = new LearningStore(jsonDbPath);
  });

  afterEach(async () => {
    await jsonStore.close();
    try {
      fs.unlinkSync(jsonDbPath);
    } catch {
      /* ok */
    }
  });

  it('runs full CRUD operations on JSON database fallback', async () => {
    const id = await jsonStore.recordFinding({
      prNumber: 42,
      type: 'issue',
      severity: 'critical',
      file: 'src/main.ts',
      line: 15,
      message: 'JSON fallback smoke test finding',
    });

    const findings = await jsonStore.getFindings(42);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe(id);

    await jsonStore.recordFeedback({
      findingId: id,
      signalType: 'dismissed',
      signalValue: 'false_positive',
      prNumber: 42,
    });

    const fpRate = await jsonStore.getFalsePositiveRate();
    expect(fpRate).toBe(1);

    const deleted = await jsonStore.deleteFindings(42);
    expect(deleted).toBe(1);
    expect(await jsonStore.getFindings(42)).toHaveLength(0);
  });

  it('generates and expires suppression rules on JSON database fallback', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await jsonStore.recordFinding({
        prNumber: 7,
        type: 'issue',
        file: 'src/main.ts',
        message: 'JSON suppression pattern',
      });
      await jsonStore.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 7,
      });
    }

    const created = await jsonStore.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(created).toBe(1);
    expect(await jsonStore.getFalsePositiveRules(['src/main.ts'])).toHaveLength(1);

    const expired = await jsonStore.expireSuppressionRules(1);
    expect(expired).toBe(1);
    expect(await jsonStore.getFalsePositiveRules(['src/main.ts'])).toHaveLength(0);

    const stats = await jsonStore.getSuppressionRuleStats();
    expect(stats.totalExpired).toBe(1);
    expect(stats.totalSuppressionHits).toBe(1);
  });

  it('excludes critical findings from JSON suppression rules by default', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await jsonStore.recordFinding({
        prNumber: 10,
        type: 'issue',
        severity: 'critical',
        file: 'src/main.ts',
        message: 'JSON critical pattern',
      });
      await jsonStore.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 10,
      });
    }

    const created = await jsonStore.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(created).toBe(0);
    expect(await jsonStore.getFalsePositiveRules(['src/main.ts'])).toHaveLength(0);
  });

  it('resets the JSON rule review budget only when dismissal evidence increases', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await jsonStore.recordFinding({
        prNumber: 11,
        type: 'issue',
        file: 'src/main.ts',
        message: 'JSON budget pattern',
      });
      await jsonStore.recordFeedback({
        findingId: id,
        signalType: 'dismissed',
        signalValue: 'false_positive',
        prNumber: 11,
      });
    }
    await jsonStore.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    // First injection consumes the review budget (maxReviews: 1).
    expect(await jsonStore.getFalsePositiveRules(['src/main.ts'])).toHaveLength(1);

    // Re-running with unchanged evidence must not reset the budget.
    await jsonStore.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });
    expect(await jsonStore.expireSuppressionRules(1)).toBe(1);

    // A new dismissal increases the evidence and reactivates with a fresh budget.
    const id = await jsonStore.recordFinding({
      prNumber: 11,
      type: 'issue',
      file: 'src/main.ts',
      message: 'JSON budget pattern',
    });
    await jsonStore.recordFeedback({
      findingId: id,
      signalType: 'dismissed',
      signalValue: 'false_positive',
      prNumber: 11,
    });
    await jsonStore.generateSuppressionRules({
      minDismissals: 3,
      ttlDays: 30,
      maxRules: 25,
    });

    // Budget was reset, so expiry (maxReviews: 1) does not fire until re-injection.
    expect(await jsonStore.expireSuppressionRules(1)).toBe(0);
    expect(await jsonStore.getFalsePositiveRules(['src/main.ts'])).toHaveLength(1);
    expect(await jsonStore.expireSuppressionRules(1)).toBe(1);
  });
});
