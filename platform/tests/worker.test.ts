import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/queue/worker.js';

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
    process.env.REVIEW_MODEL = 'opencode-go/muse-spark-1.2-contributor';
    process.env.FIX_MODEL = 'opencode-go/muse-spark-1.2-contributor';
    process.env.AUDIT_MODEL = 'opencode-go/muse-spark-1.2-contributor';
    const config = resolveConfig();
    expect(config.reviewModel).toBe('opencode-go/muse-spark-1.2-contributor');
    expect(config.fixModel).toBe('opencode-go/muse-spark-1.2-contributor');
    expect(config.auditModel).toBe('opencode-go/muse-spark-1.2-contributor');
  });

  it('prefers an explicitly provided config over env', () => {
    process.env.REVIEW_MODEL = 'env/model';
    const provided = { ...resolveConfig(), reviewModel: 'explicit/model' };
    expect(resolveConfig(provided).reviewModel).toBe('explicit/model');
  });
});
