import { Logger } from '@opencode-pr-agent/lib';
import { describe, expect, it, vi } from 'vitest';
import { handleConversation } from '../../src/handlers/conversation.js';
vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    createPlatformAdapter: vi.fn(() => ({
      getMR: vi
        .fn()
        .mockRejectedValue(new Error(`Failed with token ghp_${'a1B2c3D4e5F6'.repeat(3)}abcd`)),
    })),
  };
});

describe('handleConversation error sanitization', () => {
  it('redacts tokens from thrown errors in logger output', async () => {
    const errSpy = vi.spyOn(Logger.prototype, 'error');

    try {
      await handleConversation(
        1, // commentId
        42, // prNumber
        'owner/repo', // repo
        'token', // token
        { platform: 'github' } as unknown as import('@opencode-pr-agent/lib').AgentConfig,
        false, // isReviewComment
      );

      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain(`ghp_${'a1B2c3D4e5F6'.repeat(3)}abcd`);
      expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    } finally {
      errSpy.mockRestore();
    }
  });
});
