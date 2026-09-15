import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthorAssociation,
  isPrivilegedAuthor,
  postPrivilegeDenial,
  privilegeDenialMarker,
  satisfiesPrivilegeGate,
} from '../../src/utils/privilege.js';

const { mockPostOrUpdateComment } = vi.hoisted(() => ({
  mockPostOrUpdateComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    GitHubHelper: vi.fn().mockImplementation(
      class {
        postOrUpdateComment = mockPostOrUpdateComment;
      },
    ),
  };
});

describe('privilege gate', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = undefined;
  });

  it('isPrivilegedAuthor allows OWNER/MEMBER/COLLABORATOR only', () => {
    expect(isPrivilegedAuthor('OWNER')).toBe(true);
    expect(isPrivilegedAuthor('MEMBER')).toBe(true);
    expect(isPrivilegedAuthor('COLLABORATOR')).toBe(true);
    expect(isPrivilegedAuthor('CONTRIBUTOR')).toBe(false);
    expect(isPrivilegedAuthor('NONE')).toBe(false);
    expect(isPrivilegedAuthor(undefined)).toBe(false);
    expect(isPrivilegedAuthor('')).toBe(false);
  });

  it('getAuthorAssociation prefers comment over sender', () => {
    expect(
      getAuthorAssociation({
        comment: { author_association: 'NONE' },
        sender: { author_association: 'OWNER' },
      }),
    ).toBe('NONE');
    expect(getAuthorAssociation({ sender: { author_association: 'MEMBER' } })).toBe('MEMBER');
    expect(getAuthorAssociation({})).toBeUndefined();
    expect(getAuthorAssociation(null)).toBeUndefined();
  });

  it('satisfiesPrivilegeGate denies unprivileged, fails open when missing', () => {
    expect(satisfiesPrivilegeGate({ comment: { author_association: 'NONE' } })).toBe(false);
    expect(satisfiesPrivilegeGate({ comment: { author_association: 'OWNER' } })).toBe(true);
    expect(satisfiesPrivilegeGate({})).toBe(true);
  });

  it('privilegeDenialMarker is scoped per command', () => {
    expect(privilegeDenialMarker('fix')).toBe('<!-- permission-denied:fix -->');
    expect(privilegeDenialMarker('review')).toBe('<!-- permission-denied:review -->');
    expect(privilegeDenialMarker('fix')).not.toBe(privilegeDenialMarker('review'));
  });

  it('postPrivilegeDenial no-ops on empty repo or invalid prNumber', async () => {
    await postPrivilegeDenial('', 123, 'fix');
    await postPrivilegeDenial('owner/repo', 0, 'fix');
    await postPrivilegeDenial('owner/repo', -1, 'fix');
    expect(mockPostOrUpdateComment).not.toHaveBeenCalled();
  });

  it('postPrivilegeDenial posts per-command marker', async () => {
    await postPrivilegeDenial('owner/repo', 42, 'audit');
    expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
    expect(mockPostOrUpdateComment).toHaveBeenCalledWith(
      42,
      '<!-- permission-denied:audit -->',
      expect.stringContaining('/audit'),
    );
  });
});
