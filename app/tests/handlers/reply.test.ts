import { Logger } from '@opencode-pr-agent/lib';
import { describe, expect, it, vi } from 'vitest';
import { handleReply } from '../../src/handlers/reply.js';
import * as configModule from '../../src/utils/config.js';

vi.mock('../../src/utils/config.js', () => ({
  mergeRepoConfig: vi.fn((c) => c),
  loadConfig: vi.fn(),
}));
const _mockMergeRepoConfig = configModule.mergeRepoConfig as import('vitest').Mock;

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    createPlatformAdapter: vi.fn(() => ({
      getReviewCommentThread: vi
        .fn()
        .mockRejectedValue(
          new Error('Failed with token ghp_1234567890abcdef1234567890abcdef12345678'),
        ),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe('handleReply error sanitization', () => {
  it('redacts tokens from thrown errors in logger output', async () => {
    const errSpy = vi.spyOn(Logger.prototype, 'error');

    try {
      await handleReply(
        42,
        'owner/repo',
        'token',
        { platform: 'github' } as unknown as import('@opencode-pr-agent/lib').AgentConfig,
        1,
        'body',
      );

      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('ghp_1234567890abcdef1234567890abcdef12345678');
      expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    } finally {
      errSpy.mockRestore();
    }
  });
});
