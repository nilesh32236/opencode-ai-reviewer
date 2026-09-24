import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSetupOpenCode, mockReviewPR, mockReviewEngine } = vi.hoisted(() => ({
  mockSetupOpenCode: vi.fn(),
  mockReviewPR: vi.fn(),
  mockReviewEngine: vi.fn(),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    isInsideGitWorkTree: vi.fn(() => true),
    buildPRContextFromBranchDiff: vi.fn(),
    buildPRContextFromStagedDiff: vi.fn(() => ({
      number: 1,
      title: 'Test',
      body: '',
      headRef: 'HEAD',
      headSha: 'abc',
      baseRef: 'main',
      author: 'tester',
      labels: [],
      changedFiles: [{ path: 'src/file.ts', status: 'modified', additions: 1, deletions: 0 }],
    })),
    loadConfig: vi.fn(() => null),
    setupOpenCode: mockSetupOpenCode,
    setOpenCodeRunMode: vi.fn(),
    ReviewEngine: class {
      constructor(...args: unknown[]) {
        mockReviewEngine(...args);
      }

      reviewPR = mockReviewPR;
    },
  };
});

vi.mock('../src/config.js', () => ({
  buildAgentConfig: vi.fn(() => ({})),
}));
vi.mock('../src/local-adapter.js', () => ({
  LocalAdapter: class {},
}));
vi.mock('../src/formatters/index.js', () => ({
  formatJson: vi.fn(),
  formatMarkdown: vi.fn(),
  formatTerminal: vi.fn(() => ''),
}));

import { runReviewCommand } from '../src/commands/review.js';

describe('runReviewCommand execution budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSetupOpenCode.mockResolvedValue('/usr/bin/opencode');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses one controller budget across CLI setup and review stages', async () => {
    let executionSignal: AbortSignal | undefined;
    mockSetupOpenCode.mockImplementation(
      async (
        _version: string,
        _token: string | undefined,
        _minimum: string | undefined,
        options: { signal?: AbortSignal },
      ) => {
        executionSignal = options.signal;
        expect(executionSignal?.aborted).toBe(false);
        vi.advanceTimersByTime(30_000);
        expect(executionSignal?.aborted).toBe(false);
        return '/usr/bin/opencode';
      },
    );
    mockReviewPR.mockImplementation(async () => {
      vi.advanceTimersByTime(40_000);
      if (executionSignal?.aborted) throw executionSignal.reason;
      return {
        summary: 'ok',
        issues: [],
        strengths: [],
        verdict: { ready: true, reasoning: 'ok' },
      };
    });

    const exitCode = await runReviewCommand({
      staged: true,
      output: 'terminal',
      cwd: '/repo',
      timeoutMinutes: 1,
    });

    expect(exitCode).toBe(1);
    expect(mockSetupOpenCode).toHaveBeenCalledTimes(1);
    expect(mockReviewEngine).toHaveBeenCalledTimes(1);
    expect(mockReviewPR).toHaveBeenCalledTimes(1);
    expect(mockSetupOpenCode.mock.calls[0][3].signal).toBe(executionSignal);
    expect(mockReviewEngine.mock.calls[0][6]).toBe(executionSignal);
    expect(executionSignal?.aborted).toBe(true);
  });
});
