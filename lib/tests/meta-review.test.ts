import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import { MetaReviewEngine, MetaReviewSubscriber } from '../src/meta-review/engine.js';

vi.mock('../src/opencode.js', () => ({
  runOpenCode: vi.fn().mockResolvedValue({ success: true, output: '', durationMs: 0 }),
}));

const TEST_DB = path.join(__dirname, '.test-meta.db');

describe('MetaReviewEngine', () => {
  let store: LearningStore;
  let engine: MetaReviewEngine;

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
    engine = new MetaReviewEngine(store);
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

    const trends = await store.getQualityTrends();
    expect(trends).toHaveLength(1);
    expect((trends[0] as Record<string, unknown>).pr_number).toBe(1);
  });

  it('adds prompt override when FP rate is high', async () => {
    const id1 = await store.recordFinding({ prNumber: 1, type: 'issue', message: 'fp1' });
    await store.recordFeedback({
      findingId: id1,
      signalType: 'dismissed',
      signalValue: 'fp',
      prNumber: 1,
    });
    const id2 = await store.recordFinding({ prNumber: 1, type: 'issue', message: 'fp2' });
    await store.recordFeedback({
      findingId: id2,
      signalType: 'disputed_comment',
      signalValue: 'wrong',
      prNumber: 1,
    });

    await engine.runMetaReview({
      prNumber: 2,
      reviewSummary: 'test',
      findingsCount: 1,
      issuesCount: 1,
      strengthsCount: 0,
      hasVerdict: true,
      fileCount: 1,
    });

    const lessons = await store.getRelevantLessons(['test.ts']);
    expect(lessons.some((l) => l.includes('false positive rate'))).toBe(true);
  });
});

describe('MetaReviewSubscriber', () => {
  it('has correct subscriber configuration', async () => {
    const memoryDb = path.join(__dirname, '.test-memory-subscriber.db');
    try {
      fs.unlinkSync(memoryDb);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(memoryDb + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(memoryDb.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
    const store = new LearningStore(memoryDb);
    const engine = new MetaReviewEngine(store);
    const sub = new MetaReviewSubscriber(engine, store, 3);

    expect(sub.subscribedEvents).toEqual(['review.completed']);
    expect(sub.name).toBe('MetaReviewSubscriber');

    await store.close();
    try {
      fs.unlinkSync(memoryDb);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(memoryDb + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(memoryDb.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
  });
});

describe('MetaReviewFullFlow', () => {
  it('processes review.completed event through EventBus', async () => {
    const testDb = path.join(__dirname, '.test-full-flow.db');
    try {
      fs.unlinkSync(testDb);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(testDb + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(testDb.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }

    const store = new LearningStore(testDb);
    const { EventBus } = await import('../src/event-bus/bus.js');
    const bus = new EventBus();

    // Seed some findings so pattern detector has data
    await store.recordFinding({
      prNumber: 100,
      type: 'issue',
      severity: 'critical',
      file: 'src/app.ts',
      message: 'Missing error handling in async route handler',
    });
    await store.recordFinding({
      prNumber: 100,
      type: 'issue',
      severity: 'important',
      file: 'src/app.ts',
      message: 'Missing error handling in middleware',
    });
    await store.recordFinding({
      prNumber: 100,
      type: 'issue',
      severity: 'important',
      file: 'src/utils.ts',
      message: 'Missing error handling in database query',
    });

    const PatternDetectorClass = (await import('../src/pattern-detector/engine.js'))
      .PatternDetector;
    const patternDetector = new PatternDetectorClass(store);
    const engine = new MetaReviewEngine(store, patternDetector);
    const sub = new MetaReviewSubscriber(engine, store, 1);

    bus.register(sub);

    // Publish a review.completed event with payload
    await bus.publish({
      type: 'review.completed',
      category: 'internal',
      payload: {
        prNumber: 100,
        reviewSummary: 'Found several issues',
        findingsCount: 5,
        issuesCount: 3,
        strengthsCount: 2,
        hasVerdict: true,
        fileCount: 3,
      },
      timestamp: Date.now(),
      repo: 'owner/repo',
      prNumber: 100,
    });

    // Verify quality was recorded
    const trends = await store.getQualityTrends();
    expect(trends.length).toBeGreaterThanOrEqual(1);

    const trend = trends[0] as Record<string, unknown>;
    expect(trend.pr_number).toBe(100);
    expect(trend.actionability_score).toBeGreaterThanOrEqual(0);
    expect(trend.accuracy_score).toBeGreaterThanOrEqual(0);

    // Verify patterns were recorded and added as pending rules
    const patterns = await store.getPatterns(1);
    const pendingRules = await store.getPendingRules();

    // Either patterns or pending rules may exist depending on quality scores
    expect(patterns.length + pendingRules.length).toBeGreaterThan(0);

    await store.close();
    try {
      fs.unlinkSync(testDb);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(testDb + '-wal');
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(testDb.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
  });
});
