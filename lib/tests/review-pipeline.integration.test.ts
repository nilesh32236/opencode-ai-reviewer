import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import {
  SAMPLE_BATCH_A_JSONL,
  SAMPLE_BATCH_B_JSONL,
  SAMPLE_SYNTHESIS_JSONL,
  SAMPLE_VALID_JSONL,
  SAMPLE_VERIFICATION_ALL_INVALID_JSONL,
  SAMPLE_VERIFICATION_JSONL,
  makeAgentConfig,
  makeMetaVerificationConfig,
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
  return {
    mockRunOpenCode: _mockRunOpenCode,
    MockMCPManager: _MockMCPManager,
  };
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
import { GitHubHelper } from '../src/utils/github.js';

interface RunOpenCodeOptions {
  model: string;
  workingDirectory?: string;
}

/**
 * Locate the meta-verification runOpenCode call semantically (by prompt marker)
 * instead of by call position, so the assertion stays correct even if the
 * pipeline gains an intermediate opencode stage (e.g. a synthesis pass).
 */
function findVerificationCall(): { prompt: string; options: RunOpenCodeOptions } | undefined {
  const call = mockRunOpenCode.mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('# Verification Pass'),
  );
  if (!call) return undefined;
  return { prompt: call[0] as string, options: call[1] as RunOpenCodeOptions };
}

