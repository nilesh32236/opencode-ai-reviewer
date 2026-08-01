import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, PRContext, ReviewResult } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

const {
  mockMCPConnect,
  mockMCPDisconnect,
  mockMCPGetLibraryDocs,
  mockGitHubGetPR,
  mockRunOpenCode,
  mockParseJsonlFile,
  mockEmptyResult,
  mockBuildReviewPrompt,
  mockBuildFixPrompt,
  mockBuildAuditPrompt,
  mockBuildAnalyzePrompt,
  mockBuildSynthesisPrompt,
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
  const _mockBuildSynthesisPrompt = vi.fn(() => 'synthesis prompt');

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
    mockBuildReviewPrompt: _mockBuildReviewPrompt,
    mockBuildFixPrompt: _mockBuildFixPrompt,
    mockBuildAuditPrompt: _mockBuildAuditPrompt,
    mockBuildAnalyzePrompt: _mockBuildAnalyzePrompt,
    mockBuildSynthesisPrompt: _mockBuildSynthesisPrompt,
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

vi.mock('../src/jsonl-parser.js', () => ({
  parseJsonlFile: mockParseJsonlFile,
  emptyResult: mockEmptyResult,
}));

vi.mock('../src/prompts/builder.js', () => ({
  buildReviewPrompt: mockBuildReviewPrompt,
  buildFixPrompt: mockBuildFixPrompt,
  buildAuditPrompt: mockBuildAuditPrompt,
  buildAnalyzePrompt: mockBuildAnalyzePrompt,
  buildSynthesisPrompt: mockBuildSynthesisPrompt,
}));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      unlink: vi.fn(),
      appendFile: vi.fn(),
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
    mockAdapter = createMockAdapter();
    engine = new ReviewEngine(makeConfig(), mockAdapter);
  });

  describe('reviewPR()', () => {
    const pr = makePRContext();

    it('returns review result on success', async () => {
      const engWithMCP = new ReviewEngine(
        makeConfig({
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
  });

  describe('runAnalyze()', () => {
    const issueContextMarkdown = '## Issue #123\nSome description';

    it('returns analysis plan markdown on success', async () => {
      const engWithMCP = new ReviewEngine(
        makeConfig({
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
  });
});
