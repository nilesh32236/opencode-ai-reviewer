import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countHttpError } from '../../src/utils/circuit-breaker.js';
import {
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_TIMEOUT_MS,
  type JevNoulInput,
  type JevPrefilterFinding,
  type JevScoreInput,
  type JevValidityProvider,
  askJevChoice,
  askJevNoul,
  askJevScore,
  isJevEnabled,
  isObviousFalsePositive,
  jevUnavailable,
  mapScoreToVerdict,
  prefilterVerificationIssues,
  resetJevCircuitBreaker,
  resolveJevApiKey,
  resolveJevModel,
  resolveJevTimeoutMs,
  scoreFindingValidity,
} from '../../src/utils/jev-client.js';
import { Logger } from '../../src/utils/logger.js';

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
 * Enable Jev shadow mode with a dummy key for tests that exercise HTTP.
 */
function enableJev(): void {
  process.env.JEV_ENABLED = 'true';
  process.env.OPENCODE_API_KEY = 'test-key';
}

function sampleFindings(): JevPrefilterFinding[] {
  return [
    { file: 'src/a.ts', line: 10, message: 'Possible null dereference', severity: 'important' },
    { file: 'src/b.ts', line: 42, message: 'Unused variable', severity: 'minor' },
    { file: 'src/c.ts', line: 7, message: 'SQL string concatenation', severity: 'critical' },
  ];
}

describe('isJevEnabled', () => {
  it('is disabled by default (opt-in shadow)', () => {
    expect(isJevEnabled()).toBe(false);
  });

  it('enables only on the literal true (case-insensitive, trimmed)', () => {
    for (const value of ['true', 'TRUE', ' True ']) {
      expect(isJevEnabled({ JEV_ENABLED: value })).toBe(true);
    }
  });

  it('rejects truthy-but-invalid values', () => {
    for (const value of ['1', 'yes', 'on', '', 'false']) {
      expect(isJevEnabled({ JEV_ENABLED: value })).toBe(false);
    }
  });
});

describe('resolveJevModel', () => {
  it('defaults to the free tier model', () => {
    expect(resolveJevModel({})).toBe(JEV_DEFAULT_MODEL);
    expect(resolveJevModel({})).toBe('jev-1.13-free');
  });

  it('honors the JEV_MODEL pin for paid thresholds', () => {
    expect(resolveJevModel({ JEV_MODEL: 'jev-1.13' })).toBe('jev-1.13');
  });

  it('falls back to default on blank pin', () => {
    expect(resolveJevModel({ JEV_MODEL: '   ' })).toBe(JEV_DEFAULT_MODEL);
  });
});

describe('resolveJevTimeoutMs', () => {
  it('defaults to ~1500ms', () => {
    expect(resolveJevTimeoutMs({})).toBe(JEV_DEFAULT_TIMEOUT_MS);
    expect(resolveJevTimeoutMs({})).toBe(1500);
  });

  it('parses a valid override', () => {
    expect(resolveJevTimeoutMs({ JEV_TIMEOUT_MS: '500' })).toBe(500);
  });

  it('falls back on malformed or non-positive values', () => {
    for (const value of ['abc', '', '-100', '0']) {
      expect(resolveJevTimeoutMs({ JEV_TIMEOUT_MS: value })).toBe(JEV_DEFAULT_TIMEOUT_MS);
    }
  });

  it('clamps large overrides to the 10s upper bound', () => {
    expect(resolveJevTimeoutMs({ JEV_TIMEOUT_MS: '60000' })).toBe(10_000);
    expect(resolveJevTimeoutMs({ JEV_TIMEOUT_MS: '10000' })).toBe(10_000);
    expect(resolveJevTimeoutMs({ JEV_TIMEOUT_MS: '9999' })).toBe(9999);
  });
});

