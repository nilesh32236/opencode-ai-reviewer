import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetOctokit, mockSetFailed, mockInfo, mockContext } = vi.hoisted(() => {
  const _mockGetOctokit = vi.fn();
  const _mockSetFailed = vi.fn();
  const _mockInfo = vi.fn();
  const _mockContext = {
    actor: 'fallback-actor',
    payload: {} as Record<string, unknown>,
    repo: { owner: 'o', repo: 'r' },
  };
  return {
    mockGetOctokit: _mockGetOctokit,
    mockSetFailed: _mockSetFailed,
    mockInfo: _mockInfo,
    mockContext: _mockContext,
  };
});

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: mockInfo,
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: mockSetFailed,
  saveState: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: mockContext,
  getOctokit: mockGetOctokit,
}));

import {
  MAX_INSTRUCTION_EXTRACT_CHARS,
  MAX_INSTRUCTION_SECTION_CHARS,
} from '@opencode-pr-agent/lib';
import {
  extractCommentCommand,
  extractOperatorInstruction,
  verifyCommentActorPermission,
} from '../src/comment-commands.js';

describe('extractCommentCommand()', () => {
  it('extracts known commands', () => {
    expect(extractCommentCommand('/fix')).toBe('fix');
    expect(extractCommentCommand('/fix please address this')).toBe('fix');
    expect(extractCommentCommand('  /Analyze --full  ')).toBe('analyze');
  });

  it('matches mid-body commands like production workflow triggers', () => {
    expect(extractCommentCommand('please /fix this')).toBe('fix');
    expect(extractCommentCommand('Hi\n/fix')).toBe('fix');
    expect(extractCommentCommand('/oc please review')).toBe('oc');
    expect(extractCommentCommand('can you /review this PR?')).toBe('review');
  });

  it('returns null for non-command comments', () => {
    expect(extractCommentCommand('looks good, thanks!')).toBeNull();
    expect(extractCommentCommand('please fix this')).toBeNull();
    expect(extractCommentCommand('/unknown-command')).toBeNull();
    expect(extractCommentCommand('')).toBeNull();
    expect(extractCommentCommand(undefined)).toBeNull();
    expect(extractCommentCommand(null)).toBeNull();
  });
});

describe('extractOperatorInstruction()', () => {
  it('returns undefined for empty input or a bare command', () => {
    expect(extractOperatorInstruction(undefined)).toBeUndefined();
    expect(extractOperatorInstruction(null)).toBeUndefined();
    expect(extractOperatorInstruction('')).toBeUndefined();
    expect(extractOperatorInstruction('   ')).toBeUndefined();
    expect(extractOperatorInstruction('/fix')).toBeUndefined();
    expect(extractOperatorInstruction('/oc')).toBeUndefined();
  });

  it('returns undefined when no /fix (/oc) token is present', () => {
    expect(extractOperatorInstruction('/review do X')).toBeUndefined();
    expect(extractOperatorInstruction('looks good, thanks!')).toBeUndefined();
    expect(extractOperatorInstruction('please fix this')).toBeUndefined();
  });

  it('strips the fix token and returns the remainder', () => {
    expect(extractOperatorInstruction('/fix please rebase onto main')).toBe(
      'please rebase onto main',
    );
    expect(extractOperatorInstruction('please /fix this file')).toContain('please');
    expect(extractOperatorInstruction('please /fix this file')).toContain('this file');
    expect(extractOperatorInstruction('/oc handle the timeout error')).toBe(
      'handle the timeout error',
    );
  });

  it('truncates long instructions with a marker', () => {
    const long = `/fix ${'a'.repeat(MAX_INSTRUCTION_EXTRACT_CHARS + 100)}`;
    const result = extractOperatorInstruction(long);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(
      MAX_INSTRUCTION_EXTRACT_CHARS + '\n\n[truncated]'.length,
    );
    expect(result!.endsWith('[truncated]')).toBe(true);
  });
});

