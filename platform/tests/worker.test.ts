import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchTask, resolveConfig, runReview } from '../src/queue/worker.js';

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

  it('returns a config with defaults when no env overrides are set', () => {
    const config = resolveConfig();
    expect(config.reviewModel).toBeTruthy();
    expect(config.fixModel).toBeTruthy();
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
