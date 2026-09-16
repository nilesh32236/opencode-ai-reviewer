import type { GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeInputs, makePRContext } from './helpers/mock-factories.js';

const { mockExec, mockWarning, mockSetFailed, mockSetOutput, mockGetInput, mockReviewPR } =
  vi.hoisted(() => {
    const _mockExec = vi.fn();
    const _mockWarning = vi.fn();
    const _mockSetFailed = vi.fn();
    const _mockSetOutput = vi.fn();
    const _mockGetInput = vi.fn((name: string) => (name === 'pr-number' ? '' : ''));
    const _mockReviewPR = vi.fn();
    return {
      mockExec: _mockExec,
      mockWarning: _mockWarning,
      mockSetFailed: _mockSetFailed,
      mockSetOutput: _mockSetOutput,
      mockGetInput: _mockGetInput,
      mockReviewPR: _mockReviewPR,
    };
  });

vi.mock('@actions/exec', () => ({
  exec: mockExec,
}));

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: vi.fn(),
  warning: mockWarning,
  error: vi.fn(),
  debug: vi.fn(),
  saveState: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    payload: { pull_request: { number: 42 } },
    repo: { owner: 'o', repo: 'r' },
  },
}));

import { runReview } from '../src/review.js';
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  MAX_VERIFICATION_OUTPUT_BYTES,
  capVerificationOutput,
  createRunAbortController,
  describeAbortKind,
  execWithTimeout,
} from '../src/utils.js';

describe('capVerificationOutput', () => {
  it('passes through output within the cap unchanged', () => {
    expect(capVerificationOutput('hello')).toBe('hello');
  });

  it('caps output at 256 KiB with a truncation annotation', () => {
    const big = 'x'.repeat(300 * 1024);
    const capped = capVerificationOutput(big);
    expect(Buffer.byteLength(capped, 'utf-8')).toBeLessThanOrEqual(
      MAX_VERIFICATION_OUTPUT_BYTES + 400,
    );
    expect(capped).toContain('truncated');
  });

  it('preserves the tail (where the error usually is) when over the cap', () => {
    const big = `HEAD-MARKER-${'h'.repeat(200 * 1024)}TAIL-MARKER-${'t'.repeat(100 * 1024)}`;
    const capped = capVerificationOutput(big);
    expect(capped).toContain('HEAD-MARKER');
    expect(capped).toContain('TAIL-MARKER');
    expect(capped).toContain('truncated');
  });

  it('never splits a multi-byte sequence at the cut (no U+FFFD)', () => {
    const big = 'é'.repeat(200 * 1024); // 2 bytes each → ~400 KiB
    const capped = capVerificationOutput(big);
    expect(capped.replace(/…\[truncated.*?\]/, '')).not.toContain('�');
  });
});

describe('execWithTimeout program validation', () => {
  it.each([['/usr/bin/pnpm'], ['../bin/evil'], ['pnpm --version'], [''], ['.pnpm']])(
    'refuses non-bare program name %s',
    async (program) => {
      await expect(execWithTimeout(program, [], { timeoutMs: 1000 })).rejects.toThrow(
        /non-bare program name/,
      );
    },
  );
});

describe('describeAbortKind', () => {
  it('maps DOMException TimeoutError to timeout', () => {
    expect(describeAbortKind(new DOMException('deadline', 'TimeoutError'))).toBe('timeout');
  });

  it('maps DOMException AbortError to cancelled', () => {
    expect(describeAbortKind(new DOMException('cancel', 'AbortError'))).toBe('cancelled');
  });

  it('maps Error-named TimeoutError/AbortError', () => {
    const timeout = new Error('deadline');
    timeout.name = 'TimeoutError';
    expect(describeAbortKind(timeout)).toBe('timeout');
    const abort = new Error('cancel');
    abort.name = 'AbortError';
    expect(describeAbortKind(abort)).toBe('cancelled');
  });

  it('maps anything else to error', () => {
    expect(describeAbortKind(new Error('boom'))).toBe('error');
    expect(describeAbortKind('aborted')).toBe('error');
    expect(describeAbortKind(undefined)).toBe('error');
  });
});

