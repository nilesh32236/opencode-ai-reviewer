import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetaReviewEngine, MetaReviewSubscriber } from '../src/meta-review/engine.js';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

vi.mock('../src/opencode.js', () => ({
  runOpenCode: vi.fn().mockResolvedValue({ success: true, output: '', durationMs: 0 }),
}));

const TEST_DB = path.join(__dirname, '.test-meta.db');

describe('MetaReviewEngine', () => {
  let store: LearningStore;
  let engine: MetaReviewEngine;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    engine = new MetaReviewEngine(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('records quality metrics after review', async () => {
    await engine.runMetaReview({
      prNumber: 1,
      reviewSummary: 'Good review with specific findings',
      findingsCount: 5,
      issuesCount: 3,
      strengthsCount: 2,
      hasVerdict: true,
      fileCount: 4,
    });

    const trends = store.getQualityTrends();
    expect(trends).toHaveLength(1);
    expect((trends[0] as Record<string, unknown>).pr_number).toBe(1);
  });

  it('adds prompt override when FP rate is high', async () => {
    const id1 = store.recordFinding({ prNumber: 1, type: 'issue', message: 'fp1' });
    store.recordFeedback({ findingId: id1, signalType: 'dismissed', signalValue: 'fp', prNumber: 1 });
    const id2 = store.recordFinding({ prNumber: 1, type: 'issue', message: 'fp2' });
    store.recordFeedback({ findingId: id2, signalType: 'disputed_comment', signalValue: 'wrong', prNumber: 1 });

    await engine.runMetaReview({
      prNumber: 2,
      reviewSummary: 'test',
      findingsCount: 1,
      issuesCount: 1,
      strengthsCount: 0,
      hasVerdict: true,
      fileCount: 1,
    });

    const lessons = store.getRelevantLessons(['test.ts']);
    expect(lessons.some((l) => l.includes('false positive rate'))).toBe(true);
  });
});

describe('MetaReviewSubscriber', () => {
  it('has correct subscriber configuration', () => {
    const store = new LearningStore(':memory:');
    const engine = new MetaReviewEngine(store);
    const sub = new MetaReviewSubscriber(engine, store, 3);

    expect(sub.subscribedEvents).toEqual(['review.completed']);
    expect(sub.name).toBe('MetaReviewSubscriber');

    store.close();
  });
});
