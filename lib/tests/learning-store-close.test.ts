import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/learning/db/index.js', () => ({
  connectDb: vi.fn(),
}));

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { LearningStore } from '../src/learning/store.js';

describe('LearningStore close error handling', () => {
  it('does not throw when connection was never established', async () => {
    const { connectDb } = await import('../src/learning/db/index.js');
    vi.mocked(connectDb).mockRejectedValue(new Error('Connection refused'));

    const store = new LearningStore('invalid://test');
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('logs a warning when repo.close() fails but does not throw', async () => {
    const { connectDb } = await import('../src/learning/db/index.js');
    const mockRepo = {
      exec: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(new Error('Disk full')),
    };
    vi.mocked(connectDb).mockResolvedValue(mockRepo);

    const store = new LearningStore('sqlite://test');
    await expect(store.close()).resolves.toBeUndefined();
    expect(mockRepo.close).toHaveBeenCalledTimes(1);
  });
});
