import { describe, it, expect, beforeEach } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-learning.db');

describe('LearningStore', () => {
  let store: LearningStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('records and retrieves findings', () => {
    const id = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      file: 'src/foo.ts',
      line: 42,
      message: 'Missing error handling',
    });

    const findings = store.getFindings(1);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('Missing error handling');
    expect(findings[0].id).toBe(id);
  });

  it('records feedback and calculates false positive rate', () => {
    const id = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test finding',
    });

    store.recordFeedback({
      findingId: id,
      signalType: 'dismissed',
      signalValue: 'false positive',
      prNumber: 1,
    });

    const fpRate = store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });

  it('returns active custom rules as relevant lessons', () => {
    store.addCustomRule('Always handle async errors in Express routes', 'auto');
    const ruleId = store.addCustomRule('Use strict equality', 'manual');
    store.approveRule(ruleId);

    const lessons = store.getRelevantLessons(['src/routes.ts']);
    expect(lessons).toContain('Use strict equality');
    expect(lessons).not.toContain('Always handle async errors in Express routes');
  });

  it('records and retrieves qualities', () => {
    store.recordQuality({
      prNumber: 1,
      actionabilityScore: 80,
      accuracyScore: 90,
      coverageScore: 70,
      consistencyScore: 85,
    });

    const trends = store.getQualityTrends();
    expect(trends).toHaveLength(1);
    expect((trends[0] as Record<string, unknown>).actionability_score).toBe(80);
  });

  it('incrementAndCheckMetaReviewInterval triggers on interval', () => {
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(true);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(false);
    expect(store.incrementAndCheckMetaReviewInterval(3)).toBe(true);
  });

  it('records and retrieves patterns', () => {
    store.recordPattern({
      patternKey: 'missing-error-handling',
      messageCluster: ['Missing error handling in route', 'Unhandled promise rejection'],
      frequency: 3,
      fileTypes: ['.ts'],
    });

    const patterns = store.getPatterns(3);
    expect(patterns).toHaveLength(1);
  });

  it('manages custom rule lifecycle', () => {
    const id = store.addCustomRule('Test rule', 'auto');
    expect(store.getPendingRules()).toHaveLength(1);

    store.approveRule(id);
    expect(store.getPendingRules()).toHaveLength(0);

    const lessons = store.getRelevantLessons(['test.ts']);
    expect(lessons).toContain('Test rule');
  });
});
