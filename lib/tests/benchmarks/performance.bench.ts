import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, bench, describe, vi } from 'vitest';
import { INTER_CHUNK_DELAY_MS, MAX_BATCH_CONCURRENCY, ReviewEngine } from '../../src/engine.js';
import { parseJsonlFile, parseJsonlString } from '../../src/jsonl-parser.js';
import type { PlatformAdapter } from '../../src/platform/adapter.js';
import { buildAuditPrompt, buildFixPrompt, buildReviewPrompt } from '../../src/prompts/builder.js';
import { type AgentConfig, DEFAULT_CONFIG, type PRContext } from '../../src/types/index.js';
import {
  generateIssues,
  generateJsonlFixture,
  generatePRContextFixture,
} from './generate-fixtures.js';
import { type BenchMetrics, dropMetrics, writeMetrics } from './metrics.js';

const BATCH_SIZE = 3;
const JSONL_LINE_COUNTS = [10, 100, 500, 2000] as const;
const PR_FILE_COUNTS = [1, 5, 25, 100] as const;
const FIX_ISSUE_COUNTS = [0, 10, 50] as const;
const E2E_FILE_COUNTS = [1, 5, 25] as const;

const VALID_REVIEW_JSONL = [
  '{"type":"summary","text":"Benchmark review summary."}',
  '{"type":"verdict","ready":true,"reasoning":"ok","autoFixable":false,"confidence":"high"}',
].join('\n');

const { mockRunOpenCode } = vi.hoisted(() => {
  const _mockRunOpenCode = vi.fn();
  return { mockRunOpenCode: _mockRunOpenCode };
});

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/opencode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/opencode.js')>();
  return {
    ...actual,
    runOpenCode: mockRunOpenCode,
  };
});

const jsonlFixtures = Object.fromEntries(
  JSONL_LINE_COUNTS.map((n) => [n, generateJsonlFixture(n)]),
) as Record<number, string>;

const prFixtures = Object.fromEntries(
  PR_FILE_COUNTS.map((n) => [n, generatePRContextFixture(n)]),
) as Record<number, PRContext>;

const fixIssueFixtures = Object.fromEntries(
  FIX_ISSUE_COUNTS.map((n) => [n, generateIssues(n)]),
) as Record<number, ReturnType<typeof generateIssues>>;

function makeBenchmarkConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    enableMCP: false,
    batchSize: BATCH_SIZE,
    maxLinesPerFile: 200,
    review: {
      ...DEFAULT_CONFIG.review,
      enableReachability: false,
      enableMetaVerification: false,
    },
  };
}

function makeBenchmarkAdapter(): PlatformAdapter {
  return {
    getMR: async () => generatePRContextFixture(1),
    isMR: async () => true,
    getDefaultBranch: async () => 'main',
    getIssue: async () => ({
      number: 1,
      title: 'Synthetic issue',
      body: '',
      labels: [],
      comments: [],
    }),
    getIssueComments: async () => [],
    getDiffLines: async () => new Set<string>(),
    getDiffSince: async () => '',
    listReviewComments: async () => [],
    createReviewCommentReply: async () => {},
    listComments: async () => [],
    postComment: async () => {},
    postReview: async () => ({ success: true, method: 'full' }),
    postOrUpdateComment: async () => ({ action: 'created', commentId: 1 }),
    createComment: async () => ({ id: 1 }),
    replyToReviewComment: async () => ({ id: 1 }),
    getReviewComment: async () => ({
      id: 1,
      body: '',
      user: { login: 'benchmark-bot', type: 'Bot' },
    }),
    getReviewCommentThread: async () => ({
      comments: [],
      rootComment: { id: 0, author: '', body: '', isBot: false },
      filePath: '',
    }),
    createIssue: async () => null,
    createPR: async () => null,
    addLabels: async () => {},
    removeLabel: async () => {},
    setLabels: async () => {},
    ensureLabels: async () => {},
    gatherContext: async () => '',
    closeOpenCodePRs: async () => {},
    mergeMR: async () => true,
    enableAutoMerge: async () => true,
    closeIssue: async () => {},
    getReviewThreads: async () => [],
    resolveReviewThread: async () => {},
    minimizeReviewComment: async () => {},
    getBotReviewThreads: async () => [],
    getOpenHumanThreads: async () => '',
    updateMR: async () => {},
    getCurrentUser: async () => 'benchmark-bot',
    paginate: async () => [],
  };
}

const engine = new ReviewEngine(makeBenchmarkConfig(), makeBenchmarkAdapter());