describe('verifyCommentActorPermission()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.actor = 'fallback-actor';
    mockContext.payload = {};
  });

  function mockPermission(permission: string): void {
    mockGetOctokit.mockReturnValue({
      rest: {
        repos: {
          getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission } }),
        },
      },
    });
  }

  it('authorizes admin and write actors', async () => {
    mockContext.payload = { comment: { user: { login: 'alice' } } };
    mockPermission('admin');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
    mockPermission('write');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
    mockPermission('maintain');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('denies read/none actors (fail-closed)', async () => {
    mockContext.payload = { comment: { user: { login: 'mallory' } } };
    mockPermission('read');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('fails closed when the permission lookup throws', async () => {
    mockContext.payload = { comment: { user: { login: 'alice' } } };
    mockGetOctokit.mockReturnValue({
      rest: {
        repos: {
          getCollaboratorPermissionLevel: vi.fn().mockRejectedValue(new Error('API down')),
        },
      },
    });
    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('falls back to the workflow actor when the comment payload is absent', async () => {
    mockContext.actor = 'workflow-actor';
    mockPermission('write');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
  });
});

// This gate decides whether a read-only commenter can trigger force-pushes and
// PR creation. Its hand-rolled copy here drifted from the Probot wrapper's in
// two ways that change WHO is authorized; the shared helper in lib
// (`resolveActingLogin` + `hasWritePermission`) is now the single rule.
describe('verifyCommentActorPermission() fail-closed identity resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.actor = 'fallback-actor';
    mockContext.payload = {};
  });

  function mockPermission(permission: string): ReturnType<typeof vi.fn> {
    const lookup = vi.fn().mockResolvedValue({ data: { permission } });
    mockGetOctokit.mockReturnValue({
      rest: { repos: { getCollaboratorPermissionLevel: lookup } },
    });
    return lookup;
  }

  // The previous copy resolved `commentUser || reviewUser || github.context.actor`,
  // so a comment payload naming no author fell through to the workflow-run
  // author and trusted them as if they had written the comment.
  it('refuses the workflow actor when a comment payload names no author', async () => {
    mockContext.actor = 'workflow-actor';
    mockContext.payload = { comment: { body: '/fix please' } };
    const lookup = mockPermission('write');

    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('refuses the workflow actor when a review payload names no author', async () => {
    mockContext.actor = 'workflow-actor';
    mockContext.payload = { review: { body: '/fix please' } };
    const lookup = mockPermission('write');

    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  // Never substitute the workflow actor for the comment author on a comment
  // event: a forged payload naming a privileged actor is the threat this gate
  // exists to reject.
  it('verifies the comment author even when the workflow actor differs', async () => {
    mockContext.actor = 'workflow-actor';
    mockContext.payload = { comment: { user: { login: 'mallory' } } };
    const lookup = mockPermission('read');

    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ username: 'mallory' }));
  });

  // The previous copy compared `'admin'|'write'|'maintain'` case-sensitively
  // with no trim, so the same `Write` response denied the action and allowed the
  // Probot app.
  it.each(['Write', 'WRITE', ' Admin '])(
    'accepts a capitalized %j permission',
    async (permission) => {
      mockContext.payload = { comment: { user: { login: 'alice' } } };
      mockPermission(permission);
      await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
      expect(mockSetFailed).not.toHaveBeenCalled();
    },
  );

  it('bounds the permission lookup so a hung call cannot burn the job budget', async () => {
    mockContext.payload = { comment: { user: { login: 'alice' } } };
    const lookup = vi.fn().mockResolvedValue({ data: { permission: 'write' } });
    mockGetOctokit.mockReturnValue({
      rest: { repos: { getCollaboratorPermissionLevel: lookup } },
    });

    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
    const request = lookup.mock.calls[0]?.[0] as { request?: { signal?: AbortSignal } };
    expect(request.request?.signal).toBeDefined();
  });

  it('fails closed when the permission field is missing', async () => {
    mockContext.payload = { comment: { user: { login: 'alice' } } };
    mockGetOctokit.mockReturnValue({
      rest: {
        repos: { getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: {} }) },
      },
    });
    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(mockSetFailed).toHaveBeenCalled();
  });
});
