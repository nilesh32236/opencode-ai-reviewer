import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, PRContext, ReviewIssue, ReviewResult } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

const {
  mockMCPConnect,
  mockMCPDisconnect,
  mockMCPGetLibraryDocs,
  mockGitHubGetPR,
  mockRunOpenCode,
  mockParseJsonlFile,
  mockEmptyResult,
  mockRunSCAScan,
  mockBuildReviewPrompt,
  mockBuildFixPrompt,
  mockBuildAuditPrompt,
  mockBuildAnalyzePrompt,
  mockBuildDocsPrompt,
  mockBuildSynthesisPrompt,
  mockBuildDescribePrompt,
  MockMCPManager,
  createMockAdapter,
} = vi.hoisted(() => {
  const _mockMCPConnect = vi.fn();
  const _mockMCPDisconnect = vi.fn();
  const _mockMCPGetLibraryDocs = vi.fn();
  const _mockGitHubGetPR = vi.fn();
  const _mockGitHubGetDiffSince = vi.fn().mockResolvedValue('');
  const _mockGitHubGetOpenHumanThreads = vi.fn().mockResolvedValue('');
  const _mockRunOpenCode = vi.fn();
  const _mockParseJsonlFile = vi.fn();
  const _mockRunSCAScan = vi.fn().mockResolvedValue([]);
  const _mockEmptyResult = vi.fn(() => ({
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' as const },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
  }));
  const _mockBuildReviewPrompt = vi.fn(() => 'review prompt');
  const _mockBuildFixPrompt = vi.fn(() => 'fix prompt');
  const _mockBuildAuditPrompt = vi.fn(() => 'audit prompt');
  const _mockBuildAnalyzePrompt = vi.fn(() => 'analyze prompt');
  const _mockBuildDocsPrompt = vi.fn(() => 'docs prompt');
  const _mockBuildSynthesisPrompt = vi.fn(() => 'synthesis prompt');
  const _mockBuildDescribePrompt = vi.fn(() => 'describe prompt');

  class _MockMCPManager {
    connect = _mockMCPConnect;
    disconnect = _mockMCPDisconnect;
    getLibraryDocs = _mockMCPGetLibraryDocs;
  }

  class _MockGitHubHelper {
    getPR = _mockGitHubGetPR;
  }

  function _createMockAdapter() {
    return {
      getMR: _mockGitHubGetPR,
      isMR: vi.fn().mockResolvedValue(true),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      getIssue: vi.fn(),
      getIssueComments: vi.fn().mockResolvedValue([]),
      getIssueComment: vi.fn(),
      getDiffLines: vi.fn().mockResolvedValue(new Set<string>()),
      getDiffSince: _mockGitHubGetDiffSince,
      listReviewComments: vi.fn().mockResolvedValue([]),
      createReviewCommentReply: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      postComment: vi.fn(),
      postReview: vi.fn(),
      postOrUpdateComment: vi.fn(),
      createComment: vi.fn(),
      replyToReviewComment: vi.fn(),
      getReviewComment: vi.fn(),
      getReviewCommentThread: vi.fn(),
      createIssue: vi.fn(),
      createPR: vi.fn(),
      addLabels: vi.fn(),
      removeLabel: vi.fn(),
      setLabels: vi.fn(),
      ensureLabels: vi.fn(),
      gatherContext: vi.fn().mockResolvedValue(''),
      closeOpenCodePRs: vi.fn(),
      mergeMR: vi.fn(),
      enableAutoMerge: vi.fn(),
      closeIssue: vi.fn(),
      getReviewThreads: vi.fn().mockResolvedValue([]),
      resolveReviewThread: vi.fn(),
      minimizeReviewComment: vi.fn(),
      getBotReviewThreads: vi.fn().mockResolvedValue([]),
      getOpenHumanThreads: _mockGitHubGetOpenHumanThreads,
      updateMR: vi.fn(),
      getCurrentUser: vi.fn().mockResolvedValue('test-bot'),
      paginate: vi.fn().mockResolvedValue([]),
    };
  }

  return {
    mockMCPConnect: _mockMCPConnect,
    mockMCPDisconnect: _mockMCPDisconnect,
    mockMCPGetLibraryDocs: _mockMCPGetLibraryDocs,
    mockGitHubGetPR: _mockGitHubGetPR,
    mockRunOpenCode: _mockRunOpenCode,
    mockParseJsonlFile: _mockParseJsonlFile,
    mockEmptyResult: _mockEmptyResult,
    mockRunSCAScan: _mockRunSCAScan,
    mockBuildReviewPrompt: _mockBuildReviewPrompt,
    mockBuildFixPrompt: _mockBuildFixPrompt,
    mockBuildAuditPrompt: _mockBuildAuditPrompt,
    mockBuildAnalyzePrompt: _mockBuildAnalyzePrompt,
    mockBuildDocsPrompt: _mockBuildDocsPrompt,
    mockBuildSynthesisPrompt: _mockBuildSynthesisPrompt,
    mockBuildDescribePrompt: _mockBuildDescribePrompt,
    MockMCPManager: _MockMCPManager,
    createMockAdapter: _createMockAdapter,
  };
});

vi.mock('../src/mcp/client.js', () => ({
  MCPManager: MockMCPManager,
}));

vi.mock('../src/utils/github.js', () => ({
  GitHubHelper: MockGitHubHelper,
}));

vi.mock('../src/opencode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/opencode.js')>();
  return {
    ...actual,
    runOpenCode: mockRunOpenCode,
    getGitStatus: vi.fn(),
    ensureOutputDir: vi.fn(),
  };
});

vi.mock('../src/jsonl-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/jsonl-parser.js')>();
  return {
    ...actual,
    parseJsonlFile: mockParseJsonlFile,
    emptyResult: mockEmptyResult,
  };
});

// Deterministic SCA pass is mocked so engine-level tests can assert the merge
// behavior without real OSV network calls.
vi.mock('../src/sca/index.js', () => ({
  runSCAScan: mockRunSCAScan,
  scaVulnerabilityToIssue: vi.fn((v: unknown) => v),
}));

vi.mock('../src/prompts/builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/prompts/builder.js')>();
  return {
    ...actual,
    buildReviewPrompt: mockBuildReviewPrompt,
    buildFixPrompt: mockBuildFixPrompt,
    buildAuditPrompt: mockBuildAuditPrompt,
    buildAnalyzePrompt: mockBuildAnalyzePrompt,
    buildDocsPrompt: mockBuildDocsPrompt,
    buildSynthesisPrompt: mockBuildSynthesisPrompt,
    buildDescribePrompt: mockBuildDescribePrompt,
  };
});

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
    // execFile backs the codebase-index async git probes. A default
    // implementation is re-applied in beforeEach so the probes report an empty
    // stdout (falling back to workDir, matching pre-async behavior) and never
    // hang the review; individual tests override it with mockImplementation.
    execFile: vi.fn(actual.execFile),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      unlink: vi.fn(),
      appendFile: vi.fn(),
      // The async codebase-index walk uses the real async directory listing.
      readdir: actual.promises.readdir,
      stat: actual.promises.stat,
      mkdir: actual.promises.mkdir,
    },
  };
});

import * as fs from 'fs';
import * as cp from 'node:child_process';
import { ReviewEngine } from '../src/engine.js';
import { getGitStatus } from '../src/opencode.js';

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'test-user',
    labels: [],
    changedFiles: [
      { path: 'src/test.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' },
    ],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    ...overrides,
    review: {
      ...DEFAULT_CONFIG.review,
      enableReachability: false,
      ...((overrides.review || {}) as Record<string, unknown>),
    },
  };
}

