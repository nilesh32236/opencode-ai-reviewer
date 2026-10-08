import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPATCHABLE_TASK_TYPES, isDispatchableTaskType } from '../src/queue/types.js';
import {
  PLATFORM_OPENCODE_INVOCATION_TIMEOUT_MINUTES,
  dispatchTask,
  resolveConfig,
  runReview,
} from '../src/queue/worker.js';

const ORIGINAL_ENV = { ...process.env };

describe('worker resolveConfig', () => {
  beforeEach(() => {
    // Reset env to defaults for each test.
    process.env.REVIEW_MODEL = '';
    process.env.FIX_MODEL = '';
    process.env.AUDIT_MODEL = '';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns a config with defaults and an explicit worker cap', () => {
    const config = resolveConfig();
    expect(config.reviewModel).toBeTruthy();
    expect(config.fixModel).toBeTruthy();
    expect(config.timeoutMinutes).toBe(PLATFORM_OPENCODE_INVOCATION_TIMEOUT_MINUTES);
  });

  it('honours REVIEW_MODEL / FIX_MODEL / AUDIT_MODEL env overrides', () => {
    process.env.REVIEW_MODEL = 'opencode-go/muse-spark-1.3-contributor';
    process.env.FIX_MODEL = 'opencode-go/muse-spark-1.3-contributor';
    process.env.AUDIT_MODEL = 'opencode-go/muse-spark-1.3-contributor';
    const config = resolveConfig();
    expect(config.reviewModel).toBe('opencode-go/muse-spark-1.3-contributor');
    expect(config.fixModel).toBe('opencode-go/muse-spark-1.3-contributor');
    expect(config.auditModel).toBe('opencode-go/muse-spark-1.3-contributor');
  });

  it('prefers an explicitly provided config over env', () => {
    process.env.REVIEW_MODEL = 'env/model';
    const provided = { ...resolveConfig(), reviewModel: 'explicit/model' };
    expect(resolveConfig(provided).reviewModel).toBe('explicit/model');
  });

  it('retains the worker cap when a provided config omits timeoutMinutes', () => {
    const provided = { ...resolveConfig(), timeoutMinutes: undefined };
    expect(resolveConfig(provided).timeoutMinutes).toBe(
      PLATFORM_OPENCODE_INVOCATION_TIMEOUT_MINUTES,
    );
  });

  it('rejects an invalid provided invocation timeout', () => {
    const provided = { ...resolveConfig(), timeoutMinutes: Number.NaN };
    expect(() => resolveConfig(provided)).toThrow(/positive integer/);
  });
});

describe('worker function-score forwarding', () => {
  const changedFiles = [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    },
  ];

  function mocks(result: Record<string, unknown> = { skipped: false }) {
    const engine = { reviewPR: vi.fn().mockResolvedValue(result) };
    const gh = {
      getMR: vi.fn().mockResolvedValue({ headSha: 'abc123', changedFiles }),
      postReview: vi.fn().mockResolvedValue({}),
    };
    return { engine, gh };
  }

  function configWithFlag(flag: boolean) {
    const base = resolveConfig();
    return { ...base, review: { ...base.review, showFunctionScores: flag } };
  }

  it('forwards a function-score options bag when the flag is on', async () => {
    const { engine, gh } = mocks();
    await runReview(engine as never, gh as never, 1, '/tmp/ws', true, configWithFlag(true));
    expect(gh.postReview).toHaveBeenCalledOnce();
    const options = (gh.postReview as ReturnType<typeof vi.fn>).mock.calls[0][5] as {
      showFunctionScores: boolean;
      functionScores: unknown[];
    };
    expect(options.showFunctionScores).toBe(true);
    expect(options.functionScores).toHaveLength(1);
  });

  it('forwards undefined when the flag is off', async () => {
    const { engine, gh } = mocks();
    await runReview(engine as never, gh as never, 1, '/tmp/ws', true, configWithFlag(false));
    expect(gh.postReview).toHaveBeenCalledOnce();
    expect((gh.postReview as ReturnType<typeof vi.fn>).mock.calls[0][5]).toBeUndefined();
  });

  it('skips postReview for deduplicated (skipped) results', async () => {
    const { engine, gh } = mocks({ skipped: true });
    await runReview(engine as never, gh as never, 1, '/tmp/ws', true, configWithFlag(true));
    expect(gh.postReview).not.toHaveBeenCalled();
  });

  it('dispatchTask forwards the flag through to postReview', async () => {
    const { engine, gh } = mocks();
    await dispatchTask(
      { repo: 'o/r', type: 'review', prNumber: 7 },
      engine as never,
      gh as never,
      '/tmp/ws',
      configWithFlag(true),
    );
    expect(engine.reviewPR).toHaveBeenCalledOnce();
    expect(gh.postReview).toHaveBeenCalledOnce();
    const options = (gh.postReview as ReturnType<typeof vi.fn>).mock.calls[0][5] as {
      showFunctionScores: boolean;
    };
    expect(options.showFunctionScores).toBe(true);
  });
});

describe('DISPATCHABLE_TASK_TYPES matches what dispatchTask actually handles', () => {
  // The constant is the enqueue-side guard; dispatchTask is the worker-side
  // reality. If they drift, the API accepts a job the worker will reject AFTER
  // cloning the repo — the caller is told "queued" for work that cannot run.
  // This test is the thing that keeps them in step.

  it('every advertised type is actually dispatched, not thrown', async () => {
    const engine = {} as never;
    const gh = {} as never;

    for (const type of DISPATCHABLE_TASK_TYPES) {
      // Minimal data that gets past the per-type argument guards and reaches
      // the dispatch itself. A type in the list must NOT hit the final throw.
      const data = {
        repo: 'acme/widgets',
        type,
        prNumber: 1,
        issueNumber: 1,
      } as never;

      let message = '';
      try {
        await dispatchTask(data, engine, gh, '/tmp/ws');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      expect(
        message,
        `dispatchTask rejected '${type}', which DISPATCHABLE_TASK_TYPES advertises as supported`,
      ).not.toContain('not yet supported by the worker');
    }
  });

  it('a type NOT in the list is rejected by dispatchTask', async () => {
    const data = { repo: 'acme/widgets', type: 'conversation' } as never;

    await expect(dispatchTask(data, {} as never, {} as never, '/tmp/ws')).rejects.toThrow(
      /not yet supported by the worker/,
    );
  });

  it('the rejection names the dispatchable types, so the error is actionable', async () => {
    const data = { repo: 'acme/widgets', type: 'docs' } as never;

    await expect(dispatchTask(data, {} as never, {} as never, '/tmp/ws')).rejects.toThrow(
      /Dispatchable types are: review, analyze/,
    );
  });

  it('isDispatchableTaskType agrees with the list', () => {
    for (const type of DISPATCHABLE_TASK_TYPES) {
      expect(isDispatchableTaskType(type)).toBe(true);
    }
    expect(isDispatchableTaskType('conversation')).toBe(false);
    expect(isDispatchableTaskType('nonsense')).toBe(false);
    expect(isDispatchableTaskType(undefined)).toBe(false);
    expect(isDispatchableTaskType(42)).toBe(false);
  });
});