describe('resolveJevApiKey', () => {
  it('returns undefined when no key is configured', () => {
    expect(resolveJevApiKey({})).toBeUndefined();
  });

  it('prefers OPENCODE_API_KEY, then INPUT mirror, then TYPESAFE direct key', () => {
    expect(resolveJevApiKey({ OPENCODE_API_KEY: 'a' })).toBe('a');
    expect(resolveJevApiKey({ INPUT_OPENCODE_API_KEY: 'b' })).toBe('b');
    expect(resolveJevApiKey({ TYPESAFE_API_KEY: 'c' })).toBe('c');
    expect(
      resolveJevApiKey({
        OPENCODE_API_KEY: 'a',
        INPUT_OPENCODE_API_KEY: 'b',
        TYPESAFE_API_KEY: 'c',
      }),
    ).toBe('a');
  });
});

describe('mapScoreToVerdict', () => {
  it('maps score > 0.7 to block', () => {
    expect(mapScoreToVerdict(0.9, 0.95)).toBe('block');
    expect(mapScoreToVerdict(0.71, 0.8)).toBe('block');
  });

  it('maps score > 0.3 to review', () => {
    expect(mapScoreToVerdict(0.5, 0.9)).toBe('review');
    expect(mapScoreToVerdict(0.31, 1)).toBe('review');
  });

  it('maps score <= 0.3 to allow', () => {
    expect(mapScoreToVerdict(0.3, 0.9)).toBe('allow');
    expect(mapScoreToVerdict(0.0, 1)).toBe('allow');
  });

  it('degrades to review when confidence < 0.8 regardless of score', () => {
    expect(mapScoreToVerdict(0.95, 0.5)).toBe('review');
    expect(mapScoreToVerdict(0.05, 0.79)).toBe('review');
    expect(mapScoreToVerdict(0.95, 0.79)).toBe('review');
  });

  it('degrades to review on non-finite inputs', () => {
    expect(mapScoreToVerdict(Number.NaN, 0.9)).toBe('review');
    expect(mapScoreToVerdict(0.9, Number.NaN)).toBe('review');
  });
});

describe('isObviousFalsePositive', () => {
  it('flags low validity with high confidence', () => {
    expect(isObviousFalsePositive(0.1, 0.9)).toBe(true);
    expect(isObviousFalsePositive(0.3, 0.8)).toBe(true);
    expect(isObviousFalsePositive(0.1, 0.9, 'minor')).toBe(true);
  });

  it('keeps findings above the review threshold or below the confidence floor', () => {
    expect(isObviousFalsePositive(0.31, 0.95)).toBe(false);
    expect(isObviousFalsePositive(0.1, 0.79)).toBe(false);
    expect(isObviousFalsePositive(0.9, 0.95)).toBe(false);
  });

  it('never drops critical findings, even at score 0 with full confidence', () => {
    expect(isObviousFalsePositive(0.0, 1.0, 'critical')).toBe(false);
    expect(isObviousFalsePositive(0.1, 0.95, 'critical')).toBe(false);
    expect(isObviousFalsePositive(0.1, 0.95, ' Critical ')).toBe(false);
  });

  it('never drops on non-finite inputs', () => {
    expect(isObviousFalsePositive(Number.NaN, 0.9)).toBe(false);
    expect(isObviousFalsePositive(0.1, Number.NaN)).toBe(false);
  });
});

describe('jevUnavailable', () => {
  it('returns the fail-open review verdict', () => {
    expect(jevUnavailable()).toEqual({ verdict: 'review', reason: 'jev-unavailable' });
  });
});

