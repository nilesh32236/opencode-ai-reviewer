import * as fs from 'fs';
import * as cp from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, PRContext, ReviewResult } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { VERDICT_FAILURE_SENTINELS } from '../src/utils/verdict-mode.js';

const {
  mockRunOpenCode,
  mockParseJsonlFile,
  mockEmptyResult,
  mockRunSCAScan,
  MockMCPManager,
  createMockAdapter,
} = vi.hoisted(() => {
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

  class _MockMCPManager {
    connect = vi.fn();
    disconnect = vi.fn();
    getLibraryDocs = vi.fn();
  }

  function _createMockAdapter() {
    return {
      getMR: vi.fn(),
      isMR: vi.fn().mockResolvedValue(true),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      getIssue: vi.fn(),
      getIssueComments: vi.fn().mockResolvedValue([]),
      getIssueComment: vi.fn(),
      getDiffLines: vi.fn().mockResolvedValue(new Set<string>()),
      getDiffSince: vi.fn().mockResolvedValue(''),
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
      getOpenHumanThreads: vi.fn().mockResolvedValue(''),
      updateMR: vi.fn(),
      getCurrentUser: vi.fn().mockResolvedValue('test-bot'),
      paginate: vi.fn().mockResolvedValue([]),
    };
  }

  return {
    mockRunOpenCode: _mockRunOpenCode,
    mockParseJsonlFile: _mockParseJsonlFile,
    mockEmptyResult: _mockEmptyResult,
    mockRunSCAScan: _mockRunSCAScan,
    MockMCPManager: _MockMCPManager,
    createMockAdapter: _createMockAdapter,
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

vi.mock('../src/sca/index.js', () => ({
  runSCAScan: mockRunSCAScan,
  scaVulnerabilityToIssue: vi.fn((v: unknown) => v),
}));

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
      readdir: actual.promises.readdir,
      stat: actual.promises.stat,
      mkdir: actual.promises.mkdir,
    },
  };
});

import { buildSubagentReviewPrompt } from '../src/agents/prompts.js';
import { ReviewEngine, buildPartialAgentWarning } from '../src/engine.js';
import { buildReviewBody } from '../src/utils/review-body.js';

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
      { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff-a' },
      { path: 'src/b.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff-b' },
      { path: 'src/c.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff-c' },
      { path: 'src/d.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff-d' },
    ],
    ...overrides,
  };
}

/** A produced-nothing parsed result shaped like a free-tier dispatch denial. */
function mockProducedNothingResult(rawLines: string[] = []): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' as const },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    rawLines,
    failedLines: rawLines.length,
  };
}

