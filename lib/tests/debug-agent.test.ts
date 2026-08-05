import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
const { mockRunOpenCode, mockParseJsonlFile, mockEmptyResult, createMockAdapter, MockMCPManager } = vi.hoisted(() => {
  const mockRunOpenCode = vi.fn();
  const mockParseJsonlFile = vi.fn();
  const mockEmptyResult = vi.fn();
  const _createMockAdapter = () => ({
    getMR: vi.fn(), isMR: vi.fn().mockResolvedValue(true), getDefaultBranch: vi.fn().mockResolvedValue('main'),
    getIssue: vi.fn(), getIssueComments: vi.fn().mockResolvedValue([]), getIssueComment: vi.fn(),
    getDiffLines: vi.fn().mockResolvedValue(new Set()), getDiffSince: vi.fn().mockResolvedValue(''),
    listReviewComments: vi.fn().mockResolvedValue([]), createReviewCommentReply: vi.fn(), listComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn(), postReview: vi.fn(), postOrUpdateComment: vi.fn(), createComment: vi.fn(),
    replyToReviewComment: vi.fn(), getReviewComment: vi.fn(), getReviewCommentThread: vi.fn(),
    createIssue: vi.fn(), createPR: vi.fn(), addLabels: vi.fn(), removeLabel: vi.fn(), setLabels: vi.fn(),
    ensureLabels: vi.fn(), gatherContext: vi.fn().mockResolvedValue(''), closeOpenCodePRs: vi.fn(),
    mergeMR: vi.fn(), enableAutoMerge: vi.fn(), closeIssue: vi.fn(), getReviewThreads: vi.fn().mockResolvedValue([]),
    resolveReviewThread: vi.fn(), minimizeReviewComment: vi.fn(), getBotReviewThreads: vi.fn().mockResolvedValue([]),
    getOpenHumanThreads: vi.fn().mockResolvedValue(''), updateMR: vi.fn(), getCurrentUser: vi.fn().mockResolvedValue('test'),
    paginate: vi.fn().mockResolvedValue([]),
  });
  class _MockMCPManager { connect = vi.fn(); disconnect = vi.fn(); getLibraryDocs = vi.fn(); }
  return { mockRunOpenCode, mockParseJsonlFile, mockEmptyResult, createMockAdapter: _createMockAdapter, MockMCPManager: _MockMCPManager };
});
vi.mock('/home/runner/work/opencode-ai-reviewer/opencode-ai-reviewer/lib/src/mcp/client.js', () => ({ MCPManager: MockMCPManager }));
vi.mock('/home/runner/work/opencode-ai-reviewer/opencode-ai-reviewer/lib/src/opencode.js', async (i) => ({ ...(await i()), runOpenCode: mockRunOpenCode }));
vi.mock('/home/runner/work/opencode-ai-reviewer/opencode-ai-reviewer/lib/src/jsonl-parser.js', async (i) => ({ ...(await i()), parseJsonlFile: mockParseJsonlFile, emptyResult: mockEmptyResult }));
vi.mock('@actions/core', () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('node:child_process', async () => ({ ...(await vi.importActual('node:child_process')) }));
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, promises: { readFile: vi.fn(), unlink: vi.fn(), appendFile: vi.fn(), readdir: actual.promises.readdir, stat: actual.promises.stat, mkdir: actual.promises.mkdir } };
});
import { ReviewEngine } from '../src/engine.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

function makeConfig(overrides: any = {}) {
  return { ...DEFAULT_CONFIG, timeoutMinutes: 10, ...overrides, review: { ...DEFAULT_CONFIG.review, enableReachability: false, ...(overrides.review || {}) } };
}
function makePR() {
  return { number: 42, title: 't', body: 'b', headRef: 'f', headSha: 'abc', baseRef: 'main', author: 'u', labels: [], changedFiles: [{ path: 'src/test.ts', status: 'modified', additions: 10, deletions: 2, patch: 'diff' }] };
}
describe('debug', () => {
  let engine: any;
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunOpenCode.mockImplementation(async (p: string, opts: any) => {
      console.error('RUNOPENCODE workdir=', opts?.workingDirectory, 'prompt head=', String(p).slice(0, 60).replace(/\n/g, ' '));
      return { success: true, output: '', durationMs: 100, tokensUsed: 1 };
    });
    (fs.promises.readFile as any).mockImplementation(async () => '{"type":"summary","text":"s"}\n{"type":"issue","severity":"critical","file":"src/test.ts","line":1,"message":"m"}');
    engine = new ReviewEngine(makeConfig({ multiAgent: { enabled: true, agents: { security: { enabled: true } }, synthesis: { enabled: false } } }), createMockAdapter());
  });
  it('traces', async () => {
    await engine.reviewPR(makePR());
  });
});
