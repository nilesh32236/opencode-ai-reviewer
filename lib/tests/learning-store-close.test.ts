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

  it('waits for conversation cleanup before closing the repository', async () => {
    const { connectDb } = await import('../src/learning/db/index.js');
    let resolveCleanup!: (value: number) => void;
    const cleanup = new Promise<number>((resolve) => {
      resolveCleanup = resolve;
    });
    const mockRepo = {
      exec: vi.fn().mockResolvedValue(undefined),
      cleanupConversations: vi.fn().mockReturnValue(cleanup),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(connectDb).mockResolvedValue(mockRepo);

    const store = new LearningStore('sqlite://test');
    const cleanupPromise = store.cleanupConversations(Date.now());
    await vi.waitFor(() => expect(mockRepo.cleanupConversations).toHaveBeenCalledTimes(1));
    const closePromise = store.close();

    await Promise.resolve();
    expect(mockRepo.close).not.toHaveBeenCalled();

    resolveCleanup(0);
    await Promise.all([cleanupPromise, closePromise]);
    expect(mockRepo.close).toHaveBeenCalledTimes(1);
  });
});
