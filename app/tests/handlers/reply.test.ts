import { Logger } from '@opencode-pr-agent/lib';
import { describe, expect, it, vi } from 'vitest';
import { handleReply } from '../../src/handlers/reply.js';
vi.mock('../../src/utils/repo-filter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRepoAllowed: () => true, repoFilter: {} };
});
vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    createPlatformAdapter: vi.fn(() => ({
      getReviewCommentThread: vi
        .fn()
        .mockRejectedValue(new Error(`Failed with token ghp_${'a1B2c3D4e5F6'.repeat(3)}abcd`)),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe('handleReply error sanitization', () => {
  it('redacts tokens from thrown errors in logger output', async () => {
    const errSpy = vi.spyOn(Logger.prototype, 'error');

    try {
      await handleReply(
        42, // prNumber
        'owner/repo', // repo
        'token', // token
        { platform: 'github' } as unknown as import('@opencode-pr-agent/lib').AgentConfig,
        1, // parentCommentId
        'body', // userCommentBody
      );

      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain(`ghp_${'a1B2c3D4e5F6'.repeat(3)}abcd`);
      expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    } finally {
      errSpy.mockRestore();
    }
  });
});
