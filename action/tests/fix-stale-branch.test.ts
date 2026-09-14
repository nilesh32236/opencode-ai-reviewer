import * as exec from '@actions/exec';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFixIssue } from '../src/fix.js';
import type { ActionInputs } from '../src/inputs';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils.js')>();
  return {
    ...mod,
    resolvePrNumber: vi.fn().mockResolvedValue(123),
  };
});

const BOT_EMAIL = 'bot@example.com';
const DEFAULT_SHA = 'default-tip-sha';
const STALE_BASE_SHA = 'stale-base-sha';

function mockGh() {
  return {
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    gatherContext: vi.fn().mockResolvedValue('# 🔍 Issue Analysis & Implementation Plan\nbody'),
    getIssue: vi.fn().mockResolvedValue({ title: 't', comments: [], labels: [] }),
    ensureLabels: vi.fn().mockResolvedValue(undefined),
    createPR: vi.fn().mockResolvedValue({ url: 'http://pr', number: 1 }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    postOrUpdateComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformAdapter;
}

function mockEngine() {
  return {
    runFix: vi
      .fn()
      .mockResolvedValue({ changesMade: true, summary: 's', filesChanged: ['foo.ts'] }),
  } as unknown as ReviewEngine;
}

/**
 * Configure git probes.
 * @param tipEmail - stdout for `git log -1 --format=%ae origin/autofix/issue-123`
 *   (null = non-zero exit, i.e. no remote branch).
 * @param mergeBase - stdout for `git merge-base origin/branch origin/main`.
 * @param isAncestorExit - exit code for `git merge-base --is-ancestor`.
 */
function mockGitProbes(
  tipEmail: string | null,
  mergeBase: string,
  isAncestorExit: number,
): { execCalls: unknown[][] } {
  const execCalls: unknown[][] = [];
  vi.mocked(exec.exec).mockImplementation(async (...args: unknown[]) => {
    execCalls.push(args as unknown[]);
    const cliArgs = args[1] as string[];
    if (cliArgs.includes('--is-ancestor')) {
      return isAncestorExit;
    }
    return 0;
  });
  vi.mocked(exec.getExecOutput).mockImplementation(async (...args: unknown[]) => {
    const cliArgs = args[1] as string[];
    if (cliArgs[0] === 'log') {
      return tipEmail === null
        ? { exitCode: 1, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: `${tipEmail}\n`, stderr: '' };
    }
    if (cliArgs[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${DEFAULT_SHA}\n`, stderr: '' };
    }
    if (cliArgs[0] === 'merge-base') {
      return { exitCode: 0, stdout: `${mergeBase}\n`, stderr: '' };
    }
    if (cliArgs[0] === 'status') {
      return { exitCode: 0, stdout: ' M foo.ts\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { execCalls };
}

function checkoutArgs(calls: unknown[][]): string[][] {
  return calls.filter((c) => (c[1] as string[])[0] === 'checkout').map((c) => c[1] as string[]);
}

function pushArgs(calls: unknown[][]): string[][] {
  return calls.filter((c) => (c[1] as string[])[0] === 'push').map((c) => c[1] as string[]);
}

describe('runFixIssue stale autofix branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses bot branch with --force-with-lease when base is fresh', async () => {
    const { execCalls } = mockGitProbes(BOT_EMAIL, DEFAULT_SHA, 0);

    await runFixIssue(
      {} as ActionInputs,
      {} as AgentConfig,
      mockEngine(),
      mockGh(),
      'owner/repo',
      BOT_EMAIL,
    );

    expect(checkoutArgs(execCalls)).toContainEqual([
      'checkout',
      '-B',
      'autofix/issue-123',
      'origin/autofix/issue-123',
    ]);
    const pushes = pushArgs(execCalls);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(['push', 'origin', 'autofix/issue-123', '--force-with-lease']);
  });

  it('recreates from default with --force when bot branch base is stale', async () => {
    const { execCalls } = mockGitProbes(BOT_EMAIL, STALE_BASE_SHA, 1);

    await runFixIssue(
      {} as ActionInputs,
      {} as AgentConfig,
      mockEngine(),
      mockGh(),
      'owner/repo',
      BOT_EMAIL,
    );

    expect(checkoutArgs(execCalls)).toContainEqual([
      'checkout',
      '-B',
      'autofix/issue-123',
      'origin/main',
    ]);
    expect(checkoutArgs(execCalls)).not.toContainEqual([
      'checkout',
      '-B',
      'autofix/issue-123',
      'origin/autofix/issue-123',
    ]);
    const pushes = pushArgs(execCalls);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(['push', 'origin', 'autofix/issue-123', '--force']);
  });

  it('creates fresh branch from default when no remote branch exists', async () => {
    const { execCalls } = mockGitProbes(null, DEFAULT_SHA, 0);

    await runFixIssue(
      {} as ActionInputs,
      {} as AgentConfig,
      mockEngine(),
      mockGh(),
      'owner/repo',
      BOT_EMAIL,
    );

    expect(checkoutArgs(execCalls)).toContainEqual([
      'checkout',
      '-B',
      'autofix/issue-123',
      'origin/main',
    ]);
    const pushes = pushArgs(execCalls);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(['push', 'origin', 'autofix/issue-123', '--force']);
  });

  it('treats probe failures as stale and recreates from default', async () => {
    const execCalls: unknown[][] = [];
    vi.mocked(exec.exec).mockImplementation(async (...args: unknown[]) => {
      execCalls.push(args as unknown[]);
      return 0;
    });
    vi.mocked(exec.getExecOutput).mockImplementation(async (...args: unknown[]) => {
      const cliArgs = args[1] as string[];
      if (cliArgs[0] === 'log') {
        return { exitCode: 0, stdout: `${BOT_EMAIL}\n`, stderr: '' };
      }
      if (cliArgs[0] === 'status') {
        return { exitCode: 0, stdout: ' M foo.ts\n', stderr: '' };
      }
      // rev-parse / merge-base probes fail → fail closed toward stale
      return { exitCode: 1, stdout: '', stderr: 'boom' };
    });

    await runFixIssue(
      {} as ActionInputs,
      {} as AgentConfig,
      mockEngine(),
      mockGh(),
      'owner/repo',
      BOT_EMAIL,
    );

    expect(checkoutArgs(execCalls)).toContainEqual([
      'checkout',
      '-B',
      'autofix/issue-123',
      'origin/main',
    ]);
    const pushes = pushArgs(execCalls);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(['push', 'origin', 'autofix/issue-123', '--force']);
  });

  it('rejects invalid defaultBranch before any git exec', async () => {
    const gh = {
      getDefaultBranch: vi.fn().mockResolvedValue('--upload-pack=touch'),
    } as unknown as PlatformAdapter;

    await expect(
      runFixIssue({} as ActionInputs, {} as AgentConfig, {} as ReviewEngine, gh, 'o/r', BOT_EMAIL),
    ).rejects.toThrow(/Ref name must not begin with a dash/);
    expect(exec.exec).not.toHaveBeenCalled();
    expect(exec.getExecOutput).not.toHaveBeenCalled();
  });
});
