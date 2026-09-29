import { REVIEW_MARKER } from '@opencode-pr-agent/lib';
import type { PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFix } from '../src/fix.js';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

const { mockSetOutput, mockSetFailed, mockInfo, mockWarning } = vi.hoisted(() => ({
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockInfo: vi.fn(),
  mockWarning: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  getInput: vi.fn().mockReturnValue(''),
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn().mockResolvedValue(0),
  getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

vi.mock('@actions/github', () => ({
  context: { payload: { pull_request: { number: 42 } }, repo: { owner: 'o', repo: 'r' } },
}));

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils.js')>();
  return { ...mod, resolvePrNumber: vi.fn().mockResolvedValue(42) };
});

function makeGh(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listComments: vi.fn().mockResolvedValue([]),
    getMR: vi.fn().mockResolvedValue(makePRContext()),
    gatherContext: vi.fn().mockResolvedValue('## context'),
    setLabels: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PlatformAdapter;
}

const engine = { runFix: vi.fn() } as unknown as ReviewEngine;

function markerComments(count: number) {
  return Array.from({ length: count }, (_v, i) => ({ id: i + 1, body: `${REVIEW_MARKER}\n\nrun` }));
}

describe('runFix REVIEW_MARKER iteration scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bounds the comment scan to 3 pages x 100 and keeps the loud-failure guard', async () => {
    const listComments = vi.fn().mockResolvedValue(markerComments(3));
    const gh = makeGh({ listComments });

    await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

    expect(listComments).toHaveBeenCalledTimes(1);
    const [prNumber, options] = vi.mocked(listComments).mock.calls[0] as unknown as [
      number,
      {
        perPage: number;
        maxPages: number;
        direction: string;
        throwOnError: boolean;
        stopWhen: (items: Array<Record<string, unknown>>) => boolean;
      },
    ];
    expect(prNumber).toBe(42);
    expect(options.perPage).toBe(100);
    // The audit fix: 3 pages (300 comments) instead of 10 pages (1000).
    expect(options.maxPages).toBe(3);
    expect(options.direction).toBe('desc');
    expect(options.throwOnError).toBe(true);
  });

  it('stops paginating as soon as maxIterations markers are accumulated', async () => {
    const listComments = vi.fn().mockResolvedValue(markerComments(3));
    const gh = makeGh({ listComments });

    await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

    const options = vi.mocked(listComments).mock.calls[0]?.[1] as unknown as {
      stopWhen: (items: Array<Record<string, unknown>>) => boolean;
    };
    expect(typeof options.stopWhen).toBe('function');
    expect(options.stopWhen([{ body: 'unrelated chatter' }])).toBe(false);
    expect(
      options.stopWhen([
        { body: 'chatter' },
        { body: `noise ${REVIEW_MARKER}` },
        { body: 'more noise' },
      ]),
    ).toBe(false);
    expect(options.stopWhen(markerComments(3) as unknown as Array<Record<string, unknown>>)).toBe(
      true,
    );
  });

  it('fails closed when the bounded scan comes back at the truncation cap', async () => {
    const listComments = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 300 }, (_v, i) => ({ id: i + 1, body: 'chatter' })));
    const getMR = vi.fn().mockResolvedValue(makePRContext());
    const gh = makeGh({ listComments, getMR });

    await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('truncated at 300 comments (3 pages x 100)'),
    );
    expect(mockSetOutput).toHaveBeenCalledWith('changes_made', 'false');
    // Nothing beyond the scan may be attempted once the count is unprovable.
    expect(getMR).not.toHaveBeenCalled();
  });

  it('does not trip the truncation guard one comment below the cap', async () => {
    const listComments = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 299 }, (_v, i) => ({ id: i + 1, body: 'chatter' })));
    const gh = makeGh({ listComments });

    await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

    expect(mockSetFailed).not.toHaveBeenCalledWith(
      expect.stringContaining('Issue comment list truncated'),
    );
    // Run continued past the count gate.
    expect(gh.getMR).toHaveBeenCalled();
  });
});
