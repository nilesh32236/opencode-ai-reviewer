import { describe, expect, it } from 'vitest';
import {
  MERGE_APPROVAL_LABEL,
  hasForbiddenMergeLabel,
  hasMergeApprovalLabel,
  isBotActor,
  isMergeAuthorized,
  isPrivilegedAssociation,
  isPrivilegedPermission,
} from '../src/utils/merge-approval.js';
import type { MergeAuthorizationInput } from '../src/utils/merge-approval.js';

function validInput(overrides: Partial<MergeAuthorizationInput> = {}): MergeAuthorizationInput {
  return {
    labels: [MERGE_APPROVAL_LABEL],
    senderLogin: 'octocat',
    senderType: 'User',
    authorAssociation: 'OWNER',
    permission: 'write',
    isOpen: true,
    isMerged: false,
    eventHeadSha: 'abc123def456',
    currentHeadSha: 'abc123def456',
    ...overrides,
  };
}

describe('merge-approval policy (REF-005)', () => {
  it('authorizes one valid human approval', () => {
    const result = isMergeAuthorized(validInput());
    expect(result.authorized).toBe(true);
  });

  it('rejects missing approval label (autofix:ready is advisory only)', () => {
    expect(isMergeAuthorized(validInput({ labels: ['autofix:ready'] })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ labels: [] })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ labels: undefined })).authorized).toBe(false);
  });

  it('never repurposes destructive-fix labels for merges', () => {
    for (const label of ['autofix:approved', 'autofix-approve', 'autofix-approved']) {
      expect(isMergeAuthorized(validInput({ labels: [label] })).authorized).toBe(false);
      expect(hasMergeApprovalLabel([label])).toBe(false);
    }
  });

  it('denies forbidden labels with an explicit reason, even alongside approval', () => {
    for (const label of ['autofix:approved', 'autofix-approve', 'autofix-approved']) {
      expect(hasForbiddenMergeLabel([label])).toBe(true);
      expect(hasForbiddenMergeLabel([{ name: label }])).toBe(true);
      const verdict = isMergeAuthorized(validInput({ labels: [MERGE_APPROVAL_LABEL, label] }));
      expect(verdict.authorized).toBe(false);
      expect(verdict.reason).toContain('forbidden label');
    }
    expect(hasForbiddenMergeLabel([MERGE_APPROVAL_LABEL])).toBe(false);
    expect(hasForbiddenMergeLabel([])).toBe(false);
  });

  it('accepts GitHub API label objects via their name property', () => {
    expect(hasMergeApprovalLabel([{ name: MERGE_APPROVAL_LABEL }])).toBe(true);
    expect(hasMergeApprovalLabel([{ name: '  AutoFix:Merge-Approved  ' }])).toBe(true);
    expect(hasMergeApprovalLabel([{ name: 'autofix:ready' }])).toBe(false);
    expect(hasMergeApprovalLabel([{ name: 42 }])).toBe(false);
    expect(hasMergeApprovalLabel([{ title: MERGE_APPROVAL_LABEL }])).toBe(false);
    expect(
      isMergeAuthorized(validInput({ labels: [{ name: MERGE_APPROVAL_LABEL }] })).authorized,
    ).toBe(true);
  });

  it('rejects bot senders and absent sender types', () => {
    expect(
      isMergeAuthorized(validInput({ senderLogin: 'opencode-ai-reviewer[bot]' })).authorized,
    ).toBe(false);
    expect(isMergeAuthorized(validInput({ senderType: 'Bot' })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ senderLogin: '' })).authorized).toBe(false);
    for (const senderType of [undefined, '', '  ', 42, null]) {
      expect(isMergeAuthorized(validInput({ senderType })).authorized).toBe(false);
    }
    expect(isBotActor('some-bot[Bot]')).toBe(true);
    expect(isBotActor('octocat')).toBe(false);
  });

  it('rejects unprivileged associations', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIMER', 'NONE', undefined, '']) {
      expect(isMergeAuthorized(validInput({ authorAssociation: association })).authorized).toBe(
        false,
      );
    }
    expect(isPrivilegedAssociation('OWNER')).toBe(true);
    expect(isPrivilegedAssociation('MEMBER')).toBe(true);
    expect(isPrivilegedAssociation('COLLABORATOR')).toBe(true);
    expect(isPrivilegedAssociation('CONTRIBUTOR')).toBe(false);
  });

  it('rejects unprivileged or absent permissions (fail closed)', () => {
    expect(isMergeAuthorized(validInput({ permission: 'read' })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ permission: 'triage' })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ permission: undefined })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ permission: '' })).authorized).toBe(false);
    expect(isPrivilegedPermission('admin')).toBe(true);
    expect(isPrivilegedPermission('maintain')).toBe(true);
    expect(isPrivilegedPermission('write')).toBe(true);
    expect(isPrivilegedPermission('read')).toBe(false);
  });

  it('rejects closed/merged PRs', () => {
    expect(isMergeAuthorized(validInput({ isOpen: false })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ isMerged: true })).authorized).toBe(false);
  });

  it('rejects stale/moved heads and missing SHA binding', () => {
    expect(
      isMergeAuthorized(validInput({ eventHeadSha: 'aaa111', currentHeadSha: 'bbb222' }))
        .authorized,
    ).toBe(false);
    expect(isMergeAuthorized(validInput({ eventHeadSha: '' })).authorized).toBe(false);
    expect(isMergeAuthorized(validInput({ currentHeadSha: undefined })).authorized).toBe(false);
  });

  it('matches the approval label case-insensitively but not by substring', () => {
    expect(hasMergeApprovalLabel(['  AutoFix:Merge-Approved  '])).toBe(true);
    expect(hasMergeApprovalLabel(['autofix:merge-approved-extra'])).toBe(false);
    expect(hasMergeApprovalLabel(['prefix-autofix:merge-approved'])).toBe(false);
  });
});
