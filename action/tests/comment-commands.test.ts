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

import { extractCommentCommand, verifyCommentActorPermission } from '../src/comment-commands.js';

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
