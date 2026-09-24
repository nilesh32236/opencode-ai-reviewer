import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs } from './helpers/mock-factories.js';

const { mockCore, mockExec, mockGetDefaultBranch, mockEnsureLabels, mockCreatePR, mockAddLabels } =
  vi.hoisted(() => ({
    mockCore: {
      getInput: vi.fn().mockReturnValue(''),
      setFailed: vi.fn(),
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
    mockExec: vi.fn().mockResolvedValue(0),
    mockGetDefaultBranch: vi.fn(),
    mockEnsureLabels: vi.fn(),
    mockCreatePR: vi.fn(),
    mockAddLabels: vi.fn(),
  }));

vi.mock('@actions/core', () => mockCore);
vi.mock('@actions/exec', () => ({ exec: mockExec }));
vi.mock('@actions/github', () => ({
  context: { payload: {}, repo: { owner: 'owner', repo: 'repo' } },
}));

import { runSelfHeal as runSelfHealAction } from '../src/self-heal.js';

describe('self-heal Action deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultBranch.mockResolvedValue('main');
  });

  it('passes the absolute signal to the engine and does not retry or push after timeout', async () => {
    const controller = new AbortController();
    const runSelfHeal = vi.fn(async () => {
      controller.abort(new DOMException('deadline', 'TimeoutError'));
      throw new DOMException('deadline', 'TimeoutError');
    });
    const engine = { runSelfHeal } as unknown as ReviewEngine;
    const gh = {
      getDefaultBranch: mockGetDefaultBranch,
      ensureLabels: mockEnsureLabels,
      createPR: mockCreatePR,
      addLabels: mockAddLabels,
    } as unknown as PlatformAdapter;
    const config = makeConfig({ timeoutMinutes: 1 }) as AgentConfig;

    await runSelfHealAction(
      makeInputs({ mode: 'self-heal', ciFailureLogs: 'build failed' }),
      config,
      engine,
      gh,
      'owner/repo',
      'token',
      controller.signal,
    );

    expect(runSelfHeal).toHaveBeenCalledTimes(1);
    expect(runSelfHeal).toHaveBeenCalledWith(
      'build failed',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(mockExec).not.toHaveBeenCalledWith('git', [
      'push',
      'origin',
      expect.any(String),
      '--force-with-lease',
    ]);
    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('timeout'));
  });
});
