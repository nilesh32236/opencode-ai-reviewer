import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningRepository } from '../src/learning/types.js';

const { mockConnectDb, mockApplyMigrations } = vi.hoisted(() => ({
  mockConnectDb: vi.fn(),
  mockApplyMigrations: vi.fn(),
}));

vi.mock('../src/learning/db/index.js', () => ({ connectDb: mockConnectDb }));
vi.mock('../src/learning/schema.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  applyMigrations: mockApplyMigrations,
}));
// Single-attempt retry so connection-failure tests run fast and deterministically.
vi.mock('../src/utils/retry.js', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));

import { LearningStore } from '../src/learning/store.js';

function fakeRepo(overrides: Partial<LearningRepository> = {}): LearningRepository {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue({ ok: true, responseMs: 1 }),
    ...overrides,
  } as unknown as LearningRepository;
}

describe('LearningStore reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyMigrations.mockResolvedValue(undefined);
  });

  it('concurrent callers share a single recovery attempt after failure', async () => {
    mockConnectDb.mockRejectedValue(new Error('boom'));
    const store = new LearningStore(':memory:');
    // 1 initial attempt + exactly 1 shared recovery attempt across 5 callers.
    const results = await Promise.all([
      store.ping(),
      store.ping(),
      store.ping(),
      store.ping(),
      store.ping(),
    ]);
    for (const r of results) expect(r.ok).toBe(false);
    expect(mockConnectDb).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it('reconnect() keeps serving the prior repo when recovery fails', async () => {
    const priorClose = vi.fn().mockResolvedValue(undefined);
    mockConnectDb
      .mockResolvedValueOnce(fakeRepo({ close: priorClose }))
      .mockRejectedValueOnce(new Error('recovery boom'));
    const store = new LearningStore(':memory:');
    await expect(store.ping()).resolves.toMatchObject({ ok: true });
    await expect(store.reconnect()).rejects.toThrow('recovery boom');
    expect(priorClose).not.toHaveBeenCalled();
    await expect(store.ping()).resolves.toMatchObject({ ok: true });
    await store.close();
  });

  it('reconnect() closes the prior repo before replacing it', async () => {
    const priorClose = vi.fn().mockResolvedValue(undefined);
    mockConnectDb
      .mockResolvedValueOnce(fakeRepo({ close: priorClose }))
      .mockResolvedValueOnce(fakeRepo());
    const store = new LearningStore(':memory:');
    await expect(store.ping()).resolves.toMatchObject({ ok: true });
    await store.reconnect();
    expect(priorClose).toHaveBeenCalledTimes(1);
    await expect(store.ping()).resolves.toMatchObject({ ok: true });
    await store.close();
  });
});