describe('ReviewEngine', () => {
  let engine: ReviewEngine;

  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default git probe behavior for the codebase-index path: report empty
    // stdout so resolveCodebaseRoot falls back to the working directory (the
    // pre-async behavior) and the cache key stays the bare headSha.
    vi.mocked(cp.execFile).mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout?: string) => void;
      callback(null, '');
    });
    // Deterministic SCA defaults to no findings unless a test overrides it.
    mockRunSCAScan.mockResolvedValue([]);
    mockAdapter = createMockAdapter();
    engine = new ReviewEngine(makeConfig(), mockAdapter);
  });

  describe('reviewPR()', () => {
    const pr = makePRContext();

    it('returns review result on success', async () => {
      const engWithMCP = new ReviewEngine(
        makeConfig({
          enableMCP: true,
          mcpServers: [{ name: 'context7', type: 'local', command: ['node', 'server.js'] }],
        }),
        mockAdapter,
      );
      mockMCPConnect.mockResolvedValue(undefined);
      mockMCPGetLibraryDocs.mockResolvedValue('docs content');
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });

      const expectedResult: ReviewResult = {
        summary: 'Good PR',
        verdict: { ready: true, reasoning: 'Looks good', autoFixable: false, confidence: 'high' },
        strengths: [{ type: 'strength', file: 'src/test.ts', line: 1, message: 'Nice' }],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      mockParseJsonlFile.mockResolvedValue(expectedResult);

      const result = await engWithMCP.reviewPR(pr);

      expect(mockMCPConnect).toHaveBeenCalled();
      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'review prompt',
        expect.objectContaining({ model: DEFAULT_CONFIG.reviewModel, timeoutMinutes: 10 }),
      );
      expect(result).toEqual(expectedResult);
    });

    it('returns empty result when runOpenCode fails', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: '',
        durationMs: 500,
        tokensUsed: 0,
      });

      const result = await engine.reviewPR(pr);

      expect(result.verdict.reasoning).toBe('Review execution failed');
      expect(result.verdict.ready).toBe(false);
    });

    it('returns empty result when parseJsonlFile fails', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockRejectedValue(new Error('Parse error'));

      const result = await engine.reviewPR(pr);

      expect(result.verdict.reasoning).toBe('Failed to parse review output');
      expect(result.verdict.ready).toBe(false);
    });

    it('handles MCP connection failure gracefully', async () => {
      mockMCPConnect.mockRejectedValue(new Error('MCP failed'));
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await engine.reviewPR(pr);

      expect(result.verdict).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('merges SCA findings into a clean review result and blocks the verdict', async () => {
      const scaIssue: ReviewIssue = {
        type: 'issue',
        severity: 'critical',
        file: 'package-lock.json',
        line: 5,
        message: 'Known vulnerability CVE-2021-23337 affects lodash@4.17.20.',
        suggestion: 'Upgrade lodash to 4.17.21.',
        inline: true,
        confidence: 'high',
        category: 'security',
      };
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunSCAScan.mockResolvedValue([scaIssue]);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue({
        summary: 'Clean PR',
        verdict: { ready: true, reasoning: 'No issues', autoFixable: false, confidence: 'high' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      });

      const result = await engine.reviewPR(pr);

      expect(mockRunSCAScan).toHaveBeenCalledWith(
        pr.changedFiles,
        expect.any(String),
        expect.objectContaining({ enabled: true, deadlineMs: expect.any(Number) }),
        expect.anything(),
      );
      // The SCA finding survives verifyReviewResult and is merged with the
      // recomputed stats, forcing verdict.ready to false.
      expect(result.issues).toContainEqual(scaIssue);
      expect(result.stats.total).toBe(1);
      expect(result.stats.critical).toBe(1);
      expect(result.verdict.ready).toBe(false);
    });

    it('leaves a clean result untouched when SCA finds nothing', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunSCAScan.mockResolvedValue([]);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue({
        summary: 'Clean PR',
        verdict: { ready: true, reasoning: 'No issues', autoFixable: false, confidence: 'high' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      });

      const result = await engine.reviewPR(pr);

      expect(mockRunSCAScan).toHaveBeenCalled();
      expect(result.verdict.ready).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.stats).toEqual({ total: 0, critical: 0, important: 0, minor: 0 });
    });

    it('handles learning store failure gracefully', async () => {
      const learningStore = {
        getRelevantLessons: vi.fn().mockRejectedValue(new Error('DB error')),
        close: vi.fn(),
      };
      const eng = new ReviewEngine(makeConfig(), mockAdapter, learningStore as never);
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(pr);
      expect(result.verdict).toBeDefined();
      expect(result.issues).toBeDefined();
    });

    it('uses cached lessons within TTL', async () => {
      const learningStore = {
        getRelevantLessons: vi.fn().mockResolvedValue(['lesson 1']),
        close: vi.fn(),
      };
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        mockAdapter,
        learningStore as never,
      );
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);
      await eng.reviewPR(pr);

      expect(learningStore.getRelevantLessons).toHaveBeenCalledTimes(1);
    });

    it('skips MCP when enableMCP is false', async () => {
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      expect(mockMCPConnect).not.toHaveBeenCalled();
    });

    it('does not fetch library docs when no libraries detected', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await engine.reviewPR(
        makePRContext({
          changedFiles: [{ path: 'package.json', status: 'modified', additions: 1, deletions: 0 }],
        }),
      );

      expect(mockMCPGetLibraryDocs).not.toHaveBeenCalled();
    });

    describe('concurrent batch processing', () => {
      const batchPr = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/b.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/c.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/d.ts', status: 'modified', additions: 10, deletions: 0 },
        ],
      });

      function makeBatchResult(prefix: string): ReviewResult {
        return {
          summary: `Batch ${prefix} summary`,
          verdict: {
            ready: false,
            reasoning: 'issues found',
            autoFixable: false,
            confidence: 'medium',
          },
          strengths: [{ type: 'strength', file: `${prefix}.ts`, line: 1, message: 'Nice' }],
          issues: [
            {
              type: 'issue',
              severity: 'critical',
              file: `${prefix}.ts`,
              line: 5,
              message: `Issue in ${prefix}`,
              category: 'general',
            },
          ],
          stats: { total: 1, critical: 1, important: 0, minor: 0 },
          rawLines: [
            `{"type":"summary","text":"Batch ${prefix} summary"}`,
            `{"type":"issue","severity":"critical","file":"${prefix}.ts","line":5,"message":"Issue in ${prefix}"}`,
          ],
          failedLines: 1,
        };
      }

      it('splits files into batches and runs concurrent reviews', async () => {
        mockMCPConnect.mockResolvedValue(undefined);
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 1000,
          tokensUsed: 100,
        });
        mockParseJsonlFile
          .mockResolvedValueOnce(makeBatchResult('batch0'))
          .mockResolvedValueOnce(makeBatchResult('batch1'))
          .mockResolvedValueOnce(makeBatchResult('final'));

        const result = await engine.reviewPR(batchPr);

        expect(mockRunOpenCode).toHaveBeenCalledTimes(3);
        expect(mockBuildSynthesisPrompt).toHaveBeenCalledOnce();
        expect(result).toEqual(makeBatchResult('final'));
      });

      it('returns merged fallback when synthesis fails', async () => {
        mockMCPConnect.mockResolvedValue(undefined);
        mockRunOpenCode
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 })
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 })
          .mockResolvedValueOnce({ success: false, output: '', durationMs: 500 });

        mockParseJsonlFile
          .mockResolvedValueOnce(makeBatchResult('batch0'))
          .mockResolvedValueOnce(makeBatchResult('batch1'));

        const result = await engine.reviewPR(batchPr);

        expect(mockRunOpenCode).toHaveBeenCalledTimes(3);
        expect(result.verdict.reasoning).toBe('Synthesis failed, using merged batch results');
        expect(result.issues).toHaveLength(2);
        expect(result.stats.total).toBe(2);
      });

      it('returns merged fallback when synthesis output parse fails', async () => {
        mockMCPConnect.mockResolvedValue(undefined);
        mockRunOpenCode
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 })
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 })
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 });

        mockParseJsonlFile
          .mockResolvedValueOnce(makeBatchResult('batch0'))
          .mockResolvedValueOnce(makeBatchResult('batch1'))
          .mockRejectedValueOnce(new Error('Parse error'));

        const result = await engine.reviewPR(batchPr);

        expect(result.verdict.reasoning).toBe(
          'Synthesis output parse failed, using merged batch results',
        );
        expect(result.issues).toHaveLength(2);
      });

      it('handles individual batch failures gracefully', async () => {
        mockMCPConnect.mockResolvedValue(undefined);
        mockRunOpenCode
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 })
          .mockResolvedValueOnce({ success: false, output: '', durationMs: 500 })
          .mockResolvedValueOnce({ success: true, output: '', durationMs: 1000 });

        mockParseJsonlFile
          .mockResolvedValueOnce(makeBatchResult('batch0'))
          .mockResolvedValueOnce(makeBatchResult('final'));

        const result = await engine.reviewPR(batchPr);

        expect(result.issues).toHaveLength(1);
        expect(result.stats.total).toBe(1);
      });

      it('does not report ready:true when every batch and synthesis fail', async () => {
        mockMCPConnect.mockResolvedValue(undefined);
        // Every batch AND the synthesis pass fail.
        mockRunOpenCode.mockResolvedValue({
          success: false,
          output: '',
          durationMs: 500,
          tokensUsed: 0,
        });

        const result = await engine.reviewPR(batchPr);

        expect(result.verdict.ready).toBe(false);
        expect(result.verdict.reasoning).toBe('All review batches failed');
        expect(result.summary).toContain('batches failed');
      });
    });

    describe('duplicate review deduplication', () => {
      const dedupPr = makePRContext({ number: 900, headSha: 'dedup-hash' });

      function makeRepoEngine(repo = 'owner/repo'): ReviewEngine {
        return new ReviewEngine(makeConfig(), mockAdapter, undefined, undefined, repo);
      }

      beforeEach(() => {
        mockMCPConnect.mockResolvedValue(undefined);
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 1000,
          tokensUsed: 500,
        });
        mockParseJsonlFile.mockResolvedValue(mockEmptyResult());
        ReviewEngine.resetReviewDedup();
      });

      it('shares a single in-flight pipeline across concurrent duplicate reviews', async () => {
        const eng = makeRepoEngine();
        const [first, second] = await Promise.all([eng.reviewPR(dedupPr), eng.reviewPR(dedupPr)]);

        expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
        // The first caller owns the pipeline; the joining caller shares the same
        // computed result but is marked `skipped` so it does not re-post.
        expect(first.skipped).toBeUndefined();
        expect(second.skipped).toBe(true);
        expect(second.issues).toEqual(first.issues);
      });

      it('skips a repeated review for the same PR and headSha within the TTL window', async () => {
        const eng = makeRepoEngine();
        await eng.reviewPR(dedupPr);
        const second = await eng.reviewPR(dedupPr);

        expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
        expect(second.summary).toBe('');
        expect(second.issues).toHaveLength(0);
        expect(second.skipped).toBe(true);
      });

      it('does not deduplicate when no real repo context is set', async () => {
        const eng = new ReviewEngine(makeConfig(), mockAdapter);
        await eng.reviewPR(makePRContext({ number: 901 }));
        await eng.reviewPR(makePRContext({ number: 901 }));

        expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      });

      it('does not deduplicate when the repo is an empty string', async () => {
        const eng = makeRepoEngine('');
        await eng.reviewPR(makePRContext({ number: 903 }));
        await eng.reviewPR(makePRContext({ number: 903 }));

        expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      });

      it('runs a new review when the headSha changes', async () => {
        const eng = makeRepoEngine();
        await eng.reviewPR(makePRContext({ number: 902, headSha: 'sha-v1' }));
        await eng.reviewPR(makePRContext({ number: 902, headSha: 'sha-v2' }));

        expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      });

      it('bypasses the reviewed cache when forceReview is set (autofix re-review)', async () => {
        const eng = makeRepoEngine();
        await eng.reviewPR(dedupPr);
        const forced = await eng.reviewPR(
          dedupPr,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { forceReview: true },
        );

        expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
        expect(forced.summary).toBe('');
        expect(forced.issues).toHaveLength(0);
      });

      it('does not cache a failed pipeline as reviewed (retry re-runs the review)', async () => {
        const eng = makeRepoEngine();
        mockRunOpenCode.mockResolvedValue({
          success: false,
          output: '',
          durationMs: 500,
          tokensUsed: 0,
        });
        const first = await eng.reviewPR(dedupPr);
        expect(first.verdict.reasoning).toBe('Review execution failed');

        const second = await eng.reviewPR(dedupPr);
        expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
        expect(second.verdict.reasoning).toBe('Review execution failed');
      });

      it('does not cache a parse-failure pipeline as reviewed (retry re-runs the review)', async () => {
        const eng = makeRepoEngine();
        mockRunOpenCode.mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 1000,
          tokensUsed: 500,
        });
        mockParseJsonlFile.mockRejectedValueOnce(new Error('Parse error'));
        const first = await eng.reviewPR(dedupPr);
        expect(first.verdict.reasoning).toBe('Failed to parse review output');

        await eng.reviewPR(dedupPr);
        expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      });

      it('does not cache an all-batches-failed review (retry re-runs the pipeline)', async () => {
        const eng = makeRepoEngine();
        const multiFilePr = makePRContext({
          number: 904,
          headSha: 'multi-batch-hash',
          changedFiles: [
            { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 0 },
            { path: 'src/b.ts', status: 'modified', additions: 10, deletions: 0 },
            { path: 'src/c.ts', status: 'modified', additions: 10, deletions: 0 },
            { path: 'src/d.ts', status: 'modified', additions: 10, deletions: 0 },
          ],
        });
        mockRunOpenCode.mockResolvedValue({
          success: false,
          output: '',
          durationMs: 500,
          tokensUsed: 0,
        });
        const first = await eng.reviewPR(multiFilePr);
        expect(first.verdict.reasoning).toBe('All review batches failed');

        await eng.reviewPR(multiFilePr);
        // Second run re-runs the pipeline (the failure must NOT be cached).
        expect(mockRunOpenCode.mock.calls.length).toBeGreaterThanOrEqual(4);
      });

      it('does not leak an unhandled rejection when the review pipeline rejects', async () => {
        const eng = makeRepoEngine();
        // Force the pipeline to reject outright (a genuine throw, not a
        // fallback emptyResult) so the in-flight entry's cleanup path is hit.
        mockRunOpenCode.mockRejectedValue(new Error('boom'));

        const unhandled: unknown[] = [];
        const listener = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', listener);
        try {
          await expect(eng.reviewPR(dedupPr)).rejects.toThrow('boom');
        } finally {
          process.off('unhandledRejection', listener);
        }

        // Allow the microtask queue to flush any leaked derived promise.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toHaveLength(0);
      });
    });

    describe('multi-agent review path (single-process subagent dispatch)', () => {
      const agentPr = makePRContext();

      function makeMultiAgentEngine(): ReviewEngine {
        return new ReviewEngine(
          makeConfig({
            multiAgent: {
              enabled: true,
              agents: {
                security: { enabled: true },
                performance: { enabled: false },
                quality: { enabled: false },
                logic: { enabled: false },
              },
              synthesis: { enabled: false },
            },
          }),
          mockAdapter,
        );
      }

      it('runs a single opencode process with subagents injected, then parses the consolidated output', async () => {
        const eng = makeMultiAgentEngine();
        let capturedSubagents: unknown;
        mockRunOpenCode.mockImplementation(async (_p: string, opts?: { subagents?: unknown }) => {
          capturedSubagents = opts?.subagents;
          return { success: true, output: '', durationMs: 500, tokensUsed: 10 };
        });
        mockParseJsonlFile.mockResolvedValue({
          ...mockEmptyResult(),
          summary: 'consolidated',
          issues: [
            {
              type: 'issue',
              severity: 'critical',
              file: 'src/test.ts',
              line: 42,
              message: 'SQL injection',
              agent: 'security',
              category: 'security',
            },
          ],
        });

        const result = await eng.reviewPR(agentPr);

        // One process for the whole multi-agent review (no per-category spawns,
        // no separate synthesis pass).
        expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
        // The injected subagents include the active category as a read-only
        // subagent definition keyed by its agent name.
        expect(capturedSubagents).toBeDefined();
        const subagents = capturedSubagents as Record<string, Record<string, unknown>>;
        expect(subagents['security-reviewer']).toBeDefined();
        expect(subagents['security-reviewer'].mode).toBe('subagent');
        expect(subagents['security-reviewer'].permission).toEqual({
          edit: 'deny',
          bash: 'deny',
        });
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].agent).toBe('security');
      });

      it('emits a single streaming batch completion for the orchestrator run', async () => {
        const eng = makeMultiAgentEngine();
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 500,
          tokensUsed: 10,
        });
        mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

        const batches: number[] = [];
        await eng.reviewPR(
          agentPr,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          async (batchIndex, totalBatches) => {
            batches.push(batchIndex);
            expect(totalBatches).toBe(1);
          },
        );

        expect(batches).toHaveLength(1);
        expect(batches[0]).toBe(0);
      });

      it('reports a failed orchestrator run as not ready', async () => {
        const eng = makeMultiAgentEngine();
        mockRunOpenCode.mockResolvedValue({
          success: false,
          output: '',
          durationMs: 500,
          tokensUsed: 10,
        });
        mockParseJsonlFile.mockRejectedValue(new Error('no output'));

        const result = await eng.reviewPR(agentPr);

        expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
        expect(result.verdict.ready).toBe(false);
        expect(result.verdict.reasoning).toBe('All review agents failed');
        expect(result.failedAgents).toBe(1);
      });

      it('degrades to a failed verdict when the consolidated output cannot be parsed', async () => {
        const eng = makeMultiAgentEngine();
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 500,
          tokensUsed: 10,
        });
        mockParseJsonlFile.mockRejectedValue(new Error('bad jsonl'));

        const result = await eng.reviewPR(agentPr);

        expect(result.verdict.ready).toBe(false);
        expect(result.verdict.reasoning).toBe('Review output could not be parsed');
        expect(result.failedAgents).toBe(1);
      });

      it('reports no issues when the orchestrator produces a clean verdict', async () => {
        const eng = makeMultiAgentEngine();
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 500,
          tokensUsed: 10,
        });
        mockParseJsonlFile.mockResolvedValue({
          ...mockEmptyResult(),
          summary: 'No issues found',
          verdict: {
            ready: true,
            reasoning: 'No issues found',
            autoFixable: false,
            confidence: 'high',
          },
        });

        const result = await eng.reviewPR(agentPr);

        expect(result.issues).toHaveLength(0);
        expect(result.summary).toBe('No issues found');
        expect(result.verdict.reasoning).toBe('No issues found');
        expect(result.verdict.ready).toBe(true);
      });

      it('forwards custom promptFile and promptExtra into the orchestrator prompt', async () => {
        const customFile = path.join(process.cwd(), `.tmp-agent-engine-${Date.now()}.md`);
        fs.writeFileSync(customFile, 'CUSTOM_ENGINE_AGENT_PROMPT');
        let capturedPrompt = '';
        try {
          const eng = makeMultiAgentEngine();
          mockRunOpenCode.mockImplementation(async (p: string) => {
            capturedPrompt = p;
            return { success: true, output: '', durationMs: 500, tokensUsed: 10 };
          });
          mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

          await eng.reviewPR(agentPr, 0, path.basename(customFile), 'EXTRA_AGENT_INSTRUCTIONS');

          expect(capturedPrompt.startsWith('CUSTOM_ENGINE_AGENT_PROMPT')).toBe(true);
          expect(capturedPrompt).toContain('EXTRA_AGENT_INSTRUCTIONS');
        } finally {
          fs.unlinkSync(customFile);
        }
      });

      it('continues past a thrown runOpenCode and reports the all-failed run as not ready', async () => {
        const eng = makeMultiAgentEngine();
        mockRunOpenCode.mockRejectedValue(new Error('model outage'));
        mockParseJsonlFile.mockRejectedValue(new Error('no output'));

        const result = await eng.reviewPR(agentPr);

        expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
        expect(result.verdict.ready).toBe(false);
        expect(result.verdict.reasoning).toBe('All review agents failed');
        expect(result.failedAgents).toBe(1);
      });

      it('uses the reviewModel for the orchestrator run', async () => {
        const eng = makeMultiAgentEngine();
        let capturedModel = '';
        mockRunOpenCode.mockImplementation(async (_p: string, opts?: { model?: string }) => {
          capturedModel = opts?.model ?? '';
          return { success: true, output: '', durationMs: 500, tokensUsed: 10 };
        });
        mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

        await eng.reviewPR(agentPr);

        expect(capturedModel).toBe(DEFAULT_CONFIG.reviewModel);
      });

      it('preserves the orchestrator findings (no linters configured)', async () => {
        const eng = makeMultiAgentEngine();
        const dedupedResult: ReviewResult = {
          ...mockEmptyResult(),
          issues: [
            {
              type: 'issue',
              severity: 'important',
              file: 'src/test.ts',
              line: 42,
              message: 'SQL injection',
              agent: 'security',
            },
          ],
        };
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 500,
          tokensUsed: 10,
        });
        mockParseJsonlFile.mockResolvedValue(dedupedResult);
        const result = await eng.reviewPR(agentPr);

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toBe('SQL injection');
      });

      it('treats a run with no substantive output as a failed review (dispatch guard)', async () => {
        const eng = makeMultiAgentEngine();
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 500,
          tokensUsed: 10,
        });
        // A parseable but completely empty result (no issues, strengths,
        // summary, or verdict reasoning) means the orchestrator likely failed
        // to dispatch the subagents — never report it as a clean review.
        mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

        const result = await eng.reviewPR(agentPr);

        expect(result.verdict.ready).toBe(false);
        expect(result.verdict.reasoning).toBe('All review agents failed');
        expect(result.failedAgents).toBe(1);
      });

      it('forwards open human-thread context into the orchestrator prompt', async () => {
        const eng = makeMultiAgentEngine();
        vi.mocked(mockAdapter.getOpenHumanThreads).mockResolvedValue(
          '## Open Review Threads (Unresolved)\n\n### Thread on `src/test.ts:1`\nAlready fixed in a later commit.',
        );
        let capturedPrompt = '';
        mockRunOpenCode.mockImplementation(async (p: string) => {
          capturedPrompt = p;
          return { success: true, output: '', durationMs: 500, tokensUsed: 10 };
        });
        mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

        await eng.reviewPR(agentPr);

        expect(capturedPrompt).toContain('## Open Review Threads (Unresolved)');
        expect(capturedPrompt).toContain('Already fixed in a later commit.');
      });
    });

    it('builds the codebase index from the git repo root so cross-file context matches in a monorepo subdirectory', async () => {
      // Repo-root-relative ChangedFile.path values (e.g. "packages/app/src/util.ts")
      // only match index entries when the index is rooted at the git top-level,
      // not at the working directory (packages/app).
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-repo-'));
      const appDir = path.join(repoRoot, 'packages', 'app');
      fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'src', 'util.ts'), 'export function helper(): void {}');
      fs.writeFileSync(
        path.join(appDir, 'src', 'consumer.ts'),
        "import { helper } from './util.js';\nexport function run(): void { helper(); }",
      );
      try {
        vi.mocked(cp.execFile).mockImplementation(((
          _cmd: string,
          args: unknown,
          _opts: unknown,
          cb: unknown,
        ) => {
          const argList = args as string[];
          const callback = cb as (err: Error | null, stdout: string) => void;
          if (argList[0] === 'rev-parse') {
            callback(null, `${repoRoot}\n`);
            return;
          }
          if (argList[0] === 'status') {
            callback(null, '');
            return;
          }
          callback(null, '');
        }) as typeof cp.execFile);

        const monorepoPr = makePRContext({
          changedFiles: [
            {
              path: 'packages/app/src/util.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
            },
          ],
        });
        const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
        mockRunOpenCode.mockResolvedValue({
          success: true,
          output: '',
          durationMs: 1000,
          tokensUsed: 100,
        });
        mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

        await eng.reviewPR(
          monorepoPr,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          appDir,
        );

        const optionsArg = mockBuildReviewPrompt.mock.calls[0][2] as {
          codebaseIndexContext?: string;
        };
        expect(optionsArg.codebaseIndexContext ?? '').toContain('helper');
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('invokes onBatchComplete for completed batches with per-batch results', async () => {
      const learningStore = {
        getRelevantLessons: vi.fn().mockResolvedValue([]),
        getFalsePositiveRules: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      };
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        mockAdapter,
        learningStore as never,
      );
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const onBatchComplete = vi.fn().mockResolvedValue(undefined);
      await eng.reviewPR(
        pr,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onBatchComplete,
      );

      expect(onBatchComplete).toHaveBeenCalled();
      const calls = onBatchComplete.mock.calls as Array<[number, number, ReviewResult]>;
      for (const [idx, total, batchResult] of calls) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(total).toBeGreaterThanOrEqual(1);
        expect(batchResult).toBeDefined();
      }
    });

    it('does not fail the review when onBatchComplete throws', async () => {
      const learningStore = {
        getRelevantLessons: vi.fn().mockResolvedValue([]),
        getFalsePositiveRules: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      };
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        mockAdapter,
        learningStore as never,
      );
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const onBatchComplete = vi.fn().mockRejectedValue(new Error('stream broke'));
      const result = await eng.reviewPR(
        pr,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onBatchComplete,
      );

      expect(result).toBeDefined();
      expect(onBatchComplete).toHaveBeenCalled();
    });
  });

  describe('runFix()', () => {
    const contextMarkdown = '## PR Context\nSome context';

    it('returns FixResult with changes on success', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue(' M src/test.ts\n');

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 2000 });

      const result = await engine.runFix(42, 1, contextMarkdown);

      expect(result.changesMade).toBe(true);
      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'fix prompt',
        expect.objectContaining({ model: DEFAULT_CONFIG.fixModel }),
      );
    });

    it('returns changesMade=false when no git changes', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 2000 });

      const result = await engine.runFix(42, 1, contextMarkdown);

      expect(result.changesMade).toBe(false);
      expect(result.filesChanged).toEqual([]);
    });

    it('handles runOpenCode failure and checks partial output', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue(' M src/test.ts\n');

      mockRunOpenCode.mockResolvedValue({ success: false, output: '', durationMs: 3000 });

      const result = await engine.runFix(42, 1, contextMarkdown);

      expect(result.changesMade).toBe(true);
    });

    it('reads .fix-stuck.md and .fix-summary.md if present', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue(' M src/test.ts\n');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const fsPromises = fs.promises;
      vi.mocked(fsPromises.readFile).mockImplementation(async (path: string) => {
        if (path.includes('.fix-stuck.md')) return 'stuck on merge conflict';
        if (path.includes('.fix-summary.md')) return 'Fixed all issues';
        throw new Error('ENOENT');
      });
      vi.mocked(fsPromises.unlink).mockResolvedValue(undefined);

      const result = await engine.runFix(42, 1, contextMarkdown);

      expect(result.stuck).toBe(true);
      expect(result.stuckReason).toBe('stuck on merge conflict');
      expect(result.summary).toBe('Fixed all issues');
    });

    it('handles MCP errors gracefully in runFix', async () => {
      mockMCPConnect.mockRejectedValue(new Error('MCP connection failed'));
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const result = await engine.runFix(42, 1, contextMarkdown);

      expect(result.changesMade).toBe(false);
    });

    it('uses cachedPR for MCP when provided', async () => {
      const cachedPR = makePRContext({
        changedFiles: [{ path: 'src/app.tsx', status: 'added', additions: 50, deletions: 0 }],
      });
      mockMCPConnect.mockResolvedValue(undefined);
      mockMCPGetLibraryDocs.mockResolvedValue('react docs');
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      await engine.runFix(42, 1, contextMarkdown, cachedPR);

      expect(mockGitHubGetPR).not.toHaveBeenCalled();
    });

    it('skips MCP when no servers configured', async () => {
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const result = await eng.runFix(42, 1, contextMarkdown);

      expect(mockMCPConnect).not.toHaveBeenCalled();
      expect(result.changesMade).toBe(false);
    });

    it('handles readFile errors for .fix-stuck.md and .fix-summary.md', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const result = await engine.runFix(42, 1, contextMarkdown);

      expect(result.stuck).toBe(false);
      expect(result.summary).toBeUndefined();
    });
  });

  describe('runDocs()', () => {
    const contextMarkdown = '## PR Context\nSome context';
    const pr = makePRContext({
      changedFiles: [{ path: 'src/example.ts', status: 'modified', additions: 20, deletions: 0 }],
    });
    // runDocs gates on docs.enabled, so exercise it with the flag enabled.
    let docsEngine: ReviewEngine;

    beforeEach(() => {
      docsEngine = new ReviewEngine(
        makeConfig({ docs: { enabled: true, style: 'auto' } }),
        mockAdapter,
      );
    });

    it('returns FixResult with changes on success', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue(' M src/example.ts\n');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 2000 });

      const result = await docsEngine.runDocs(pr, contextMarkdown);

      expect(result.changesMade).toBe(true);
      expect(mockBuildDocsPrompt).toHaveBeenCalled();
      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'docs prompt',
        expect.objectContaining({ model: DEFAULT_CONFIG.reviewModel }),
      );
    });

    it('returns changesMade=false when no git changes', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 2000 });

      const result = await docsEngine.runDocs(pr, contextMarkdown);

      expect(result.changesMade).toBe(false);
      expect(result.filesChanged).toEqual([]);
    });

    it('reads .docs-summary.md if present', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue(' M src/example.ts\n');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const fsPromises = fs.promises;
      vi.mocked(fsPromises.readFile).mockImplementation(async (path: string) => {
        if (path.includes('.docs-summary.md')) return 'Documented the changed API';
        throw new Error('ENOENT');
      });
      vi.mocked(fsPromises.unlink).mockResolvedValue(undefined);

      const result = await docsEngine.runDocs(pr, contextMarkdown);

      expect(result.summary).toBe('Documented the changed API');
    });

    it('passes the doc style to the prompt builder', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue('');

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      await docsEngine.runDocs(pr, contextMarkdown, undefined, undefined, 'tsdoc');

      expect(mockBuildDocsPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'tsdoc',
      );
    });

    it('handles runOpenCode failure and checks partial output', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      mockedGetGitStatus.mockReturnValue(' M src/example.ts\n');

      mockRunOpenCode.mockResolvedValue({ success: false, output: '', durationMs: 3000 });

      const result = await docsEngine.runDocs(pr, contextMarkdown);

      expect(result.changesMade).toBe(true);
    });

    it('skips the run entirely when docs are disabled', async () => {
      const disabledEngine = new ReviewEngine(makeConfig(), mockAdapter);

      const result = await disabledEngine.runDocs(pr, contextMarkdown);

      expect(result.changesMade).toBe(false);
      expect(result.filesChanged).toEqual([]);
      expect(result.summary).toBeUndefined();
      expect(mockRunOpenCode).not.toHaveBeenCalled();
    });

    it('does not report changes when only .docs-summary.md was written', async () => {
      const mockedGetGitStatus = vi.mocked(getGitStatus);
      const fsPromises = fs.promises;
      let summaryUnlinked = false;
      vi.mocked(fsPromises.unlink).mockImplementation(async (path: string) => {
        if (String(path).includes('.docs-summary.md')) summaryUnlinked = true;
        return undefined;
      });
      vi.mocked(fsPromises.readFile).mockImplementation(async (path: string) => {
        if (String(path).includes('.docs-summary.md')) return 'Summary only';
        throw new Error('ENOENT');
      });
      // Simulate a workspace whose only untracked file is the summary marker:
      // once the engine removes it, git status is clean. If the engine checked
      // status before consuming the marker, the untracked file would report a
      // change that does not exist after cleanup.
      mockedGetGitStatus.mockImplementation(() => (summaryUnlinked ? '' : '?? .docs-summary.md\n'));

      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const result = await docsEngine.runDocs(pr, contextMarkdown);

      expect(result.changesMade).toBe(false);
      expect(result.filesChanged).toEqual([]);
      expect(result.summary).toBe('Summary only');
    });
  });

  describe('runDescribe()', () => {
    const contextMarkdown = '## PR Context\nSome context';
    const pr = makePRContext({
      changedFiles: [{ path: 'src/example.ts', status: 'modified', additions: 20, deletions: 0 }],
    });

    it('returns a non-empty description on success', async () => {
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: 'PR description',
        durationMs: 1500,
      });

      const result = await engine.runDescribe(pr, contextMarkdown);

      expect(mockBuildDescribePrompt).toHaveBeenCalled();
      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'describe prompt',
        expect.objectContaining({ model: DEFAULT_CONFIG.reviewModel }),
      );
      expect(result).toContain('PR description');
    });

    it('uses the resolved describe model override when configured', async () => {
      const describeEngine = new ReviewEngine(makeConfig({ describeModel: 'gpt-4o' }), mockAdapter);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      await describeEngine.runDescribe(pr, contextMarkdown);

      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'describe prompt',
        expect.objectContaining({ model: 'gpt-4o' }),
      );
    });

    it('returns a fallback message when runOpenCode fails', async () => {
      mockRunOpenCode.mockResolvedValue({ success: false, output: '', durationMs: 500 });

      const result = await engine.runDescribe(pr, contextMarkdown);

      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('runAudit()', () => {
    it('returns audit result on success', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1500 });

      const expectedResult: ReviewResult = {
        summary: 'Audit complete',
        verdict: {
          ready: false,
          reasoning: 'Issues found',
          autoFixable: true,
          confidence: 'medium',
        },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      mockParseJsonlFile.mockResolvedValue(expectedResult);

      const result = await engine.runAudit('audit prompt content', './src', 'security');

      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'audit prompt',
        expect.objectContaining({ model: DEFAULT_CONFIG.reviewModel }),
      );
      expect(result).toEqual(expectedResult);
    });

    it('returns empty result when runOpenCode fails', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: false, output: '', durationMs: 500 });

      const result = await engine.runAudit('audit prompt', './src', 'security');

      expect(result.verdict.reasoning).toBe('Audit execution failed');
    });

    it('returns empty result when parseJsonlFile fails', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockRejectedValue(new Error('Parse error'));

      const result = await engine.runAudit('audit prompt', './src', 'security');

      expect(result.verdict.reasoning).toBe('Failed to parse audit output');
    });

    it('handles MCP connection failure gracefully', async () => {
      mockMCPConnect.mockRejectedValue(new Error('MCP failed'));
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await engine.runAudit('audit prompt', './src', 'security');

      expect(result.verdict).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('skips MCP when enableMCP is false', async () => {
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.runAudit('audit prompt', './src', 'security');

      expect(mockMCPConnect).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('merges deterministic secret findings into the audit result', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const GITHUB_PAT = ['ghp_', 'aBcDeFgHiJkLmNOpQrStUvWxYz', '0123456789'].join('');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-audit-secrets-'));
      try {
        fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'src', 'config.ts'), `const t = "${GITHUB_PAT}"`, 'utf-8');
        // Route the (mocked) readFile so only our fixture carries a secret.
        vi.mocked(fs.promises.readFile).mockImplementation(async (p: string | URL | number) => {
          const full = String(p);
          if (full.includes('config.ts')) return Buffer.from(`const t = "${GITHUB_PAT}"`);
          return Buffer.from('');
        });

        const result = await engine.runAudit('audit prompt', 'src', 'security', undefined, tmp);

        const secretIssue = result.issues.find((i) => i.message.startsWith('Hardcoded'));
        expect(secretIssue).toBeDefined();
        expect(secretIssue!.severity).toBe('critical');
        expect(secretIssue!.file).toBe('src/config.ts');
        expect(secretIssue!.inline).toBe(true);
        expect(secretIssue!.message).not.toContain(GITHUB_PAT);
        expect(result.stats.critical).toBe(1);
        expect(result.stats.total).toBe(1);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('runAnalyze()', () => {
    const issueContextMarkdown = '## Issue #123\nSome description';

    it('returns analysis plan markdown on success', async () => {
      const engWithMCP = new ReviewEngine(
        makeConfig({
          enableMCP: true,
          mcpServers: [{ name: 'context7', type: 'local', command: ['node', 'server.js'] }],
        }),
        mockAdapter,
      );
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const fsPromises = fs.promises;
      vi.mocked(fsPromises.readFile).mockResolvedValue('# Implementation Plan\n\n1. Fix the bug');
      vi.mocked(fsPromises.unlink).mockResolvedValue(undefined);

      const result = await engWithMCP.runAnalyze(123, issueContextMarkdown);

      expect(mockBuildAnalyzePrompt).toHaveBeenCalledWith(
        { projectContext: DEFAULT_CONFIG.projectContext.description || undefined },
        issueContextMarkdown,
      );
      expect(mockRunOpenCode).toHaveBeenCalledWith(
        'analyze prompt',
        expect.objectContaining({ model: DEFAULT_CONFIG.reviewModel, timeoutMinutes: 10 }),
      );
      expect(result).toBe('# Implementation Plan\n\n1. Fix the bug');
    });

    it('returns error markdown when runOpenCode fails', async () => {
      mockRunOpenCode.mockResolvedValue({ success: false, output: '', durationMs: 500 });

      const result = await engine.runAnalyze(123, issueContextMarkdown);

      expect(result).toBe(
        '⚠️ **Analysis Failed**: OpenCode CLI was unable to complete the codebase analysis.',
      );
    });

    it('returns error markdown when analysis-plan.md cannot be read', async () => {
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const fsPromises = fs.promises;
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));

      const result = await engine.runAnalyze(123, issueContextMarkdown);

      expect(result).toBe(
        '⚠️ **Analysis Error**: Could not read generated `.opencode/analysis-plan.md` file.',
      );
    });

    it('works with custom config', async () => {
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

      const fsPromises = fs.promises;
      vi.mocked(fsPromises.readFile).mockResolvedValue('# Plan');
      vi.mocked(fsPromises.unlink).mockResolvedValue(undefined);

      const result = await eng.runAnalyze(123, issueContextMarkdown);

      expect(result).toBe('# Plan');
    });
  });

  describe('buildPRContextString() patch truncation', () => {
    it('truncates patch when exceeding maxLinesPerFile', async () => {
      const lineCount = 1000;
      const maxLines = 100;
      const lines = Array.from({ length: lineCount }, (_, i) => `+line ${i + 1}`);
      const patch = lines.join('\n');

      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/large.ts',
            status: 'modified' as const,
            additions: 200,
            deletions: 800,
            patch,
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({ maxLinesPerFile: maxLines, enableMCP: false, mcpServers: [] }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];

      expect(contextArg).toContain('### File Diffs');
      expect(contextArg).toContain(
        `[Patch truncated: ${lineCount - maxLines} remaining lines omitted. Use the 'read' tool to inspect the full file at src/large.ts]`,
      );
      expect(contextArg).toContain('+line 1');
      expect(contextArg).toContain('+line 100');
      expect(contextArg).not.toContain('+line 101');
    });

    it('does not truncate patches within maxLinesPerFile', async () => {
      const patch = '+line 1\n+line 2\n+line 3';

      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/small.ts',
            status: 'modified' as const,
            additions: 3,
            deletions: 0,
            patch,
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({ maxLinesPerFile: 100, enableMCP: false, mcpServers: [] }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];

      expect(contextArg).toContain('+line 1');
      expect(contextArg).toContain('+line 3');
      expect(contextArg).not.toContain('[Patch truncated');
    });

    it('includes patches for all files even when some exceed maxLinesPerFile', async () => {
      const largeLines = Array.from({ length: 200 }, (_, i) => `+large ${i + 1}`);
      const largePatch = largeLines.join('\n');

      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/large.ts',
            status: 'modified' as const,
            additions: 100,
            deletions: 100,
            patch: largePatch,
          },
          {
            path: 'src/small.ts',
            status: 'added' as const,
            additions: 2,
            deletions: 0,
            patch: '+new file\n+second line',
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({ maxLinesPerFile: 50, enableMCP: false, mcpServers: [] }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];

      expect(contextArg).toContain('[Patch truncated: 150 remaining lines omitted');
      expect(contextArg).toContain('**src/small.ts** (2 lines):');
      expect(contextArg).toContain('+new file');
    });
  });

  describe('git blame awareness', () => {
    const PR_COMMIT = 'f0e2a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c';
    const OLD_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e';

    function porcelainOutput(): string {
      return [
        `${OLD_COMMIT} 1 1 1`,
        'author Alice',
        'author-mail <alice@example.com>',
        'author-time 1700000000',
        'author-tz +0000',
        'committer Alice',
        'committer-mail <alice@example.com>',
        'committer-time 1700000000',
        'committer-tz +0000',
        'summary Old code',
        '\tpre-existing line',
        `${PR_COMMIT} 1 2 1`,
        'author Bob',
        'author-mail <bob@example.com>',
        'author-time 1720000000',
        'author-tz +0000',
        'committer Bob',
        'committer-mail <bob@example.com>',
        'committer-time 1720000000',
        'committer-tz +0000',
        'summary New code',
        '\tnew line',
      ].join('\n');
    }

    it('renders per-file blame annotations inside buildPRContextString', () => {
      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+ new',
          },
        ],
      });
      const blameData = new Map<string, Map<number, import('../src/types/index.js').BlameInfo>>([
        [
          'src/test.ts',
          new Map([
            [1, { commitSha: OLD_COMMIT, author: 'Alice', date: '2023-11-14', isInPRDiff: false }],
            [2, { commitSha: PR_COMMIT, author: 'Bob', date: '2024-07-03', isInPRDiff: true }],
          ]),
        ],
      ]);

      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      const { context } = eng.buildPRContextString(pr, undefined, false, blameData);

      expect(context).toContain('### Git Blame Annotations');
      expect(context).toContain(
        `- Line 1 — pre-existing @Alice, 2023-11-14, ${OLD_COMMIT.slice(0, 7)}`,
      );
      expect(context).toContain(
        `- Line 2 — [PR CHANGE] @Bob, 2024-07-03, ${PR_COMMIT.slice(0, 7)}`,
      );
    });

    it('collapses contiguous lines with identical blame into a range', () => {
      const pr = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified' as const, additions: 3, deletions: 0, patch: 'x' },
        ],
      });
      const blameData = new Map([
        [
          'src/a.ts',
          new Map([
            [10, { commitSha: OLD_COMMIT, author: 'Alice', date: '2023-11-14', isInPRDiff: false }],
            [11, { commitSha: OLD_COMMIT, author: 'Alice', date: '2023-11-14', isInPRDiff: false }],
            [12, { commitSha: PR_COMMIT, author: 'Bob', date: '2024-07-03', isInPRDiff: true }],
          ]),
        ],
      ]);

      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      const { context } = eng.buildPRContextString(pr, undefined, false, blameData);

      expect(context).toContain('- Lines 10-11 — pre-existing @Alice, 2023-11-14');
      expect(context).toContain('- Line 12 — [PR CHANGE] @Bob, 2024-07-03');
    });

    it('injects blame annotations into the review context via reviewPR', async () => {
      const pr = makePRContext({
        baseSha: 'b'.repeat(40),
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+new\n+extra',
          },
        ],
      });
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);

      vi.mocked(cp.execFile).mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        if (args[0] === 'rev-list') callback(null, PR_COMMIT);
        else if (args[0] === 'blame') callback(null, porcelainOutput());
        else callback(null, '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).toContain('### Git Blame Annotations');
      expect(contextArg).toContain('[PR CHANGE]');
      expect(contextArg).toContain('pre-existing');
      expect(mockBuildReviewPrompt.mock.calls[0][2]).toMatchObject({ blameAware: true });
    });

    it('skips blame when includePreExisting enables full audit mode', async () => {
      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 1,
            deletions: 0,
            patch: '@@ -1 +1 @@\n- old\n+new',
          },
        ],
      });
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [], review: { includePreExisting: true } }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).not.toContain('### Git Blame Annotations');
      expect(mockBuildReviewPrompt.mock.calls[0][2]).toMatchObject({ blameAware: false });
    });

    it('blames from the resolved repository root and at the head commit', async () => {
      const pr = makePRContext({
        baseSha: 'b'.repeat(40),
        headSha: 'abcdef1234567890',
        changedFiles: [
          {
            path: 'packages/app/src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+new',
          },
        ],
      });
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);

      vi.mocked(cp.execFile).mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        if (args[0] === 'rev-parse') callback(null, '/resolved/repo/root');
        else if (args[0] === 'rev-list') callback(null, PR_COMMIT);
        else if (args[0] === 'blame') callback(null, porcelainOutput());
        else callback(null, '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const blameCall = vi.mocked(cp.execFile).mock.calls.find((c) => c[1][0] === 'blame');
      expect(blameCall).toBeDefined();
      // Repo-root-relative paths are resolved against the git top-level, not workDir.
      expect(blameCall![2]).toMatchObject({ cwd: '/resolved/repo/root' });
      // Blame runs against the head commit so line numbers align with the patch.
      expect(blameCall![1]).toContain('abcdef1234567890');
    });

    it('derives the per-file blame cap from the configured splitThreshold', async () => {
      // A tiny configured splitThreshold means the 2-line hunk exceeds the cap,
      // so blame is skipped entirely for the file (observable: no blame call).
      const pr = makePRContext({
        baseSha: 'b'.repeat(40),
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+new',
          },
        ],
      });
      const eng = new ReviewEngine(
        makeConfig({
          enableMCP: false,
          mcpServers: [],
          review: { reviewBudget: { enabled: true, summaryThreshold: 500, splitThreshold: 1 } },
        }),
        mockAdapter,
      );

      vi.mocked(cp.execFile).mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        if (args[0] === 'rev-list') callback(null, PR_COMMIT);
        else callback(null, '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const blameCall = vi.mocked(cp.execFile).mock.calls.find((c) => c[1][0] === 'blame');
      expect(blameCall).toBeUndefined();
      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).not.toContain('### Git Blame Annotations');
      expect(mockBuildReviewPrompt.mock.calls[0][2]).toMatchObject({ blameAware: false });
    });

    it('renders uncommitted lines as working-tree changes', () => {
      const pr = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: 'x' },
        ],
      });
      const blameData = new Map<string, Map<number, import('../src/types/index.js').BlameInfo>>([
        [
          'src/a.ts',
          new Map([
            [5, { commitSha: '0'.repeat(40), author: 'Dev', date: '2023-11-14', isInPRDiff: true }],
          ]),
        ],
      ]);
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      const { context } = eng.buildPRContextString(pr, undefined, false, blameData);
      expect(context).toContain('- Line 5 — [PR CHANGE] @Dev, 2023-11-14, working tree');
      expect(context).not.toContain('0000000');
    });

    it('escapes markdown-significant characters in author names', () => {
      const pr = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: 'x' },
        ],
      });
      const blameData = new Map<string, Map<number, import('../src/types/index.js').BlameInfo>>([
        [
          'src/a.ts',
          new Map([
            [
              3,
              { commitSha: OLD_COMMIT, author: 'a*b[c]`d', date: '2023-11-14', isInPRDiff: false },
            ],
          ]),
        ],
      ]);
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      const { context } = eng.buildPRContextString(pr, undefined, false, blameData);
      expect(context).toContain('@a\\*b\\[c\\]\\`d');
    });

    it('omits blame annotations for lines hidden by patch truncation', () => {
      const body = Array.from({ length: 30 }, (_, i) => ` line${i + 1}`).join('\n');
      const patch = '@@ -1,31 +1,31 @@\n' + body + '\n+newline';
      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/big.ts',
            status: 'modified' as const,
            additions: 1,
            deletions: 0,
            patch,
          },
        ],
      });
      const blameData = new Map<string, Map<number, import('../src/types/index.js').BlameInfo>>([
        [
          'src/big.ts',
          new Map([
            [1, { commitSha: OLD_COMMIT, author: 'Alice', date: '2023-11-14', isInPRDiff: false }],
            [15, { commitSha: PR_COMMIT, author: 'Bob', date: '2024-07-03', isInPRDiff: true }],
            [31, { commitSha: PR_COMMIT, author: 'Bob', date: '2024-07-03', isInPRDiff: true }],
          ]),
        ],
      ]);
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [], maxLinesPerFile: 6 }),
        mockAdapter,
      );
      const { context } = eng.buildPRContextString(pr, undefined, false, blameData);
      expect(context).toContain('[Patch truncated:');
      // Line 1 is inside the first 6 patch lines; 15 and 31 are not.
      expect(context).toContain('- Line 1 — pre-existing @Alice');
      expect(context).not.toContain('- Line 15 —');
      expect(context).not.toContain('- Line 31 —');
      expect(context).toContain(
        'blame annotations for 2 line(s) past the truncated diff are omitted',
      );
    });

    it('filters batch blame data down to each batch file set', async () => {
      const pr = makePRContext({
        baseSha: 'b'.repeat(40),
        changedFiles: ['a', 'b', 'c', 'd'].map((name) => ({
          path: `src/${name}.ts`,
          status: 'modified' as const,
          additions: 2,
          deletions: 0,
          patch: '@@ -1,2 +1,2 @@\n- old\n+new',
        })),
      });
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [], batchSize: 2 }),
        mockAdapter,
      );

      vi.mocked(cp.execFile).mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        if (args[0] === 'rev-list') callback(null, PR_COMMIT);
        else if (args[0] === 'blame') callback(null, porcelainOutput());
        else callback(null, '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());
      mockMCPConnect.mockResolvedValue(undefined);

      await eng.reviewPR(pr);

      // Batch 0 covers a.ts/b.ts, batch 1 covers c.ts/d.ts. Each batch prompt
      // only renders blame annotations for the files in that batch.
      const batch0Context = mockBuildReviewPrompt.mock.calls[0][1];
      const batch1Context = mockBuildReviewPrompt.mock.calls[1][1];
      expect(batch0Context).toContain('**src/a.ts**');
      expect(batch0Context).toContain('### Git Blame Annotations');
      expect(batch0Context).not.toContain('**src/c.ts**');
      expect(batch1Context).toContain('**src/c.ts**');
      expect(batch1Context).toContain('### Git Blame Annotations');
      expect(batch1Context).not.toContain('**src/a.ts**');
    });

    it('falls back to merge-base when baseSha is unavailable', async () => {
      const pr = makePRContext({
        baseRef: 'main',
        baseSha: undefined,
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+new',
          },
        ],
      });
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);

      vi.mocked(cp.execFile).mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        if (args[0] === 'merge-base') callback(null, 'MERGE_BASE_SHA');
        else if (args[0] === 'rev-list') callback(null, PR_COMMIT);
        else if (args[0] === 'blame') callback(null, porcelainOutput());
        else callback(null, '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const mergeBaseCall = vi.mocked(cp.execFile).mock.calls.find((c) => c[1][0] === 'merge-base');
      expect(mergeBaseCall).toBeDefined();
      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).toContain('### Git Blame Annotations');
    });

    it('treats the head commit as the PR scope when no base is resolvable', async () => {
      const pr = makePRContext({
        baseRef: '',
        baseSha: undefined,
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+new',
          },
        ],
      });
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);

      vi.mocked(cp.execFile).mockImplementation((_cmd, args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        if (args[0] === 'blame') callback(null, porcelainOutput());
        else callback(null, '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      // Blame still runs, scoped to the head commit.
      const blameCall = vi.mocked(cp.execFile).mock.calls.find((c) => c[1][0] === 'blame');
      expect(blameCall).toBeDefined();
      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).toContain('### Git Blame Annotations');
    });

    it('degrades gracefully when the PR commit scope cannot be resolved', async () => {
      const pr = makePRContext({
        baseSha: 'b'.repeat(40),
        changedFiles: [
          {
            path: 'src/test.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: '@@ -1,2 +1,2 @@\n- old\n+new',
          },
        ],
      });
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);

      vi.mocked(cp.execFile).mockImplementation((_cmd, _args, _opts, cb) => {
        const callback = cb as (err: Error | null, stdout?: string) => void;
        callback(new Error('shallow clone: commit not reachable'), '');
      });
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const blameCall = vi.mocked(cp.execFile).mock.calls.find((c) => c[1][0] === 'blame');
      expect(blameCall).toBeUndefined();
      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).not.toContain('### Git Blame Annotations');
      expect(mockBuildReviewPrompt.mock.calls[0][2]).toMatchObject({ blameAware: false });
    });
  });

  describe('token budget / complexity heuristic', () => {
    it('simple file gets reduced context when token budget is enabled', async () => {
      const smallPatch = '+line 1\n+line 2';
      const pr = makePRContext({
        changedFiles: [
          {
            path: 'simple/config.ts',
            status: 'modified' as const,
            additions: 2,
            deletions: 0,
            patch: smallPatch,
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({
          maxLinesPerFile: 200,
          enableMCP: false,
          mcpServers: [],
          review: {
            ...DEFAULT_CONFIG.review,
            tokenBudget: {
              enabled: true,
              maxLinesComplex: 200,
              maxLinesSimple: 10,
              complexityThreshold: 30,
              simpleThreshold: 10,
            },
          },
        }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).toContain('Token budget:');
      expect(contextArg).toContain('(complexity score:');
    });

    it('complex file gets full context when token budget is enabled', async () => {
      const lines = Array.from(
        { length: 5 },
        (_, i) => `+function foo${i}() {\n+  if (x && y) {\n+    bar();\n+  }\n+}`,
      );
      const patch = lines.join('\n');

      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/complex.ts',
            status: 'modified' as const,
            additions: 100,
            deletions: 20,
            patch,
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({
          maxLinesPerFile: 200,
          enableMCP: false,
          mcpServers: [],
          review: {
            ...DEFAULT_CONFIG.review,
            tokenBudget: {
              enabled: true,
              maxLinesComplex: 200,
              maxLinesSimple: 10,
              complexityThreshold: 30,
              simpleThreshold: 10,
            },
          },
        }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).toContain('Token budget:');
      const scoreMatch = contextArg.match(/complexity score: ([\d.]+)/);
      expect(scoreMatch).not.toBeNull();
      if (scoreMatch) {
        expect(Number.parseFloat(scoreMatch[1])).toBeGreaterThan(30);
      }
      expect(contextArg).not.toContain('[Patch truncated');
    });

    it('all files get equal treatment when token budget is disabled (backward compat)', async () => {
      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/small.ts',
            status: 'modified' as const,
            additions: 3,
            deletions: 0,
            patch: '+line 1\n+line 2\n+line 3',
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({ maxLinesPerFile: 100, enableMCP: false, mcpServers: [] }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).not.toContain('Token budget:');
      expect(contextArg).not.toContain('complexity score:');
    });

    it('no patch files get score 0 and fall back to maxLinesPerFile', async () => {
      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/nopatch.ts',
            status: 'added' as const,
            additions: 100,
            deletions: 0,
          },
        ],
      });

      const eng = new ReviewEngine(
        makeConfig({
          maxLinesPerFile: 200,
          enableMCP: false,
          mcpServers: [],
          review: {
            ...DEFAULT_CONFIG.review,
            tokenBudget: {
              enabled: true,
              maxLinesComplex: 200,
              maxLinesSimple: 10,
              complexityThreshold: 30,
              simpleThreshold: 10,
            },
          },
        }),
        mockAdapter,
      );

      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      const contextArg = mockBuildReviewPrompt.mock.calls[0][1];
      expect(contextArg).not.toContain('Token budget:');
      expect(contextArg).not.toContain('**src/nopatch.ts**');
      expect(contextArg).toContain('### Changed Files');
      expect(contextArg).toContain('src/nopatch.ts (added, +100/-0)');
    });
  });

  describe('cleanup()', () => {
    it('completes cleanup successfully', async () => {
      mockMCPDisconnect.mockResolvedValue(undefined);

      await expect(engine.cleanup()).resolves.toBeUndefined();
      expect(mockMCPDisconnect).toHaveBeenCalled();
    });

    it('handles MCP disconnect failure gracefully', async () => {
      mockMCPDisconnect.mockRejectedValue(new Error('Disconnect failed'));

      await expect(engine.cleanup()).resolves.toBeUndefined();
    });

    it('closes learning store when present', async () => {
      const learningStore = {
        close: vi.fn().mockResolvedValue(undefined),
      };
      const eng = new ReviewEngine(makeConfig(), mockAdapter, learningStore as never);
      mockMCPDisconnect.mockResolvedValue(undefined);

      await eng.cleanup();

      expect(learningStore.close).toHaveBeenCalled();
    });

    it('handles learning store close failure gracefully', async () => {
      const learningStore = {
        close: vi.fn().mockRejectedValue(new Error('Close failed')),
      };
      const eng = new ReviewEngine(makeConfig(), mockAdapter, learningStore as never);
      mockMCPDisconnect.mockResolvedValue(undefined);

      await expect(eng.cleanup()).resolves.toBeUndefined();
    });

    it('times out and warns when cleanup takes too long', async () => {
      vi.useFakeTimers();
      try {
        mockMCPDisconnect.mockImplementation(() => new Promise(() => {}));

        const cleanupPromise = engine.cleanup();
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(cleanupPromise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    }, 20000);
  });

  describe('linter integration', () => {
    const mockSpawnSync = vi.mocked(cp.spawnSync);
    const prLinter = makePRContext();

    beforeEach(() => {
      mockSpawnSync.mockReturnValue({
        stdout: '',
        stderr: '',
        status: 0,
        pid: 0,
        output: [],
        signal: null,
      } as never);
    });

    it('skips linters when no linters configured', async () => {
      const eng = new ReviewEngine(makeConfig({ linters: [] }), mockAdapter);

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(prLinter);

      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('runs linters when configured', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          linters: [{ pattern: '**/*.ts', command: 'eslint', args: ['--format', 'json'] }],
        }),
        mockAdapter,
      );

      mockSpawnSync.mockReturnValue({
        stdout: JSON.stringify([
          {
            filePath: 'src/test.ts',
            messages: [
              {
                line: 5,
                column: 1,
                severity: 'warning',
                ruleId: 'no-unused-vars',
                message: 'x is unused',
              },
            ],
          },
        ]),
        stderr: '',
        status: 0,
        pid: 0,
        output: [],
        signal: null,
      } as never);

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(prLinter);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'eslint',
        expect.arrayContaining(['--format', 'json', 'src/test.ts']),
        expect.any(Object),
      );
    });

    it('matches linters only to files matching pattern', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          linters: [{ pattern: '**/*.py', command: 'ruff' }],
        }),
        mockAdapter,
      );
      const pr = makePRContext({
        changedFiles: [
          { path: 'src/test.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' },
          { path: 'src/test.py', status: 'modified', additions: 5, deletions: 1, patch: 'diff' },
        ],
      });

      mockSpawnSync.mockReturnValue({
        stdout: '',
        stderr: '',
        status: 0,
        pid: 0,
        output: [],
        signal: null,
      } as never);

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      // Should only run ruff for .py files, not .ts
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'ruff',
        expect.arrayContaining(['src/test.py']),
        expect.any(Object),
      );
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        'ruff',
        expect.arrayContaining(['src/test.ts']),
        expect.any(Object),
      );
    });

    it('gracefully handles linter failure', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          linters: [{ pattern: '**/*.ts', command: 'eslint' }],
        }),
        mockAdapter,
      );

      mockSpawnSync.mockImplementation(() => {
        throw new Error('Command not found');
      });

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(prLinter);
      expect(result).toBeDefined();
    });

    it('deduplicates AI findings against linter output', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          linters: [{ pattern: '**/*.ts', command: 'eslint', parseFormat: 'eslint' }],
        }),
        mockAdapter,
      );

      mockSpawnSync.mockReturnValue({
        stdout: JSON.stringify([
          {
            filePath: 'src/test.ts',
            messages: [{ line: 5, severity: 2, ruleId: 'no-unused-vars', message: 'x is unused' }],
          },
        ]),
        stderr: '',
        status: 0,
        pid: 0,
        output: [],
        signal: null,
      } as never);

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });

      const aiResult: ReviewResult = {
        summary: 'Found issues',
        verdict: {
          ready: false,
          reasoning: 'Issues found',
          autoFixable: false,
          confidence: 'medium',
        },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'important',
            file: 'src/test.ts',
            line: 5,
            message: 'x is unused, declared but never used',
            suggestion: 'Remove unused variable',
          },
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/test.ts',
            line: 10,
            message: 'SQL injection risk',
            suggestion: 'Use parameterized queries',
          },
        ],
        stats: { total: 2, critical: 1, important: 1, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      mockParseJsonlFile.mockResolvedValue(aiResult);

      const result = await eng.reviewPR(prLinter);

      // Issue at line 5 should be suppressed (linter matches), issue at line 10 should remain
      expect(result.issues.length).toBe(1);
      expect(result.issues[0].line).toBe(10);
      expect(result.issues[0].message).toContain('SQL injection');
      // Stats should reflect dedup
      expect(result.stats.total).toBe(1);
      expect(result.stats.critical).toBe(1);
      expect(result.stats.important).toBe(0);
    });

    it('recalculates stats after dedup', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          linters: [{ pattern: '**/*.ts', command: 'eslint', parseFormat: 'eslint' }],
        }),
        mockAdapter,
      );

      mockSpawnSync.mockReturnValue({
        stdout: JSON.stringify([
          {
            filePath: 'src/test.ts',
            messages: [
              { line: 5, severity: 2, ruleId: 'no-unused-vars', message: 'x is unused' },
              { line: 10, severity: 2, ruleId: 'no-console', message: 'Unexpected console' },
            ],
          },
        ]),
        stderr: '',
        status: 0,
        pid: 0,
        output: [],
        signal: null,
      } as never);

      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });

      const aiResult: ReviewResult = {
        summary: 'Test',
        verdict: { ready: false, reasoning: 'test', autoFixable: false, confidence: 'low' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/test.ts',
            line: 5,
            message: 'x is unused, declared but not used',
          },
          {
            type: 'issue',
            severity: 'important',
            file: 'src/test.ts',
            line: 10,
            message: 'Unexpected console statement found',
          },
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/test.ts',
            line: 15,
            message: 'minor style',
          },
        ],
        stats: { total: 3, critical: 1, important: 1, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };
      mockParseJsonlFile.mockResolvedValue(aiResult);

      const result = await eng.reviewPR(prLinter);

      expect(result.issues.length).toBe(1);
      expect(result.stats.total).toBe(1);
      expect(result.stats.critical).toBe(0);
      expect(result.stats.important).toBe(0);
      expect(result.stats.minor).toBe(1);
    });

    it('preserves failedBatches when linter dedup rebuilds the result', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          linters: [{ pattern: '**/*.ts', command: 'eslint', parseFormat: 'eslint' }],
        }),
        mockAdapter,
      );

      // > batchSize (3) files forces the concurrent batch path where
      // failedBatches is tracked.
      const pr = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' },
          { path: 'src/b.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' },
          { path: 'src/c.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' },
          { path: 'src/test.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' },
        ],
      });

      mockSpawnSync.mockReturnValue({
        stdout: JSON.stringify([
          {
            filePath: 'src/test.ts',
            messages: [{ line: 5, severity: 2, ruleId: 'no-unused-vars', message: 'x is unused' }],
          },
        ]),
        stderr: '',
        status: 0,
        pid: 0,
        output: [],
        signal: null,
      } as never);

      mockMCPConnect.mockResolvedValue(undefined);

      // Batch 1 review fails => 1 failed batch; batch 2 and the synthesis pass
      // succeed so the parsed result flows through the linter dedup branch.
      mockRunOpenCode
        .mockResolvedValueOnce({
          success: false,
          output: '',
          durationMs: 1000,
          tokensUsed: 500,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 1000,
          tokensUsed: 500,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 1000,
          tokensUsed: 500,
        });

      const aiResult: ReviewResult = {
        summary: 'Found issues',
        verdict: {
          ready: false,
          reasoning: 'Issues found',
          autoFixable: false,
          confidence: 'medium',
        },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'important',
            file: 'src/test.ts',
            line: 5,
            message: 'x is unused, declared but never used',
            suggestion: 'Remove unused variable',
          },
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/test.ts',
            line: 10,
            message: 'SQL injection risk',
            suggestion: 'Use parameterized queries',
          },
        ],
        stats: { total: 2, critical: 1, important: 1, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      mockParseJsonlFile.mockResolvedValue(aiResult);

      const result = await eng.reviewPR(pr);

      // Dedup fires (line 5 suppressed) but the partial-review marker survives.
      expect(result.issues.length).toBe(1);
      expect(result.failedBatches).toBe(1);
    });
  });

  describe('review budget modes', () => {
    function makePatch(lineCount: number): string {
      return Array.from({ length: lineCount }, (_, i) => `+line ${i + 1}`).join('\n');
    }

    function makeLargePR(lineCount: number): PRContext {
      return makePRContext({
        changedFiles: [
          {
            path: 'src/large.ts',
            status: 'modified' as const,
            additions: lineCount,
            deletions: 0,
            patch: makePatch(lineCount),
          },
        ],
      });
    }

    function makeBudgetEnabledConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
      return makeConfig({
        enableMCP: false,
        mcpServers: [],
        ...overrides,
        review: {
          ...DEFAULT_CONFIG.review,
          reviewBudget: { enabled: true, summaryThreshold: 500, splitThreshold: 1000 },
          ...((overrides.review || {}) as Record<string, unknown>),
        },
      });
    }

    function budgetModeArg(): unknown {
      return mockBuildReviewPrompt.mock.calls[0][2];
    }

    beforeEach(() => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });
    });

    it('uses full mode below the summary threshold', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(makeLargePR(100));

      expect(mockBuildReviewPrompt).toHaveBeenCalled();
      expect(budgetModeArg()).toMatchObject({ budgetMode: 'full', totalDiffLines: 100 });
    });

    it('uses summary mode exactly at the summary threshold (500 lines)', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(makeLargePR(500));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'summary', totalDiffLines: 500 });
      expect(result.summary).not.toContain('Large PR Detected');
    });

    it('uses summary mode at the summary threshold with budget banner', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(makeLargePR(600));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'summary', totalDiffLines: 600 });
      expect(result.summary).not.toContain('Large PR Detected');
    });

    it('uses split mode exactly at the split threshold (1000 lines)', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(makeLargePR(1000));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'split', totalDiffLines: 1000 });
      expect(result.summary).toContain('Large PR Detected');
      expect(result.summary).toContain('split');
    });

    it('uses split mode above the split threshold and prepends a split recommendation', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(makeLargePR(1500));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'split', totalDiffLines: 1500 });
      expect(result.summary).toContain('Large PR Detected');
      expect(result.summary).toContain('split');
    });

    it('always uses full mode when budget review is disabled', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          enableMCP: false,
          mcpServers: [],
          review: {
            ...DEFAULT_CONFIG.review,
            reviewBudget: { enabled: false, summaryThreshold: 500, splitThreshold: 1000 },
          },
        }),
        mockAdapter,
      );
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(makeLargePR(2000));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'full' });
      expect(result.summary).not.toContain('Large PR Detected');
    });

    it('defaults to full mode when reviewBudget is not configured', async () => {
      const eng = new ReviewEngine(makeConfig({ enableMCP: false, mcpServers: [] }), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(makeLargePR(2000));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'full' });
      expect(result.summary).not.toContain('Large PR Detected');
    });

    it('respects custom thresholds', async () => {
      const eng = new ReviewEngine(
        makeConfig({
          enableMCP: false,
          mcpServers: [],
          review: {
            ...DEFAULT_CONFIG.review,
            reviewBudget: { enabled: true, summaryThreshold: 100, splitThreshold: 1000 },
          },
        }),
        mockAdapter,
      );
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(makeLargePR(150));

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'summary' });
    });

    it('computes budget mode from total diff lines across multiple files', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/a.ts',
            status: 'modified' as const,
            additions: 300,
            deletions: 0,
            patch: makePatch(300),
          },
          {
            path: 'src/b.ts',
            status: 'modified' as const,
            additions: 300,
            deletions: 0,
            patch: makePatch(300),
          },
        ],
      });

      await eng.reviewPR(pr);

      expect(budgetModeArg()).toMatchObject({ budgetMode: 'summary', totalDiffLines: 600 });
    });

    it('does not inject budget-mode instructions into per-batch prompts', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig({ batchSize: 1 }), mockAdapter);
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const pr = makePRContext({
        changedFiles: [
          {
            path: 'src/a.ts',
            status: 'modified' as const,
            additions: 600,
            deletions: 0,
            patch: makePatch(600),
          },
          {
            path: 'src/b.ts',
            status: 'modified' as const,
            additions: 600,
            deletions: 0,
            patch: makePatch(600),
          },
        ],
      });

      await eng.reviewPR(pr);

      expect(mockBuildReviewPrompt).toHaveBeenCalled();
      for (const call of mockBuildReviewPrompt.mock.calls) {
        const options = call[2] as { budgetMode?: string; totalDiffLines?: number };
        expect(options.budgetMode).toBeUndefined();
        expect(options.totalDiffLines).toBeUndefined();
      }
    });

    it('prepends the split banner on the single-batch execution-failure path', async () => {
      const eng = new ReviewEngine(makeBudgetEnabledConfig(), mockAdapter);
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: '',
        durationMs: 1000,
        tokensUsed: 100,
      });

      const result = await eng.reviewPR(makeLargePR(1500));

      expect(result.summary).toContain('Large PR Detected');
      expect(result.summary).toContain('split');
      expect(result.verdict.reasoning).toBe('Review execution failed');
    });
  });

  describe('token usage / cost telemetry', () => {
    const pr = makePRContext();

    function makeCostTrackingConfig(
      overrides: Partial<AgentConfig> = {},
      costTracking: { enabled?: boolean; verbosity?: 'off' | 'summary' | 'detailed' } = {},
    ): AgentConfig {
      return makeConfig({
        enableMCP: false,
        mcpServers: [],
        ...overrides,
        review: {
          ...DEFAULT_CONFIG.review,
          costTracking: {
            enabled: costTracking.enabled ?? true,
            verbosity: costTracking.verbosity ?? 'summary',
          },
          ...((overrides.review || {}) as Record<string, unknown>),
        },
      });
    }

    beforeEach(() => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
        promptTokens: 400,
        completionTokens: 100,
      });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());
    });

    it('returns null telemetry before any pipeline run', () => {
      expect(engine.getLastTelemetry()).toBeNull();
    });

    it('accumulates token usage after a review run', async () => {
      const eng = new ReviewEngine(makeCostTrackingConfig(), mockAdapter);

      await eng.reviewPR(pr);

      const telemetry = eng.getLastTelemetry();
      expect(telemetry).not.toBeNull();
      expect(telemetry?.totalTokens).toBe(500);
      expect(telemetry?.promptTokens).toBe(400);
      expect(telemetry?.completionTokens).toBe(100);
      expect(telemetry?.durationMs).toBe(1000);
    });

    it('attaches summary usage to the review result', async () => {
      const eng = new ReviewEngine(makeCostTrackingConfig(), mockAdapter);

      const result = await eng.reviewPR(pr);

      expect(result.usage).toEqual({
        totalTokens: 500,
        durationMs: 1000,
        estimatedCost: undefined,
      });
    });

    it('attaches full breakdown for detailed verbosity', async () => {
      const eng = new ReviewEngine(
        makeCostTrackingConfig({}, { verbosity: 'detailed' }),
        mockAdapter,
      );

      const result = await eng.reviewPR(pr);

      expect(result.usage).toEqual({
        totalTokens: 500,
        promptTokens: 400,
        completionTokens: 100,
        durationMs: 1000,
        estimatedCost: undefined,
      });
    });

    it('does not attach usage when cost tracking is disabled', async () => {
      const eng = new ReviewEngine(makeCostTrackingConfig({}, { enabled: false }), mockAdapter);

      const result = await eng.reviewPR(pr);

      expect(result.usage).toBeUndefined();
    });

    it('estimates cost from configured rates', async () => {
      const eng = new ReviewEngine(
        makeCostTrackingConfig({
          review: {
            ...DEFAULT_CONFIG.review,
            costTracking: {
              enabled: true,
              verbosity: 'detailed',
              inputCostPer1K: 0.01,
              outputCostPer1K: 0.02,
            },
          },
        }),
        mockAdapter,
      );

      const result = await eng.reviewPR(pr);

      expect(result.usage?.estimatedCost).toBeCloseTo(0.004 + 0.002, 6);
    });

    it('prices the uncovered remainder when only the prompt side is parsed', async () => {
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
        promptTokens: 300,
      });

      const eng = new ReviewEngine(
        makeCostTrackingConfig({
          review: {
            ...DEFAULT_CONFIG.review,
            costTracking: {
              enabled: true,
              verbosity: 'detailed',
              inputCostPer1K: 0.01,
              outputCostPer1K: 0.02,
            },
          },
        }),
        mockAdapter,
      );

      const result = await eng.reviewPR(pr);

      // 300 prompt tokens priced at the input rate plus the 200 uncovered
      // tokens priced at the same (input) rate — partial parsing must not
      // silently drop the remainder.
      expect(result.usage?.promptTokens).toBe(300);
      expect(result.usage?.completionTokens).toBeUndefined();
      expect(result.usage?.estimatedCost).toBeCloseTo((500 / 1000) * 0.01, 6);
    });

    it('prices the full total as input tokens when no breakdown is parsed', async () => {
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 1000,
        tokensUsed: 500,
      });

      const eng = new ReviewEngine(
        makeCostTrackingConfig({
          review: {
            ...DEFAULT_CONFIG.review,
            costTracking: {
              enabled: true,
              verbosity: 'detailed',
              inputCostPer1K: 0.01,
              outputCostPer1K: 0.02,
            },
          },
        }),
        mockAdapter,
      );

      const result = await eng.reviewPR(pr);

      expect(result.usage?.promptTokens).toBeUndefined();
      expect(result.usage?.completionTokens).toBeUndefined();
      expect(result.usage?.estimatedCost).toBeCloseTo((500 / 1000) * 0.01, 6);
    });

    it('falls back to known model rates when config rates are absent', async () => {
      const eng = new ReviewEngine(
        makeCostTrackingConfig(
          { reviewModel: 'anthropic/claude-3-5-sonnet' },
          { verbosity: 'detailed' },
        ),
        mockAdapter,
      );

      const result = await eng.reviewPR(pr);

      const expected = (400 / 1000) * 0.003 + (100 / 1000) * 0.015;
      expect(result.usage?.estimatedCost).toBeCloseTo(expected, 6);
    });

    it('leaves estimatedCost undefined for unknown free models', async () => {
      const eng = new ReviewEngine(
        makeCostTrackingConfig({ reviewModel: 'opencode/deepseek-v4-flash-free' }),
        mockAdapter,
      );

      const result = await eng.reviewPR(pr);

      expect(result.usage?.estimatedCost).toBeUndefined();
    });

    it('writes a JSONL cost log when exposure is enabled', async () => {
      const eng = new ReviewEngine(makeCostTrackingConfig(), mockAdapter);

      await eng.reviewPR(pr);

      const appendFile = fs.promises.appendFile;
      expect(appendFile).toHaveBeenCalled();
      const [, content] = (appendFile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(content).toContain('"totalTokens":500');
    });

    it('attributes batch and synthesis tokens to their own models in multi-batch reviews', async () => {
      mockRunOpenCode
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 100,
          tokensUsed: 100,
          promptTokens: 80,
          completionTokens: 20,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 100,
          tokensUsed: 100,
          promptTokens: 80,
          completionTokens: 20,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 200,
          tokensUsed: 50,
          promptTokens: 40,
          completionTokens: 10,
        });
      mockParseJsonlFile
        .mockResolvedValueOnce(mockEmptyResult())
        .mockResolvedValueOnce(mockEmptyResult())
        .mockResolvedValueOnce(mockEmptyResult());

      const eng = new ReviewEngine(
        makeCostTrackingConfig(
          {
            reviewModel: 'gpt-4o',
            synthesisModel: 'claude-3-5-sonnet',
            batchSize: 2,
          },
          { verbosity: 'detailed' },
        ),
        mockAdapter,
      );

      const multiBatchPR = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/b.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/c.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/d.ts', status: 'modified', additions: 10, deletions: 0 },
        ],
      });

      const result = await eng.reviewPR(multiBatchPR);

      const telemetry = eng.getLastTelemetry();
      expect(telemetry?.totalTokens).toBe(250);
      expect(telemetry?.promptTokens).toBe(200);
      expect(telemetry?.completionTokens).toBe(50);
      // Batch duration uses wall-clock (not the sum of concurrent batch
      // durations = 400); ~200ms synthesis plus the tiny batch loop elapsed.
      expect(telemetry?.durationMs).toBeGreaterThanOrEqual(200);
      expect(telemetry?.durationMs).toBeLessThan(300);
      // Batch tokens priced at gpt-4o, synthesis tokens at claude-3-5-sonnet.
      const gpt4oCost = (160 / 1000) * 0.0025 + (40 / 1000) * 0.01;
      const claudeCost = (40 / 1000) * 0.003 + (10 / 1000) * 0.015;
      expect(result.usage?.estimatedCost).toBeCloseTo(gpt4oCost + claudeCost, 6);
    });

    it('writes per-call cost log entries instead of cumulative snapshots', async () => {
      mockRunOpenCode
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 100,
          tokensUsed: 100,
          promptTokens: 80,
          completionTokens: 20,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 100,
          tokensUsed: 100,
          promptTokens: 80,
          completionTokens: 20,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '',
          durationMs: 200,
          tokensUsed: 50,
          promptTokens: 40,
          completionTokens: 10,
        });
      mockParseJsonlFile
        .mockResolvedValueOnce(mockEmptyResult())
        .mockResolvedValueOnce(mockEmptyResult())
        .mockResolvedValueOnce(mockEmptyResult());

      const eng = new ReviewEngine(
        makeCostTrackingConfig(
          {
            reviewModel: 'gpt-4o',
            synthesisModel: 'claude-3-5-sonnet',
            batchSize: 2,
          },
          { verbosity: 'detailed' },
        ),
        mockAdapter,
      );

      const multiBatchPR = makePRContext({
        changedFiles: [
          { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/b.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/c.ts', status: 'modified', additions: 10, deletions: 0 },
          { path: 'src/d.ts', status: 'modified', additions: 10, deletions: 0 },
        ],
      });

      await eng.reviewPR(multiBatchPR);

      const appendFile = fs.promises.appendFile as ReturnType<typeof vi.fn>;
      expect(appendFile).toHaveBeenCalledTimes(2);
      const firstEntry = appendFile.mock.calls[0][1] as string;
      const secondEntry = appendFile.mock.calls[1][1] as string;
      expect(firstEntry).toContain('"totalTokens":200');
      expect(firstEntry).toContain('"model":"gpt-4o"');
      // Second entry is the synthesis call's delta (50), not the cumulative 250.
      expect(secondEntry).toContain('"totalTokens":50');
      expect(secondEntry).toContain('"model":"claude-3-5-sonnet"');
    });
  });
});