describe('askJevChoice', () => {
  it('parses choice + probabilities + confidence and logs response.model', async () => {
    enableJev();
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          answers: {
            'choice-0': {
              choice: 'genuine',
              probabilities: { genuine: 0.85, 'false-positive': 0.15 },
              confidence: 0.85,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await askJevChoice(
      {
        question: 'Is this finding genuine?',
        context: 'Finding in src/a.ts line 1: null dereference',
        criteria: {
          genuine: 'A real defect',
          'false-positive': 'Not a real defect',
        },
      },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      choice: 'genuine',
      probabilities: { genuine: 0.85, 'false-positive': 0.15 },
      confidence: 0.85,
      model: 'jev-1.13-free',
    });
    // Bearer auth header is sent.
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    // Request uses the `{ model, state, questions-map }` shape with the
    // `criteria` option map (never `options`, never per-question
    // `question`/`context`/`id` fields).
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      state: string;
      questions: Record<string, Record<string, unknown>>;
    };
    expect(body.model).toBe('jev-1.13-free');
    expect(body.state).toBe('Finding in src/a.ts line 1: null dereference');
    expect(Object.keys(body.questions)).toEqual(['choice-0']);
    expect(body.questions['choice-0']).toMatchObject({
      type: 'choice',
      instructions: 'Is this finding genuine?',
      criteria: { genuine: 'A real defect', 'false-positive': 'Not a real defect' },
    });
    expect(body.questions['choice-0']).not.toHaveProperty('options');
    expect(body.questions['choice-0']).not.toHaveProperty('question');
    expect(body.questions['choice-0']).not.toHaveProperty('context');
    expect(body.questions['choice-0']).not.toHaveProperty('id');
  });

  it('posts the documented wire shape: state string + questions map with instructions', async () => {
    enableJev();
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ model: 'm', answers: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await askJevScore(
      {
        question: 'How valid is this finding?',
        context: 'shared finding text',
        criteria: ['False positive', 'Genuine defect'],
      },
      { fetchImpl },
    );

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    // Top level: model + state string + questions map (no questions array).
    expect(typeof body.state).toBe('string');
    expect(body.state).toBe('shared finding text');
    expect(Array.isArray(body.questions)).toBe(false);
    const questions = body.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions)).toEqual(['score-0']);
    // Map entries carry type + instructions + criteria only.
    expect(questions['score-0'].type).toBe('score');
    expect(questions['score-0'].instructions).toBe('How valid is this finding?');
    expect(questions['score-0'].criteria).toEqual(['False positive', 'Genuine defect']);
    for (const entry of Object.values(questions)) {
      expect(entry).not.toHaveProperty('question');
      expect(entry).not.toHaveProperty('context');
      expect(entry).not.toHaveProperty('id');
      expect(entry).not.toHaveProperty('options');
    }
  });

  it('fails open (undefined, never throws) on 429', async () => {
    enableJev();
    const result = await askJevScore(
      { question: 'Score this', criteria: ['Low', 'High'] },
      { fetchImpl: jsonFetch({ error: 'rate limited' }, 429) },
    );
    expect(result).toBeUndefined();
  });

  it('fails open without attempting a request when disabled', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const result = await askJevChoice(
      { question: 'q', criteria: { a: 'Option A' } },
      { fetchImpl },
    );
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('fails open (never throws) on malformed caller input', async () => {
    enableJev();
    const nullCriteria = {
      question: 'q',
      criteria: null as unknown as Record<string, string>,
    };
    await expect(askJevChoice(nullCriteria, {})).resolves.toBeUndefined();
    await expect(askJevScore(null as unknown as JevScoreInput, {})).resolves.toBeUndefined();
    await expect(askJevNoul(null as unknown as JevNoulInput, {})).resolves.toBeUndefined();
  });

  it('skips the request (fail-open) on malformed criteria without HTTP traffic', async () => {
    enableJev();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    // Choice needs a non-empty option map; score needs at least 2 levels.
    await expect(
      askJevChoice({ question: 'q', criteria: {} }, { fetchImpl }),
    ).resolves.toBeUndefined();
    await expect(
      askJevScore({ question: 'q', criteria: ['Only one level'] }, { fetchImpl }),
    ).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it('logs a distinct warning on deterministic 4xx so silent fail-open stays visible', async () => {
    enableJev();
    const warnings: string[] = [];
    Logger.setSink({
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
      error: () => undefined,
    });
    try {
      const result = await askJevScore(
        { question: 'Score this', criteria: ['Low', 'High'] },
        { fetchImpl: jsonFetch({ error: 'bad request' }, 400) },
      );
      expect(result).toBeUndefined();
      expect(warnings.some((w) => w.includes('deterministic client error (HTTP 400)'))).toBe(true);
    } finally {
      Logger.resetSink();
    }
  });

  it('drops out-of-range probability entries instead of normalizing them', async () => {
    enableJev();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          answers: [
            {
              id: 'choice-0',
              choice: 'genuine',
              probabilities: { genuine: 0.6, inflated: 1.5, negative: -0.2, nanish: 'x' },
              confidence: 0.9,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    const result = await askJevChoice(
      { question: 'Is this finding genuine?', criteria: { genuine: 'A real defect' } },
      { fetchImpl },
    );
    expect(result?.probabilities).toEqual({ genuine: 0.6 });
  });

  it('returns undefined for missing/out-of-range choice confidence (mirrors score path)', async () => {
    enableJev();
    const choiceFetch = (confidence: unknown) =>
      jsonFetch({
        model: 'jev-1.13-free',
        answers: [{ id: 'choice-0', choice: 'genuine', probabilities: {}, confidence }],
      });
    for (const confidence of [999, -1, undefined]) {
      const result = await askJevChoice(
        { question: 'Is this finding genuine?', criteria: { genuine: 'A real defect' } },
        { fetchImpl: choiceFetch(confidence) },
      );
      expect(result, `confidence=${String(confidence)}`).toBeUndefined();
    }
  });

  it('parses numeric noul answers, deriving decisiveness when confidence is absent', async () => {
    enableJev();
    // Native noul answers carry no confidence field: a decisive P(yes)
    // derives high confidence from distance-from-ambivalence.
    const decisive = await askJevNoul(
      { question: 'Is this urgent?' },
      { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: [{ noul: 0.95 }] }) },
    );
    expect(decisive).toMatchObject({ noul: 0.95 });
    expect(decisive?.confidence).toBeCloseTo(0.9, 10);
    // An ambivalent P(yes) derives low confidence (fail-open downstream).
    const ambivalent = await askJevNoul(
      { question: 'Is this urgent?' },
      { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: [{ noul: 0.6 }] }) },
    );
    expect(ambivalent).toMatchObject({ noul: 0.6 });
    expect(ambivalent?.confidence).toBeCloseTo(0.2, 10);
    // An explicit confidence is honored when present and valid.
    const explicit = await askJevNoul(
      { question: 'Is this urgent?' },
      {
        fetchImpl: jsonFetch({
          model: 'jev-1.13-free',
          answers: [{ noul: 0.7, confidence: 0.85 }],
        }),
      },
    );
    expect(explicit).toMatchObject({ noul: 0.7, confidence: 0.85 });
  });

  it('returns undefined for out-of-range noul values or explicitly malformed confidence', async () => {
    enableJev();
    const noulFetch = (answer: Record<string, unknown>) =>
      jsonFetch({ model: 'jev-1.13-free', answers: [answer] });
    // Out-of-range or missing P(yes) never parses.
    for (const noul of [999, -1, undefined, 'yes']) {
      const result = await askJevNoul(
        { question: 'Is this urgent?' },
        { fetchImpl: noulFetch({ noul }) },
      );
      expect(result, `noul=${String(noul)}`).toBeUndefined();
    }
    // An explicitly present but out-of-range confidence fails open even
    // when P(yes) itself is valid.
    for (const confidence of [999, -1]) {
      const result = await askJevNoul(
        { question: 'Is this urgent?' },
        { fetchImpl: noulFetch({ noul: 0.9, confidence }) },
      );
      expect(result, `confidence=${String(confidence)}`).toBeUndefined();
    }
  });

  it('accepts numeric answer/value aliases for noul (envelope drift)', async () => {
    enableJev();
    // Mirrors the score path tolerating validity/value: a verdict carried
    // under a neighboring key still parses instead of dropping the signal.
    for (const [answer, expected] of [
      [{ answer: 0.8 }, 0.8],
      [{ value: 0.2 }, 0.2],
      [{ answer: '0.75' }, 0.75],
    ] as Array<[Record<string, unknown>, number]>) {
      const result = await askJevNoul(
        { question: 'Is this urgent?' },
        { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: [answer] }) },
      );
      expect(result, JSON.stringify(answer)).toMatchObject({ noul: expected });
    }
    // The native `noul` key wins when several keys are present.
    const precedence = await askJevNoul(
      { question: 'Is this urgent?' },
      { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: [{ noul: 0.9, answer: 0.1 }] }) },
    );
    expect(precedence).toMatchObject({ noul: 0.9 });
  });

  it('reads a single answer object nested under answers', async () => {
    enableJev();
    // `{ model, answers: { noul: 0.9 } }` — `answers` is itself the answer
    // (a record with no nested answer records), not an id-keyed map. The
    // parser must read it instead of the envelope so the signal survives.
    const result = await askJevNoul(
      { question: 'Is this urgent?' },
      { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: { noul: 0.9 } }) },
    );
    expect(result).toMatchObject({ noul: 0.9, model: 'jev-1.13-free' });
  });

  it('omits non-string noul criteria instead of sending a 422-shaped payload', async () => {
    enableJev();
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ model: 'm', answers: [{ noul: 0.9 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    // Non-string true/false descriptions are dropped; with neither
    // surviving, criteria is omitted entirely — but the request still goes
    // out and the answer still parses (fail-open before send).
    const dropped = await askJevNoul(
      {
        question: 'Is this urgent?',
        criteria: { true: 123, false: { nested: true } } as unknown as JevNoulInput['criteria'],
      },
      { fetchImpl },
    );
    expect(dropped).toMatchObject({ noul: 0.9 });
    const sentWithoutCriteria = JSON.parse(capturedBody) as {
      questions: Record<string, Record<string, unknown>>;
    };
    expect(sentWithoutCriteria.questions['noul-0']).not.toHaveProperty('criteria');

    // Valid string descriptions are still sent (trimmed).
    const kept = await askJevNoul(
      {
        question: 'Is this urgent?',
        criteria: { true: '  Definitely urgent  ', false: 'Not urgent' },
      },
      { fetchImpl },
    );
    expect(kept).toMatchObject({ noul: 0.9 });
    const sentWithCriteria = JSON.parse(capturedBody) as {
      questions: Record<string, Record<string, unknown>>;
    };
    expect(sentWithCriteria.questions['noul-0'].criteria).toEqual({
      true: 'Definitely urgent',
      false: 'Not urgent',
    });
  });

  it('excludes deterministic 4xx from circuit-breaker tripping', async () => {
    // countHttpError backs the shared Jev breaker: 4xx (except 429) must not count.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(countHttpError(Object.assign(new Error('client error'), { status }))).toBe(false);
    }
    expect(countHttpError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
  });

  it('caller aborts do not count toward tripping the circuit breaker', async () => {
    enableJev();
    const abortFetch = (async () => {
      throw new DOMException('caller cancelled', 'AbortError');
    }) as typeof fetch;
    // Six consecutive aborts — more than the breaker's failureThreshold of 5.
    // Each still fails open to undefined (no signal was passed, so there is
    // nothing to rethrow for), but none may trip the breaker.
    for (let i = 0; i < 6; i++) {
      await expect(
        askJevScore({ question: 'q', criteria: ['Low', 'High'] }, { fetchImpl: abortFetch }),
      ).resolves.toBeUndefined();
    }
    // Breaker must still be CLOSED: a healthy call goes through to fetch.
    const ok = await askJevScore(
      { question: 'q', criteria: ['Low', 'High'] },
      {
        fetchImpl: jsonFetch({
          model: 'jev-1.13-free',
          answers: [{ score: 0.9, confidence: 0.95 }],
        }),
      },
    );
    expect(ok).toMatchObject({ score: 0.9, confidence: 0.95 });
  });
});

