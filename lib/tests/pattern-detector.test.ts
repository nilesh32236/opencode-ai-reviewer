import { describe, it, expect, beforeEach } from 'vitest';
import { clusterFindings } from '../src/pattern-detector/cluster.js';
import { PatternDetector } from '../src/pattern-detector/engine.js';
import { RuleApprovalSubscriber } from '../src/pattern-detector/rule-approval.js';
import { LearningStore } from '../src/learning/store.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = path.join(__dirname, '.test-pattern.db');

describe('clusterFindings', () => {
  it('groups similar messages by Jaccard similarity', () => {
    const messages = [
      'Missing error handling in async route',
      'Unhandled promise rejection in error handling route',
      'Add error boundary to React component',
      'Wrap component with error boundary',
      'React component missing key prop',
    ];

    const clusters = clusterFindings(messages, 0.3);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for empty input', () => {
    expect(clusterFindings([], 0.3)).toEqual([]);
  });

  it('returns only clusters with at least 2 messages', () => {
    const messages = [
      'Missing error handling in async route',
      'Unhandled promise rejection in error handling route',
      'Unique message that stands alone',
    ];

    const clusters = clusterFindings(messages, 0.3);
    for (const c of clusters) {
      expect(c.messages.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('handles single message gracefully', () => {
    expect(clusterFindings(['Only message'], 0.3)).toEqual([]);
  });

  it('uses custom threshold correctly', () => {
    const messages = [
      'error handling missing in async route handler',
      'completely different topic about database queries',
      'yet another completely different topic about caching',
    ];

    const strictClusters = clusterFindings(messages, 0.9);
    expect(strictClusters.length).toBe(0);

    const looseClusters = clusterFindings(messages, 0.1);
    expect(looseClusters.length).toBe(1);
  });

  it('handles identical messages', () => {
    const messages = Array(5).fill('Missing error handling in async function');
    const clusters = clusterFindings(messages, 0.3);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it('handles special characters in messages', () => {
    const messages = [
      'Error in route /api/v1/users (timeout)',
      'Error in route /api/v1/users (connection)',
      'Some other random thing',
    ];

    const clusters = clusterFindings(messages, 0.3);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
  });
});

describe('PatternDetector', () => {
  let store: LearningStore;
  let detector: PatternDetector;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    detector = new PatternDetector(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('detects patterns from findings with same message', () => {
    for (let i = 0; i < 3; i++) {
      store.recordFinding({
        prNumber: i + 1,
        type: 'issue',
        severity: 'important',
        message: 'Missing error handling in async function',
        file: 'src/routes.ts',
      });
    }

    const patterns = detector.discover(3);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].frequency).toBeGreaterThanOrEqual(3);
  });
});

describe('RuleApprovalSubscriber', () => {
  let store: LearningStore;
  let sub: RuleApprovalSubscriber;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    store = new LearningStore(TEST_DB);
    sub = new RuleApprovalSubscriber(store);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  });

  it('handles /approve-rule command', async () => {
    const ruleId = store.addCustomRule('Test rule', 'auto');

    await sub.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: `/approve-rule ${ruleId}`,
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const pending = store.getPendingRules();
    expect(pending).toHaveLength(0);
  });

  it('ignores non-approval comments', async () => {
    await sub.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        body: 'Looks good to me',
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });
  });
});
