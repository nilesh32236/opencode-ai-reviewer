import { describe, expect, it } from 'vitest';
import { CodebaseExtractor } from '../src/codebase-index/extractor.js';
import { EventBus } from '../src/event-bus/bus.js';
import { lshCandidates } from '../src/pattern-detector/minhash-optimized.js';
import type { GitHubEvent, Subscriber } from '../src/types/index.js';
import { mapLimit, resolveConcurrency } from '../src/utils/concurrency.js';
import { analyzeBatchReachability } from '../src/utils/reachability.js';

function makeSub(name: string, seen: string[]): Subscriber {
  return {
    name,
    subscribedEvents: ['pr.opened'],
    async handle(event: GitHubEvent) {
      seen.push(name);
      await Promise.resolve(event);
    },
  };
}

describe('performance-efficiency audit fixes', () => {
  it('EventBus rejects non-positive concurrency instead of hanging publish', async () => {
    expect(() => new EventBus({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new EventBus({ concurrency: -3 })).toThrow(RangeError);
    expect(() => new EventBus({ concurrency: Number.NaN })).toThrow(RangeError);

    const bus = new EventBus({ concurrency: 2 });
    const seen: string[] = [];
    bus.register(makeSub('a', seen));
    bus.register(makeSub('b', seen));
    bus.register(makeSub('c', seen));
    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('resolveConcurrency clamps and validates', () => {
    expect(resolveConcurrency(undefined, 10)).toBe(10);
    expect(resolveConcurrency(3.7, 10)).toBe(3);
    expect(() => resolveConcurrency(0, 10)).toThrow(RangeError);
  });

  it('mapLimit bounds parallelism and preserves order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('analyzeBatchReachability is fail-open on missing files', async () => {
    const results = await analyzeBatchReachability(
      [{ file: 'nope/missing.ts', line: 1 }],
      process.cwd(),
    );
    expect(results).toEqual([{ theoreticalRisk: true }]);
  });

  it('lshCandidates caps pathological buckets with numeric pair keys', () => {
    // 500 identical signatures would yield ~125k pairs per band x 42 bands.
    const sig = Array.from({ length: 126 }, (_, i) => (i * 2654435761) >>> 0);
    const signatures = Array.from({ length: 500 }, () => [...sig]);
    const candidates = lshCandidates(signatures);
    expect(candidates.size).toBeLessThanOrEqual(50_000);
    for (const [i, j] of candidates) {
      expect(i).toBeLessThan(j);
    }
  });

  it('CodebaseExtractor resolution cache stays bounded', () => {
    const extractor = new CodebaseExtractor();
    const inner = extractor as unknown as {
      resolutionCache: Map<string, string>;
      resolveLocalImport(source: string, specifier: string, baseDir: string): string;
    };
    for (let i = 0; i < 2500; i++) {
      inner.resolveLocalImport('/repo/src/a.ts', `./missing-${i}`, '/repo');
    }
    expect(inner.resolutionCache.size).toBeLessThanOrEqual(1000);
  });
});