const contextCache = new Map<number, string>();
for (const n of PR_FILE_COUNTS) {
  contextCache.set(n, engine.buildPRContextString(prFixtures[n]).context);
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-bench-'));
const jsonlFile = path.join(tmpDir, 'output-500.jsonl');
writeFileSync(jsonlFile, jsonlFixtures[500], 'utf-8');

const e2eWorkDir = mkdtempSync(path.join(os.tmpdir(), 'opencode-engine-bench-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(e2eWorkDir, { recursive: true, force: true });
});

const metrics: BenchMetrics = { memory: [], apiCalls: [], e2eLatency: [] };
let maxHeapDelta = 0;

describe('JSONL parsing throughput', () => {
  for (const n of JSONL_LINE_COUNTS) {
    bench(`jsonl string parse ${n} lines`, () => {
      parseJsonlString(jsonlFixtures[n]);
    });
  }

  bench('jsonl file parse 500 lines', async () => {
    await parseJsonlFile(jsonlFile);
  });
});

describe('Prompt construction', () => {
  for (const n of PR_FILE_COUNTS) {
    bench(`buildReviewPrompt ${n} files`, () => {
      buildReviewPrompt({ projectContext: 'Benchmark project context' }, contextCache.get(n) ?? '');
    });
  }

  for (const n of FIX_ISSUE_COUNTS) {
    bench(`buildFixPrompt ${n} issues`, () => {
      buildFixPrompt(
        { projectContext: 'Benchmark project context' },
        'PR context',
        0,
        fixIssueFixtures[n],
      );
    });
  }

  bench('buildAuditPrompt', () => {
    buildAuditPrompt(
      { projectContext: 'Benchmark project context' },
      'Audit the codebase for security, performance, and resilience issues.',
      'src/',
      'security',
    );
  });
});

describe('PR context building', () => {
  for (const n of PR_FILE_COUNTS) {
    bench(`buildPRContextString ${n} files`, () => {
      engine.buildPRContextString(prFixtures[n]);
    });
  }
});

describe('Memory usage', () => {
  bench(
    'jsonl string parse heap delta (2000 lines)',
    () => {
      globalThis.gc?.();
      const before = process.memoryUsage().heapUsed;
      parseJsonlString(jsonlFixtures[2000]);
      const after = process.memoryUsage().heapUsed;
      const delta = Math.max(0, after - before);
      maxHeapDelta = Math.max(maxHeapDelta, delta);
      const name = 'jsonl-parse-2000-lines';
      metrics.memory = [...dropMetrics(metrics.memory, name), { name, value: maxHeapDelta }];
      writeMetrics(metrics);
    },
    { iterations: 5, time: 0 },
  );
});

describe('Engine orchestration overhead', () => {
  for (const n of E2E_FILE_COUNTS) {
    bench(
      `reviewPR ${n} files`,
      async () => {
        let calls = 0;
        const countingMock = async (_prompt: string, options: { workingDirectory?: string }) => {
          calls++;
          const cwd = options.workingDirectory || process.cwd();
          const outputPath = path.join(cwd, 'review-output.jsonl');
          mkdirSync(path.dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, VALID_REVIEW_JSONL, 'utf-8');
          return { success: true, output: '', durationMs: 10, tokensUsed: 5 };
        };
        mockRunOpenCode.mockImplementation(countingMock as typeof mockRunOpenCode);

        const pr = generatePRContextFixture(n);
        const start = performance.now();
        await engine.reviewPR(pr, undefined, undefined, undefined, 10, undefined, e2eWorkDir);
        const elapsed = performance.now() - start;

        const name = `reviewPR-${n}-files`;
        const batches = Math.ceil(n / BATCH_SIZE);
        const concurrencyLimit = Math.min(os.cpus().length, batches, MAX_BATCH_CONCURRENCY);
        const chunks = Math.ceil(batches / concurrencyLimit);
        const delays = Math.max(0, chunks - 1);
        const prevElapsed = metrics.e2eLatency.find((e) => e.name === name)?.value;
        const minElapsed = prevElapsed !== undefined ? Math.min(prevElapsed, elapsed) : elapsed;

        metrics.apiCalls = [
          ...dropMetrics(metrics.apiCalls, name),
          { name, value: calls, meta: { batches } },
        ];
        metrics.e2eLatency = [
          ...dropMetrics(metrics.e2eLatency, name),
          {
            name,
            value: Math.round(minElapsed),
            meta: { batches, delays, delayMs: INTER_CHUNK_DELAY_MS },
          },
        ];
        writeMetrics(metrics);
      },
      { iterations: 3, time: 0 },
    );
  }
});
