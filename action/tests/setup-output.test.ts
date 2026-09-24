import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs } from './helpers/mock-factories.js';

const { mockCore, mockRunAll } = vi.hoisted(() => ({
  mockCore: {
    info: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockRunAll: vi.fn(),
}));

vi.mock('@actions/core', () => mockCore);
vi.mock('@actions/github', () => ({
  context: { payload: {} },
}));
vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    SetupEngine: class {
      runAll = mockRunAll;
      formatReport = vi.fn();
    },
  };
});

import { runSetup } from '../src/setup.js';

describe('setup action output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAll.mockRejectedValue(new Error('setup failed'));
  });

  it('marks setup_passed=false when validation throws', async () => {
    const gh = {
      postOrUpdateComment: vi.fn(),
    } as unknown as PlatformAdapter;

    await runSetup(makeInputs({ mode: 'setup' }), makeConfig(), gh, 'owner/repo', 'token');

    expect(mockCore.setOutput).toHaveBeenCalledWith('setup_passed', 'false');
    expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('setup failed'));
  });
});
