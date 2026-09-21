import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewEngine } from '../src/engine.js';
import type { runOpenCode } from '../src/opencode.js';
import type { PlatformAdapter } from '../src/platform/adapter.js';
import type { AgentConfig, ReviewIssue, ReviewResult } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { computeReviewStats } from '../src/utils/filter-findings.js';

const { mockPrefilter } = vi.hoisted(() => ({ mockPrefilter: vi.fn() }));

// Mock only the pre-filter entry point: every other jev-client export
// (thresholds, resolvers, circuit reset) stays real so these tests exercise
// the true client unless a test overrides the mock per-case.
vi.mock('../src/utils/jev-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/jev-client.js')>();
  return { ...actual, prefilterVerificationIssues: mockPrefilter };
});

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

type RunLLMResult = Awaited<ReturnType<typeof runOpenCode>>;

interface EngineTestSeam {
  runLLM: (prompt: string, options: Record<string, unknown>) => Promise<RunLLMResult>;
  verifyReviewResult: (
    result: ReviewResult,
    prContext: string,
    workDir: string,
    timeoutMinutes?: number,
    prNumber?: number,
  ) => Promise<ReviewResult>;
}

const ENV_KEYS = ['JEV_ENABLED', 'JEV_MODEL', 'OPENCODE_API_KEY'] as const;

let savedEnv: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;
let runLLMSpy: ReturnType<typeof vi.spyOn>;

function makeJevConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    review: {
      ...DEFAULT_CONFIG.review,
      enableMetaVerification: true,
      enableReachability: false,
    },
  };
}

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    type: 'issue',
    severity: 'minor',
    file: 'src/a.ts',
    line: 1,
    message: 'suspicious code',
    ...overrides,
  };
}

function makeResult(issues: ReviewIssue[]): ReviewResult {
  return {
    summary: 'review',
    verdict: { ready: true, reasoning: 'ok', autoFixable: false, confidence: 'high' },
    strengths: [],
    issues,
    stats: computeReviewStats(issues),
    rawLines: [],
    failedLines: 0,
  };
}

/**
 * The downstream sensitivity filter stamps `category: 'general'` on every
 * finding, so expected issue lists must include it.
 *
 * @param issues - Findings entering verification.
 * @returns The same findings with the downstream enrichment applied.
 */
function withDownstreamEnrichment(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.map((issue) => ({ ...issue, category: 'general' }));
}

/**
 * Build a Jev Score fetch stub answering from a per-index plan.
 *
 * @param plan - Validity score/confidence per finding index.
 * @param onRequest - Optional hook observing the raw request init.
 * @returns A fetch-compatible stub answering `{ answers }`.
 */
