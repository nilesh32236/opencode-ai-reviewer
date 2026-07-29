import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, PRContext } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import {
  SAMPLE_BATCH_A_JSONL,
  SAMPLE_BATCH_B_JSONL,
  SAMPLE_SYNTHESIS_JSONL,
  SAMPLE_VALID_JSONL,
  SAMPLE_VERIFICATION_JSONL,
  makePRContext,
} from './helpers/mock-factories.js';

interface FixtureEntry {
  content: string | undefined;
  verification?: string;
  success?: boolean;
}

const fixtureQueue: FixtureEntry[] = [];

const { mockRunOpenCode, MockMCPManager } = vi.hoisted(() => {
  const _mockRunOpenCode = vi.fn();
  class _MockMCPManager {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    getLibraryDocs = vi.fn().mockResolvedValue('');
  }
  return { mockRunOpenCode: _mockRunOpenCode, MockMCPManager: _MockMCPManager };
});

vi.mock('../src/mcp/client.js', () => ({
  MCPManager: MockMCPManager,
}));

vi.mock('../src/opencode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/opencode.js')>();
  return {
    ...actual,
    runOpenCode: mockRunOpenCode,
    getGitStatus: vi.fn(() => ''),
  };
});

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { ReviewEngine } from '../src/engine.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    ...overrides,
  };
}

