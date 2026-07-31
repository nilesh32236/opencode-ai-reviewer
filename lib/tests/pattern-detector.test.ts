import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import {
  EXACT_CLUSTER_LIMIT,
  MAX_CLUSTER_INPUT,
  clusterFindings,
  clusterFindingsExact,
  clusterFindingsWithStatus,
} from '../src/pattern-detector/cluster.js';
import { PatternDetector } from '../src/pattern-detector/engine.js';
import {
  LSH_BANDS,
  LSH_ROWS,
  computeMinHashSignature,
  hashToken,
  lshCandidates,
} from '../src/pattern-detector/minhash.js';
import { RuleApprovalSubscriber } from '../src/pattern-detector/rule-approval.js';

const TEST_DB = path.join(__dirname, '.test-pattern.db');

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSyntheticDataset(
  numGroups: number,
  perGroup: number,
  noiseTokens: number,
  seed: number,
): { messages: string[]; groups: string[][] } {
  const rng = seededRandom(seed);
  const messages: string[] = [];
  const groups: string[][] = [];

  for (let g = 0; g < numGroups; g++) {
    const template = Array.from({ length: 6 }, (_, t) => `g${g}tok${t}`);
    const group: string[] = [];
    for (let m = 0; m < perGroup; m++) {
      const tokens = [...template];
      const noise = new Set<string>();
      while (noise.size < noiseTokens) {
        noise.add(`n${Math.floor(rng() * 100000)}`);
      }
      for (const n of noise) tokens.push(n);
      tokens.push(`id${g}_${m}`);
      const message = tokens.join(' ');
      messages.push(message);
      group.push(message);
    }
    groups.push(group);
  }

  return { messages, groups };
}

function clusterRecall(
  clusters: Array<{ centroid: string; messages: string[] }>,
  groups: string[][],
): number {
  const clusterOf = new Map<string, number>();
  clusters.forEach((cluster, idx) => {
    for (const msg of cluster.messages) clusterOf.set(msg, idx);
  });

  let totalPairs = 0;
  let recoveredPairs = 0;
  for (const group of groups) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        totalPairs++;
        const ca = clusterOf.get(group[a]);
        const cb = clusterOf.get(group[b]);
        if (ca !== undefined && ca === cb) recoveredPairs++;
      }
    }
  }
  return totalPairs === 0 ? 1 : recoveredPairs / totalPairs;
}

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

