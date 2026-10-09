import * as exec from '@actions/exec';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetState,
  mockGetInput,
  mockInfo,
  mockWarning,
  mockSaveState,
  mockExecWithTimeout,
  mockGetExecOutput,
} = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockGetInput: vi.fn(),
  mockInfo: vi.fn(),
  mockWarning: vi.fn(),
  mockSaveState: vi.fn(),
  mockExecWithTimeout: vi.fn(),
  mockGetExecOutput: vi.fn(),
}));

vi.mock('@actions/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@actions/core')>();
  return {
    ...mod,
    getState: mockGetState,
    getInput: mockGetInput,
    info: mockInfo,
    warning: mockWarning,
    saveState: mockSaveState,
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    summary: {
      addHeading: vi.fn().mockReturnThis(),
      addList: vi.fn().mockReturnThis(),
      write: vi.fn(),
    },
  };
});

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: mockGetExecOutput,
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: {
      pull_request: { number: 42 },
    },
  },
}));

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils.js')>();
  return {
    ...mod,
    execWithTimeout: mockExecWithTimeout,
  };
});

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    LearningStore: class {
      async getTelemetryStats() {
        return { totalReviews: 0, avgDurationMs: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
      }
      async getPerPRStats() {
        return { totalPrs: 0, totalFindings: 0, avgFindingsPerPr: 0, maxFindingsInPr: 0 };
      }
      async getSeverityDistribution() {
        return { critical: 0, important: 0, minor: 0, unknown: 0 };
      }
      async close() {}
    },
  };
});

import {
  FIX_EXIT_REASON_STATE_KEY as FIX_KEY,
  isMutatedTreeExitReason,
  saveFixExitReason,
} from '../src/fix.js';
import {
  FIX_EXIT_REASON_STATE_KEY as POST_KEY,
  hasUncommittedChanges,
  hasUnpushedCommits,
  runPost,
  shouldSkipPostVerification,
} from '../src/post.js';
import { makeInputs } from './helpers/mock-factories.js';

const MUTATED = ['no-changes', 'git-failure', 'NO-CHANGES', 'Git-Failure', '  no-changes  '];
const NOT_MUTATED = [
  undefined,
  null,
  '',
  '   ',
  'success',
  'verification-failed',
  'approved',
  'exhausted',
  'cancelled',
  'context-failure',
  'pr-closed',
  'deferred',
  'no-change',
  'git-failures',
];

describe('isMutatedTreeExitReason / shouldSkipPostVerification', () => {
  it.each(MUTATED)('treats %p as a mutated-tree reason', (reason) => {
    expect(isMutatedTreeExitReason(reason)).toBe(true);
    expect(shouldSkipPostVerification(reason)).toBe(true);
  });

  it.each(NOT_MUTATED)('does not treat %p as a mutated-tree reason', (reason) => {
    expect(isMutatedTreeExitReason(reason)).toBe(false);
    expect(shouldSkipPostVerification(reason)).toBe(false);
  });
});

describe('fix/post exit-reason bridge sync', () => {
  it('uses the same state key on both sides of the bridge', () => {
    expect(POST_KEY).toBe(FIX_KEY);
    expect(FIX_KEY).toBe('fix_exit_reason');
  });

  it('both predicates agree on every known reason', () => {
    const reasons = [...MUTATED, ...NOT_MUTATED];
    for (const reason of reasons) {
      expect(
        shouldSkipPostVerification(reason),
        `predicate drift for reason ${String(reason)}`,
      ).toBe(isMutatedTreeExitReason(reason));
    }
  });
});

describe('saveFixExitReason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the terminal reason under the shared state key', () => {
    saveFixExitReason('no-changes');
    expect(mockSaveState).toHaveBeenCalledWith('fix_exit_reason', 'no-changes');
  });

  it('never throws when the state write fails', () => {
    mockSaveState.mockImplementationOnce(() => {
      throw new Error('state unavailable');
    });
    expect(() => saveFixExitReason('git-failure')).not.toThrow();
  });
});

