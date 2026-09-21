import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewEngine } from '../src/engine.js';
import type { runOpenCode } from '../src/opencode.js';
import type { PlatformAdapter } from '../src/platform/adapter.js';
import {
  type DiffRiskGateResult,
  JEV_DIFF_RISK_GATE_TIMEOUT_CAP_MS,
  assessJevDiffRiskGate,
} from '../src/review/jev-diff-risk.js';
import type { AgentConfig, ChangedFile, PRContext } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import type { Logger } from '../src/utils/logger.js';

const { mockGate } = vi.hoisted(() => ({ mockGate: vi.fn() }));

// Mock only the gate entry point: every other jev-diff-risk export
// (resolveJevBudgetMode, isDocsOnlyPaths, the timeout cap) stays real so
// these tests assert the engine's wiring against true gate constants.
vi.mock('../src/review/jev-diff-risk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/review/jev-diff-risk.js')>();
  return { ...actual, assessJevDiffRiskGate: mockGate };
});

const ENV_KEYS = ['JEV_ENABLED', 'JEV_MODEL', 'JEV_TIMEOUT_MS', 'OPENCODE_API_KEY'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockGate.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  vi.restoreAllMocks();
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

function stubRunLLM(engine: ReviewEngine): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(engine as unknown as { runLLM: () => Promise<RunLLMResult> }, 'runLLM' as never)
    .mockResolvedValue({
      success: true,
      output: '',
      durationMs: 5,
      tokensUsed: 10,
    } as RunLLMResult);
}

function engineLogger(engine: ReviewEngine): Logger {
  return (engine as unknown as { logger: Logger }).logger;
}

describe('engine diff-risk gate: bounded timeout (finding 1)', () => {
  it('caps the gate timeout even when JEV_TIMEOUT_MS is maxed', async () => {
    expect(JEV_DIFF_RISK_GATE_TIMEOUT_CAP_MS).toBe(2000);
    process.env.JEV_TIMEOUT_MS = '10000';
    mockGate.mockResolvedValue({
      budgetMode: 'summary',
      suggestLite: false,
      level: 'unknown',
      reason: 'jev-unavailable',
      skipped: true,
    } satisfies DiffRiskGateResult);

    const engine = new ReviewEngine(makeGateConfig(), {} as unknown as PlatformAdapter);
    const runLLM = stubRunLLM(engine);
    await engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
      workingDirectory: await os.tmpdir(),
    });

    expect(mockGate).toHaveBeenCalledTimes(1);
    const gateOptions = vi.mocked(assessJevDiffRiskGate).mock.calls[0][1] ?? {};
    // Bounded by the gate cap, not the (maxed) env timeout.
    expect(gateOptions.timeoutMs).toBe(JEV_DIFF_RISK_GATE_TIMEOUT_CAP_MS);
    expect(gateOptions.timeoutMs).toBeLessThanOrEqual(2000);
    expect(runLLM).toHaveBeenCalled();
  });

  it('uses the (lower) resolved timeout when JEV_TIMEOUT_MS is unset', async () => {
    mockGate.mockResolvedValue({
      budgetMode: 'summary',
      suggestLite: false,
      level: 'unknown',
      reason: 'jev-disabled',
      skipped: true,
    } satisfies DiffRiskGateResult);

    const engine = new ReviewEngine(makeGateConfig(), {} as unknown as PlatformAdapter);
    stubRunLLM(engine);
    await engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
      workingDirectory: await os.tmpdir(),
    });

    expect(mockGate).toHaveBeenCalledTimes(1);
    const gateOptions = vi.mocked(assessJevDiffRiskGate).mock.calls[0][1] ?? {};
    // Default resolveJevTimeoutMs() (1500) sits below the cap and passes through.
    expect(gateOptions.timeoutMs).toBe(1500);
  });
});

describe('engine diff-risk gate: abort propagation (finding 2)', () => {
  it('aborted gate rejects → propagates instead of fail-open continue', async () => {
    mockGate.mockRejectedValueOnce(new DOMException('gate aborted', 'AbortError'));

    const engine = new ReviewEngine(makeGateConfig(), {} as unknown as PlatformAdapter);
    const runLLM = stubRunLLM(engine);

    await expect(
      engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
        workingDirectory: await os.tmpdir(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // The review never proceeds to the LLM pass once cancelled.
    expect(runLLM).not.toHaveBeenCalled();
  });

  it('non-cancel gate failures still fail open', async () => {
    mockGate.mockRejectedValueOnce(new Error('jev exploded'));

    const engine = new ReviewEngine(makeGateConfig(), {} as unknown as PlatformAdapter);
    const runLLM = stubRunLLM(engine);

    await engine.reviewPR(makeGatePR([makeFile('src/a.ts', 300), makeFile('src/b.ts', 300)]), {
      workingDirectory: await os.tmpdir(),
    });

    expect(runLLM).toHaveBeenCalled();
    const prompt = String(runLLM.mock.calls[0][0]);
    expect(prompt).toContain('Review Budget Mode: SUMMARY');
  });
});

describe('engine diff-risk gate: advisory lite suggestion (finding 4)', () => {
  it('logs suggestLite explicitly and leaves the mode unchanged', async () => {
    mockGate.mockResolvedValue({
      budgetMode: 'summary',
      suggestLite: true,
      level: 'low',
      reason: 'ok',
      skipped: false,
    } satisfies DiffRiskGateResult);

    const engine = new ReviewEngine(makeGateConfig(), {} as unknown as PlatformAdapter);
    const debugSpy = vi.spyOn(engineLogger(engine), 'debug');
    const runLLM = stubRunLLM(engine);

    // Docs-only PR sized into the deterministic summary band: the advisory
    // lite suggestion must not change the mode the review runs at.
    await engine.reviewPR(
      makeGatePR([makeFile('README.md', 300), makeFile('docs/guide.md', 300)]),
      {
        workingDirectory: await os.tmpdir(),
      },
    );

    expect(runLLM).toHaveBeenCalled();
    const prompt = String(runLLM.mock.calls[0][0]);
    expect(prompt).toContain('Review Budget Mode: SUMMARY');
    expect(debugSpy).toHaveBeenCalledWith(
      'Jev diff-risk gate suggests lite review (advisory only)',
    );
  });
});
