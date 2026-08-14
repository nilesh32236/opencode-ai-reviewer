import * as core from '@actions/core';
import * as exec from '@actions/exec';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInputs } from '../src/inputs.js';
import { runSelfHeal } from '../src/self-heal.js';

vi.mock('@actions/exec');
vi.mock('@actions/core');

describe('runSelfHeal', () => {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  let mockEngine: any;
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  let mockGh: any;
  let mockInputs: ActionInputs;
  let mockConfig: AgentConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine = {
      runSelfHeal: vi.fn().mockResolvedValue({ changesMade: false }),
    };
    mockGh = {
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      ensureLabels: vi.fn(),
      createPR: vi.fn().mockResolvedValue({ number: 1, url: 'https://github.com/a/b/pull/1' }),
      addLabels: vi.fn(),
    };
    mockInputs = {
      ciFailureLogs: 'some logs',
    } as ActionInputs;
    mockConfig = {} as AgentConfig;
    process.env.GITHUB_RUN_ID = '123';
  });

  it('rejects an invalid branchName (invalid chars) and throws/fails action', async () => {
    process.env.GITHUB_RUN_ID = 'injection \n injection';
    await expect(
      runSelfHeal(mockInputs, mockConfig, mockEngine, mockGh, 'owner/repo', 'token'),
    ).rejects.toThrow(/contains invalid characters/);
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it('rejects an invalid branchName (leading dash) and throws/fails action', async () => {
    process.env.GITHUB_RUN_ID = 'id';
    mockGh.getDefaultBranch.mockResolvedValueOnce('-main'); // inject leading dash into default branch
    await expect(
      runSelfHeal(mockInputs, mockConfig, mockEngine, mockGh, 'owner/repo', 'token'),
    ).rejects.toThrow('Ref name must not begin with a dash');
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it('proceeds to checkout and push with valid branchName', async () => {
    process.env.GITHUB_RUN_ID = '123';
    mockEngine.runSelfHeal.mockResolvedValueOnce({ changesMade: true });

    // mock verification
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (exec.exec as any).mockImplementation((prog: string, _args: string[]) => {
      if (prog === 'pnpm') return Promise.resolve(0);
      return Promise.resolve(0);
    });

    await runSelfHeal(mockInputs, mockConfig, mockEngine, mockGh, 'owner/repo', 'token');

    expect(exec.exec).toHaveBeenCalledWith('git', [
      'checkout',
      '-b',
      'fix/ci-heal-123',
      'origin/main',
    ]);
  });
});
