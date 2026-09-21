import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JEV_CONTEXT_RANK_MAX_ENTRIES, rankContextEntries } from '../src/mcp/context-ranker.js';
import type { MCPContextEntry } from '../src/types/index.js';
import { resetJevCircuitBreaker } from '../src/utils/jev-client.js';

const ENV_KEYS = [
  'JEV_ENABLED',
  'JEV_MODEL',
  'JEV_TIMEOUT_MS',
  'OPENCODE_API_KEY',
  'INPUT_OPENCODE_API_KEY',
  'TYPESAFE_API_KEY',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetJevCircuitBreaker();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  resetJevCircuitBreaker();
});

/**
 * Build a fetch stub resolving to a JSON response.
 *
 * @param body - JSON-serializable response body.
 * @param status - HTTP status code.
 * @returns A fetch-compatible stub.
 */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

/**
 * Enable Jev with a dummy key for tests that exercise HTTP.
 */
function enableJev(): void {
  process.env.JEV_ENABLED = 'true';
  process.env.OPENCODE_API_KEY = 'test-key';
}

function makeEntry(source: string, content: string, relevance = 0.8): MCPContextEntry {
  return { source, content, relevance };
}

/**
 * Build a Jev relevance fetch stub answering from a per-index plan.
 *
 * @param plan - Relevance score/confidence per entry index.
 * @param onRequest - Optional hook observing the raw request init.
 * @returns A fetch-compatible stub answering `{ answers }`.
 */