function jevFetch(
  plan: Array<{ score: number; confidence: number }>,
  onRequest?: (init?: RequestInit) => void,
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(init);
    return new Response(
      JSON.stringify({
        model: 'jev-1.13-free',
        answers: plan.map((entry, i) => ({
          id: `validity-${i}`,
          score: entry.score,
          confidence: entry.confidence,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Default: delegate to the REAL pre-filter so tests exercise the true
  // client + stubbed global fetch unless they override the mock per-case.
  const actual = await vi.importActual<typeof import('../src/utils/jev-client.js')>(
    '../src/utils/jev-client.js',
  );
  mockPrefilter.mockReset();
  mockPrefilter.mockImplementation(actual.prefilterVerificationIssues);
  const { resetJevCircuitBreaker } = actual;
  resetJevCircuitBreaker();

  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  runLLMSpy = vi.spyOn(
    ReviewEngine.prototype as unknown as EngineTestSeam,
    'runLLM' as never,
  ) as unknown as ReturnType<typeof vi.spyOn>;
  runLLMSpy.mockResolvedValue({
    success: true,
    output: '',
    durationMs: 5,
    tokensUsed: 10,
  } as RunLLMResult);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeEngine(): { engine: ReviewEngine; seam: EngineTestSeam } {
  const adapter = {} as unknown as PlatformAdapter;
  const engine = new ReviewEngine(makeJevConfig(), adapter);
  return { engine, seam: engine as unknown as EngineTestSeam };
}

describe('engine Jev verification pre-filter', () => {
  it('disabled no-op: preserves issues + stats, performs no fetch, still verifies', async () => {
    const issues = [makeIssue({ severity: 'important' }), makeIssue({ severity: 'minor' })];
    const { seam } = makeEngine();
    fetchMock.mockImplementation(async () => {
      throw new Error('fetch must not be called while disabled');
    });

    const result = await seam.verifyReviewResult(makeResult(issues), 'pr context', os.tmpdir());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPrefilter).toHaveBeenCalledTimes(1);
    expect(runLLMSpy).toHaveBeenCalledTimes(1);
    expect(result.issues).toEqual(withDownstreamEnrichment(issues));
    expect(result.stats).toEqual(computeReviewStats(issues));
  });

  it('enabled drop: removes obvious FPs and recomputes stats via computeReviewStats', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    const issues = [
      makeIssue({ severity: 'minor', message: 'likely FP' }),
      makeIssue({ severity: 'important', message: 'real bug', file: 'src/b.ts', line: 9 }),
      makeIssue({ severity: 'critical', message: 'RCE sink', file: 'src/c.ts', line: 3 }),
    ];
    vi.stubGlobal(
      'fetch',
      jevFetch([
        { score: 0.1, confidence: 0.95 },
        { score: 0.9, confidence: 0.95 },
        // Critical scored 0 with full confidence: still kept (never auto-drop).
        { score: 0.0, confidence: 1.0 },
      ]),
    );
    const { seam } = makeEngine();

    const result = await seam.verifyReviewResult(makeResult(issues), 'pr context', os.tmpdir());

    expect(result.issues).toEqual(withDownstreamEnrichment([issues[1], issues[2]]));
    expect(result.stats).toEqual(computeReviewStats([issues[1], issues[2]]));
    expect(runLLMSpy).toHaveBeenCalledTimes(1);
  });

  it('all-dropped: skips the verification LLM guard', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    const issues = [makeIssue({}), makeIssue({ file: 'src/b.ts', line: 2 })];
    vi.stubGlobal(
      'fetch',
      jevFetch([
        { score: 0.05, confidence: 0.99 },
        { score: 0.1, confidence: 0.9 },
      ]),
    );
    const { seam } = makeEngine();

    const result = await seam.verifyReviewResult(makeResult(issues), 'pr context', os.tmpdir());

    expect(result.issues).toEqual([]);
    expect(result.stats).toEqual(computeReviewStats([]));
    expect(runLLMSpy).not.toHaveBeenCalled();
  });

  it('throw-in-prefilter: engine try/catch still runs verification', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    mockPrefilter.mockRejectedValueOnce(new Error('boom'));
    const issues = [makeIssue({ severity: 'important' })];
    const { seam } = makeEngine();

    const result = await seam.verifyReviewResult(makeResult(issues), 'pr context', os.tmpdir());

    expect(runLLMSpy).toHaveBeenCalledTimes(1);
    expect(result.issues).toEqual(withDownstreamEnrichment(issues));
  });

  it('rescues critical findings even if the provider drops them (engine safety net)', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    const critical = makeIssue({ severity: 'critical', message: 'RCE sink' });
    const minor = makeIssue({ severity: 'minor', message: 'nit' });
    // Simulate a regressed provider that drops a critical: the engine layer
    // must restore it in original order and still verify the remainder.
    mockPrefilter.mockResolvedValueOnce({
      kept: [],
      dropped: [critical, minor],
      skipped: false,
      reason: 'ok',
      model: 'jev-1.13-free',
    });
    const { seam } = makeEngine();

    const result = await seam.verifyReviewResult(
      makeResult([critical, minor]),
      'pr context',
      os.tmpdir(),
    );

    expect(result.issues).toEqual(withDownstreamEnrichment([critical]));
    expect(result.stats).toEqual(computeReviewStats([critical]));
    expect(runLLMSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates the JEV_MODEL pin to the Jev request', async () => {
    process.env.JEV_ENABLED = 'true';
    process.env.OPENCODE_API_KEY = 'test-key';
    process.env.JEV_MODEL = 'jev-1.13';
    let requestModel: string | undefined;
    vi.stubGlobal(
      'fetch',
      jevFetch([{ score: 0.9, confidence: 0.95 }], (init) => {
        const body = JSON.parse(String(init?.body)) as { model?: string };
        requestModel = body.model;
      }),
    );
    const { seam } = makeEngine();

    const result = await seam.verifyReviewResult(
      makeResult([makeIssue({})]),
      'pr context',
      os.tmpdir(),
    );

    expect(requestModel).toBe('jev-1.13');
    expect(result.issues).toHaveLength(1);
    expect(runLLMSpy).toHaveBeenCalledTimes(1);
  });
});
