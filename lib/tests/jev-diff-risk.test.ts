import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewEngine } from '../src/engine.js';
import type { runOpenCode } from '../src/opencode.js';
import type { PlatformAdapter } from '../src/platform/adapter.js';
import {
  assessJevDiffRiskGate,
  isDocsOnlyPaths,
  resolveJevBudgetMode,
} from '../src/review/jev-diff-risk.js';
import type { AgentConfig, ChangedFile, PRContext } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import {
  JEV_RISK_HIGH_THRESHOLD,
  JEV_RISK_LOW_THRESHOLD,
  JEV_RISK_MAX_DESC_CHARS,
  JEV_RISK_MAX_FILES,
  JEV_RISK_MAX_STAT_CHARS,
  buildDiffRiskContext,
  mapDiffRiskSignalsToLevel,
  resetJevCircuitBreaker,
} from '../src/utils/jev-client.js';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Enable Jev with a dummy key for tests that exercise HTTP.
 */
function enableJev(): void {
  process.env.JEV_ENABLED = 'true';
  process.env.OPENCODE_API_KEY = 'test-key';
}

/**
 * Build a fetch stub answering the diff-risk batch from fixed signals.
 *
 * @param authNoul - `touches-auth-migration-secrets` answer.
 * @param destructiveNoul - `destructive-migration` answer.
 * @param blastScore - `blast-radius` score answer.
 * @param onRequest - Optional hook observing the raw request init.
 * @returns A fetch-compatible stub answering `{ answers }`.
 */