describe('Review Pipeline Integration', () => {
  let engine: ReviewEngine;
  let gh: GitHubHelper;
  let workDir: string;
  let origCwd: string;
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

    origCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pipeline-'));
    process.chdir(workDir);

    gh = new GitHubHelper('fake-token', 'owner/repo');
    setupFetchMock();
    setupRunOpenCodeMock();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('a) successful full review flow (single batch)', async () => {
    engine = new ReviewEngine(makeAgentConfig({ enableMCP: false, mcpServers: [] }), gh);
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
      makeAgentConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      gh,
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
    engine = new ReviewEngine(makeAgentConfig({ enableMCP: false, mcpServers: [] }), gh);
    const pr = makePRContext();

    fixtureQueue.push({ content: undefined, success: false });

    const result = await engine.reviewPR(pr);

    expect(result.verdict.reasoning).toBe('Review execution failed');
    expect(result.verdict.ready).toBe(false);
    expect(result.stats.total).toBe(0);
  });

  it('c2) secret scan still reports hardcoded credentials when the model fails', async () => {
    const GITHUB_PAT = ['ghp_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('');
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'src/fallback.ts'),
      `const token = "${GITHUB_PAT}";`,
      'utf-8',
    );
    engine = new ReviewEngine(makeAgentConfig({ enableMCP: false, mcpServers: [] }), gh);
    const pr = makePRContext({
      changedFiles: [
        {
          path: 'src/fallback.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+const token = "…";',
        },
      ],
    });

    fixtureQueue.push({ content: undefined, success: false });

    const result = await engine.reviewPR(pr);

    expect(result.verdict.reasoning).toBe('Review execution failed');
    const secretIssue = result.issues.find((i) => i.message.startsWith('Hardcoded'));
    expect(secretIssue).toBeDefined();
    expect(secretIssue!.file).toBe('src/fallback.ts');
    expect(secretIssue!.message).not.toContain(GITHUB_PAT);
    expect(result.stats.critical).toBe(1);
  });

  it('d) OpenCode CLI failure — synthesis failure', async () => {
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
      makeAgentConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      gh,
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

  it('e) OpenCode CLI failure — individual batch failure', async () => {
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
      makeAgentConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      gh,
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

  it('f) JSONL parse failure — main review (malformed output)', async () => {
    engine = new ReviewEngine(makeAgentConfig({ enableMCP: false, mcpServers: [] }), gh);
    const pr = makePRContext();

    fixtureQueue.push({ content: 'this is not valid json line 1\nnor is this' });

    const result = await engine.reviewPR(pr);

    expect(result.stats.total).toBe(0);
    expect(result.failedLines).toBe(2);
  });

  it('g) JSONL parse failure — synthesis output not found (returns empty when file missing)', async () => {
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
      makeAgentConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      gh,
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

  it('h) JSONL parse failure — individual batch parse failure (falls back to other batches)', async () => {
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
      makeAgentConfig({ batchSize: 3, enableMCP: false, mcpServers: [] }),
      gh,
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

  it('i) meta-verification loop filters false positives', async () => {
    engine = new ReviewEngine(makeMetaVerificationConfig(), gh);
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

    // Agreement rate is logged as a quality metric (2 of 3 issues kept = 66.7%)
    expect(vi.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining('Verification agreement rate: 66.7%'),
    );
  });

  it('i2) meta-verification uses verificationModel when configured', async () => {
    const verificationModel = 'anthropic/claude-4-sonnet';
    engine = new ReviewEngine(makeMetaVerificationConfig({ verificationModel }), gh);
    const pr = makePRContext();

    fixtureQueue.push(
      { content: SAMPLE_VALID_JSONL },
      { content: SAMPLE_VALID_JSONL, verification: SAMPLE_VERIFICATION_JSONL },
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
    // First call = batch review, verification pass located semantically
    expect(mockRunOpenCode.mock.calls[0][1]).toMatchObject({
      model: DEFAULT_CONFIG.reviewModel,
    });
    expect(findVerificationCall()?.options.model).toBe(verificationModel);
    expect(result.issues).toHaveLength(2);
  });

  it('i3) meta-verification falls back to reviewModel when verificationModel unset', async () => {
    engine = new ReviewEngine(makeMetaVerificationConfig(), gh);
    const pr = makePRContext();

    fixtureQueue.push(
      { content: SAMPLE_VALID_JSONL },
      { content: SAMPLE_VALID_JSONL, verification: SAMPLE_VERIFICATION_JSONL },
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
    expect(findVerificationCall()?.options.model).toBe(DEFAULT_CONFIG.reviewModel);
    expect(result.issues).toHaveLength(2);
  });

  it('i4) meta-verification logs 0% agreement when every issue is rejected', async () => {
    engine = new ReviewEngine(makeMetaVerificationConfig(), gh);
    const pr = makePRContext();

    fixtureQueue.push(
      { content: SAMPLE_VALID_JSONL },
      {
        content: SAMPLE_VALID_JSONL,
        verification: SAMPLE_VERIFICATION_ALL_INVALID_JSONL,
      },
    );

    const result = await engine.reviewPR(pr);

    // The agreement rate is logged even when the verification model drops every
    // issue (0% agreement) — the exact signal monitoring must surface.
    expect(vi.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining(
        'Verification agreement rate: 0.0% (0/3 issues kept by verification model)',
      ),
    );
    // All-rejected verification retains the enriched result (no valid entries)
    expect(result.issues).toHaveLength(3);
  });

  it('i5) meta-verification warns (no agreement rate) when output file is missing', async () => {
    engine = new ReviewEngine(makeMetaVerificationConfig(), gh);
    const pr = makePRContext();

    fixtureQueue.push(
      { content: SAMPLE_VALID_JSONL },
      // Verification pass succeeds but never writes verification-output.jsonl
      { content: SAMPLE_VALID_JSONL },
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Meta-verification output file not found'),
    );
    // A missing output must not fabricate a misleading agreement-rate line.
    expect(vi.mocked(core.info)).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification agreement rate'),
    );
    expect(result.issues).toHaveLength(3);
  });

  it('i6) meta-verification warns (no agreement rate) when output has no usable entries', async () => {
    engine = new ReviewEngine(makeMetaVerificationConfig(), gh);
    const pr = makePRContext();

    fixtureQueue.push(
      { content: SAMPLE_VALID_JSONL },
      {
        content: SAMPLE_VALID_JSONL,
        verification:
          'this is not valid json\n{"type":"strength","file":"x.ts","line":1,"message":"ok"}',
      },
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Meta-verification produced no usable verification output'),
    );
    // Malformed output is not conflated with the model actively rejecting findings.
    expect(vi.mocked(core.info)).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification agreement rate'),
    );
    expect(result.issues).toHaveLength(3);
  });

  it('j) file exclusion filters excluded files from batches', async () => {
    engine = new ReviewEngine(
      makeAgentConfig({
        enableMCP: false,
        mcpServers: [],
        batchSize: 2,
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
      gh,
    );
    const nonExcludedFiles = Array.from({ length: 5 }, (_, i) => ({
      path: `src/lib/module${i}.ts`,
      status: 'modified' as const,
      additions: 10,
      deletions: 2,
      patch: `@@ -1 +1 @@\n-old${i}\n+new${i}`,
    }));
    const pr = makePRContext({
      changedFiles: [
        ...nonExcludedFiles,
        {
          path: 'pnpm-lock.yaml',
          status: 'modified',
          additions: 100,
          deletions: 50,
          patch: '@@ -1 +1 @@\n-locked\n+updated',
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

    fixtureQueue.push(
      { content: SAMPLE_BATCH_A_JSONL },
      { content: SAMPLE_BATCH_B_JSONL },
      { content: SAMPLE_BATCH_A_JSONL },
      { content: SAMPLE_SYNTHESIS_JSONL },
    );

    const result = await engine.reviewPR(pr);

    // 5 non-excluded files, batchSize=2 => 3 batches + 1 synthesis = 4 calls
    expect(mockRunOpenCode).toHaveBeenCalledTimes(4);

    // Each batch prompt should NOT contain excluded filenames
    for (let i = 0; i < 3; i++) {
      const batchPrompt = mockRunOpenCode.mock.calls[i][0];
      expect(batchPrompt).not.toContain('pnpm-lock.yaml');
      expect(batchPrompt).not.toContain('dist/bundle.js');
    }

    // Non-excluded files appear in the correct batch prompts
    // batch 0 => module0, module1; batch 1 => module2, module3; batch 2 => module4
    const batchFiles = [['module0', 'module1'], ['module2', 'module3'], ['module4']];
    for (let batchIdx = 0; batchIdx < 3; batchIdx++) {
      const batchPrompt = mockRunOpenCode.mock.calls[batchIdx][0];
      for (const file of batchFiles[batchIdx]) {
        expect(batchPrompt).toContain(`src/lib/${file}.ts`);
      }
    }

    expect(result).toBeDefined();
  });

  it('k) context building includes truncation markers for large patches', async () => {
    const totalLines = 200;
    const maxLinesPerFile = 50;
    const remainingLines = totalLines - maxLinesPerFile;
    const largePatch = Array.from({ length: totalLines }, (_, i) => `+line ${i + 1}`).join('\n');
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
      makeAgentConfig({ maxLinesPerFile, enableMCP: false, mcpServers: [] }),
      gh,
    );

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    await engine.reviewPR(pr);

    const promptArg = mockRunOpenCode.mock.calls[0][0];

    expect(promptArg).toContain(`[Patch truncated: ${remainingLines} remaining lines omitted`);
    expect(promptArg).toContain('+line 1');
    expect(promptArg).toContain('+line 50');
    expect(promptArg).not.toContain('+line 51');

    // Verify exactly maxLinesPerFile lines are included
    const lineCount = (promptArg.match(/\+line \d+/g) || []).length;
    expect(lineCount).toBe(maxLinesPerFile);
  });

  it('l) excluded files cause skipped review when all files match exclude patterns', async () => {
    const pr = makePRContext({
      changedFiles: [
        { path: 'pnpm-lock.yaml', status: 'modified', additions: 10, deletions: 2, patch: '' },
        { path: 'dist/bundle.js', status: 'added', additions: 500, deletions: 0, patch: '' },
      ],
    });

    engine = new ReviewEngine(
      makeAgentConfig({
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
      gh,
    );

    const result = await engine.reviewPR(pr);

    expect(mockRunOpenCode).not.toHaveBeenCalled();
    expect(result.verdict.ready).toBe(false);
    expect(result.stats.total).toBe(0);
  });

  it('m) secret detector flags a hardcoded token on disk as a blocking critical finding', async () => {
    const GITHUB_PAT = ['ghp_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('');
    // Write the changed file to disk so the deterministic scanner can read it.
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'src/config.ts'),
      `const apiToken = "${GITHUB_PAT}";
export default apiToken;
`,
      'utf-8',
    );
    const pr = makePRContext({
      changedFiles: [
        {
          path: 'src/config.ts',
          status: 'added',
          additions: 2,
          deletions: 0,
          patch: '@@ -0,0 +1,2 @@\n+const apiToken = "…";\n+export default apiToken;',
        },
      ],
    });

    engine = new ReviewEngine(makeAgentConfig({ enableMCP: false, mcpServers: [] }), gh);

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    const result = await engine.reviewPR(pr);

    const secretIssue = result.issues.find((i) => i.message.startsWith('Hardcoded'));
    expect(secretIssue).toBeDefined();
    expect(secretIssue!.severity).toBe('critical');
    expect(secretIssue!.file).toBe('src/config.ts');
    expect(secretIssue!.inline).toBe(true);
    // The message is redacted and never leaks the full token.
    expect(secretIssue!.message).toContain('ghp_');
    expect(secretIssue!.message).not.toContain(GITHUB_PAT);
    // Stats reflect the merged critical secret.
    expect(result.stats.critical).toBeGreaterThanOrEqual(1);
    expect(result.stats.total).toBeGreaterThan(3);
  });

  it('n) secret detector honors secrets.excludePatterns and allowlist', async () => {
    const GITHUB_PAT = ['ghp_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('');
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'src/secrets.example.ts'),
      `const token = "${GITHUB_PAT}";`,
      'utf-8',
    );
    // Not matched by excludePatterns — only the allowlist can suppress this one.
    fs.writeFileSync(
      path.join(workDir, 'src/allowlisted.ts'),
      `const token = "${GITHUB_PAT}";`,
      'utf-8',
    );
    const pr = makePRContext({
      changedFiles: [
        {
          path: 'src/secrets.example.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+const token = "…";',
        },
        {
          path: 'src/allowlisted.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+const token = "…";',
        },
      ],
    });

    engine = new ReviewEngine(
      makeAgentConfig({
        enableMCP: false,
        mcpServers: [],
        secrets: {
          ...DEFAULT_CONFIG.secrets,
          allowlist: [GITHUB_PAT.slice(0, 10)],
          excludePatterns: ['**/*.example.ts'],
        },
      }),
      gh,
    );

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    const result = await engine.reviewPR(pr);

    expect(result.issues.some((i) => i.message.startsWith('Hardcoded'))).toBe(false);
    expect(result.stats.total).toBe(3);
  });

  it('o) secret detector skips binary files', async () => {
    fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
    // A fake binary file containing NUL bytes followed by a token string.
    fs.writeFileSync(
      path.join(workDir, 'assets/blob.bin'),
      Buffer.concat([
        Buffer.from([0x00, 0x01, 0x00]),
        Buffer.from(['ghp_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('')),
      ]),
    );
    const pr = makePRContext({
      changedFiles: [
        {
          path: 'assets/blob.bin',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+',
        },
      ],
    });

    engine = new ReviewEngine(makeAgentConfig({ enableMCP: false, mcpServers: [] }), gh);

    fixtureQueue.push({ content: SAMPLE_VALID_JSONL });

    const result = await engine.reviewPR(pr);

    expect(result.issues.some((i) => i.message.startsWith('Hardcoded'))).toBe(false);
    expect(result.stats.total).toBe(3);
  });
});
