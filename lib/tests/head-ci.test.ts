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
    expect(isHeadCIGreen(makeStatus({ pending: 1 }))).toBe(false);
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

  it('requires named checks when requireNames is supplied', () => {
    expect(isHeadCIGreen(makeStatus(), { requireNames: ['build', 'test'] })).toBe(true);
    expect(isHeadCIGreen(makeStatus(), { requireNames: ['security-scan'] })).toBe(false);
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
});
