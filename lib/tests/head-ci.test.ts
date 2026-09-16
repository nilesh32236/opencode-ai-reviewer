import { describe, expect, it, vi } from 'vitest';
import type { HeadCIStatus } from '../src/platform/adapter.js';
import { checkHeadCIGreen, isHeadCIGreen } from '../src/utils/head-ci.js';

function makeStatus(overrides: Partial<HeadCIStatus> = {}): HeadCIStatus {
  return {
    commitSha: 'abc123',
    total: 2,
    successful: 2,
    failed: 0,
    pending: 0,
    skipped: 0,
    green: true,
    checks: [
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'success' },
    ],
    ...overrides,
  };
}

describe('isHeadCIGreen', () => {
  it('returns true for a fully successful rollup', () => {
    expect(isHeadCIGreen(makeStatus())).toBe(true);
  });

  it('fails closed on an empty rollup', () => {
    expect(isHeadCIGreen(makeStatus({ total: 0, successful: 0, green: false, checks: [] }))).toBe(
      false,
    );
  });

  it('blocks on pending and failed checks', () => {
    expect(isHeadCIGreen(makeStatus({ pending: 1, successful: 1 }))).toBe(false);
    expect(isHeadCIGreen(makeStatus({ failed: 1, successful: 1 }))).toBe(false);
  });

  it('treats skipped as blocking by default but allows opt-in', () => {
    const skipped = makeStatus({
      skipped: 1,
      successful: 1,
      green: false,
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'skipped' },
      ],
    });
    expect(isHeadCIGreen(skipped)).toBe(false);
    expect(isHeadCIGreen(skipped, { allowSkipped: true })).toBe(true);
  });

  it('treats neutral/cancelled as blocking by default but allows opt-in', () => {
    for (const conclusion of ['neutral', 'cancelled']) {
      const status = makeStatus({
        skipped: 1,
        successful: 1,
        green: false,
        checks: [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'test', status: 'completed', conclusion },
        ],
      });
      expect(isHeadCIGreen(status)).toBe(false);
      expect(isHeadCIGreen(status, { allowSkipped: true })).toBe(true);
    }
  });

  it('requires named checks when requireNames is supplied', () => {
    expect(isHeadCIGreen(makeStatus(), { requireNames: ['build', 'test'] })).toBe(true);
    expect(isHeadCIGreen(makeStatus(), { requireNames: ['security-scan'] })).toBe(false);
  });

  it('matches required names case-insensitively', () => {
    expect(
      isHeadCIGreen(
        makeStatus({
          checks: [
            { name: 'BUILD', status: 'completed', conclusion: 'success' },
            { name: 'Test', status: 'completed', conclusion: 'success' },
          ],
        }),
        { requireNames: ['build', 'test'] },
      ),
    ).toBe(true);
  });

  it('blocks when any same-named required check is non-success', () => {
    const dup = makeStatus({
      total: 3,
      successful: 2,
      failed: 1,
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'build', status: 'completed', conclusion: 'failure' },
        { name: 'test', status: 'completed', conclusion: 'success' },
      ],
    });
    expect(isHeadCIGreen(dup, { requireNames: ['build'] })).toBe(false);
  });

  it('fails closed on malformed counters and malformed checks', () => {
    expect(
      isHeadCIGreen(makeStatus({ total: Number.NaN as number, pending: 0, failed: 0, skipped: 0 })),
    ).toBe(false);
    expect(
      isHeadCIGreen(
        makeStatus({ total: undefined as unknown as number, pending: 0, failed: 0, skipped: 0 }),
      ),
    ).toBe(false);
    // Malformed check entry (missing name) must not throw and must block green.
    const malformed = makeStatus({
      checks: [
        { name: undefined as unknown as string, status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'success' },
      ],
    });
    expect(() => isHeadCIGreen(malformed, { requireNames: ['build'] })).not.toThrow();
    expect(isHeadCIGreen(malformed, { requireNames: ['build'] })).toBe(false);
  });

  it('fails closed on negative counters', () => {
    expect(isHeadCIGreen(makeStatus({ total: 2, pending: -1 }))).toBe(false);
    expect(isHeadCIGreen(makeStatus({ total: 2, failed: -1 }))).toBe(false);
    expect(isHeadCIGreen(makeStatus({ total: -1 }))).toBe(false);
  });

  it('cross-checks checks[] on the default path even with clean counters', () => {
    // Buggy adapter: clean counters but a failure entry in checks.
    const divergent = makeStatus({
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(isHeadCIGreen(divergent)).toBe(false);
    // Skipped entry with clean counters still blocks by default...
    const skippedEntry = makeStatus({
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'skipped' },
      ],
    });
    expect(isHeadCIGreen(skippedEntry)).toBe(false);
    // ...but passes with allowSkipped.
    expect(isHeadCIGreen(skippedEntry, { allowSkipped: true })).toBe(true);
    // Non-completed entries block even with clean counters.
    const pendingEntry = makeStatus({
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'in_progress', conclusion: 'pending' },
      ],
    });
    expect(isHeadCIGreen(pendingEntry)).toBe(false);
  });

  it('tolerates non-string requireNames entries without throwing', () => {
    const mixed = { requireNames: [null, undefined, 'build'] as unknown as string[] };
    expect(() => isHeadCIGreen(makeStatus(), mixed)).not.toThrow();
    expect(isHeadCIGreen(makeStatus(), mixed)).toBe(true);
    // Null entries never bypass a valid requirement: a missing name still
    // fails closed.
    const missing = { requireNames: [null, 'security-scan'] as unknown as string[] };
    expect(isHeadCIGreen(makeStatus(), missing)).toBe(false);
  });
});