describe('scoreFindingValidity', () => {
  it('returns unavailable fail-open when Jev is disabled', async () => {
    const assessment = await scoreFindingValidity({
      file: 'src/a.ts',
      line: 1,
      message: 'x',
    });
    expect(assessment).toMatchObject({ unavailable: true, reason: 'jev-unavailable' });
  });

  it('fails open on transport errors without throwing', async () => {
    enableJev();
    const failingFetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    const assessment = await scoreFindingValidity(
      { file: 'src/a.ts', line: 1, message: 'x' },
      { fetchImpl: failingFetch },
    );
    expect(assessment.unavailable).toBe(true);
    expect(assessment.reason).toBe('jev-unavailable');
  });

  it('fails open (never throws) on a malformed finding', async () => {
    enableJev();
    const assessment = await scoreFindingValidity(null as unknown as JevPrefilterFinding, {});
    expect(assessment).toMatchObject({ unavailable: true, reason: 'jev-unavailable' });
  });

  it('treats out-of-range score/confidence as unavailable (finding kept, never a drop)', async () => {
    enableJev();
    const cases: Array<{ answers: Array<Record<string, unknown>>; label: string }> = [
      { label: 'negative score', answers: [{ score: -1, confidence: 1 }] },
      { label: 'score above 1', answers: [{ score: 1.5, confidence: 1 }] },
      { label: 'confidence above 1', answers: [{ score: 0.0, confidence: 2 }] },
      { label: 'missing confidence', answers: [{ score: 0.0 }] },
      { label: 'negative confidence', answers: [{ score: 0.0, confidence: -0.2 }] },
    ];
    for (const { answers, label } of cases) {
      const assessment = await scoreFindingValidity(
        { file: 'src/a.ts', line: 1, message: 'x' },
        { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers }) },
      );
      expect(assessment, label).toMatchObject({ unavailable: true, reason: 'jev-unavailable' });
    }
  });

  it('rejects numeric strings with trailing garbage instead of parseFloat-prefixing them', async () => {
    enableJev();
    for (const score of ['0.9xyz', '0abc', '1e2abc']) {
      const assessment = await scoreFindingValidity(
        { file: 'src/a.ts', line: 1, message: 'x' },
        { fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: [{ score, confidence: 0.9 }] }) },
      );
      expect(assessment, `score=${score}`).toMatchObject({
        unavailable: true,
        reason: 'jev-unavailable',
      });
    }
    // A clean numeric string still parses (strict Number, not a blanket string ban).
    const ok = await scoreFindingValidity(
      { file: 'src/a.ts', line: 1, message: 'x' },
      {
        fetchImpl: jsonFetch({
          model: 'jev-1.13-free',
          answers: [{ score: '0.95', confidence: 0.9 }],
        }),
      },
    );
    expect(ok.unavailable).toBe(false);
    expect(ok.score).toBe(0.95);
  });
});

