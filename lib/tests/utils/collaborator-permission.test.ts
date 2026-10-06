/**
 * The collaborator gate decides whether a read-only commenter can trigger
 * force-pushes and PR creation. It existed twice — `app/src/utils/privilege.ts`
 * and `action/src/comment-commands.ts` — and the two copies had drifted in ways
 * that changed WHO is authorized. These tests hold the shared rule in one place
 * so neither wrapper can reintroduce its own answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_LOOKUP_TIMEOUT_MS,
  hasWritePermission,
  isPrivilegedPermissionLevel,
  resolveActingLogin,
} from '../../src/utils/collaborator-permission.js';

describe('isPrivilegedPermissionLevel()', () => {
  it.each(['admin', 'maintain', 'write'])('allows %s', (permission) => {
    expect(isPrivilegedPermissionLevel(permission)).toBe(true);
  });

  it.each(['read', 'none', 'triage', ''])('denies %s', (permission) => {
    expect(isPrivilegedPermissionLevel(permission)).toBe(false);
  });

  it('denies undefined (missing permission field)', () => {
    expect(isPrivilegedPermissionLevel(undefined)).toBe(false);
  });

  // The action's hand-rolled copy compared `'admin'|'write'|'maintain'`
  // case-sensitively with no trim, so the SAME `Write` response denied the
  // action and allowed the app. Proxies and API-version skew really do return
  // capitalized values.
  it.each(['Write', 'WRITE', ' Admin ', '\tmaintain\n'])(
    'normalizes %j so capitalization never flips authorization',
    (permission) => {
      expect(isPrivilegedPermissionLevel(permission)).toBe(true);
    },
  );
});

describe('resolveActingLogin()', () => {
  it('uses the comment author on a comment event', () => {
    const resolved = resolveActingLogin({ comment: { user: { login: 'alice' } } }, 'runner-actor');
    expect(resolved).toEqual({ login: 'alice', source: 'comment', hasCommentPayload: true });
  });

  it('uses the review author on a pull_request_review event', () => {
    const resolved = resolveActingLogin({ review: { user: { login: 'bob' } } }, 'runner-actor');
    expect(resolved).toEqual({ login: 'bob', source: 'review', hasCommentPayload: true });
  });

  // The action's copy fell back to `github.context.actor` when a comment payload
  // named no author — so on a comment event the workflow-run author was trusted
  // as if they had written the comment.
  it('refuses the fallback actor when a comment payload names no author', () => {
    const resolved = resolveActingLogin({ comment: { body: 'hi' } }, 'runner-actor');
    expect(resolved.login).toBeUndefined();
    expect(resolved.source).toBe('none');
    expect(resolved.hasCommentPayload).toBe(true);
  });

  it('refuses the fallback actor when a review payload names no author', () => {
    const resolved = resolveActingLogin({ review: { body: 'hi' } }, 'runner-actor');
    expect(resolved.login).toBeUndefined();
    expect(resolved.hasCommentPayload).toBe(true);
  });

  // A forged payload naming a privileged sender while acting as someone else is
  // the shape this gate exists to reject.
  it('never substitutes the sender when a comment is present', () => {
    const resolved = resolveActingLogin({
      comment: { user: { login: 'attacker' } },
      sender: { login: 'octocat', author_association: 'OWNER' },
    });
    expect(resolved.login).toBe('attacker');
    expect(resolved.login).not.toBe('octocat');
  });

  it('uses the sender on an event that carries no comment', () => {
    const resolved = resolveActingLogin({ sender: { login: 'octocat' } }, 'runner-actor');
    expect(resolved).toEqual({ login: 'octocat', source: 'sender', hasCommentPayload: false });
  });

  it('falls back to the ambient actor only when no comment/review is present', () => {
    const resolved = resolveActingLogin({}, 'runner-actor');
    expect(resolved).toEqual({
      login: 'runner-actor',
      source: 'fallback',
      hasCommentPayload: false,
    });
  });

  it('resolves nothing when there is no payload and no fallback', () => {
    expect(resolveActingLogin({})).toEqual({ source: 'none', hasCommentPayload: false });
    expect(resolveActingLogin(undefined, undefined).login).toBeUndefined();
    expect(resolveActingLogin(null).login).toBeUndefined();
  });

  it('ignores an empty-string login', () => {
    expect(resolveActingLogin({ comment: { user: { login: '' } } }, 'runner-actor').login).toBe(
      undefined,
    );
  });
});

describe('hasWritePermission()', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // withRetry sleeps between attempts; keep transient-failure cases fast.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw Object.assign(new Error('network down'), { status: 0 });
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('denies without invoking the transport when no login resolves', async () => {
    const lookup = vi.fn();
    await expect(hasWritePermission(undefined, lookup)).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows when the transport reports a privileged level', async () => {
    const lookup = vi.fn(async () => 'write');
    await expect(hasWritePermission('alice', lookup)).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith('alice', expect.any(AbortSignal));
  });

  it('allows a capitalized privileged level', async () => {
    await expect(hasWritePermission('alice', async () => 'Write')).resolves.toBe(true);
  });

  it('denies an unprivileged level', async () => {
    await expect(hasWritePermission('mallory', async () => 'read')).resolves.toBe(false);
  });

  it('denies when the transport returns no permission field', async () => {
    await expect(hasWritePermission('alice', async () => undefined)).resolves.toBe(false);
  });

  // Fail closed: a permission API that cannot be reached must never widen
  // access. (Transient failures are retried by withRetry first.)
  it('denies when the transport keeps throwing', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('api down');
    });
    await expect(hasWritePermission('alice', lookup)).resolves.toBe(false);
    expect(lookup.mock.calls.length).toBeGreaterThan(1);
  });

  // Only the app's transport has a positive cache; the shared helper must not
  // add one silently, or a permission revocation would be memoized across
  // wrappers.
  it('does not memoize a positive result across calls', async () => {
    const lookup = vi.fn(async () => 'admin');
    await expect(hasWritePermission('alice', lookup)).resolves.toBe(true);
    await expect(hasWritePermission('alice', lookup)).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('bounds every attempt with a timeout signal', async () => {
    let seen: AbortSignal | undefined;
    await hasWritePermission('alice', async (_login, signal) => {
      seen = signal;
      return 'admin';
    });
    expect(seen).toBeDefined();
    // A hung permission call previously burned the wrapper's entire job budget
    // in the action; the bound is what prevents that.
    expect(PERMISSION_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PERMISSION_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