describe('createRunAbortController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires with a TimeoutError reason at the deadline', () => {
    const { signal, dispose } = createRunAbortController(0.001); // ~60ms
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
    dispose();
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the 20-minute default for invalid timeout %s',
    (bad) => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const { dispose } = createRunAbortController(bad);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20 * 60 * 1000);
      setTimeoutSpy.mockRestore();
      dispose();
    },
  );

  it('dispose clears the deadline timer', () => {
    const { signal, dispose } = createRunAbortController(0.001);
    dispose();
    vi.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(false);
  });
});

describe('execWithTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exit code and captured output on success', async () => {
    mockExec.mockImplementation(
      async (
        _program: string,
        _args: string[],
        opts?: { listeners?: { stdout?: (d: Buffer) => void } },
      ) => {
        opts?.listeners?.stdout?.(Buffer.from('ok-output'));
        return 0;
      },
    );
    const result = await execWithTimeout('echo', ['hi'], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ok-output');
  });

  it('converts spawn rejection into a failure result instead of throwing', async () => {
    mockExec.mockRejectedValue(new Error('spawn echo ENOENT'));
    const result = await execWithTimeout('echo', ['hi'], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('failed to start');
  });

  it('reports a hung command as exit 124 without hanging the caller', async () => {
    mockExec.mockImplementation(() => new Promise<number>(() => {}));
    const result = await execWithTimeout('sleep', ['60'], { timeoutMs: 50 });
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain('timed out');
  });

  it('treats an already-aborted signal as a timeout and detaches the listener', async () => {
    mockExec.mockImplementation(() => new Promise<number>(() => {}));
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const result = await execWithTimeout('sleep', ['60'], {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(124);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default timeout for invalid timeoutMs %s',
    async (bad) => {
      mockExec.mockResolvedValue(0);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const result = await execWithTimeout('echo', ['hi'], { timeoutMs: bad });
      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_VERIFICATION_TIMEOUT_MS,
      );
      expect(result.exitCode).toBe(0);
      setTimeoutSpy.mockRestore();
    },
  );

  it('labels an AbortError-aborted signal as cancelled in the output', async () => {
    mockExec.mockImplementation(() => new Promise<number>(() => {}));
    const controller = new AbortController();
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    const result = await execWithTimeout('sleep', ['60'], {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain('cancelled');
    expect(result.output).toContain('AbortError');
  });

  it('retains the tail of verbose output for diagnosis', async () => {
    mockExec.mockImplementation(
      async (
        _program: string,
        _args: string[],
        opts?: { listeners?: { stdout?: (d: Buffer) => void } },
      ) => {
        opts?.listeners?.stdout?.(Buffer.from(`${'h'.repeat(200 * 1024)}TAIL-ERROR-XYZ`));
        return 1;
      },
    );
    const result = await execWithTimeout('pnpm', ['test'], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('TAIL-ERROR-XYZ');
  });
});

describe('runReview error boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the review-error marker before failing when the engine throws', async () => {
    const mockPostOrUpdateComment = vi.fn().mockResolvedValue(undefined);
    const mockGh = {
      getMR: vi.fn().mockResolvedValue(makePRContext()),
      isMR: vi.fn(),
      getBotReviewThreads: vi.fn().mockResolvedValue([]),
      postReview: vi.fn(),
      postOrUpdateComment: mockPostOrUpdateComment,
    } as unknown as GitHubHelper;
    const mockEngine = {
      reviewPR: mockReviewPR,
      getLastTelemetry: vi.fn().mockReturnValue(null),
    } as unknown as ReviewEngine;
    mockReviewPR.mockRejectedValue(new Error('LLM exploded'));

    await runReview(makeInputs(), makeConfig(), mockEngine, mockGh, 'o/r');

    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- review-error -->',
      expect.stringContaining('Review Failed'),
    );
    expect(mockSetFailed).toHaveBeenCalled();
  });
});
