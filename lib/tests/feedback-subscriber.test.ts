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
      file: 'src/foo.ts',
      line: 10,
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'This is a false positive, not an issue',
          in_reply_to_id: 42,
          path: 'src/foo.ts',
          line: 10,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(1);
  });

  it('ignores slash-command replies even when they contain dispute keywords', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
      file: 'src/foo.ts',
      line: 10,
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: '/dismiss false positive',
          in_reply_to_id: 42,
          path: 'src/foo.ts',
          line: 10,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(0);
  });

  it('ignores non-dispute comments', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
      file: 'src/foo.ts',
      line: 10,
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'Looks good to me!',
          in_reply_to_id: 42,
          path: 'src/foo.ts',
          line: 10,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(0);
  });

  it('ignores top-level comments even with dispute keywords', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: { body: 'This finding is wrong' },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const fpRate = await store.getFalsePositiveRate();
    expect(fpRate).toBe(0);
  });

  it('fetches at most 20 findings for feedback', async () => {
    for (let i = 0; i < 30; i++) {
      await store.recordFinding({
        prNumber: 1,
        type: 'issue',
        message: `finding ${i}`,
        file: 'src/foo.ts',
        line: 10,
      });
    }

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'This is wrong',
          in_reply_to_id: 42,
          path: 'src/foo.ts',
          line: 10,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.disputedCount).toBe(20);
  });

  it('debounce prevents duplicate processing within 60s', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'test',
      file: 'src/foo.ts',
      line: 10,
    });

    const event = {
      type: 'comment.created' as const,
      category: 'comment' as const,
      payload: {
        comment: {
          body: 'This is wrong',
          in_reply_to_id: 42,
          path: 'src/foo.ts',
          line: 10,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    };

    await subscriber.handle(event);
    await subscriber.handle(event);

    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.disputedCount).toBe(1);
  });

  it('parses file:line from comment body to narrow feedback', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'unrelated',
      file: 'src/other.ts',
      line: 10,
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'target',
      file: 'src/target.ts',
      line: 42,
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'target line',
      file: 'src/target.ts',
      line: 60,
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'This is incorrect at src/target.ts:42',
          in_reply_to_id: 42,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.disputedCount).toBe(1);
  });

  it('ignores empty comment bodies', async () => {
    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: { body: '' },
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

      await s.recordFinding({
        prNumber: 1,
        type: 'issue',
        message: 'test',
        file: `src/kw_${i}.ts`,
        line: i + 1,
      });
      await sub.handle({
        type: 'comment.created',
        category: 'comment',
        payload: {
          comment: {
            body: kw,
            in_reply_to_id: 42,
            path: `src/kw_${i}.ts`,
            line: i + 1,
          },
          issue: { number: 1 },
        },
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

  it('does NOT mark findings when no scope (path/line or file:line refs) is available', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordFinding({
        prNumber: 1,
        type: 'issue',
        message: `finding ${i}`,
        file: `src/file_${i}.ts`,
        line: 10,
      });
    }

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'This is wrong and a false positive',
          in_reply_to_id: 42,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.disputedCount).toBe(0);
  });

  it('marks only the finding matching the comment path/line', async () => {
    const _matchingId = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'matching',
      file: 'src/match.ts',
      line: 42,
    });
    const _unrelatedId = await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'unrelated',
      file: 'src/other.ts',
      line: 10,
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'this is wrong',
          in_reply_to_id: 42,
          path: 'src/match.ts',
          line: 42,
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    // Exactly the one matching finding is disputed — the unrelated finding
    // on `src/other.ts` is NOT marked, even though both exist for the same PR.
    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.disputedCount).toBe(1);
  });

  it('matches all findings on the file when line is absent (file-only scope)', async () => {
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'a',
      file: 'src/any.ts',
      line: 5,
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'b',
      file: 'src/any.ts',
      line: 200,
    });
    await store.recordFinding({
      prNumber: 1,
      type: 'issue',
      message: 'unrelated file',
      file: 'src/other.ts',
      line: 10,
    });

    await subscriber.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: {
          body: 'wrong approach here',
          in_reply_to_id: 42,
          path: 'src/any.ts',
        },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const breakdown = await store.getFeedbackBreakdown();
    expect(breakdown.disputedCount).toBe(2);
  });

  it('does not consume the debounce window for an unscoped dispute (reprocessing is allowed)', async () => {
    const uniqDebounce = 30_000;
    const slowSub = new FeedbackSubscriber(store, uniqDebounce);
    await store.recordFinding({
      prNumber: 7,
      type: 'issue',
      message: 'target',
      file: 'src/x.ts',
      line: 10,
    });

    const unscopedEvent = {
      type: 'comment.created' as const,
      category: 'comment' as const,
      payload: {
        comment: { body: 'this is wrong', in_reply_to_id: 42 },
        issue: { number: 7 },
      },
      timestamp: Date.now(),
      prNumber: 7,
    };
    const scopedEvent = {
      type: 'comment.created' as const,
      category: 'comment' as const,
      payload: {
        comment: { body: 'this is wrong', in_reply_to_id: 42, path: 'src/x.ts', line: 10 },
        issue: { number: 7 },
      },
      timestamp: Date.now(),
      prNumber: 7,
    };

    // Unscoped dispute arrives first — should be skipped (no scope) AND must
    // NOT consume the debounce window.
    await slowSub.handle(unscopedEvent);
    expect((await store.getFeedbackBreakdown()).disputedCount).toBe(0);

    // Scoped dispute arrives immediately after within the debounceMs window.
    // Pre-fix it would have been discarded because the unscoped event already
    // stamped lastProcessedAt. Post-fix it must still be processed.
    await slowSub.handle(scopedEvent);
    expect((await store.getFeedbackBreakdown()).disputedCount).toBe(1);
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
