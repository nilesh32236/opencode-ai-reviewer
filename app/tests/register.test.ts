import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG, EventBus, LearningStore } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSubscribers } from '../src/subscribers/index.js';

const TEST_DB = path.join(__dirname, '.test-register.db');
const TEST_ARTIFACTS = [
  TEST_DB,
  `${TEST_DB}-wal`,
  `${TEST_DB}-shm`,
  TEST_DB.replace(/\.db$/, '.json'),
];

const EXPECTED_SUBSCRIBERS = [
  'ReviewSubscriber',
  'FixSubscriber',
  'DocsSubscriber',
  'ChangelogSubscriber',
  'AuditSubscriber',
  'AnalyzeSubscriber',
  'AutoAnalyzeSubscriber',
  'QuestionAnsweredSubscriber',
  'ReplySubscriber',
  'DismissSubscriber',
  'ExplainSubscriber',
  'DescribeSubscriber',
  'ConversationSubscriber',
  'SetupSubscriber',
  'AdminSubscriber',
  'TelemetrySubscriber',
  'FeedbackSubscriber',
  'SuppressionSubscriber',
  'MetaReviewSubscriber',
  'DiscoverSubscriber',
  'MetricsSubscriber',
];

describe('registerSubscribers', () => {
  let store: LearningStore;
  let bus: EventBus;

  beforeEach(() => {
    for (const p of TEST_ARTIFACTS) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ok */
      }
    }
    store = new LearningStore(TEST_DB);
    bus = new EventBus();
  });

  afterEach(async () => {
    await store.close();
    for (const p of TEST_ARTIFACTS) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ok */
      }
    }
  });

  it('returns all expected subscribers in registration order', () => {
    const subs = registerSubscribers(bus, store, DEFAULT_CONFIG);

    expect(subs.map((s) => s.name)).toEqual(EXPECTED_SUBSCRIBERS);
  });

  it('covers all previously registered GitHub event types', () => {
    const subs = registerSubscribers(bus, store, DEFAULT_CONFIG);
    const covered = new Set(subs.flatMap((s) => s.subscribedEvents));

    for (const eventType of [
      'pr.opened',
      'pr.synchronize',
      'comment.created',
      'review_comment.created',
      'issue.labeled',
      'issue.opened',
      'review.dismissed',
      'review_comment.dismissed',
      'review_comment.deleted',
      'review.completed',
    ]) {
      expect(covered.has(eventType)).toBe(true);
    }
  });

  it('registers every subscriber on the event bus for health tracking', () => {
    const subs = registerSubscribers(bus, store, DEFAULT_CONFIG);
    const healthNames = new Set(bus.getSubscriberHealth().map((h) => h.name));

    for (const sub of subs) {
      expect(healthNames.has(sub.name)).toBe(true);
    }
  });

  it('wires the MetaReviewSubscriber to review.completed', () => {
    const subs = registerSubscribers(bus, store, DEFAULT_CONFIG);
    const meta = subs.find((s) => s.name === 'MetaReviewSubscriber');

    expect(meta?.subscribedEvents).toEqual(['review.completed']);
  });
});