function riskFetch(
  authNoul: { noul: number; confidence: number },
  destructiveNoul: { noul: number; confidence: number },
  blastScore: { score: number; confidence: number },
  onRequest?: (init?: RequestInit) => void,
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(init);
    return new Response(
      JSON.stringify({
        model: 'jev-1.13-free',
        answers: [
          { id: 'risk-auth-migration-secrets', ...authNoul },
          { id: 'risk-destructive-migration', ...destructiveNoul },
          { id: 'risk-blast-radius', ...blastScore },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

const HIGH_RISK = {
  auth: { noul: 0.95, confidence: 0.95 },
  destructive: { noul: 0.05, confidence: 0.95 },
  blast: { score: 0.9, confidence: 0.95 },
};

const LOW_RISK = {
  auth: { noul: 0.05, confidence: 0.95 },
  destructive: { noul: 0.05, confidence: 0.95 },
  blast: { score: 0.1, confidence: 0.95 },
};

describe('resolveJevBudgetMode (exact mapping)', () => {
  it.each(['summary', 'split'] as const)('high risk escalates %s → full', (deterministic) => {
    expect(resolveJevBudgetMode(deterministic, 'high', false)).toEqual({
      budgetMode: 'full',
      suggestLite: false,
    });
  });

  it('high risk on full stays full with no lite suggestion', () => {
    expect(resolveJevBudgetMode('full', 'high', true)).toEqual({
      budgetMode: 'full',
      suggestLite: false,
    });
  });

  it.each(['full', 'summary', 'split'] as const)(
    'unknown risk leaves %s unchanged (fail-open)',
    (deterministic) => {
      expect(resolveJevBudgetMode(deterministic, 'unknown', false)).toEqual({
        budgetMode: deterministic,
        suggestLite: false,
      });
      // Even a docs-only PR gets no suggestion without a Jev signal.
      expect(resolveJevBudgetMode(deterministic, 'unknown', true)).toEqual({
        budgetMode: deterministic,
        suggestLite: false,
      });
    },
  );

  it('low risk on docs-only suggests lite WITHOUT changing the mode (no bypass)', () => {
    expect(resolveJevBudgetMode('full', 'low', true)).toEqual({
      budgetMode: 'full',
      suggestLite: true,
    });
    expect(resolveJevBudgetMode('summary', 'low', true)).toEqual({
      budgetMode: 'summary',
      suggestLite: true,
    });
  });

  it('low risk without docs-only changes nothing and suggests nothing', () => {
    expect(resolveJevBudgetMode('full', 'low', false)).toEqual({
      budgetMode: 'full',
      suggestLite: false,
    });
    expect(resolveJevBudgetMode('split', 'low', false)).toEqual({
      budgetMode: 'split',
      suggestLite: false,
    });
  });
});

describe('isDocsOnlyPaths (deterministic gate for the lite suggestion)', () => {
  it('accepts markdown / docs-dir / well-known basenames', () => {
    expect(isDocsOnlyPaths(['README.md', 'docs/guide.md', 'LICENSE', 'CHANGELOG'])).toBe(true);
    expect(isDocsOnlyPaths(['website/docs/index.mdx', 'NOTICE.txt', 'CONTRIBUTING'])).toBe(true);
  });

  it('narrows docs-dir matching to the top-level docs/ tree', () => {
    expect(isDocsOnlyPaths(['docs/guide.md'])).toBe(true);
    expect(isDocsOnlyPaths(['README.md'])).toBe(true);
    // Nested docs dirs are source, not docs.
    expect(isDocsOnlyPaths(['src/docs/code.ts'])).toBe(false);
    expect(isDocsOnlyPaths(['website/docs/runbook.ts'])).toBe(false);
    expect(isDocsOnlyPaths(['src/docs/code.ts', 'docs/guide.md'])).toBe(false);
  });

  it('does not treat generic .txt files as docs-only', () => {
    expect(isDocsOnlyPaths(['seed.txt'])).toBe(false);
    expect(isDocsOnlyPaths(['data/fixtures/seed.txt'])).toBe(false);
    // Doc-ish .txt basenames still match via the well-known basename roots.
    expect(isDocsOnlyPaths(['NOTICE.txt'])).toBe(true);
    expect(isDocsOnlyPaths(['docs/notes.txt'])).toBe(true);
  });

  it('does not treat source files sharing a doc basename root as docs-only', () => {
    expect(isDocsOnlyPaths(['src/license.ts'])).toBe(false);
    expect(isDocsOnlyPaths(['lib/notice.js'])).toBe(false);
    expect(isDocsOnlyPaths(['src/license.ts', 'lib/notice.js'])).toBe(false);
    // Full doc basenames still count.
    expect(isDocsOnlyPaths(['LICENSE'])).toBe(true);
    expect(isDocsOnlyPaths(['NOTICE.md'])).toBe(true);
    expect(isDocsOnlyPaths(['docs/guide.md'])).toBe(true);
  });

  it('rejects mixed source + docs PRs', () => {
    expect(isDocsOnlyPaths(['README.md', 'src/index.ts'])).toBe(false);
    expect(isDocsOnlyPaths(['src/index.ts'])).toBe(false);
  });

  it('normalizes whitespace, ./ prefixes, and backslash separators', () => {
    expect(isDocsOnlyPaths(['  docs/guide.md '])).toBe(true);
    expect(isDocsOnlyPaths(['./docs/guide.md'])).toBe(true);
    expect(isDocsOnlyPaths(['docs\\guide.md'])).toBe(true);
  });

  it('a bare `docs` file is not docs-only (directory prefix only)', () => {
    // A top-level file literally named `docs` (no extension) is not the
    // `docs/` tree; only the directory prefix counts.
    expect(isDocsOnlyPaths(['docs'])).toBe(false);
    expect(isDocsOnlyPaths(['docs', 'docs/guide.md'])).toBe(false);
    expect(isDocsOnlyPaths(['docs/guide.md'])).toBe(true);
  });

  it('never treats an empty list as docs-only', () => {
    expect(isDocsOnlyPaths([])).toBe(false);
  });
});

describe('mapDiffRiskSignalsToLevel (escalation-only asymmetry)', () => {
  it('confident yes on either noul is high — even with siblings missing', () => {
    expect(mapDiffRiskSignalsToLevel({ noul: 0.95, confidence: 0.9 }, undefined, undefined)).toBe(
      'high',
    );
    expect(mapDiffRiskSignalsToLevel(undefined, { noul: 0.97, confidence: 0.85 }, undefined)).toBe(
      'high',
    );
  });

  it('confident blast-radius above 0.7 is high', () => {
    expect(
      mapDiffRiskSignalsToLevel(
        { noul: 0.05, confidence: 0.9 },
        { noul: 0.05, confidence: 0.9 },
        { score: 0.71, confidence: 0.9 },
      ),
    ).toBe('high');
  });

  it('low requires all three confident and negative', () => {
    expect(
      mapDiffRiskSignalsToLevel(
        { noul: 0.05, confidence: 0.9 },
        { noul: 0.05, confidence: 0.9 },
        { score: 0.3, confidence: 0.9 },
      ),
    ).toBe('low');
  });

  it('risk thresholds are dedicated bindings with strict > / <= boundary semantics', () => {
    // Decoupled from the Module 1 validity thresholds by design: tuning
    // validity must never silently retune risk escalation. Initial defaults
    // match numerically, but the bindings evolve independently.
    expect(JEV_RISK_HIGH_THRESHOLD).toBe(0.7);
    expect(JEV_RISK_LOW_THRESHOLD).toBe(0.3);
    const confidentNo = { noul: 0.05, confidence: 0.9 };
    const blast = (score: number) => ({ score, confidence: 0.9 });
    // Mapping truth table (defaults): high only strictly above 0.7, low at
    // or below 0.3, everything in between stays unknown (fail-open).
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.9))).toBe('high');
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.71))).toBe('high');
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.7))).toBe('unknown');
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.5))).toBe('unknown');
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.31))).toBe('unknown');
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.3))).toBe('low');
    expect(mapDiffRiskSignalsToLevel(confidentNo, confidentNo, blast(0.1))).toBe('low');
  });

  it('noul verdicts share the dedicated risk bindings (strict > 0.7 / <= 0.3)', () => {
    const confident = (noul: number) => ({ noul, confidence: 0.9 });
    // Yes means confidently ABOVE the high binding (strict, mirroring blast).
    expect(mapDiffRiskSignalsToLevel(confident(0.95), undefined, undefined)).toBe('high');
    expect(mapDiffRiskSignalsToLevel(confident(0.71), undefined, undefined)).toBe('high');
    expect(mapDiffRiskSignalsToLevel(confident(0.7), undefined, undefined)).toBe('unknown');
    // No means confidently AT/BELOW the low binding (mirroring blast).
    expect(
      mapDiffRiskSignalsToLevel(confident(0.05), confident(0.05), { score: 0.1, confidence: 0.9 }),
    ).toBe('low');
    expect(
      mapDiffRiskSignalsToLevel(confident(0.3), confident(0.3), { score: 0.1, confidence: 0.9 }),
    ).toBe('low');
    expect(
      mapDiffRiskSignalsToLevel(confident(0.31), confident(0.05), { score: 0.1, confidence: 0.9 }),
    ).toBe('unknown');
  });

  it('low-confidence or missing signals degrade to unknown (fail-open)', () => {
    // Low-confidence yes must NOT escalate.
    expect(mapDiffRiskSignalsToLevel({ noul: 0.95, confidence: 0.5 }, undefined, undefined)).toBe(
      'unknown',
    );
    // A missing blast-radius must NOT allow a low verdict.
    expect(
      mapDiffRiskSignalsToLevel(
        { noul: 0.05, confidence: 0.9 },
        { noul: 0.05, confidence: 0.9 },
        undefined,
      ),
    ).toBe('unknown');
    // Borderline blast-radius (above the low bar, below the high bar) is unknown.
    expect(
      mapDiffRiskSignalsToLevel(
        { noul: 0.05, confidence: 0.9 },
        { noul: 0.05, confidence: 0.9 },
        { score: 0.5, confidence: 0.9 },
      ),
    ).toBe('unknown');
  });
});

