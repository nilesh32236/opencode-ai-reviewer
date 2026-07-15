import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeedbackSubscriber } from '../src/learning/feedback-subscriber.js';
import { LearningStore } from '../src/learning/store.js';

const TEST_DB = path.join(__dirname, '.test-feedback.db');

describe('FeedbackSubscriber', () => {
  let store: LearningStore;
  let subscriber: FeedbackSubscriber;

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
    subscriber = new FeedbackSubscriber(store);
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

  it('subscribes to review and comment events', () => {
    expect(subscriber.subscribedEvents).toContain('review.dismissed');
    expect(subscriber.subscribedEvents).toContain('review_comment.dismissed');
    expect(subscriber.subscribedEvents).toContain('comment.created');
  });

  it('records feedback on review.dismissed', async () => {
    const _findingId = await store.recordFinding({
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

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBeGreaterThan(0);
  });

  it('scans comment.created for dispute keywords', async () => {
    await store.recordFinding({
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

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });

  it('ignores non-dispute comments', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: 'Looks good to me!',
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(0);
  });

  it('ignores empty comment bodies', async () => {
    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: '',
        issue: { number: 1 },
      },
      timestamp: Date.now(),
    });
  });

  it('ignores events without prNumber', async () => {
    await subscriber.handle({
      type: 'review.dismissed',
      category: 'review',
      payload: {},
      timestamp: Date.now(),
    });
  });

  it('handles review.dismissed without findings gracefully', async () => {
    await subscriber.handle({
      type: 'review.dismissed',
      category: 'review',
      payload: {
        pull_request: { number: 999 },
      },
      timestamp: Date.now(),
      prNumber: 999,
    });
  });

  it('detects all dispute keywords', async () => {
    const keywords = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const dbPath = TEST_DB + `_kw_${i}`;
      const s = new LearningStore(dbPath);
      const sub = new FeedbackSubscriber(s);

      await s.recordFinding({ prNumber: 1, type: 'issue', message: 'test' });
      await sub.handle({
        type: 'comment.created',
        category: 'comment',
        payload: { body: kw, issue: { number: 1 } },
        timestamp: Date.now(),
        prNumber: 1,
      });

      expect(await s.getFalsePositiveRate()).toBeGreaterThan(0);
      await s.close();
      try {
        fs.unlinkSync(dbPath);
      } catch {
        /* ok */
      }
      try {
        fs.unlinkSync(dbPath.replace(/\.db$/, '.json'));
      } catch {
        /* ok */
      }
    }
  });

  it('dispatches to correct handler based on event type', async () => {
    await store.recordFinding({ prNumber: 1, type: 'issue', message: 'test' });

    await subscriber.handle({
      type: 'review_comment.dismissed',
      category: 'review',
      payload: {},
      timestamp: Date.now(),
      prNumber: 1,
    });
  });
});
