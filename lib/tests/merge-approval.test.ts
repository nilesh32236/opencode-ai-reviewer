import { describe, expect, it } from 'vitest';
import {
  MERGE_APPROVAL_LABEL,
  authorizeMergeFromTimeline,
  hasForbiddenMergeLabel,
  hasMergeApprovalLabel,
  isBotActor,
  isMergeAuthorized,
  isPrivilegedAssociation,
  isPrivilegedPermission,
  resolveMergeApprovalEvent,
} from '../src/utils/merge-approval.js';
import type { MergeApprovalPRState, MergeAuthorizationInput } from '../src/utils/merge-approval.js';

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

function validPRState(overrides: Partial<MergeApprovalPRState> = {}): MergeApprovalPRState {
  return {
    labels: [MERGE_APPROVAL_LABEL],
    isOpen: true,
    isMerged: false,
    currentHeadSha: 'abc123def456',
    permission: 'write',
    ...overrides,
  };
}

function labeledEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'labeled',
    label: { name: MERGE_APPROVAL_LABEL },
    actor: { login: 'octocat', type: 'User' },
    author_association: 'OWNER',
    commit_id: 'abc123def456',
    created_at: '2026-09-24T12:00:00Z',
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

describe('merge-approval timeline resolution (DISC-001)', () => {
  it('resolves the latest labeled event for the approval label', () => {
    const resolved = resolveMergeApprovalEvent([
      labeledEvent({ actor: { login: 'first-human', type: 'User' } }),
      labeledEvent({ actor: { login: 'octocat', type: 'User' } }),
    ]);
    expect(resolved?.senderLogin).toBe('octocat');
    expect(resolved?.eventHeadSha).toBe('abc123def456');
  });

  it('ignores non-labeled events and other labels', () => {
    expect(
      resolveMergeApprovalEvent([
        { event: 'unlabeled', label: { name: MERGE_APPROVAL_LABEL } },
        labeledEvent({ label: { name: 'autofix:ready' } }),
        { event: 'commented' },
      ]),
    ).toBeUndefined();
    expect(resolveMergeApprovalEvent([])).toBeUndefined();
    expect(resolveMergeApprovalEvent(undefined)).toBeUndefined();
    expect(resolveMergeApprovalEvent('not-an-array')).toBeUndefined();
  });

  it('returns bot approvers as candidates so the verdict denies explicitly', () => {
    const resolved = resolveMergeApprovalEvent([
      labeledEvent({ actor: { login: 'autofix-bot[bot]', type: 'Bot' } }),
    ]);
    expect(resolved?.senderLogin).toBe('autofix-bot[bot]');
    const verdict = authorizeMergeFromTimeline(validPRState(), [
      labeledEvent({ actor: { login: 'autofix-bot[bot]', type: 'Bot' } }),
    ]);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toContain('bot');
  });

  it('authorizes approval present + head pinned + privileged actor', () => {
    const verdict = authorizeMergeFromTimeline(validPRState(), [labeledEvent()]);
    expect(verdict.authorized).toBe(true);
  });

  it('denies a stale approval when the head moved after labeling', () => {
    const verdict = authorizeMergeFromTimeline(validPRState({ currentHeadSha: 'bbb222' }), [
      labeledEvent(),
    ]);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toContain('stale approval');
  });

  it('denies when the approval label is missing from live PR state', () => {
    const verdict = authorizeMergeFromTimeline(validPRState({ labels: ['autofix:ready'] }), [
      labeledEvent(),
    ]);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toContain('missing required label');
  });

  it('denies when no labeled event exists in the timeline', () => {
    const verdict = authorizeMergeFromTimeline(validPRState(), []);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toContain('no labeled event');
  });

  it('denies weak associations and low permissions resolved for the approver', () => {
    expect(
      authorizeMergeFromTimeline(validPRState(), [
        labeledEvent({ author_association: 'CONTRIBUTOR' }),
      ]).authorized,
    ).toBe(false);
    expect(
      authorizeMergeFromTimeline(validPRState({ permission: 'read' }), [labeledEvent()]).authorized,
    ).toBe(false);
    expect(
      authorizeMergeFromTimeline(validPRState({ permission: undefined }), [labeledEvent()])
        .authorized,
    ).toBe(false);
  });

  it('denies forbidden labels even with a timeline approval', () => {
    const verdict = authorizeMergeFromTimeline(
      validPRState({ labels: [MERGE_APPROVAL_LABEL, 'autofix:approved'] }),
      [labeledEvent()],
    );
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toContain('forbidden label');
  });

  it('prefers canonical commit_id over generic sha aliases (fail closed on wrong binding)', () => {
    // Canonical binding wins when both are present — an unrelated `sha`
    // field must never override the approval binding.
    const resolved = resolveMergeApprovalEvent([
      labeledEvent({ commit_id: 'abc123def456', sha: 'unrelated999' }),
    ]);
    expect(resolved?.eventHeadSha).toBe('abc123def456');
    // Generic alias is only a fallback when the canonical field is absent.
    const fallback = resolveMergeApprovalEvent([
      { ...labeledEvent(), commit_id: undefined, sha: 'abc123def456' },
    ]);
    expect(fallback?.eventHeadSha).toBe('abc123def456');
    // Missing binding fails closed downstream (no auto-carry).
    const missing = authorizeMergeFromTimeline(validPRState(), [
      { ...labeledEvent(), commit_id: undefined },
    ]);
    // labeledEvent helper always sets commit_id; strip every known alias.
    const stripped = resolveMergeApprovalEvent([
      {
        event: 'labeled',
        label: { name: MERGE_APPROVAL_LABEL },
        actor: { login: 'octocat', type: 'User' },
        author_association: 'OWNER',
        created_at: '2026-09-24T12:00:00Z',
      },
    ]);
    expect(stripped?.eventHeadSha).toBeUndefined();
    expect(missing.authorized).toBe(false);
  });
});