describe('buildDiffRiskContext (bounded, sanitize-before-truncate)', () => {
  it('caps the file list at JEV_RISK_MAX_FILES with a "+N more" tail', () => {
    expect(JEV_RISK_MAX_FILES).toBe(50);
    const filePaths = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
    const context = buildDiffRiskContext({
      statLine: '60 files changed, ~600 diff lines',
      filePaths,
      description: 'big PR',
    });

    expect(context).toContain('(+10 more)');
    expect(context).not.toContain('src/file-59.ts');
    expect(context).toContain('src/file-0.ts');
  });

  it('junk path entries do not inflate the "+N more" dropped count', () => {
    const valid = Array.from({ length: 55 }, (_, i) => `src/file-${i}.ts`);
    const junk = ['', '', null, undefined, 42, {}, []] as unknown as string[];
    const context = buildDiffRiskContext({
      statLine: 'stat',
      filePaths: [...valid, ...junk],
      description: 'junk paths',
    });

    // 55 valid entries capped to 50 → 5 dropped; the 7 junk entries are
    // filtered before the count, so the tail must read +5, not +12.
    expect(context).toContain('(+5 more)');
    expect(context).not.toContain('(+12 more)');
    // The Files (N) count must use the valid-entry list too, not the raw
    // list length (which would read 62 with the junk included).
    expect(context).toContain('Files (55):');
    expect(context).not.toContain('Files (62):');
  });

  it('filters whitespace-only path entries (matching isDocsOnlyPath trim semantics)', () => {
    const context = buildDiffRiskContext({
      statLine: 'stat',
      filePaths: ['   ', '\t\n ', 'src/a.ts'],
      description: 'desc',
    });

    // Only the real path survives filtering.
    expect(context).toContain('Files (1):');
    expect(context).toContain('src/a.ts');
  });

  it('truncates the description and redacts secret-shaped text pre-send', () => {
    expect(JEV_RISK_MAX_DESC_CHARS).toBe(2000);
    // NOTE: AWS's published documentation example placeholder (EXAMPLE key
    // material, not a real credential), assembled via concatenation so no
    // literal credential-shaped token appears in source.
    const exampleId = `${'AK' + 'IA'}IOSFODNN7${'EXAM' + 'PLE'}`;
    const marker = 'SENTINEL-BEYOND-DESC-CAP';
    const description = `key ${exampleId} ` + 'x'.repeat(3000) + marker;
    const context = buildDiffRiskContext({ statLine: 'stat', filePaths: ['a.ts'], description });

    expect(context).not.toContain(exampleId);
    expect(context).not.toContain(marker);
  });

  it('caps the stat line at JEV_RISK_MAX_STAT_CHARS', () => {
    expect(JEV_RISK_MAX_STAT_CHARS).toBe(500);
    const marker = 'SENTINEL-BEYOND-STAT-CAP';
    const context = buildDiffRiskContext({
      statLine: 'x'.repeat(600) + marker,
      filePaths: ['a.ts'],
      description: 'desc',
    });

    expect(context).not.toContain(marker);
  });
});

