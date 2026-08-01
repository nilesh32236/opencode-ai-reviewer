import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import { TelemetrySubscriber } from '../src/learning/telemetry-subscriber.js';
import type { GitHubEvent } from '../src/types/index.js';

const TEST_DB = path.join(os.tmpdir(), `.test-telemetry-${Date.now()}.db`);

describe('TelemetrySubscriber', () => {
  let store: LearningStore;
  let sub: TelemetrySubscriber;

  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm', '.json']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
    store = new LearningStore(TEST_DB);
    sub = new TelemetrySubscriber(store);
  });

  afterEach(async () => {
    await store.close();
    for (const suffix of ['', '-wal', '-shm', '.json']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
  });

  it('listens only for completed pipeline events', () => {
    expect(sub.subscribedEvents).toContain('review.completed');
    expect(sub.subscribedEvents).toContain('fix.completed');
    expect(sub.subscribedEvents).toContain('audit.completed');
    expect(sub.subscribedEvents).toContain('analyze.completed');
    expect(sub.subscribedEvents).not.toContain('review.started');
    expect(sub.subscribedEvents).not.toContain('pr.opened');
  });

  it('records duration/token telemetry for a completed event with a PR number', async () => {
    const event: GitHubEvent = {
      type: 'review.completed',
      category: 'pipeline',
      prNumber: 42,
      payload: { prNumber: 42, durationMs: 1234, tokensUsed: 567 },
      timestamp: Date.now(),
    };

    await sub.handle(event);

    const stats = await store.getTelemetryStats();
    expect(stats.totalReviews).toBe(1);
    expect(stats.avgDurationMs).toBe(1234);
    expect(stats.totalTokensUsed).toBe(567);
  });

  it('uses the event envelope prNumber when the payload lacks one', async () => {
    const event: GitHubEvent = {
      type: 'review.completed',
      category: 'pipeline',
      prNumber: 7,
      payload: { durationMs: 100 },
      timestamp: Date.now(),
    };

    await sub.handle(event);

    const stats = await store.getTelemetryStats();
    expect(stats.totalReviews).toBe(1);
  });

  it('skips events without a PR number (e.g. audits)', async () => {
    const event: GitHubEvent = {
      type: 'audit.completed',
      category: 'pipeline',
      payload: { durationMs: 500, tokensUsed: 42 },
      timestamp: Date.now(),
    };

    await sub.handle(event);

    const stats = await store.getTelemetryStats();
    expect(stats.totalReviews).toBe(0);
  });

  it('skips events without duration or token telemetry', async () => {
    const event: GitHubEvent = {
      type: 'review.completed',
      category: 'pipeline',
      prNumber: 42,
      payload: { prNumber: 42 },
      timestamp: Date.now(),
    };

    await sub.handle(event);

    const stats = await store.getTelemetryStats();
    expect(stats.totalReviews).toBe(0);
  });

  it('does not throw when the payload is null or non-object', async () => {
    await expect(
      sub.handle({
        type: 'review.completed',
        category: 'pipeline',
        prNumber: 42,
        payload: null,
        timestamp: Date.now(),
      }),
    ).resolves.not.toThrow();
    await expect(
      sub.handle({
        type: 'review.completed',
        category: 'pipeline',
        prNumber: 42,
        payload: 'boom',
        timestamp: Date.now(),
      }),
    ).resolves.not.toThrow();
  });
});