function relevanceFetch(
  plan: Array<{ score: number; confidence: number }>,
  onRequest?: (init?: RequestInit) => void,
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(init);
    return new Response(
      JSON.stringify({
        model: 'jev-1.13-free',
        answers: plan.map((entry, i) => ({
          id: `relevance-${i}`,
          score: entry.score,
          confidence: entry.confidence,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('rankContextEntries', () => {
  it('disabled no-op: returns the same reference with no HTTP traffic', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const entries = [makeEntry('a', 'docs A'), makeEntry('b', 'docs B')];

    const result = await rankContextEntries(entries, 'review query', { fetchImpl });

    expect(result).toBe(entries);
    expect(called).toBe(false);
  });

  it('returns input unchanged when no API key is configured', async () => {
    process.env.JEV_ENABLED = 'true';
    const entries = [makeEntry('a', 'docs A')];

    const result = await rankContextEntries(entries, 'review query');

    expect(result).toBe(entries);
  });

  it('enabled re-rank: sorts by Jev score desc in one batched call', async () => {
    enableJev();
    let callCount = 0;
    const fetchImpl = relevanceFetch(
      [
        { score: 0.2, confidence: 0.95 },
        { score: 0.9, confidence: 0.95 },
        { score: 0.5, confidence: 0.9 },
      ],
      () => {
        callCount++;
      },
    );
    const entries = [
      makeEntry('low', 'barely related docs'),
      makeEntry('high', 'directly relevant docs'),
      makeEntry('mid', 'somewhat related docs'),
    ];

    const result = await rankContextEntries(entries, 'review query', { fetchImpl });

    expect(callCount).toBe(1);
    expect(result.map((entry) => entry.source)).toEqual(['high', 'mid', 'low']);
    expect(result.map((entry) => entry.relevance)).toEqual([0.9, 0.5, 0.2]);
  });

  it('blank query: same ref returned with no HTTP traffic', async () => {
    enableJev();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const entries = [makeEntry('a', 'docs A')];

    for (const query of ['', '   ']) {
      const result = await rankContextEntries(entries, query, { fetchImpl });
      expect(result, `query=${JSON.stringify(query)}`).toBe(entries);
    }
    expect(called).toBe(false);
  });

  it('low-confidence scores keep heuristic relevance (JEV_CONFIDENCE_FLOOR 0.8, shared with Module 1)', async () => {
    // Justification: Module 1 treats confidence < 0.8 as too uncertain for a
    // drop/allow decision (mapScoreToVerdict degrades to `review`); the same
    // floor gates reordering here so an uncertain relevance score cannot
    // push context out of the token budget.
    enableJev();
    const entries = [makeEntry('a', 'docs A'), makeEntry('b', 'docs B')];
    const result = await rankContextEntries(entries, 'review query', {
      fetchImpl: relevanceFetch([
        // High score but below the confidence floor — must not apply.
        { score: 0.99, confidence: 0.5 },
        { score: 0.1, confidence: 0.4 },
      ]),
    });

    expect(result).toBe(entries);
    expect(entries[0].relevance).toBe(0.8);
    expect(entries[1].relevance).toBe(0.8);
  });

  it('never mutates caller objects: re-scored entries are clones', async () => {
    enableJev();
    const entries = [makeEntry('low', 'barely related'), makeEntry('high', 'very relevant')];
    const snapshot = entries.map((entry) => ({ ...entry }));

    const result = await rankContextEntries(entries, 'review query', {
      fetchImpl: relevanceFetch([
        { score: 0.2, confidence: 0.95 },
        { score: 0.9, confidence: 0.95 },
      ]),
    });

    expect(result.map((entry) => entry.source)).toEqual(['high', 'low']);
    // Input array order and objects untouched; re-scored outputs are clones.
    expect(entries).toEqual(snapshot);
    expect(result[0]).not.toBe(entries[1]);
    expect(result[1]).not.toBe(entries[0]);
  });

  it('aborted signal: same ref returned, fetch never attempted', async () => {
    enableJev();
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const entries = [makeEntry('a', 'docs A')];

    const result = await rankContextEntries(entries, 'review query', {
      fetchImpl,
      signal: controller.signal,
    });

    expect(result).toBe(entries);
    expect(called).toBe(false);
  });

  it('live signal is forwarded to the Jev fetch call (combined with the attempt timeout)', async () => {
    enableJev();
    const controller = new AbortController();
    let sentSignal: AbortSignal | undefined | null;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ model: 'x', answers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await rankContextEntries([makeEntry('a', 'docs A')], 'review query', {
      fetchImpl,
      signal: controller.signal,
    });

    // withRetryAndTimeout combines the outer signal with the per-attempt
    // timeout via AbortSignal.any, so identity is not preserved — but an
    // outer abort must propagate to the in-flight request.
    expect(sentSignal).toBeInstanceOf(AbortSignal);
    expect(sentSignal?.aborted).toBe(false);
    controller.abort();
    expect(sentSignal?.aborted).toBe(true);
  });

  it('keeps existing order when Jev is unavailable (fail-open)', async () => {
    enableJev();
    const failingFetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    const entries = [makeEntry('a', 'docs A'), makeEntry('b', 'docs B')];

    const result = await rankContextEntries(entries, 'review query', {
      fetchImpl: failingFetch,
    });

    expect(result).toBe(entries);
    expect(entries[0].relevance).toBe(0.8);
    expect(entries[1].relevance).toBe(0.8);
  });

  it('applies partial success: usable scores reorder, unavailable entries keep heuristic relevance', async () => {
    enableJev();
    const entries = [makeEntry('a', 'docs A'), makeEntry('b', 'docs B')];
    const result = await rankContextEntries(entries, 'review query', {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        // Only the first entry answered; the second keeps 0.8 and — being
        // unscored — sorts above the Jev-low first entry.
        answers: [{ id: 'relevance-0', score: 0.1, confidence: 0.95 }],
      }),
    });

    expect(result.map((entry) => entry.source)).toEqual(['b', 'a']);
    expect(entries[1].relevance).toBe(0.8);
  });

  it('caps entries scored per call: one batch, tail keeps order and relevance', async () => {
    enableJev();
    const total = JEV_CONTEXT_RANK_MAX_ENTRIES + 5;
    const entries: MCPContextEntry[] = Array.from({ length: total }, (_, i) =>
      makeEntry(`s${i}`, `docs ${i}`),
    );
    const batchSizes: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: unknown[] };
      batchSizes.push(body.questions.length);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          answers: body.questions.map(() => ({ score: 0.9, confidence: 0.95 })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await rankContextEntries(entries, 'review query', { fetchImpl });

    expect(JEV_CONTEXT_RANK_MAX_ENTRIES).toBe(20);
    expect(batchSizes).toEqual([JEV_CONTEXT_RANK_MAX_ENTRIES]);
    // All scored entries (0.9) float above the unscored tail (0.8), which
    // keeps its original relative order.
    expect(result.slice(0, JEV_CONTEXT_RANK_MAX_ENTRIES).map((e) => e.source)).toEqual(
      entries.slice(0, JEV_CONTEXT_RANK_MAX_ENTRIES).map((e) => e.source),
    );
    expect(result.slice(JEV_CONTEXT_RANK_MAX_ENTRIES).map((e) => e.source)).toEqual(
      entries.slice(JEV_CONTEXT_RANK_MAX_ENTRIES).map((e) => e.source),
    );
    expect(result.slice(JEV_CONTEXT_RANK_MAX_ENTRIES).every((e) => e.relevance === 0.8)).toBe(true);
  });

  it('honors the maxEntries override', async () => {
    enableJev();
    const entries = [makeEntry('a', 'docs A'), makeEntry('b', 'docs B'), makeEntry('c', 'docs C')];
    const batchSizes: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: unknown[] };
      batchSizes.push(body.questions.length);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          answers: body.questions.map(() => ({ score: 0.9, confidence: 0.95 })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await rankContextEntries(entries, 'review query', { fetchImpl, maxEntries: 2 });

    expect(batchSizes).toEqual([2]);
    expect(entries[2].relevance).toBe(0.8);
  });

  it('truncates large entry content and redacts secret-shaped text pre-send', async () => {
    enableJev();
    // NOTE: the value below is AWS's published documentation example
    // placeholder (EXAMPLE key material, not a real credential), assembled
    // via concatenation so no literal credential-shaped token appears in
    // source. Used solely to exercise the pre-send redaction.
    const exampleId = `${'AK' + 'IA'}IOSFODNN7${'EXAM' + 'PLE'}`;
    const marker = 'SENTINEL-BEYOND-EXCERPT';
    const content = `key ${exampleId} ` + 'x'.repeat(3000) + marker;
    let sentQuestion = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: Array<{ question: string }>;
      };
      sentQuestion = body.questions[0].question;
      return new Response(JSON.stringify({ model: 'x', answers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await rankContextEntries([makeEntry('a', content)], 'review query', { fetchImpl });

    expect(sentQuestion).not.toContain(exampleId);
    expect(sentQuestion).not.toContain(marker);
    expect(sentQuestion.length).toBeLessThan(content.length);
  });
});