describe('assessJevDiffRiskGate', () => {
  it('empty diff fails open with no HTTP traffic', async () => {
    enableJev();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await assessJevDiffRiskGate(
      { deterministic: 'summary', totalDiffLines: 0, filePaths: [] },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      budgetMode: 'summary',
      suggestLite: false,
      level: 'unknown',
      reason: 'empty-diff',
      skipped: true,
    });
    expect(called).toBe(false);
  });

  it('junk-only paths fail open as an empty diff with no HTTP traffic', async () => {
    enableJev();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await assessJevDiffRiskGate(
      {
        deterministic: 'split',
        totalDiffLines: 0,
        filePaths: ['', '', null, undefined, 42] as unknown as string[],
      },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      budgetMode: 'split',
      suggestLite: false,
      level: 'unknown',
      reason: 'empty-diff',
      skipped: true,
    });
    expect(called).toBe(false);
  });

  it('whitespace-only paths fail open as an empty diff with no HTTP traffic', async () => {
    enableJev();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await assessJevDiffRiskGate(
      {
        deterministic: 'summary',
        totalDiffLines: 0,
        filePaths: ['   ', '\t', '\n '],
      },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      budgetMode: 'summary',
      suggestLite: false,
      level: 'unknown',
      reason: 'empty-diff',
      skipped: true,
    });
    expect(called).toBe(false);
  });

  it('disabled no-op: deterministic mode unchanged with no HTTP traffic', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await assessJevDiffRiskGate(
      { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      budgetMode: 'summary',
      suggestLite: false,
      level: 'unknown',
      reason: 'jev-disabled',
      skipped: true,
    });
    expect(called).toBe(false);
  });

  it('high risk escalates summary → full in a single batched call', async () => {
    enableJev();
    let callCount = 0;
    let questionCount = 0;
    const fetchImpl = riskFetch(HIGH_RISK.auth, HIGH_RISK.destructive, HIGH_RISK.blast, (init) => {
      callCount++;
      questionCount = Object.keys(
        (JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions,
      ).length;
    });

    const result = await assessJevDiffRiskGate(
      {
        deterministic: 'summary',
        totalDiffLines: 600,
        filePaths: ['src/auth.ts'],
        title: 'rotate tokens',
        body: 'touches login',
      },
      { fetchImpl },
    );

    expect(callCount).toBe(1);
    expect(questionCount).toBe(3);
    expect(result).toMatchObject({
      budgetMode: 'full',
      suggestLite: false,
      level: 'high',
      reason: 'ok',
      skipped: false,
    });
  });

  it('posts one call with the diff summary as state and three map questions', async () => {
    enableJev();
    let capturedBody = '';
    const fetchImpl = riskFetch(HIGH_RISK.auth, HIGH_RISK.destructive, HIGH_RISK.blast, (init) => {
      capturedBody = String(init?.body);
    });

    await assessJevDiffRiskGate(
      {
        deterministic: 'summary',
        totalDiffLines: 600,
        filePaths: ['src/auth.ts'],
        title: 'rotate tokens',
        body: 'touches login',
      },
      { fetchImpl },
    );

    const body = JSON.parse(capturedBody) as {
      model: string;
      state: string;
      questions: Record<string, Record<string, unknown>>;
    };
    expect(body.model).toBe('jev-1.13-free');
    // Shared state carries the diff summary (stat + files + description).
    expect(body.state).toContain('src/auth.ts');
    expect(body.state).toContain('rotate tokens');
    // Three questions as a map: two noul + one score, instructions only.
    expect(Object.keys(body.questions)).toEqual([
      'risk-auth-migration-secrets',
      'risk-destructive-migration',
      'risk-blast-radius',
    ]);
    expect(body.questions['risk-auth-migration-secrets']).toMatchObject({ type: 'noul' });
    expect(body.questions['risk-destructive-migration']).toMatchObject({ type: 'noul' });
    expect(body.questions['risk-blast-radius']).toMatchObject({ type: 'score' });
    for (const entry of Object.values(body.questions)) {
      expect(typeof entry.instructions).toBe('string');
      expect(entry).not.toHaveProperty('question');
      expect(entry).not.toHaveProperty('context');
      expect(entry).not.toHaveProperty('id');
    }
    // Noul criteria is the optional { true, false } object; score criteria
    // is an ordered level array (2 levels keep the score in 0..1).
    expect(body.questions['risk-auth-migration-secrets'].criteria).toMatchObject({
      true: expect.any(String),
      false: expect.any(String),
    });
    expect(body.questions['risk-blast-radius'].criteria).toHaveLength(2);
  });

  it('high risk never suggests lite (critical signals never suppress review)', async () => {
    enableJev();
    const result = await assessJevDiffRiskGate(
      {
        deterministic: 'full',
        totalDiffLines: 10,
        filePaths: ['README.md'],
        title: 'docs',
        body: 'docs',
      },
      {
        fetchImpl: riskFetch(
          { noul: 0.05, confidence: 0.95 },
          { noul: 0.95, confidence: 0.95 },
          { score: 0.9, confidence: 0.95 },
        ),
      },
    );

    expect(result.budgetMode).toBe('full');
    expect(result.suggestLite).toBe(false);
    expect(result.level).toBe('high');
  });

  it('docs-only + low risk suggests lite without changing the mode', async () => {
    enableJev();
    const result = await assessJevDiffRiskGate(
      {
        deterministic: 'full',
        totalDiffLines: 40,
        filePaths: ['README.md', 'docs/guide.md'],
        title: 'docs',
        body: 'typo fixes',
      },
      { fetchImpl: riskFetch(LOW_RISK.auth, LOW_RISK.destructive, LOW_RISK.blast) },
    );

    expect(result).toMatchObject({
      budgetMode: 'full',
      suggestLite: true,
      level: 'low',
      skipped: false,
    });
  });

  it('low risk on a non-docs PR changes nothing', async () => {
    enableJev();
    const result = await assessJevDiffRiskGate(
      {
        deterministic: 'summary',
        totalDiffLines: 600,
        filePaths: ['src/a.ts'],
        title: 'refactor',
        body: 'cleanup',
      },
      { fetchImpl: riskFetch(LOW_RISK.auth, LOW_RISK.destructive, LOW_RISK.blast) },
    );

    expect(result).toMatchObject({ budgetMode: 'summary', suggestLite: false, level: 'low' });
  });

  it('unavailable Jev falls back to deterministic (fail-open)', async () => {
    enableJev();
    const failingFetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;

    const result = await assessJevDiffRiskGate(
      { deterministic: 'split', totalDiffLines: 1500, filePaths: ['src/a.ts'] },
      { fetchImpl: failingFetch },
    );

    expect(result).toMatchObject({ budgetMode: 'split', suggestLite: false, skipped: true });
  });

  it('low-confidence answers fall back to deterministic (fail-open)', async () => {
    enableJev();
    const result = await assessJevDiffRiskGate(
      { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
      {
        fetchImpl: riskFetch(
          { noul: 0.95, confidence: 0.4 },
          { noul: 0.05, confidence: 0.4 },
          { score: 0.9, confidence: 0.3 },
        ),
      },
    );

    expect(result).toMatchObject({
      budgetMode: 'summary',
      suggestLite: false,
      level: 'unknown',
      skipped: false,
    });
  });

  it('throwing provider falls back to deterministic (fail-open)', async () => {
    enableJev();
    const throwingProvider = {
      assessRisk: async () => {
        throw new Error('provider blew up');
      },
    };

    const result = await assessJevDiffRiskGate(
      { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
      { provider: throwingProvider },
    );

    expect(result).toMatchObject({ budgetMode: 'summary', suggestLite: false, skipped: true });
  });

  it('aborted signal rejects (no fail-open swallow)', async () => {
    enableJev();
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await expect(
      assessJevDiffRiskGate(
        { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
        { fetchImpl, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('swallowing provider still rejects when the signal aborted (post-call check)', async () => {
    enableJev();
    const controller = new AbortController();
    controller.abort();
    const swallowingProvider = {
      assessRisk: async () => ({
        level: 'high' as const,
        reason: 'ok',
        unavailable: false,
      }),
    };

    await expect(
      assessJevDiffRiskGate(
        { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
        { provider: swallowingProvider, signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('provider abort without a gate-level signal still rejects (no fail-open swallow)', async () => {
    enableJev();
    const abortingProvider = {
      assessRisk: async () => {
        throw new DOMException('provider aborted', 'AbortError');
      },
    };

    await expect(
      assessJevDiffRiskGate(
        { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
        { provider: abortingProvider },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fetch-level abort without a signal rejects (no fail-open swallow)', async () => {
    enableJev();
    const abortingFetch = (async () => {
      throw new DOMException('fetch aborted', 'AbortError');
    }) as typeof fetch;

    await expect(
      assessJevDiffRiskGate(
        { deterministic: 'summary', totalDiffLines: 600, filePaths: ['src/a.ts'] },
        { fetchImpl: abortingFetch },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

type RunLLMResult = Awaited<ReturnType<typeof runOpenCode>>;

function makeGateConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    review: {
      ...DEFAULT_CONFIG.review,
      reviewBudget: { enabled: true, summaryThreshold: 500, splitThreshold: 1000 },
      enableCodebaseIndex: false,
      enableReachability: false,
      enableMetaVerification: false,
      enableTestGapDetection: false,
      includePreExisting: true,
    },
  };
}

function makeFile(path: string, lines: number): ChangedFile {
  return {
    path,
    status: 'modified',
    additions: lines,
    deletions: 0,
    patch: '@@ -1,1 +1,1 @@\n-old\n+new',
  };
}

function makeGatePR(files: ChangedFile[]): PRContext {
  return {
    number: 7,
    title: 'gate wiring PR',
    body: 'exercises the diff-risk gate',
    headRef: 'feature',
    headSha: '0'.repeat(40),
    baseRef: 'main',
    author: 'tester',
    labels: [],
    changedFiles: files,
  };
}

describe('engine diff-risk gate wiring', () => {
  it('disabled: deterministic summary mode reaches the prompt unchanged', async () => {
    const adapter = {} as unknown as PlatformAdapter;
    const engine = new ReviewEngine(makeGateConfig(), adapter);
    const runLLM = vi
      .spyOn(engine as unknown as { runLLM: () => Promise<RunLLMResult> }, 'runLLM' as never)
      .mockResolvedValue({
        success: true,
        output: '',
        durationMs: 5,
        tokensUsed: 10,
      } as RunLLMResult);
    const workDir = await os.tmpdir();

    await engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
      workingDirectory: workDir,
    });

    expect(runLLM).toHaveBeenCalled();
    const prompt = String(runLLM.mock.calls[0][0]);
    expect(prompt).toContain('Review Budget Mode: SUMMARY');
  });

  it('enabled high-risk: summary PR is escalated to full (no budget banner)', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    vi.stubGlobal('fetch', riskFetch(HIGH_RISK.auth, HIGH_RISK.destructive, HIGH_RISK.blast));
    const adapter = {} as unknown as PlatformAdapter;
    const engine = new ReviewEngine(makeGateConfig(), adapter);
    const runLLM = vi
      .spyOn(engine as unknown as { runLLM: () => Promise<RunLLMResult> }, 'runLLM' as never)
      .mockResolvedValue({
        success: true,
        output: '',
        durationMs: 5,
        tokensUsed: 10,
      } as RunLLMResult);
    const workDir = await os.tmpdir();

    await engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
      workingDirectory: workDir,
    });

    expect(runLLM).toHaveBeenCalled();
    const prompt = String(runLLM.mock.calls[0][0]);
    expect(prompt).not.toContain('Review Budget Mode');
  });

  it('enabled but unavailable: deterministic summary mode is kept (fail-open)', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    vi.stubGlobal('fetch', (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch);
    const adapter = {} as unknown as PlatformAdapter;
    const engine = new ReviewEngine(makeGateConfig(), adapter);
    const runLLM = vi
      .spyOn(engine as unknown as { runLLM: () => Promise<RunLLMResult> }, 'runLLM' as never)
      .mockResolvedValue({
        success: true,
        output: '',
        durationMs: 5,
        tokensUsed: 10,
      } as RunLLMResult);
    const workDir = await os.tmpdir();

    await engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
      workingDirectory: workDir,
    });

    expect(runLLM).toHaveBeenCalled();
    const prompt = String(runLLM.mock.calls[0][0]);
    expect(prompt).toContain('Review Budget Mode: SUMMARY');
  });
});
