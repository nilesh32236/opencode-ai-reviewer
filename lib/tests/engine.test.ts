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
  mockBuildSynthesisPrompt,
  MockMCPManager,
  MockGitHubHelper,
} = vi.hoisted(() => {
  const _mockMCPConnect = vi.fn();
  const _mockMCPDisconnect = vi.fn();
  const _mockMCPGetLibraryDocs = vi.fn();
  const _mockGitHubGetPR = vi.fn();
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
  const _mockBuildSynthesisPrompt = vi.fn(() => 'synthesis prompt');

  class _MockMCPManager {
    connect = _mockMCPConnect;
    disconnect = _mockMCPDisconnect;
    getLibraryDocs = _mockMCPGetLibraryDocs;
  }

  class _MockGitHubHelper {
    getPR = _mockGitHubGetPR;
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
    mockBuildSynthesisPrompt: _mockBuildSynthesisPrompt,
    MockMCPManager: _MockMCPManager,
    MockGitHubHelper: _MockGitHubHelper,
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
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

import * as fs from 'fs';
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
  };
}

describe('ReviewEngine', () => {
  let engine: ReviewEngine;

  beforeEach(() => {
    vi.resetAllMocks();
    engine = new ReviewEngine(makeConfig(), 'fake-token', 'owner/repo');
  });

  describe('reviewPR()', () => {
    const pr = makePRContext();

    it('returns review result on success', async () => {
      const engWithMCP = new ReviewEngine(
        makeConfig({
          mcpServers: [{ name: 'context7', type: 'local', command: ['node', 'server.js'] }],
        }),
        'fake-token',
        'owner/repo',
      );
      mockMCPConnect.mockResolvedValue(undefined);
      mockMCPGetLibraryDocs.mockResolvedValue('docs content');
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });

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
      mockRunOpenCode.mockResolvedValue({ success: false, output: '', durationMs: 500 });

      const result = await engine.reviewPR(pr);

      expect(result.verdict.reasoning).toBe('Review execution failed');
      expect(result.verdict.ready).toBe(false);
    });

    it('returns empty result when parseJsonlFile fails', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockRejectedValue(new Error('Parse error'));

      const result = await engine.reviewPR(pr);

      expect(result.verdict.reasoning).toBe('Failed to parse review output');
      expect(result.verdict.ready).toBe(false);
    });

    it('handles MCP connection failure gracefully', async () => {
      mockMCPConnect.mockRejectedValue(new Error('MCP failed'));
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await engine.reviewPR(pr);

      expect(result).toBeDefined();
    });

    it('handles learning store failure gracefully', async () => {
      const learningStore = {
        getRelevantLessons: vi.fn().mockRejectedValue(new Error('DB error')),
        close: vi.fn(),
      };
      const eng = new ReviewEngine(
        makeConfig(),
        'fake-token',
        'owner/repo',
        learningStore as never,
      );
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.reviewPR(pr);
      expect(result).toBeDefined();
    });

    it('uses cached lessons within TTL', async () => {
      const learningStore = {
        getRelevantLessons: vi.fn().mockResolvedValue(['lesson 1']),
        close: vi.fn(),
      };
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        'fake-token',
        'owner/repo',
        learningStore as never,
      );
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);
      await eng.reviewPR(pr);

      expect(learningStore.getRelevantLessons).toHaveBeenCalledTimes(1);
    });

    it('skips MCP when enableMCP is false', async () => {
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        'fake-token',
        'owner/repo',
      );
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      await eng.reviewPR(pr);

      expect(mockMCPConnect).not.toHaveBeenCalled();
    });

    it('does not fetch library docs when no libraries detected', async () => {
      mockMCPConnect.mockResolvedValue(undefined);
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
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
        mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
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
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        'fake-token',
        'owner/repo',
      );
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

      expect(result).toBeDefined();
    });

    it('skips MCP when enableMCP is false', async () => {
      const eng = new ReviewEngine(
        makeConfig({ enableMCP: false, mcpServers: [] }),
        'fake-token',
        'owner/repo',
      );
      mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 1000 });
      mockParseJsonlFile.mockResolvedValue(mockEmptyResult());

      const result = await eng.runAudit('audit prompt', './src', 'security');

      expect(mockMCPConnect).not.toHaveBeenCalled();
      expect(result).toBeDefined();
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
      const eng = new ReviewEngine(
        makeConfig(),
        'fake-token',
        'owner/repo',
        learningStore as never,
      );
      mockMCPDisconnect.mockResolvedValue(undefined);

      await eng.cleanup();

      expect(learningStore.close).toHaveBeenCalled();
    });

    it('handles learning store close failure gracefully', async () => {
      const learningStore = {
        close: vi.fn().mockRejectedValue(new Error('Close failed')),
      };
      const eng = new ReviewEngine(
        makeConfig(),
        'fake-token',
        'owner/repo',
        learningStore as never,
      );
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
});
