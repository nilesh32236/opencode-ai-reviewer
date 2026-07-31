import { describe, expect, it } from 'vitest';
import {
  EXACT_CLUSTER_LIMIT,
  MAX_CLUSTER_INPUT,
  clusterFindings,
  clusterFindingsExact,
  clusterFindingsWithStatus,
} from '../src/pattern-detector/cluster.js';
import {
  LSH_BANDS,
  LSH_ROWS,
  computeMinHashSignature,
  lshCandidates,
} from '../src/pattern-detector/minhash.js';

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
    const template = Array.from({ length: 150 }, (_, t) => `g${g}tok${t}`);
    const group: string[] = [];
    for (let m = 0; m < perGroup; m++) {
      const tokens = [...template];
      const noise = new Set<string>();
      while (noise.size < noiseTokens) {
        noise.add(`n${Math.floor(rng() * 100000)}`);
      }
      for (const n of noise) tokens.push(n);
      for (let k = 0; k < 4; k++) tokens.push(`id${g}_${m}_${k}`);
      const message = tokens.join(' ');
      messages.push(message);
      group.push(message);
    }
    groups.push(group);
  }

  return { messages, groups };
}

function makeBenchmarkDataset(n: number, seed: number): string[] {
  const rng = seededRandom(seed);
  const messages: string[] = [];
  const numGroups = 20;
  const perGroup = Math.max(1, Math.floor((n * 2) / 3 / numGroups));

  for (let g = 0; g < numGroups; g++) {
    const template = Array.from({ length: 150 }, (_, t) => `g${g}tok${t}`);
    for (let m = 0; m < perGroup; m++) {
      const tokens = [...template];
      const noise = new Set<string>();
      while (noise.size < 3) {
        noise.add(`n${Math.floor(rng() * 100000)}`);
      }
      for (const x of noise) tokens.push(x);
      for (let k = 0; k < 4; k++) tokens.push(`id${g}_${m}_${k}`);
      messages.push(tokens.join(' '));
    }
  }

  while (messages.length < n) {
    const tokens = Array.from({ length: 40 }, () => `z${Math.floor(rng() * 100000)}`);
    messages.push(tokens.join(' '));
  }

  // Shuffle so the first MAX_CLUSTER_INPUT messages are a representative mix
  // of near-duplicates and singletons regardless of N, rather than a dense
  // block of near-duplicates that would bias the LSH comparison.
  for (let i = messages.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = messages[i];
    messages[i] = messages[j];
    messages[j] = tmp;
  }

  return messages;
}

describe('cluster scaling', () => {
  it('LSH candidate sets stay small relative to all pairs', () => {
    const { messages } = makeSyntheticDataset(50, 40, 2, 1337);
    expect(messages.length).toBe(2000);

    const signatures = messages.map((m) =>
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
    const totalPairs = (messages.length * (messages.length - 1)) / 2;
    expect(candidates.size).toBeLessThan(totalPairs * 0.05);
  });

  it('adaptive clustering matches exact output for moderate datasets', () => {
    const { messages } = makeSyntheticDataset(30, 8, 2, 99);
    expect(messages.length).toBeGreaterThan(EXACT_CLUSTER_LIMIT);

    const exact = new Set(clusterFindingsExact(messages, 0.3).flatMap((c) => c.messages));
    const lsh = new Set(clusterFindings(messages, 0.3).flatMap((c) => c.messages));
    expect(lsh.size).toBeGreaterThanOrEqual(exact.size * 0.9);
  });
});

describe.runIf(process.env.RUN_BENCH === '1')('cluster scaling benchmark', () => {
  it('compares exact vs adaptive clustering on identical inputs (isolates LSH effect)', () => {
    const sizes = [100, 200, 500, 1000, 2000, 5000];
    const rows: Array<{ n: number; exactMs: number; adaptiveMs: number; speedup: number }> = [];

    for (const n of sizes) {
      // Same input for both paths: cap to MAX_CLUSTER_INPUT so the adaptive
      // path is NOT silently truncating while the exact path runs on full N.
      const input = makeBenchmarkDataset(n, n).slice(0, MAX_CLUSTER_INPUT);

      const startExact = performance.now();
      const exactClusters = clusterFindingsExact(input, 0.3);
      const exactMs = performance.now() - startExact;

      const startAdaptive = performance.now();
      const adaptiveClusters = clusterFindings(input, 0.3);
      const adaptiveMs = performance.now() - startAdaptive;

      rows.push({ n, exactMs, adaptiveMs, speedup: exactMs / Math.max(adaptiveMs, 0.001) });
      expect(adaptiveClusters.length).toBeGreaterThanOrEqual(0);
      expect(exactClusters.length).toBeGreaterThanOrEqual(0);
      expect(adaptiveMs).toBeLessThan(10000);
    }

    console.log('clusterFindings benchmark (exact vs adaptive, same capped input):');
    console.log(JSON.stringify(rows, null, 2));
  }, 120000);

  it('shows the adaptive path stays bounded by MAX_CLUSTER_INPUT on full-N inputs', () => {
    const sizes = [500, 1000, 2000, 5000];
    const rows: Array<{ n: number; exactMs: number; adaptiveMs: number; speedup: number }> = [];

    for (const n of sizes) {
      const messages = makeBenchmarkDataset(n, n);

      const startExact = performance.now();
      clusterFindingsExact(messages, 0.3);
      const exactMs = performance.now() - startExact;

      const startAdaptive = performance.now();
      const { truncated } = clusterFindingsWithStatus(messages, 0.3);
      const adaptiveMs = performance.now() - startAdaptive;

      rows.push({ n, exactMs, adaptiveMs, speedup: exactMs / Math.max(adaptiveMs, 0.001) });
      expect(truncated).toBe(n > MAX_CLUSTER_INPUT);
      expect(adaptiveMs).toBeLessThan(10000);
    }

    console.log('clusterFindings benchmark (full-N: exact vs truncation-capped adaptive):');
    console.log(JSON.stringify(rows, null, 2));
  }, 120000);
});