describe('hasUncommittedChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('scopes the probe to tracked files so untracked artifacts cannot skip verification', async () => {
    await hasUncommittedChanges();
    expect(mockGetExecOutput).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ silent: true, ignoreReturnCode: true }),
    );
  });

  it('returns true when tracked modifications exist', async () => {
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' });
    await expect(hasUncommittedChanges()).resolves.toBe(true);
  });

  it('returns false on a clean tree', async () => {
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '   \n', stderr: '' });
    await expect(hasUncommittedChanges()).resolves.toBe(false);
  });

  it('fails open (false) when the probe rejects', async () => {
    mockGetExecOutput.mockRejectedValue(new Error('no git'));
    await expect(hasUncommittedChanges()).resolves.toBe(false);
  });
});

describe('hasUnpushedCommits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when HEAD is ahead of its upstream', async () => {
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '2\n', stderr: '' });
    await expect(hasUnpushedCommits()).resolves.toBe(true);
    expect(mockGetExecOutput).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--count', '@{u}..HEAD'],
      expect.objectContaining({ silent: true, ignoreReturnCode: true }),
    );
  });

  it('returns false when HEAD matches upstream', async () => {
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '0\n', stderr: '' });
    await expect(hasUnpushedCommits()).resolves.toBe(false);
  });

  it('fails open (false) when there is no upstream', async () => {
    mockGetExecOutput.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'no upstream' });
    await expect(hasUnpushedCommits()).resolves.toBe(false);
  });

  it('fails open (false) when the probe rejects', async () => {
    mockGetExecOutput.mockRejectedValue(new Error('no git'));
    await expect(hasUnpushedCommits()).resolves.toBe(false);
  });
});

describe('runPost verification skip-branching (issue #942)', () => {
  const mockGh = { postOrUpdateComment: vi.fn() } as unknown as Parameters<typeof runPost>[1];

  function fixInputs() {
    return makeInputs({
      mode: 'fix',
      runChecksAfterFix: 'echo hello',
      checkAllowlist: ['echo'],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue('');
    mockGetInput.mockImplementation((name: string) => (name === 'learning_enabled' ? 'false' : ''));
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockExecWithTimeout.mockResolvedValue({ exitCode: 0, output: 'ok' });
  });

  it('skips verification via the state bridge even on a clean tree', async () => {
    mockGetState.mockImplementation((key: string) =>
      key === 'fix_exit_reason' ? 'no-changes' : '',
    );

    await runPost(fixInputs(), mockGh, 'owner/repo', 'token');

    expect(mockExecWithTimeout).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Skipping verification'));
  });

  it('skips verification via the dirty-tree fallback when state is absent', async () => {
    mockGetState.mockReturnValue('');
    // git status reports tracked edits; rev-list reports no unpushed commits.
    mockGetExecOutput.mockImplementation((_prog: string, args: string[]) => {
      if (args.includes('--porcelain')) {
        return Promise.resolve({ exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' });
    });

    await runPost(fixInputs(), mockGh, 'owner/repo', 'token');

    expect(mockExecWithTimeout).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Skipping verification'));
  });

  it('skips verification via the ahead-of-remote fallback on a clean tree with unpushed commits', async () => {
    mockGetState.mockReturnValue('');
    mockGetExecOutput.mockImplementation((_prog: string, args: string[]) => {
      if (args.includes('--porcelain')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '1\n', stderr: '' });
    });

    await runPost(fixInputs(), mockGh, 'owner/repo', 'token');

    expect(mockExecWithTimeout).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Skipping verification'));
  });

  it('runs verification on a clean tree with no state (behavior preserved)', async () => {
    mockGetState.mockReturnValue('');
    mockGetExecOutput.mockImplementation((_prog: string, args: string[]) => {
      if (args.includes('--porcelain')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '0\n', stderr: '' });
    });

    await runPost(fixInputs(), mockGh, 'owner/repo', 'token');

    expect(mockExecWithTimeout).toHaveBeenCalled();
    expect(mockWarning).not.toHaveBeenCalledWith(expect.stringContaining('Skipping verification'));
  });
});