describe('clusterFindings – scaling', () => {
  it('caps large inputs to MAX_CLUSTER_INPUT with truncation status', () => {
    const { messages } = makeSyntheticDataset(30, 20, 2, 7);
    expect(messages.length).toBeGreaterThan(MAX_CLUSTER_INPUT);

    const result = clusterFindingsWithStatus(messages, 0.3);
    expect(result.truncated).toBe(true);

    const capped = new Set(messages.slice(0, MAX_CLUSTER_INPUT));
    for (const cluster of result.clusters) {
      for (const msg of cluster.messages) {
        expect(capped.has(msg)).toBe(true);
      }
    }
  });

  it('public API returns clusters only referencing capped messages', () => {
    const { messages } = makeSyntheticDataset(30, 20, 2, 8);
    expect(messages.length).toBeGreaterThan(MAX_CLUSTER_INPUT);

    const clusters = clusterFindings(messages, 0.3);
    const capped = new Set(messages.slice(0, MAX_CLUSTER_INPUT));
    for (const cluster of clusters) {
      for (const msg of cluster.messages) {
        expect(capped.has(msg)).toBe(true);
      }
    }
  });

  it('keeps exact path for inputs at or below EXACT_CLUSTER_LIMIT', () => {
    const { messages } = makeSyntheticDataset(EXACT_CLUSTER_LIMIT, 2, 2, 9);
    expect(messages.length).toBe(EXACT_CLUSTER_LIMIT * 2);
    expect(clusterFindingsWithStatus(messages, 0.3).truncated).toBe(false);
  });

  it('produces far fewer LSH candidates than all pairs for large datasets', () => {
    const { messages } = makeSyntheticDataset(30, 20, 2, 10);
    const rng = seededRandom(11);
    const singletons = Array.from({ length: 400 }, (_, i) => {
      const noise = Array.from({ length: 4 }, () => `z${Math.floor(rng() * 100000)}`);
      return `s${i} ${noise.join(' ')}`;
    });
    const all = [...messages, ...singletons];

    const signatures = all.map((m) =>
      computeMinHashSignature(
        new Set(
          m
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter((t) => t.length > 2),
        ),
      ),
    );

    const candidates = lshCandidates(signatures, LSH_BANDS, LSH_ROWS);
    const totalPairs = (all.length * (all.length - 1)) / 2;
    expect(candidates.size).toBeLessThan(totalPairs * 0.05);
  });

  it('reaches near-exact recall on the LSH path for large inputs', () => {
    const { messages, groups } = makeSyntheticDataset(30, 12, 2, 42);
    expect(messages.length).toBeGreaterThan(EXACT_CLUSTER_LIMIT);
    expect(messages.length).toBeLessThanOrEqual(MAX_CLUSTER_INPUT);

    const exactClusters = clusterFindingsExact(messages, 0.3);
    const lshClusters = clusterFindings(messages, 0.3);

    const exactRecall = clusterRecall(exactClusters, groups);
    const lshRecall = clusterRecall(lshClusters, groups);

    expect(exactRecall).toBeGreaterThanOrEqual(0.9);
    expect(lshRecall).toBeGreaterThanOrEqual(0.9);
    expect(lshRecall).toBeGreaterThanOrEqual(exactRecall - 0.05);

    const largest = [...lshClusters].sort((a, b) => b.messages.length - a.messages.length)[0];
    if (largest) {
      const dominantGroup = groups.reduce(
        (best, group) => {
          const overlap = group.filter((m) => largest.messages.includes(m)).length;
          return overlap > best.overlap ? { group, overlap } : best;
        },
        { group: [] as string[], overlap: 0 },
      );
      expect(dominantGroup.overlap / largest.messages.length).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe('minhash', () => {
  it('hashToken is deterministic and salt-sensitive', () => {
    const a1 = hashToken('error', 0);
    const a2 = hashToken('error', 0);
    const b = hashToken('error', 1);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('computes identical signatures for identical token sets', () => {
    const s1 = computeMinHashSignature(new Set(['foo', 'bar', 'baz']));
    const s2 = computeMinHashSignature(new Set(['bar', 'baz', 'foo']));
    expect(s1).toEqual(s2);
  });

  it('returns all-zero signatures for empty token sets', () => {
    expect(computeMinHashSignature(new Set<string>())).toEqual(new Array(128).fill(0));
  });

  it('puts similar sets in shared LSH bands', () => {
    const a = new Set(['error', 'handling', 'async', 'route', 'missing']);
    const b = new Set(['error', 'handling', 'async', 'route', 'wrapper']);
    const candidates = lshCandidates(
      [computeMinHashSignature(a), computeMinHashSignature(b)],
      LSH_BANDS,
      LSH_ROWS,
    );
    expect(candidates.size).toBeGreaterThan(0);
  });

  it('deduplicates candidate pairs', () => {
    const a = new Set(['error', 'handling', 'async', 'route', 'missing']);
    const b = new Set(['error', 'handling', 'async', 'route', 'wrapper']);
    const signatures = [computeMinHashSignature(a), computeMinHashSignature(b)];
    const candidates = lshCandidates(signatures, LSH_BANDS, LSH_ROWS);
    for (const [i, j] of candidates) {
      expect(i).toBeLessThan(j);
    }
  });
});

describe('PatternDetector', () => {
  let store: LearningStore;
  let detector: PatternDetector;

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
    detector = new PatternDetector(store);
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

  it('detects patterns from findings with same message', async () => {
    for (let i = 0; i < 3; i++) {
      await store.recordFinding({
        prNumber: i + 1,
        type: 'issue',
        severity: 'important',
        message: 'Missing error handling in async function',
        file: 'src/routes.ts',
      });
    }

    const patterns = await detector.discover(3);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].frequency).toBeGreaterThanOrEqual(3);
  });
});

describe('RuleApprovalSubscriber', () => {
  let store: LearningStore;
  let sub: RuleApprovalSubscriber;

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
    sub = new RuleApprovalSubscriber(store);
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

  it('handles /approve-rule command', async () => {
    const ruleId = await store.addCustomRule('Test rule', 'auto');

    await sub.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: { body: `/approve-rule ${ruleId}` },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });

    const pending = await store.getPendingRules();
    expect(pending).toHaveLength(0);
  });

  it('handles /approve-rule via review_comment.created', async () => {
    const ruleId = await store.addCustomRule('Test rule for review comment', 'auto');

    await sub.handle({
      type: 'review_comment.created',
      category: 'comment',
      payload: {
        comment: { body: `/approve-rule ${ruleId}` },
        issue: { number: 2 },
      },
      timestamp: Date.now(),
      prNumber: 2,
    });

    const pending = await store.getPendingRules();
    expect(pending).toHaveLength(0);
  });

  it('has correct subscribed events', () => {
    expect(sub.subscribedEvents).toEqual(['comment.created', 'review_comment.created']);
  });

  it('ignores non-approval comments', async () => {
    await sub.handle({
      type: 'comment.created',
      category: 'comment',
      payload: {
        comment: { body: 'Looks good to me' },
        issue: { number: 1 },
      },
      timestamp: Date.now(),
      prNumber: 1,
    });
  });
});
