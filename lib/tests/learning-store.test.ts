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
});
