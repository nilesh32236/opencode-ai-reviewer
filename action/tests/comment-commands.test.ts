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

import * as core from '@actions/core';
import {
  MAX_OPERATOR_INSTRUCTION_CHARS,
  PRIVILEGED_MODES,
  extractCommentCommand,
  extractOperatorInstruction,
  getCommentTriggerBody,
  isExplicitOperatorTrigger,
  isWriteMode,
  redactActor,
  shouldRefuseUnauthenticatedCommentTrigger,
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
    const long = `/fix ${'a'.repeat(MAX_OPERATOR_INSTRUCTION_CHARS + 100)}`;
    const result = extractOperatorInstruction(long);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(
      MAX_OPERATOR_INSTRUCTION_CHARS + '\n\n[truncated]'.length,
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

  it('accepts case-insensitive permission levels (Write)', async () => {
    mockContext.payload = { comment: { user: { login: 'alice' } } };
    mockPermission('Write');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
  });

  it('fails closed when a comment payload exists but names no author (no workflow-actor fallback)', async () => {
    mockContext.actor = 'workflow-actor';
    mockContext.payload = { comment: {} };
    mockPermission('write');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    expect(mockSetFailed).toHaveBeenCalled();
  });

  it('logs authorization at debug level without the raw login', async () => {
    const coreModule = core as unknown as { debug: ReturnType<typeof vi.fn> };
    mockContext.payload = { comment: { user: { login: 'alice' } } };
    mockPermission('write');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(true);
    expect(coreModule.debug).toHaveBeenCalled();
    for (const call of coreModule.debug.mock.calls) {
      expect(String(call[0])).not.toContain('alice');
    }
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('never leaks the raw login in denial messages', async () => {
    mockContext.payload = { comment: { user: { login: 'mallory' } } };
    mockPermission('read');
    await expect(verifyCommentActorPermission('token')).resolves.toBe(false);
    for (const call of mockSetFailed.mock.calls) {
      expect(String(call[0])).not.toContain('mallory');
    }
  });
});

describe('PRIVILEGED_MODES / isWriteMode()', () => {
  it('covers every mode that performs writes with the repo token', () => {
    for (const mode of ['fix', 'review', 'self-heal', 'docs', 'changelog', 'analyze', 'describe']) {
      expect(PRIVILEGED_MODES.has(mode)).toBe(true);
      expect(isWriteMode(mode, true)).toBe(true);
      expect(isWriteMode(mode, false)).toBe(true);
    }
  });

  it('treats audit as privileged only when issue creation is enabled', () => {
    expect(isWriteMode('audit', true)).toBe(true);
    // Fail-closed default: callers that have not parsed inputs yet gate audit.
    expect(isWriteMode('audit')).toBe(true);
    // The tokenless read-only split emits audit_findings with no writes.
    expect(isWriteMode('audit', false)).toBe(false);
  });

  it('leaves read-only modes ungated', () => {
    expect(isWriteMode('post', true)).toBe(false);
    expect(isWriteMode('setup', true)).toBe(false);
    expect(isWriteMode(undefined)).toBe(false);
    expect(isWriteMode('unknown-mode', true)).toBe(false);
  });
});

describe('redactActor()', () => {
  it('is stable per actor and never contains the login', () => {
    const tag = redactActor('mallory');
    expect(redactActor('mallory')).toBe(tag);
    expect(tag).not.toContain('mallory');
    expect(redactActor('alice')).not.toBe(tag);
  });
});

describe('comment-trigger body / operator-trigger helpers', () => {
  const mockGetInput = vi.mocked(core.getInput);

  function setEvent(eventName: string | undefined): void {
    (mockContext as unknown as { eventName?: string }).eventName = eventName;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.actor = 'fallback-actor';
    mockContext.payload = {};
    setEvent(undefined);
    mockGetInput.mockReturnValue('');
  });

  it('getCommentTriggerBody prefers the comment body, then the review body', () => {
    mockContext.payload = {
      comment: { body: '/fix please' },
      review: { body: '/review please' },
    };
    expect(getCommentTriggerBody()).toBe('/fix please');
    mockContext.payload = { review: { body: '/review please' } };
    expect(getCommentTriggerBody()).toBe('/review please');
    mockContext.payload = {};
    expect(getCommentTriggerBody()).toBeUndefined();
  });

  it('isExplicitOperatorTrigger honors dispatch/schedule and explicit inputs', () => {
    setEvent('workflow_dispatch');
    expect(isExplicitOperatorTrigger()).toBe(true);
    setEvent('schedule');
    expect(isExplicitOperatorTrigger()).toBe(true);
    setEvent('issue_comment');
    expect(isExplicitOperatorTrigger()).toBe(false);
    mockGetInput.mockImplementation((name: string) => (name === 'pr-number' ? '42' : ''));
    expect(isExplicitOperatorTrigger()).toBe(true);
    mockGetInput.mockImplementation((name: string) =>
      name === 'comment-body' ? '/fix do it' : '',
    );
    expect(isExplicitOperatorTrigger()).toBe(true);
  });

  it('shouldRefuseUnauthenticatedCommentTrigger allows non-comment events', () => {
    for (const eventName of [undefined, 'schedule', 'workflow_dispatch', 'issues', 'labeled']) {
      setEvent(eventName);
      expect(shouldRefuseUnauthenticatedCommentTrigger()).toBe(false);
    }
  });

  it('refuses stray non-command comments fail-closed', () => {
    setEvent('issue_comment');
    mockContext.payload = { comment: { body: 'looks good, thanks!' } };
    expect(shouldRefuseUnauthenticatedCommentTrigger()).toBe(true);
    // Substring triggers the workflow fires on but the strict gate rejects.
    mockContext.payload = { comment: { body: 'see a/fix for details' } };
    expect(shouldRefuseUnauthenticatedCommentTrigger()).toBe(true);
    // Bodyless review events (empty approvals) carry no command either.
    mockContext.payload = { review: {} };
    expect(shouldRefuseUnauthenticatedCommentTrigger()).toBe(true);
  });

  it('allows recognized slash-command comments and explicit operator input', () => {
    setEvent('issue_comment');
    mockContext.payload = { comment: { body: 'please /analyze this' } };
    expect(shouldRefuseUnauthenticatedCommentTrigger()).toBe(false);
    mockContext.payload = { comment: { body: 'random chatter' } };
    mockGetInput.mockImplementation((name: string) => (name === 'pr-number' ? '7' : ''));
    expect(shouldRefuseUnauthenticatedCommentTrigger()).toBe(false);
  });
});