describe('Review Pipeline Integration', () => {
  let engine: ReviewEngine;
  let workDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  function setupFetchMock(): void {
    fetchMock = vi.fn();

    fetchMock.mockImplementation(async (url: string | URL | Request, _options?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      if (urlStr.includes('/user')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({ login: 'opencode-ai-reviewer[bot]' }),
          text: vi.fn().mockResolvedValue(JSON.stringify({ login: 'opencode-ai-reviewer[bot]' })),
        } as unknown as Response;
      }

      if (urlStr.includes('/graphql')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          }),
          text: vi.fn().mockResolvedValue('{}'),
        } as unknown as Response;
      }

      if (urlStr.includes('/pulls/')) {
        if (urlStr.includes('/files')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: vi.fn().mockResolvedValue([]),
            text: vi.fn().mockResolvedValue('[]'),
          } as unknown as Response;
        }

        if (urlStr.includes('/reviews')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: vi.fn().mockResolvedValue({ id: 1 }),
            text: vi.fn().mockResolvedValue(JSON.stringify({ id: 1 })),
          } as unknown as Response;
        }

        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({}),
          text: vi.fn().mockResolvedValue('{}'),
        } as unknown as Response;
      }

      if (urlStr.includes('/issues/')) {
        if (urlStr.includes('/comments')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: vi.fn().mockResolvedValue([]),
            text: vi.fn().mockResolvedValue('[]'),
          } as unknown as Response;
        }
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockResolvedValue('{}'),
      } as unknown as Response;
    });

    vi.stubGlobal('fetch', fetchMock);
  }

  function setupRunOpenCodeMock(): void {
    mockRunOpenCode.mockImplementation(
      async (_prompt: string, options: { model: string; workingDirectory?: string }) => {
        const fixture = fixtureQueue.shift() || { content: undefined, success: true };

        if (fixture.content !== undefined) {
          const cwd = options.workingDirectory || process.cwd();
          const reviewPath = path.join(cwd, 'review-output.jsonl');
          await fs.promises.mkdir(path.dirname(reviewPath), { recursive: true });
          await fs.promises.writeFile(reviewPath, fixture.content, 'utf-8');

          if (fixture.verification) {
            const verDir = path.join(cwd, '.opencode');
            await fs.promises.mkdir(verDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(verDir, 'verification-output.jsonl'),
              fixture.verification,
              'utf-8',
            );
          }
        }

        return {
          success: fixture.success !== false,
          output: '',
          durationMs: 1000,
          tokensUsed: 500,
        };
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fixtureQueue.length = 0;

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pipeline-'));
    process.chdir(workDir);

    setupFetchMock();
    setupRunOpenCodeMock();
  });

  afterEach(() => {
    process.chdir('/');
    fs.rmSync(workDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('a) successful full review flow (single batch)', async () => {
    engine = new ReviewEngine(
      makeConfig({ enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );
    const pr = makePRContext();

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
    expect(mockRunOpenCode).toHaveBeenCalledWith(
      expect.stringContaining(`PR #${pr.number}`),
      expect.objectContaining({ model: DEFAULT_CONFIG.reviewModel }),
    );
    expect(result.summary).toBe(
      'The PR implements JWT authentication middleware. Overall good structure with some security concerns.',
    );
    expect(result.verdict.ready).toBe(false);
    expect(result.verdict.reasoning).toBe(
      'Found 3 issues including one critical security vulnerability.',
    );
    expect(result.stats.total).toBe(3);
    expect(result.stats.critical).toBe(1);
    expect(result.stats.important).toBe(1);
    expect(result.stats.minor).toBe(1);
    expect(result.issues[0].file).toBe('src/auth/jwt.ts');
    expect(result.issues[0].line).toBe(28);
    expect(result.strengths).toHaveLength(2);
  });

  it('b) review with multiple files requiring batching', async () => {
    const pr = makePRContext({
      changedFiles: Array.from({ length: 7 }, (_, i) => ({
        path: `src/module${i}.ts`,
        status: 'modified' as const,
        additions: 10,
        deletions: 2,
        patch: `diff --git a/src/module${i}.ts b/src/module${i}.ts\n@@ -1 +1 @@\n-old\n+new`,
      })),
    });

    engine = new ReviewEngine(
      makeConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );

    fixtureQueue.push(
      { content: SAMPLE_BATCH_A_JSONL },
      { content: SAMPLE_BATCH_B_JSONL },
      { content: SAMPLE_BATCH_A_JSONL },
      { content: SAMPLE_SYNTHESIS_JSONL },
    );

    const result = await engine.reviewPR(pr);

    const batchDir = path.join(workDir, '.opencode');
    expect(fs.existsSync(path.join(batchDir, 'batch-0', 'review-output.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'batch-1', 'review-output.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'batch-2', 'review-output.jsonl'))).toBe(true);

    // 3 batch calls + 1 synthesis = 4 total runOpenCode calls
    expect(mockRunOpenCode).toHaveBeenCalledTimes(4);

    const firstCallArgs = mockRunOpenCode.mock.calls[0];
    expect(firstCallArgs[1]).toHaveProperty('workingDirectory');

    // Synthesis prompt was built with collated raw lines
    const synthCallArgs = mockRunOpenCode.mock.calls[3];
    expect(synthCallArgs[1].workingDirectory).toBe(workDir);

    expect(result.summary).toBe('Merged review of all modules.');
    expect(result.issues).toHaveLength(3);
    expect(result.stats.total).toBe(3);
  });

  it('c) OpenCode CLI failure — pre-batch failure', async () => {
    engine = new ReviewEngine(
      makeConfig({ enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );
    const pr = makePRContext();

    fixtureQueue.push({ content: undefined, success: false });

    const result = await engine.reviewPR(pr);

    expect(result.verdict.reasoning).toBe('Review execution failed');
    expect(result.verdict.ready).toBe(false);
    expect(result.stats.total).toBe(0);
  });

  it('c) OpenCode CLI failure — synthesis failure', async () => {
    const pr = makePRContext({
      changedFiles: Array.from({ length: 7 }, (_, i) => ({
        path: `src/module${i}.ts`,
        status: 'modified' as const,
        additions: 10,
        deletions: 2,
        patch: 'diff --git a/src/module.ts b/src/module.ts\n@@ -1 +1 @@\n-old\n+new',
      })),
    });

    engine = new ReviewEngine(
      makeConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );

    fixtureQueue.push(
      { content: SAMPLE_BATCH_A_JSONL },
      { content: SAMPLE_BATCH_B_JSONL },
      { content: SAMPLE_BATCH_A_JSONL },
      { content: undefined, success: false },
    );

    const result = await engine.reviewPR(pr);

    expect(result.verdict.reasoning).toBe('Synthesis failed, using merged batch results');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.stats.total).toBeGreaterThan(0);
  });

  it('c) OpenCode CLI failure — individual batch failure', async () => {
    const pr = makePRContext({
      changedFiles: Array.from({ length: 7 }, (_, i) => ({
        path: `src/module${i}.ts`,
        status: 'modified' as const,
        additions: 10,
        deletions: 2,
        patch: 'diff --git a/src/module.ts b/src/module.ts\n@@ -1 +1 @@\n-old\n+new',
      })),
    });

    engine = new ReviewEngine(
      makeConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );

    fixtureQueue.push(
      { content: SAMPLE_BATCH_A_JSONL },
      { content: undefined, success: false },
      { content: SAMPLE_BATCH_B_JSONL },
      { content: SAMPLE_SYNTHESIS_JSONL },
    );

    const result = await engine.reviewPR(pr);

    expect(result.issues).toHaveLength(3);
    expect(result.stats.total).toBe(3);
  });

  it('d) JSONL parse failure — main review (malformed output)', async () => {
    engine = new ReviewEngine(
      makeConfig({ enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );
    const pr = makePRContext();

    fixtureQueue.push({ content: 'this is not valid json line 1\nnor is this' });

    const result = await engine.reviewPR(pr);

    expect(result.stats.total).toBe(0);
    expect(result.failedLines).toBe(2);
  });

  it('d) JSONL parse failure — synthesis output not found (returns empty when file missing)', async () => {
    const pr = makePRContext({
      changedFiles: Array.from({ length: 7 }, (_, i) => ({
        path: `src/module${i}.ts`,
        status: 'modified' as const,
        additions: 10,
        deletions: 2,
        patch: 'diff --git a/src/module.ts b/src/module.ts\n@@ -1 +1 @@\n-old\n+new',
      })),
    });

    engine = new ReviewEngine(
      makeConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );

    fixtureQueue.push(
      { content: SAMPLE_BATCH_A_JSONL },
      { content: SAMPLE_BATCH_B_JSONL },
      { content: SAMPLE_BATCH_A_JSONL },
      { content: undefined, success: true },
    );

    const result = await engine.reviewPR(pr);

    expect(result).toBeDefined();
    expect(result.stats.total).toBe(0);
  });

  it('d) JSONL parse failure — individual batch parse failure (falls back to other batches)', async () => {
    const pr = makePRContext({
      changedFiles: Array.from({ length: 7 }, (_, i) => ({
        path: `src/module${i}.ts`,
        status: 'modified' as const,
        additions: 10,
        deletions: 2,
        patch: 'diff --git a/src/module.ts b/src/module.ts\n@@ -1 +1 @@\n-old\n+new',
      })),
    });

    engine = new ReviewEngine(
      makeConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );

    fixtureQueue.push(
      { content: SAMPLE_BATCH_A_JSONL },
      { content: undefined, success: true },
      { content: SAMPLE_BATCH_B_JSONL },
      { content: SAMPLE_SYNTHESIS_JSONL },
    );

    const result = await engine.reviewPR(pr);

    expect(result.issues).toHaveLength(3);
  });

  it('e) meta-verification loop filters false positives', async () => {
    engine = new ReviewEngine(
      makeConfig({
        enableMCP: false,
        mcpServers: [],
        review: {
          ...DEFAULT_CONFIG.review,
          enableMetaVerification: true,
          skipLabels: DEFAULT_CONFIG.review.skipLabels,
          skipActors: DEFAULT_CONFIG.review.skipActors,
          inline: DEFAULT_CONFIG.review.inline,
          requireVerdict: DEFAULT_CONFIG.review.requireVerdict,
          commandTriggers: DEFAULT_CONFIG.review.commandTriggers,
          excludePatterns: DEFAULT_CONFIG.review.excludePatterns,
        },
      }),
      'fake-token',
      'owner/repo',
    );
    const pr = makePRContext();

    fixtureQueue.push(
      { content: SAMPLE_VALID_JSONL },
      { content: SAMPLE_VALID_JSONL, verification: SAMPLE_VERIFICATION_JSONL },
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);

    const verificationOutputPath = path.join(workDir, '.opencode', 'verification-output.jsonl');
    expect(fs.existsSync(verificationOutputPath)).toBe(true);

    // SAMPLE_VALID_JSONL has 3 issues, but SAMPLE_VERIFICATION_JSONL marks
    // issue indices 0 and 2 as valid, dropping index 1
    expect(result.issues).toHaveLength(2);
    expect(result.stats.total).toBe(2);
    expect(result.issues[0].message).toContain('hardcoded');
    expect(result.issues[1].message).toContain('Unused import');
  });

  it('f) file exclusion filters excluded files from batches', async () => {
    engine = new ReviewEngine(
      makeConfig({
        enableMCP: false,
        mcpServers: [],
        batchSize: 3,
        review: {
          ...DEFAULT_CONFIG.review,
          excludePatterns: ['**/pnpm-lock.yaml', '**/dist/**'],
          skipLabels: DEFAULT_CONFIG.review.skipLabels,
          skipActors: DEFAULT_CONFIG.review.skipActors,
          inline: DEFAULT_CONFIG.review.inline,
          requireVerdict: DEFAULT_CONFIG.review.requireVerdict,
          commandTriggers: DEFAULT_CONFIG.review.commandTriggers,
          enableMetaVerification: DEFAULT_CONFIG.review.enableMetaVerification,
        },
      }),
      'fake-token',
      'owner/repo',
    );
    const pr = makePRContext({
      changedFiles: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 10,
          deletions: 2,
          patch: '@@ -1 +1 @@\n-old\n+new',
        },
        {
          path: 'pnpm-lock.yaml',
          status: 'modified',
          additions: 100,
          deletions: 50,
          patch: '@@ -1 +1 @@\n-locked\n+updated\n+more',
        },
        {
          path: 'dist/bundle.js',
          status: 'added',
          additions: 500,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+console.log',
        },
      ],
    });

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    const result = await engine.reviewPR(pr);

    const promptArg = mockRunOpenCode.mock.calls[0][0];
    expect(promptArg).toContain('src/app.ts');
    expect(promptArg).toContain('pnpm-lock.yaml');
    expect(promptArg).toContain('dist/bundle.js');
    expect(result).toBeDefined();
  });

  it('g) context building includes truncation markers for large patches', async () => {
    const largePatch = Array.from({ length: 200 }, (_, i) => `+line ${i + 1}`).join('\n');
    const pr = makePRContext({
      changedFiles: [
        {
          path: 'src/large.ts',
          status: 'modified',
          additions: 100,
          deletions: 100,
          patch: largePatch,
        },
      ],
    });

    engine = new ReviewEngine(
      makeConfig({ maxLinesPerFile: 50, enableMCP: false, mcpServers: [] }),
      'fake-token',
      'owner/repo',
    );

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    await engine.reviewPR(pr);

    const promptArg = mockRunOpenCode.mock.calls[0][0];

    expect(promptArg).toContain('[Patch truncated: 150 remaining lines omitted');
    expect(promptArg).toContain('+line 1');
    expect(promptArg).toContain('+line 50');
    expect(promptArg).not.toContain('+line 51');
  });

  it('excluded files cause skipped review when all files match exclude patterns', async () => {
    const pr = makePRContext({
      changedFiles: [
        { path: 'pnpm-lock.yaml', status: 'modified', additions: 10, deletions: 2, patch: '' },
        { path: 'dist/bundle.js', status: 'added', additions: 500, deletions: 0, patch: '' },
      ],
    });

    engine = new ReviewEngine(
      makeConfig({
        enableMCP: false,
        mcpServers: [],
        review: {
          ...DEFAULT_CONFIG.review,
          excludePatterns: ['**/pnpm-lock.yaml', '**/dist/**'],
          skipLabels: DEFAULT_CONFIG.review.skipLabels,
          skipActors: DEFAULT_CONFIG.review.skipActors,
          inline: DEFAULT_CONFIG.review.inline,
          requireVerdict: DEFAULT_CONFIG.review.requireVerdict,
          commandTriggers: DEFAULT_CONFIG.review.commandTriggers,
          enableMetaVerification: DEFAULT_CONFIG.review.enableMetaVerification,
        },
      }),
      'fake-token',
      'owner/repo',
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).not.toHaveBeenCalled();
    expect(result.verdict.ready).toBe(false);
    expect(result.stats.total).toBe(0);
  });
});