describe('checkHeadCIGreen', () => {
  it('passes when the adapter reports green on the exact SHA', async () => {
    const adapter = { getHeadCIStatus: vi.fn().mockResolvedValue(makeStatus()) };
    const result = await checkHeadCIGreen(adapter, 'abc123');
    expect(result.ok).toBe(true);
    expect(adapter.getHeadCIStatus).toHaveBeenCalledWith('abc123', undefined);
  });

  it('fails closed when the adapter method is missing', async () => {
    const result = await checkHeadCIGreen({}, 'abc123');
    expect(result.ok).toBe(false);
  });

  it('fails closed on SHA mismatch and on query errors', async () => {
    const mismatched = { getHeadCIStatus: vi.fn().mockResolvedValue(makeStatus()) };
    expect((await checkHeadCIGreen(mismatched, 'deadbee')).ok).toBe(false);

    const throwing = {
      getHeadCIStatus: vi.fn().mockRejectedValue(new Error('boom')),
    };
    expect((await checkHeadCIGreen(throwing, 'abc123')).ok).toBe(false);
  });

  it('fails closed on an empty rollup', async () => {
    const adapter = {
      getHeadCIStatus: vi
        .fn()
        .mockResolvedValue(makeStatus({ total: 0, successful: 0, green: false, checks: [] })),
    };
    const result = await checkHeadCIGreen(adapter, 'abc123');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty rollup/);
  });

  it('fails closed on empty head SHA and null status', async () => {
    const adapter = { getHeadCIStatus: vi.fn() };
    expect((await checkHeadCIGreen(adapter, '')).ok).toBe(false);
    expect((await checkHeadCIGreen(adapter, '   ')).ok).toBe(false);
    expect(adapter.getHeadCIStatus).not.toHaveBeenCalled();

    const nullAdapter = { getHeadCIStatus: vi.fn().mockResolvedValue(null) };
    expect((await checkHeadCIGreen(nullAdapter, 'abc123')).ok).toBe(false);
  });

  it('fails closed on malformed numeric counters', async () => {
    const nanAdapter = {
      getHeadCIStatus: vi.fn().mockResolvedValue(makeStatus({ total: Number.NaN as number })),
    };
    const nanResult = await checkHeadCIGreen(nanAdapter, 'abc123');
    expect(nanResult.ok).toBe(false);
    expect(nanResult.reason).toMatch(/malformed/);

    const undefinedAdapter = {
      getHeadCIStatus: vi
        .fn()
        .mockResolvedValue(makeStatus({ pending: undefined as unknown as number })),
    };
    expect((await checkHeadCIGreen(undefinedAdapter, 'abc123')).ok).toBe(false);

    const infinityAdapter = {
      getHeadCIStatus: vi
        .fn()
        .mockResolvedValue(makeStatus({ total: Number.POSITIVE_INFINITY as number })),
    };
    expect((await checkHeadCIGreen(infinityAdapter, 'abc123')).ok).toBe(false);
    expect(isHeadCIGreen(makeStatus({ total: Number.POSITIVE_INFINITY as number }))).toBe(false);
  });

  it('fails closed on negative counters via checkHeadCIGreen', async () => {
    const negativeAdapter = {
      getHeadCIStatus: vi.fn().mockResolvedValue(makeStatus({ pending: -1 })),
    };
    const result = await checkHeadCIGreen(negativeAdapter, 'abc123');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/malformed/);
  });

  it('forwards opts and signal to the adapter and evaluator', async () => {
    const signal = new AbortController().signal;
    const green = {
      getHeadCIStatus: vi.fn().mockResolvedValue(makeStatus()),
    };
    const okResult = await checkHeadCIGreen(green, 'abc123', { requireNames: ['build'] }, signal);
    expect(okResult.ok).toBe(true);
    expect(green.getHeadCIStatus).toHaveBeenCalledWith('abc123', signal);

    const skippedStatus = makeStatus({
      skipped: 1,
      successful: 1,
      green: false,
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'skipped' },
      ],
    });
    const skippedAdapter = { getHeadCIStatus: vi.fn().mockResolvedValue(skippedStatus) };
    expect((await checkHeadCIGreen(skippedAdapter, 'abc123')).ok).toBe(false);
    expect((await checkHeadCIGreen(skippedAdapter, 'abc123', { allowSkipped: true })).ok).toBe(
      true,
    );
  });
});
