import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackSubscriber } from '../src/learning/feedback-subscriber.js';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-feedback.db');

describe('FeedbackSubscriber', () => {
  let store: LearningStore;
  let subscriber: FeedbackSubscriber;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    subscriber = new FeedbackSubscriber(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('subscribes to review and comment events', () => {
    expect(subscriber.subscribedEvents).toContain('review.dismissed');
    expect(subscriber.subscribedEvents).toContain('review_comment.dismissed');
    expect(subscriber.subscribedEvents).toContain('comment.created');
  });

  it('records feedback on review.dismissed', async () => {
    const findingId = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
    });

    await subscriber.handle({
      type: 'review.dismissed',
      category: 'review',
      payload: {
        review: { id: 123 },
        pull_request: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = store.getFalsePositiveRate();
    expect(fpRate).toBeGreaterThan(0);
  });

  it('scans comment.created for dispute keywords', async () => {
    const findingId = store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: 'This is a false positive, not an issue',
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });
});
