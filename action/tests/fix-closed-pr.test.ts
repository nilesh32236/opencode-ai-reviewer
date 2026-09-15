import * as exec from '@actions/exec';
import type { PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPrClosedOrMerged, runFix } from '../src/fix.js';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils.js')>();
  return {
    ...mod,
    resolvePrNumber: vi.fn().mockResolvedValue(42),
  };
});

function mockGh(prState?: string) {
  return {
    listComments: vi.fn().mockResolvedValue([]),
    getMR: vi.fn().mockResolvedValue(makePRContext({ state: prState })),
    gatherContext: vi.fn().mockResolvedValue('## context'),
    setLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformAdapter;
}

function mockEngine() {
  return {
    runFix: vi.fn().mockResolvedValue({ changesMade: true, summary: 's', filesChanged: ['a.ts'] }),
  } as unknown as ReviewEngine;
}

describe('isPrClosedOrMerged', () => {
  it('returns false for open states and unknown state', () => {
    expect(isPrClosedOrMerged('open')).toBe(false);
    expect(isPrClosedOrMerged('opened')).toBe(false);
    expect(isPrClosedOrMerged(undefined)).toBe(false);
    expect(isPrClosedOrMerged('')).toBe(false);
  });

  it('returns true for closed/merged states', () => {
    expect(isPrClosedOrMerged('closed')).toBe(true);
    expect(isPrClosedOrMerged('merged')).toBe(true);
  });
});

describe('runFix closed-PR guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['merged', 'closed'])(
    'skips commit and push when the PR is already %s',
    async (state) => {
      const gh = mockGh(state);
      const engine = mockEngine();

      await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

      // Fix ran, but no git operations were attempted on the dead branch.
      expect(engine.runFix).toHaveBeenCalledTimes(1);
      expect(exec.exec).not.toHaveBeenCalled();
    },
  );

  it('pushes normally when the PR is still open', async () => {
    const gh = mockGh('open');
    const engine = mockEngine();
    vi.mocked(exec.exec).mockResolvedValue(0);
    vi.mocked(exec.getExecOutput).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

    const commands = vi.mocked(exec.exec).mock.calls.map((c) => c[1]);
    expect(commands).toContainEqual(['add', '-A']);
    expect(commands.some((args) => Array.isArray(args) && args[0] === 'commit')).toBe(true);
  });
});
