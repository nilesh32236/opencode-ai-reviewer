import * as exec from '@actions/exec';
import type { PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_FAILED_MARKER,
  buildVerificationFailedCommentBody,
  runFix,
} from '../src/fix.js';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

const { mockSetOutput, mockSetFailed, mockExecWithTimeout } = vi.hoisted(() => ({
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockExecWithTimeout: vi.fn(),
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock('@actions/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@actions/core')>();
  return {
    ...mod,
    setOutput: mockSetOutput,
    setFailed: mockSetFailed,
    info: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils.js')>();
  return {
    ...mod,
    resolvePrNumber: vi.fn().mockResolvedValue(42),
    execWithTimeout: mockExecWithTimeout,
  };
});

function mockGh() {
  return {
    listComments: vi.fn().mockResolvedValue([]),
    getMR: vi.fn().mockResolvedValue(makePRContext({ state: 'open' })),
    gatherContext: vi.fn().mockResolvedValue('## context'),
    setLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    postOrUpdateComment: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(1),
  } as unknown as PlatformAdapter;
}

describe('buildVerificationFailedCommentBody', () => {
  it('includes the stable marker and requested output', () => {
    const body = buildVerificationFailedCommentBody('boom');
    expect(body).toContain(VERIFICATION_FAILED_MARKER);
    expect(body).toContain('boom');
  });

  it('neutralizes triple-backtick sequences so output cannot break the fence', () => {
    const body = buildVerificationFailedCommentBody('evil ```evil``` payload');
    expect(body).not.toContain('```evil```');
    expect(body).toContain('ˋˋˋevilˋˋˋ');
  });

  it('falls back to a diagnostic message when output is empty', () => {
    const body = buildVerificationFailedCommentBody('');
    expect(body).toContain('did not pass after retries');
    // A fallback body must still render a non-empty fenced block.
    expect(body).not.toMatch(/```\n\n```/);
  });

  it('caps embedded output at the length limit', () => {
    const body = buildVerificationFailedCommentBody('x'.repeat(5000));
    expect(body).toContain('…[truncated ');
  });

  it('appends optional extra context (e.g. iteration exhaustion)', () => {
    const body = buildVerificationFailedCommentBody('boom', 'exhaustion context');
    expect(body).toContain('exhaustion context');
  });
});

describe('runFix verification fail-closed gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exec.exec).mockResolvedValue(0);
    vi.mocked(exec.getExecOutput).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('fails closed on final-retry non-zero with truthful changes_made, label, and comment', async () => {
    const gh = mockGh();
    // Every verification attempt fails; retries produce no new changes.
    mockExecWithTimeout.mockResolvedValue({ exitCode: 1, output: 'check failed' });
    const engine = {
      runFix: vi
        .fn()
        .mockResolvedValueOnce({ changesMade: true, summary: 's', filesChanged: ['a.ts'] })
        .mockResolvedValue({ changesMade: false, summary: 's', filesChanged: [] }),
    } as unknown as ReviewEngine;

    await runFix(
      makeInputs({ runChecksAfterFix: 'echo hello', checkAllowlist: ['echo'] }),
      makeConfig({ maxIterations: 3 }),
      engine,
      gh,
    );

    expect(mockSetFailed).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(mockSetFailed).mock.calls[0]?.[0] ?? '')).toMatch(
      /Verification failed/,
    );
    // The fix WAS pushed — downstream steps must see the truthful push state.
    expect(mockSetOutput).toHaveBeenCalledWith('changes_made', 'true');
    expect(gh.setLabels).toHaveBeenCalledWith(
      expect.anything(),
      ['autofix:needs-manual-review'],
      expect.anything(),
    );
    expect(gh.postOrUpdateComment).toHaveBeenCalledWith(
      expect.anything(),
      VERIFICATION_FAILED_MARKER,
      expect.stringContaining(VERIFICATION_FAILED_MARKER),
    );
  });

  it('fails closed on parse rejection with truthful changes_made and label', async () => {
    const gh = mockGh();
    const engine = {
      runFix: vi
        .fn()
        .mockResolvedValue({ changesMade: true, summary: 's', filesChanged: ['a.ts'] }),
    } as unknown as ReviewEngine;

    await runFix(
      makeInputs({ runChecksAfterFix: 'not-allowed-prog --x', checkAllowlist: ['echo'] }),
      makeConfig({ maxIterations: 3 }),
      engine,
      gh,
    );

    expect(mockSetFailed).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(mockSetFailed).mock.calls[0]?.[0] ?? '')).toMatch(
      /Verification command rejected/,
    );
    expect(mockSetOutput).toHaveBeenCalledWith('changes_made', 'true');
    expect(gh.setLabels).toHaveBeenCalledWith(
      expect.anything(),
      ['autofix:needs-manual-review'],
      expect.anything(),
    );
  });

  it('succeeds when verification passes (no false-positive fail-closed)', async () => {
    const gh = mockGh();
    mockExecWithTimeout.mockResolvedValue({ exitCode: 0, output: 'ok' });
    const engine = {
      runFix: vi
        .fn()
        .mockResolvedValue({ changesMade: true, summary: 's', filesChanged: ['a.ts'] }),
    } as unknown as ReviewEngine;

    await runFix(
      makeInputs({ runChecksAfterFix: 'echo hello', checkAllowlist: ['echo'] }),
      makeConfig({ maxIterations: 3 }),
      engine,
      gh,
    );

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('changes_made', 'true');
  });

  it('preserves git-failure handling (lost push never reports success)', async () => {
    const gh = mockGh();
    vi.mocked(exec.exec).mockRejectedValueOnce(new Error('push denied'));
    const engine = {
      runFix: vi
        .fn()
        .mockResolvedValue({ changesMade: true, summary: 's', filesChanged: ['a.ts'] }),
    } as unknown as ReviewEngine;

    await runFix(makeInputs(), makeConfig({ maxIterations: 3 }), engine, gh);

    expect(mockSetFailed).toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('changes_made', 'false');
  });
});
