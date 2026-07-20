import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';

const TEST_DB = path.join(__dirname, '.test-learning.db');

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
});