describe('subagent fallback hardening', () => {
  const pr = makePRContext();
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish the empty-result factory (resetAllMocks wipes the
    // vi.hoisted implementation); branch-B salvage builds on it.
    mockEmptyResult.mockImplementation(() => ({
      summary: '',
      verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' as const },
      strengths: [],
      issues: [],
      stats: { total: 0, critical: 0, important: 0, minor: 0 },
      rawLines: [],
      failedLines: 0,
    }));
    vi.mocked(cp.execFile).mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout?: string) => void;
      callback(null, '');
    });
    mockRunSCAScan.mockResolvedValue([]);
    mockAdapter = createMockAdapter();
  });

  function fourAgentEngine(): ReviewEngine {
    return new ReviewEngine(makeConfig(), mockAdapter);
  }

  describe('partial salvage (dispatch-coverage guard)', () => {
    it('keeps survivors with an exact failedAgents count instead of total all-fail', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      // Strict parse found nothing substantive, but the raw lines carry a
      // security finding strict validation would drop (wrong-cased severity,
      // no confidence) plus a performance ok-status and a strength.
      mockParseJsonlFile.mockResolvedValue(
        mockProducedNothingResult([
          '{"type":"issue","agent":"security","category":"security","severity":"CRITICAL","file":"src/a.ts","line":5,"message":"Unsanitized input flows into query."}',
          '{"type":"agent_status","agent":"performance","status":"ok"}',
          '{"type":"strength","file":"src/b.ts","line":3,"message":"Clean error handling."}',
          'task tool denied for quality-reviewer',
        ]),
      );

      const result = await eng.reviewPR(pr);

      // Deterministic denials must never be blindly retried.
      expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toBe('Unsanitized input flows into query.');
      expect(result.issues[0].severity).toBe('critical');
      expect(result.strengths).toHaveLength(1);
      // security (finding) + performance (ok status) survived; quality + logic failed.
      expect(result.failedAgents).toBe(2);
      expect(result.totalAgents).toBe(4);
      expect(result.verdict.ready).toBe(false);
      expect(result.verdict.reasoning).toContain('Partial review: 2/4 agent(s) failed');
      expect(result.summary).toContain('Partial review: 2/4 agent(s) failed');
      expect(result.verdict.reasoning).not.toBe('All review agents failed');
    });

    it('still forces total all-fail with sentinels intact when nothing survived', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockResolvedValue(mockProducedNothingResult([]));

      const result = await eng.reviewPR(pr);

      expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(0);
      expect(result.verdict.ready).toBe(false);
      expect(result.verdict.reasoning).toBe('All review agents failed');
      expect(VERDICT_FAILURE_SENTINELS.has(result.verdict.reasoning)).toBe(true);
      expect(result.failedAgents).toBe(4);
      expect(result.totalAgents).toBe(4);
      expect(result.summary).toContain('could not be completed');
    });

    it('ignores unusable raw lines when mining (no message, no salvage)', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockResolvedValue(
        mockProducedNothingResult([
          'task tool denied for security-reviewer',
          '{"type":"issue","severity":"important"}',
          '```',
          '',
        ]),
      );

      const result = await eng.reviewPR(pr);

      expect(result.verdict.reasoning).toBe('All review agents failed');
      expect(result.failedAgents).toBe(4);
    });
  });

  describe('failed-run salvage (branch A)', () => {
    it('salvages a partially written consolidated output instead of total all-fail', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      // The failed run still left a partially written output file behind.
      mockParseJsonlFile.mockResolvedValue({
        ...mockProducedNothingResult(['{"type":"agent_status","agent":"logic","status":"ok"}']),
        issues: [
          {
            type: 'issue',
            severity: 'important',
            file: 'src/c.ts',
            line: 12,
            message: 'Missing null check',
            agent: 'logic',
            category: 'logic',
          },
        ],
      });

      const result = await eng.reviewPR(pr);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toBe('Missing null check');
      expect(result.failedAgents).toBe(3);
      expect(result.totalAgents).toBe(4);
      expect(result.verdict.reasoning).toContain('Partial review: 3/4 agent(s) failed');
    });

    it('falls back to total all-fail when the failed run left nothing behind', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockRejectedValue(new Error('no output file'));

      const result = await eng.reviewPR(pr);

      expect(result.verdict.ready).toBe(false);
      expect(result.verdict.reasoning).toBe('All review agents failed');
      expect(VERDICT_FAILURE_SENTINELS.has(result.verdict.reasoning)).toBe(true);
      expect(result.failedAgents).toBe(4);
    });
  });

  describe('parse-failure salvage (branch B)', () => {
    it('mines the raw output text when strict parsing throws', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockRejectedValue(new Error('bad jsonl'));
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        '{"type":"issue","agent":"quality","category":"quality","severity":"minor","file":"src/d.ts","line":7,"message":"Unused variable."}\n' +
          '{"type":"agent_status","agent":"quality","status":"ok"}\n',
      );

      const result = await eng.reviewPR(pr);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toBe('Unused variable.');
      expect(result.failedAgents).toBe(3);
      expect(result.verdict.reasoning).toContain('Partial review: 3/4 agent(s) failed');
    });

    it('keeps the parse-failure sentinel when the raw text has nothing usable', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockRejectedValue(new Error('bad jsonl'));
      vi.mocked(fs.promises.readFile).mockResolvedValue('not json at all\n');

      const result = await eng.reviewPR(pr);

      expect(result.verdict.ready).toBe(false);
      expect(result.verdict.reasoning).toBe('Review output could not be parsed');
      expect(VERDICT_FAILURE_SENTINELS.has(result.verdict.reasoning)).toBe(true);
      expect(result.failedAgents).toBe(4);
    });
  });

  describe('orchestrator retry (transient thrown failures only)', () => {
    it('retries a thrown orchestrator error and recovers when the retry succeeds', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockRejectedValueOnce(new Error('spawn ENOENT')).mockResolvedValueOnce({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockResolvedValue({
        ...mockProducedNothingResult(),
        summary: 'Recovered review',
        verdict: {
          ready: true,
          reasoning: 'Recovered review',
          autoFixable: false,
          confidence: 'high' as const,
        },
      });

      const result = await eng.reviewPR(pr);

      expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
      expect(result.summary).toBe('Recovered review');
      expect(result.verdict.ready).toBe(true);
      expect(result.failedAgents).toBeUndefined();
    });

    it('retries a persistently thrown orchestrator error, then degrades to all-fail', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockRejectedValue(new Error('fetch failed'));
      mockParseJsonlFile.mockRejectedValue(new Error('no output'));

      const result = await eng.reviewPR(pr);

      expect(mockRunOpenCode).toHaveBeenCalledTimes(3);
      expect(result.verdict.ready).toBe(false);
      expect(result.verdict.reasoning).toBe('All review agents failed');
      expect(result.failedAgents).toBe(4);
    }, 20000);

    it('forwards the guarded resume option into the orchestrator run', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: true,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      mockParseJsonlFile.mockResolvedValue(mockProducedNothingResult());

      await eng.reviewPR(pr);

      expect(mockRunOpenCode).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ resumeOnNetworkError: false }),
      );
    });
  });

  describe('buildPartialAgentWarning', () => {
    it('formats the shared blind-coverage warning', () => {
      expect(buildPartialAgentWarning(2, 4)).toBe(
        'Partial review: 2/4 agent(s) failed — findings may be missing',
      );
    });
  });

  describe('applyPartialAgentDegradation', () => {
    it('demotes the verdict and records counts without touching sentinels', () => {
      const base = mockProducedNothingResult();
      const degraded = ReviewEngine.applyPartialAgentDegradation(
        { ...base, summary: 'Some findings', verdict: { ...base.verdict, reasoning: 'Mixed' } },
        1,
        4,
      );
      expect(degraded.verdict.ready).toBe(false);
      expect(degraded.verdict.reasoning).toContain('Partial review: 1/4 agent(s) failed');
      expect(degraded.summary).toContain('Partial review: 1/4 agent(s) failed');
      expect(degraded.failedAgents).toBe(1);
      expect(degraded.totalAgents).toBe(4);
    });

    it('returns the result untouched when no agents failed', () => {
      const base = mockProducedNothingResult();
      expect(ReviewEngine.applyPartialAgentDegradation(base, 0, 4)).toBe(base);
    });
  });

  describe('mineLenientSubagentFindings', () => {
    it('skips non-JSON and message-less lines', () => {
      const mined = ReviewEngine.mineLenientSubagentFindings([
        'plain denial text',
        '{"type":"issue","severity":"critical","file":"a.ts","line":1}',
        '{"type":"mystery","x":1}',
        '',
        '```',
      ]);
      expect(mined.issues).toHaveLength(0);
      expect(mined.strengths).toHaveLength(0);
      expect(mined.okAgents).toHaveLength(0);
      expect(mined.failedAgents).toHaveLength(0);
      expect(mined.statusLines).toBe(0);
    });

    it('collects ok agent_status lines once each', () => {
      const mined = ReviewEngine.mineLenientSubagentFindings([
        '{"type":"agent_status","agent":"security","status":"ok"}',
        '{"type":"agent_status","agent":"security","status":"ok"}',
        '{"type":"agent_status","agent":"logic","status":"failed","error":"denied"}',
      ]);
      expect(mined.okAgents).toEqual(['security']);
      expect(mined.failedAgents).toEqual(['logic']);
      expect(mined.statusLines).toBe(3);
    });

    it('records explicit failed statuses separately from ok', () => {
      const mined = ReviewEngine.mineLenientSubagentFindings([
        '{"type":"agent_status","agent":"security","status":"failed","error":"denied"}',
        '{"type":"agent_status","agent":"logic","status":"ok"}',
        '{"type":"agent_status","agent":"unknown","status":"ok"}',
      ]);
      expect(mined.failedAgents).toEqual(['security']);
      expect(mined.okAgents).toEqual(['logic']);
      // Every agent_status line counts toward coverage — even duplicates
      // and unknown agents — so the exactly-one-per-subagent check sees them.
      expect(mined.statusLines).toBe(3);
    });
  });

  describe('salvagePartialSubagentResult (always degraded)', () => {
    const categories = ['security', 'performance', 'quality', 'logic'] as const;

    function expectSalvaged(salvaged: ReviewResult | null): ReviewResult {
      if (!salvaged) throw new Error('expected salvage to keep survivors');
      return salvaged;
    }

    /** A model-written clean verdict, as a failed run can leave behind. */
    function readyBase(): ReviewResult {
      return {
        ...mockProducedNothingResult(),
        summary: 'All clear',
        verdict: {
          ready: true,
          reasoning: 'Looks good',
          autoFixable: false,
          confidence: 'high' as const,
        },
      };
    }

    it('forces ready:false with a blind-coverage warning even when every agent left attributable traces', () => {
      const salvaged = expectSalvaged(
        ReviewEngine.salvagePartialSubagentResult(
          readyBase(),
          [
            '{"type":"agent_status","agent":"security","status":"ok"}',
            '{"type":"agent_status","agent":"performance","status":"ok"}',
            '{"type":"agent_status","agent":"quality","status":"ok"}',
            '{"type":"agent_status","agent":"logic","status":"ok"}',
            '{"type":"issue","agent":"security","severity":"minor","file":"src/a.ts","line":1,"message":"Nit."}',
          ],
          categories,
        ),
      );
      // The failed run itself counts: salvage never presents ready:true.
      expect(salvaged.verdict.ready).toBe(false);
      expect(salvaged.failedAgents).toBe(1);
      expect(salvaged.totalAgents).toBe(4);
      expect(salvaged.verdict.reasoning).toContain('Partial review: 1/4 agent(s) failed');
      expect(salvaged.summary).toContain('Partial review: 1/4 agent(s) failed');
      expect(salvaged.issues).toHaveLength(1);
    });

    it('branch-A salvage with full attribution still yields ready:false', async () => {
      const eng = fourAgentEngine();
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: '',
        durationMs: 500,
        tokensUsed: 10,
      });
      // Failed run, yet the partial output claims full coverage and ready:true.
      mockParseJsonlFile.mockResolvedValue({
        ...mockProducedNothingResult([
          '{"type":"agent_status","agent":"security","status":"ok"}',
          '{"type":"agent_status","agent":"performance","status":"ok"}',
          '{"type":"agent_status","agent":"quality","status":"ok"}',
          '{"type":"agent_status","agent":"logic","status":"ok"}',
        ]),
        summary: 'All clear',
        verdict: {
          ready: true,
          reasoning: 'Looks good',
          autoFixable: false,
          confidence: 'high' as const,
        },
        issues: [
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/a.ts',
            line: 1,
            message: 'Nit.',
            agent: 'security',
            category: 'security',
          },
        ],
      });

      const result = await eng.reviewPR(pr);

      expect(result.issues).toHaveLength(1);
      expect(result.verdict.ready).toBe(false);
      expect(result.failedAgents).toBe(1);
      expect(result.totalAgents).toBe(4);
      expect(result.verdict.reasoning).toContain('Partial review: 1/4 agent(s) failed');
    });

    it('deduplicates strengths shared by the strict parse and mined lines', () => {
      const strength = {
        type: 'strength' as const,
        file: 'src/b.ts',
        line: 3,
        message: 'Clean error handling.',
      };
      const salvaged = expectSalvaged(
        ReviewEngine.salvagePartialSubagentResult(
          { ...mockProducedNothingResult(), strengths: [strength] },
          [
            '{"type":"strength","file":"src/b.ts","line":3,"message":"Clean error handling."}',
            '{"type":"strength","file":"src/c.ts","line":1,"message":"Good test coverage."}',
          ],
          categories,
        ),
      );
      expect(salvaged.strengths).toHaveLength(2);
      expect(salvaged.strengths.filter((s) => s.message === 'Clean error handling.')).toHaveLength(
        1,
      );
    });

    it('never lets issue attribution override an explicit failed status', () => {
      const salvaged = expectSalvaged(
        ReviewEngine.salvagePartialSubagentResult(
          mockProducedNothingResult(),
          [
            '{"type":"agent_status","agent":"security","status":"failed","error":"denied"}',
            '{"type":"issue","agent":"security","severity":"critical","file":"src/a.ts","line":5,"message":"Unsanitized input."}',
          ],
          categories,
        ),
      );
      // security explicitly failed, so nothing counts as succeeded.
      expect(salvaged.failedAgents).toBe(4);
      expect(salvaged.verdict.ready).toBe(false);
    });

    it('lets an explicit failed status win over a conflicting ok status', () => {
      const salvaged = expectSalvaged(
        ReviewEngine.salvagePartialSubagentResult(
          mockProducedNothingResult(),
          [
            '{"type":"agent_status","agent":"security","status":"ok"}',
            '{"type":"agent_status","agent":"security","status":"failed","error":"denied"}',
            '{"type":"issue","agent":"security","severity":"critical","file":"src/a.ts","line":5,"message":"Unsanitized input."}',
          ],
          categories,
        ),
      );
      expect(salvaged.failedAgents).toBe(4);
      expect(salvaged.verdict.ready).toBe(false);
    });
  });

  describe('agent_status coverage check (fail-open warn)', () => {
    const categories = ['security', 'performance', 'quality', 'logic'] as const;

    it('calls onWarn when status lines do not match the dispatched count', () => {
      const warned: string[] = [];
      const salvaged = ReviewEngine.salvagePartialSubagentResult(
        mockProducedNothingResult(),
        [
          '{"type":"agent_status","agent":"security","status":"ok"}',
          '{"type":"issue","agent":"security","severity":"minor","file":"src/a.ts","line":1,"message":"Nit."}',
        ],
        categories,
        (message) => {
          warned.push(message);
        },
      );
      expect(salvaged).not.toBeNull();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('expected 4 agent_status line(s) but found 1');
    });

    it('stays silent when every subagent reported exactly once', () => {
      const warned: string[] = [];
      const salvaged = ReviewEngine.salvagePartialSubagentResult(
        mockProducedNothingResult(),
        [
          '{"type":"agent_status","agent":"security","status":"ok"}',
          '{"type":"agent_status","agent":"performance","status":"ok"}',
          '{"type":"agent_status","agent":"quality","status":"ok"}',
          '{"type":"agent_status","agent":"logic","status":"ok"}',
          '{"type":"issue","agent":"security","severity":"minor","file":"src/a.ts","line":1,"message":"Nit."}',
        ],
        categories,
        (message) => {
          warned.push(message);
        },
      );
      expect(salvaged).not.toBeNull();
      expect(warned).toHaveLength(0);
    });

    it('warns even when nothing was salvaged (observability without behavior change)', () => {
      const warned: string[] = [];
      const salvaged = ReviewEngine.salvagePartialSubagentResult(
        mockProducedNothingResult(),
        [],
        categories,
        (message) => {
          warned.push(message);
        },
      );
      expect(salvaged).toBeNull();
      expect(warned).toHaveLength(1);
    });
  });

  describe('orchestrator prompt per-agent status', () => {
    it('requires machine-readable per-agent status while keeping existing instructions', () => {
      const prompt = buildSubagentReviewPrompt({ inputs: {}, prContext: 'PR body' }, [
        'security',
        'performance',
        'quality',
        'logic',
      ]);
      // New additive requirement.
      expect(prompt).toContain('agent_status');
      expect(prompt).toContain('"status":"ok"');
      expect(prompt).toContain('"status":"failed"');
      // Every pre-existing instruction stays intact.
      expect(prompt).toContain('Issue ALL task-tool calls for the subagents');
      expect(prompt).toContain('Collect all subagent findings once they finish.');
      expect(prompt).toContain('Deduplicate overlapping findings');
      expect(prompt).toContain('Prioritize by severity × confidence.');
      expect(prompt).toContain('review-output.jsonl');
      expect(prompt).toContain('note the failure in the verdict reasoning');
    });
  });

  describe('review body banner (total vs partial)', () => {
    function bannerResult(overrides: Partial<ReviewResult>): ReviewResult {
      return {
        summary: 'Summary.',
        verdict: { ready: false, reasoning: 'Reasoning.' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
        ...overrides,
      };
    }

    it('labels an N/N failure with no survivors as a failed review, not partial', () => {
      const body = buildReviewBody(bannerResult({ failedAgents: 4, totalAgents: 4 }));
      expect(body).toContain('Review failed');
      expect(body).toContain('all 4 agent(s) failed');
      expect(body).not.toContain('Partial review');
    });

    it('labels surviving findings as a partial review with exact counts', () => {
      const body = buildReviewBody(
        bannerResult({
          failedAgents: 3,
          totalAgents: 4,
          issues: [
            {
              type: 'issue',
              severity: 'minor',
              file: 'src/a.ts',
              line: 1,
              message: 'Nit.',
            },
          ],
          stats: { total: 1, critical: 0, important: 0, minor: 1 },
        }),
      );
      expect(body).toContain('Partial review');
      expect(body).toContain('3/4 agent(s) failed');
      expect(body).not.toContain('Review failed');
    });
  });
});