describe('prefilterVerificationIssues', () => {
  it('skips with input intact when JEV_ENABLED!=true (zero behavior change)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings, { fetchImpl });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('jev-disabled');
    expect(result.kept).toBe(findings);
    expect(result.dropped).toEqual([]);
    expect(called).toBe(false);
  });

  it('fails open (keeps everything) when no API key is configured', async () => {
    process.env.JEV_ENABLED = 'true';
    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('jev-unavailable');
    expect(result.kept).toBe(findings);
  });

  it('drops only low-validity/high-confidence findings in one batched call', async () => {
    enableJev();
    let callCount = 0;
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          // Documented answers-map envelope, keyed by the request ids.
          answers: {
            'validity-0': { score: 0.1, confidence: 0.9 },
            'validity-1': { score: 0.9, confidence: 0.95 },
            // Low validity but low confidence -> must be kept for LLM review.
            'validity-2': { score: 0.1, confidence: 0.5 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings, { fetchImpl });

    expect(callCount).toBe(1);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('ok');
    expect(result.model).toBe('jev-1.13-free');
    expect(result.dropped).toEqual([findings[0]]);
    expect(result.kept).toEqual([findings[1], findings[2]]);
    // The batch shares ONE state (numbered findings) with an id-keyed
    // questions map — no per-question question/context/id fields.
    const body = JSON.parse(capturedBody) as {
      state: string;
      questions: Record<string, Record<string, unknown>>;
    };
    expect(typeof body.state).toBe('string');
    expect(body.state).toContain('1.');
    expect(body.state).toContain('Possible null dereference');
    expect(Object.keys(body.questions)).toEqual(['validity-0', 'validity-1', 'validity-2']);
    for (const [id, entry] of Object.entries(body.questions)) {
      expect(entry.type).toBe('score');
      expect(typeof entry.instructions).toBe('string');
      expect(String(entry.instructions)).toContain(`finding #${Number(id.split('-')[1]) + 1}`);
      expect(entry).not.toHaveProperty('question');
      expect(entry).not.toHaveProperty('context');
      expect(entry).not.toHaveProperty('id');
    }
  });

  it('keeps everything fail-open on network failure without throwing', async () => {
    enableJev();
    const failingFetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings, { fetchImpl: failingFetch });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('jev-unavailable');
    expect(result.kept).toBe(findings);
    expect(result.dropped).toEqual([]);
  });

  it('keeps findings on unparseable responses (endpoint drift degrades gracefully)', async () => {
    enableJev();
    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings, {
      fetchImpl: jsonFetch({ model: 'jev-1.13-free', answers: [{ unexpected: true }] }),
    });
    // Nothing usable came back: fail-open keep-all reported as skipped so the
    // caller proceeds to LLM verification exactly as when Jev is disabled.
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('jev-unavailable');
    expect(result.kept).toBe(findings);
    expect(result.dropped).toEqual([]);
  });

  it('prefers answers over results when both envelopes are present', async () => {
    enableJev();
    const findings = sampleFindings();
    // `answers` carries one id-less entry (drops finding 0); `results`
    // carries drop-worthy entries that must be ignored entirely — the old
    // concat behavior would positionally misassign them onto findings 1-2.
    const result = await prefilterVerificationIssues(findings, {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        answers: [{ score: 0.05, confidence: 0.99 }],
        results: [
          { score: 0.0, confidence: 1.0 },
          { score: 0.0, confidence: 1.0 },
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.dropped).toEqual([findings[0]]);
    expect(result.kept).toEqual([findings[1], findings[2]]);
  });

  it('never aligns positionally when the response carries ids but omits an answer', async () => {
    enableJev();
    const findings = sampleFindings();
    // Only validity-0 (drop-worthy) and validity-2 (keep) answered; the
    // middle finding has no answer. Positional fallback would misassign
    // validity-2's keep-answer to the middle finding — both must be kept.
    const result = await prefilterVerificationIssues(findings, {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        answers: [
          { id: 'validity-0', score: 0.05, confidence: 0.99 },
          { id: 'validity-2', score: 0.9, confidence: 0.95 },
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.dropped).toEqual([findings[0]]);
    expect(result.kept).toEqual([findings[1], findings[2]]);
  });

  it('aligns out-of-order id-bearing answers to the correct findings', async () => {
    enableJev();
    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings, {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        answers: [
          { id: 'validity-2', score: 0.9, confidence: 0.95 },
          { id: 'validity-0', score: 0.05, confidence: 0.99 },
          { id: 'validity-1', score: 0.9, confidence: 0.95 },
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.dropped).toEqual([findings[0]]);
    expect(result.kept).toEqual([findings[1], findings[2]]);
  });

  it('accepts the results envelope as well as answers', async () => {
    enableJev();
    const findings = sampleFindings();
    const result = await prefilterVerificationIssues(findings, {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        results: [
          { id: 'validity-0', score: 0.05, confidence: 0.99 },
          { id: 'validity-1', score: 0.9, confidence: 0.95 },
          { id: 'validity-2', score: 0.9, confidence: 0.95 },
        ],
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.dropped).toEqual([findings[0]]);
    expect(result.kept).toEqual([findings[1], findings[2]]);
  });

  it('never drops critical findings even when Jev scores them 0 with full confidence', async () => {
    enableJev();
    const findings: JevPrefilterFinding[] = [
      { file: 'src/crit.ts', line: 1, message: 'RCE sink', severity: 'critical' },
      { file: 'src/minor.ts', line: 2, message: 'Typo in comment', severity: 'minor' },
    ];
    const result = await prefilterVerificationIssues(findings, {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        answers: [
          { id: 'validity-0', score: 0.0, confidence: 1.0 },
          { id: 'validity-1', score: 0.0, confidence: 1.0 },
        ],
      }),
    });
    expect(result.dropped).toEqual([findings[1]]);
    expect(result.kept).toEqual([findings[0]]);
  });

  it('chunks large finding lists into batches of at most 20 questions', async () => {
    enableJev();
    const findings: JevPrefilterFinding[] = Array.from({ length: 25 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i + 1,
      message: `finding ${i}`,
      severity: 'minor',
    }));
    const batchSizes: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      batchSizes.push(Object.keys(body.questions).length);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          answers: Object.keys(body.questions).map(() => ({
            // All findings score high-validity: nothing dropped, batching only.
            score: 0.9,
            confidence: 0.95,
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = await prefilterVerificationIssues(findings, { fetchImpl });
    expect(batchSizes).toEqual([20, 5]);
    expect(result.kept).toEqual(findings);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a failed chunk fail-open while applying successful chunks', async () => {
    enableJev();
    const findings: JevPrefilterFinding[] = Array.from({ length: 21 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i + 1,
      message: `finding ${i}`,
      severity: 'minor',
    }));
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return new Response(
        JSON.stringify({ model: 'x', answers: [{ score: 0.0, confidence: 1.0 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = await prefilterVerificationIssues(findings, { fetchImpl });
    // First chunk (20 findings) failed open -> kept; second chunk dropped its one FP.
    expect(calls).toBe(2);
    expect(result.kept).toEqual(findings.slice(0, 20));
    expect(result.dropped).toEqual([findings[20]]);
  });

  it('aborted signal rejects instead of fail-open resolve', async () => {
    enableJev();
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    // The pre-check throws before fetch; the abort must propagate through
    // scoreBatch into the prefilter catch-all, which rethrows on abort
    // instead of resolving `jev-unavailable`.
    await expect(
      prefilterVerificationIssues(sampleFindings(), { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('swallowing provider still rejects when the signal aborted (post-await check)', async () => {
    enableJev();
    const controller = new AbortController();
    controller.abort();
    // A provider that resolves normally despite cancellation must not let
    // the prefilter resolve fail-open: the post-await signal check rejects.
    const swallowingProvider: JevValidityProvider = {
      scoreBatch: async () => [
        { score: 0.9, confidence: 0.95, model: 'x', unavailable: false, reason: 'ok' },
      ],
    };

    await expect(
      prefilterVerificationIssues(sampleFindings(), {
        provider: swallowingProvider,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('abort with a custom Error reason rejects without tripping the breaker', async () => {
    enableJev();
    const customAbortFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const sig = init?.signal;
      // Behave like undici: reject with the signal's reason once aborted.
      if (sig?.aborted) throw sig.reason;
      await new Promise((_, reject) => {
        sig?.addEventListener('abort', () => reject((sig as AbortSignal).reason), {
          once: true,
        });
      });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    // Six consecutive custom-reason aborts — more than the breaker's
    // failureThreshold of 5. Each rejects (no fail-open swallow) but none
    // may count toward tripping the breaker.
    for (let i = 0; i < 6; i++) {
      const c = new AbortController();
      const pending = prefilterVerificationIssues(sampleFindings(), {
        fetchImpl: customAbortFetch,
        signal: c.signal,
      });
      c.abort(new Error('caller went away'));
      await expect(pending, `iteration ${i}`).rejects.toThrow('caller went away');
    }
    // Breaker still CLOSED: a healthy call scores instead of failing fast.
    const result = await prefilterVerificationIssues(sampleFindings(), {
      fetchImpl: jsonFetch({
        model: 'jev-1.13-free',
        answers: sampleFindings().map((_, i) => ({
          id: `validity-${i}`,
          score: 0.9,
          confidence: 0.95,
        })),
      }),
    });
    expect(result.skipped).toBe(false);
    expect(result.dropped).toEqual([]);
  });
});

// Opt-in live smoke canary for the Zen SystemOne contract. Skipped by default;
// run manually with JEV_LIVE_SMOKE=true + a real key to detect endpoint drift.
// NOT part of CI: asserts the live shape still parses.
const LIVE_SMOKE_ENABLED =
  process.env.JEV_LIVE_SMOKE === 'true' &&
  (process.env.OPENCODE_API_KEY ?? process.env.TYPESAFE_API_KEY) !== undefined;
const LIVE_SMOKE_KEY: string = process.env.OPENCODE_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '';

it.runIf(LIVE_SMOKE_ENABLED)(
  'live smoke: choice question against Zen SystemOne',
  async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = LIVE_SMOKE_KEY;
    const result = await askJevChoice(
      {
        question: 'Is the sky blue? (connectivity smoke test)',
        criteria: { yes: 'The sky is blue', no: 'The sky is not blue' },
      },
      { timeoutMs: 15_000 },
    );
    expect(result).toBeDefined();
    expect(result?.choice.length).toBeGreaterThan(0);
  },
  30_000,
);
