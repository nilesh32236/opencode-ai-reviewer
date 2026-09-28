import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPrivilegeDenialThrottle,
  clearPrivilegeVerificationCache,
  getAuthorAssociation,
  isPrivilegedAuthor,
  isPrivilegedPermissionLevel,
  postPrivilegeDenial,
  privilegeDenialMarker,
  satisfiesPrivilegeGate,
  verifyPrivilegeGate,
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
    clearPrivilegeDenialThrottle();
  });

  afterEach(() => {
    // `delete`, not assignment: `process.env.X = undefined` stores the STRING
    // "undefined", so it leaves a truthy token behind and every later token
    // guard silently takes the non-fail-closed path.
    // biome-ignore lint/performance/noDelete: assignment would store the STRING "undefined"
    delete process.env.GITHUB_TOKEN;
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

  it('isPrivilegedPermissionLevel allows admin/maintain/write only', () => {
    expect(isPrivilegedPermissionLevel('admin')).toBe(true);
    expect(isPrivilegedPermissionLevel('write')).toBe(true);
    // `maintain` never arrives in the API's `permission` field (only in
    // `role_name`), but it is accepted so a caller that already resolved
    // `role_name` is not silently under-approximated.
    expect(isPrivilegedPermissionLevel('maintain')).toBe(true);
    expect(isPrivilegedPermissionLevel(' ADMIN ')).toBe(true);
    // `triage` sits below `write`, which is the spend threshold.
    expect(isPrivilegedPermissionLevel('triage')).toBe(false);
    expect(isPrivilegedPermissionLevel('read')).toBe(false);
    expect(isPrivilegedPermissionLevel('none')).toBe(false);
    expect(isPrivilegedPermissionLevel(undefined)).toBe(false);
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

  // "Absent" and "present but unusable" are different answers. A comment block
  // carrying a non-string association is reporting the ACTOR's own (broken)
  // value; borrowing the sender's association for it is the same cross-identity
  // hint swap the server-side gate rejects, so it must not fall through.
  it.each([
    ['empty string', ''],
    ['null', null],
    ['number', 0],
    ['boolean', true],
    ['array', ['OWNER']],
  ])('getAuthorAssociation never borrows the sender hint for a %s comment value', (_l, value) => {
    expect(
      getAuthorAssociation({
        comment: { author_association: value },
        sender: { author_association: 'OWNER' },
      }),
    ).toBeUndefined();
  });

  it('getAuthorAssociation still falls back to the sender when the comment omits the key', () => {
    expect(
      getAuthorAssociation({ comment: { body: 'hi' }, sender: { author_association: 'OWNER' } }),
    ).toBe('OWNER');
  });

  it('satisfiesPrivilegeGate denies unprivileged and fails closed when missing', () => {
    expect(satisfiesPrivilegeGate({ comment: { author_association: 'NONE' } })).toBe(false);
    expect(satisfiesPrivilegeGate({ comment: { author_association: 'OWNER' } })).toBe(true);
    // User-invoked comment events fail closed when the association is absent.
    expect(satisfiesPrivilegeGate({})).toBe(false);
    expect(satisfiesPrivilegeGate({}, 'comment.created')).toBe(false);
    expect(satisfiesPrivilegeGate({}, 'review_comment.created')).toBe(false);
    // A present-but-unusable comment association is not an absent one, and the
    // sender's OWNER hint must not stand in for it.
    expect(
      satisfiesPrivilegeGate(
        { comment: { author_association: null }, sender: { author_association: 'OWNER' } },
        'comment.created',
      ),
    ).toBe(false);
  });

  // FORWARD CONTRACT, not a live guarantee: each allowlisted event type is
  // currently reachable only from a subscriber that already gates its own
  // actor, so no production path relies on these fail-opens. The assertions
  // below must stay green, but a NEW subscriber on `pr.opened` / `pr.synchronize`
  // inherits a silent fail-open and has to verify its actor itself — see the
  // contract documented on SYSTEM_EVENT_ALLOWLIST.
  it('satisfiesPrivilegeGate leaves allowlisted system events open', () => {
    expect(satisfiesPrivilegeGate({}, 'issue.labeled')).toBe(true);
    expect(satisfiesPrivilegeGate({}, 'pr.opened')).toBe(true);
    expect(satisfiesPrivilegeGate({}, 'pr.synchronize')).toBe(true);
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

describe('postPrivilegeDenial adapter seam', () => {
  beforeEach(() => {
    clearPrivilegeDenialThrottle();
  });

  it('uses the injected adapter instead of constructing one', async () => {
    const postOrUpdateComment = vi.fn().mockResolvedValue(undefined);
    await postPrivilegeDenial('owner/repo', 7, 'fix', {
      postOrUpdateComment,
    } as never);
    expect(postOrUpdateComment).toHaveBeenCalledTimes(1);
    expect(postOrUpdateComment).toHaveBeenCalledWith(
      7,
      '<!-- permission-denied:fix -->',
      expect.stringContaining('/fix'),
    );
  });
});

// The denial path is the cheapest thing an unprivileged caller can trigger: it
// runs before `checkRateLimit` in every subscriber, so a flood of `/fix`
// comments from any account that can comment is a flood of app-authored public
// comments — the classic way to get an installation rate-limited.
describe('postPrivilegeDenial flood throttle', () => {
  const INTERVAL_MS = 60_000;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockPostOrUpdateComment.mockReset();
    mockPostOrUpdateComment.mockResolvedValue(undefined);
    clearPrivilegeDenialThrottle();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assignment would store the STRING "undefined"
    delete process.env.GITHUB_TOKEN;
  });

  it('suppresses repeat notices for the same repo+command inside the interval', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      for (let i = 0; i < 25; i++) {
        await postPrivilegeDenial('owner/repo', 42 + i, 'fix');
      }
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('allows a new notice once the interval elapses', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await postPrivilegeDenial('owner/repo', 42, 'fix');
      spy.mockReturnValue(1_700_000_000_000 + INTERVAL_MS);
      await postPrivilegeDenial('owner/repo', 42, 'fix');
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('throttles per command and per repo, not globally', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await postPrivilegeDenial('owner/repo', 42, 'fix');
      await postPrivilegeDenial('owner/repo', 42, 'review');
      await postPrivilegeDenial('owner/other', 42, 'fix');
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  // The same clock-step hazard the authz cache had, one layer down: a backwards
  // step makes `now - last` negative, and a negative number is below any
  // interval. Without `now >= lastAt` the throttle silences every future denial
  // until the clock catches back up — unbounded, not the documented 60s.
  it('does not stay silent forever after the clock steps backwards', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await postPrivilegeDenial('owner/repo', 42, 'fix');
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(1);

      // Ten minutes back: the stored stamp is now in the "future".
      spy.mockReturnValue(1_700_000_000_000 - 10 * 60_000);
      await postPrivilegeDenial('owner/repo', 43, 'fix');
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(2);

      // The re-stamp re-anchors the window to the new clock, so the flood is
      // still bounded from here.
      await postPrivilegeDenial('owner/repo', 44, 'fix');
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(2);

      spy.mockReturnValue(1_700_000_000_000 - 10 * 60_000 + INTERVAL_MS);
      await postPrivilegeDenial('owner/repo', 45, 'fix');
      expect(mockPostOrUpdateComment).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('verifyPrivilegeGate()', () => {
  const realFetch = globalThis.fetch;

  // Clear on BOTH sides of every test. The cache is module-global, so an
  // afterEach-only clear makes this block depend on the preceding block's
  // teardown — and a warm positive from a neighbouring describe would let a
  // positive assertion pass with zero API calls while proving nothing.
  beforeEach(() => {
    clearPrivilegeVerificationCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearPrivilegeVerificationCache();
    vi.useRealTimers();
  });

  // Only `octocat` has repository access; `attacker` does not.
  const stubApi = (queried: string[]): void => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      queried.push(url);
      return (url.includes('octocat')
        ? new Response('{"permission":"admin"}', { status: 200 })
        : new Response('{"message":"Not Found"}', { status: 404 })) as unknown as Response;
    }) as unknown as typeof fetch;
  };

  // The F1 regression: the acting identity is comment.user.login. The previous
  // fallback verified sender.login when comment.author_association was absent,
  // so a payload could name a privileged sender and act as someone else.
  it('verifies the comment author, not the sender, when the hint came from the sender', async () => {
    const queried: string[] = [];
    stubApi(queried);

    const allowed = await verifyPrivilegeGate(
      {
        comment: { user: { login: 'attacker' } },
        // The privileged hint is on the SENDER, as in a forged payload.
        sender: { login: 'octocat', author_association: 'OWNER' },
      },
      'comment.created',
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(false);
    expect(queried.some((u) => u.includes('attacker'))).toBe(true);
    expect(queried.some((u) => u.includes('octocat'))).toBe(false);
  });

  it('still allows a genuine collaborator on a comment', async () => {
    const queried: string[] = [];
    stubApi(queried);

    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } }, sender: { login: 'octocat' } },
      'comment.created',
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(true);
    expect(queried.some((u) => u.includes('octocat'))).toBe(true);
  });

  it('consults the sender for an event that carries no comment', async () => {
    const queried: string[] = [];
    stubApi(queried);

    const allowed = await verifyPrivilegeGate(
      { sender: { login: 'octocat' } },
      'issue.opened',
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(true);
    expect(queried.some((u) => u.includes('octocat'))).toBe(true);
  });

  it('fails closed when the comment carries no login', async () => {
    const queried: string[] = [];
    stubApi(queried);

    const allowed = await verifyPrivilegeGate(
      { comment: { user: {} }, sender: { login: 'octocat' } },
      'comment.created',
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(false);
    expect(queried).toHaveLength(0);
  });

  // The event type — not the payload's own `comment` key — decides whose
  // identity is verified. A `comment.created` delivery that arrives with no
  // usable comment block must NOT quietly fall back to the privileged sender.
  it.each([
    ['comment is null', null],
    ['comment is absent', undefined],
    ['comment has no user', {}],
  ])('fails closed on a comment event where %s', async (_label, comment) => {
    const queried: string[] = [];
    stubApi(queried);

    const allowed = await verifyPrivilegeGate(
      { comment, sender: { login: 'octocat', author_association: 'OWNER' } },
      'comment.created',
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(false);
    expect(queried).toHaveLength(0);
  });

  // The gate must not fall open when the API errors. `withRetry` sleeps with
  // real timers, so the retry cases run under fake timers and are advanced
  // explicitly — otherwise this file spends seconds in backoff.
  it.each([
    ['throws', () => Promise.reject(new Error('network down'))],
    ['401', () => Promise.resolve(new Response('', { status: 401 }))],
    ['403', () => Promise.resolve(new Response('', { status: 403 }))],
    ['500', () => Promise.resolve(new Response('', { status: 500 }))],
  ])('fails closed when the API %s', async (_label, impl) => {
    globalThis.fetch = vi.fn(impl as never) as unknown as typeof fetch;
    vi.useFakeTimers();

    const pending = verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } }, sender: { login: 'octocat' } },
      'comment.created',
      'owner/repo',
      'test-token',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toBe(false);
  });

  // The per-attempt timeout must survive the caller's signal. A fallback path
  // that passed the outer signal alone would silently drop the 5s bound, so
  // the request must carry a COMBINED signal that the outer signal still drives.
  it('passes a combined signal so the per-attempt timeout is not dropped', async () => {
    let captured: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: Record<string, unknown>) => {
      captured = init?.signal as AbortSignal | undefined;
      return new Response('{"permission":"admin"}', { status: 200 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const outer = new AbortController();
    await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/repo',
      'test-token',
      globalThis.fetch as never,
      outer.signal,
    );

    expect(captured).toBeDefined();
    expect(captured).not.toBe(outer.signal);
    outer.abort();
    expect(captured?.aborted).toBe(true);
  });
});

// The 60s positive cache memoizes "this identity is privileged on this repo".
// The invariant that makes it safe is that it is only ever consulted for the
// ACTING identity, never for one borrowed from a forged payload. Without this
// test, shortening or removing the F1 identity resolution would be invisible
// here: every existing case uses a single identity, so a cache hit and a
// cross-identity borrow look identical.
describe('privilege cache isolation', () => {
  const realFetch = globalThis.fetch;

  // Clear on BOTH sides of every test. Clearing only in afterEach makes the
  // block depend on the preceding block's teardown, so a future describe that
  // warms the cache without clearing it -- or a reorder / -t filter run --
  // would fail the first assertion spuriously.
  beforeEach(() => {
    clearPrivilegeVerificationCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearPrivilegeVerificationCache();
  });

  it('does not let a forged payload borrow another identity cached positive', async () => {
    const queried: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      queried.push(url);
      return (url.includes('octocat')
        ? new Response('{"permission":"admin"}', { status: 200 })
        : new Response('{"message":"Not Found"}', { status: 404 })) as unknown as Response;
    }) as unknown as typeof fetch;

    // Establish a warm positive cache entry for octocat.
    await expect(
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
    ).resolves.toBe(true);
    expect(queried.length).toBe(1);

    // A cache HIT must be silent. Asserting the warm-up proves the entry was
    // written; this proves it is actually READ back, so the negative cases
    // below cannot be satisfied by a cache that never warms at all.
    await expect(
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
    ).resolves.toBe(true);
    expect(queried.length).toBe(1);

    // A forged payload acting as `attacker` while naming octocat as a
    // privileged sender. The cache must not be consulted for octocat.
    queried.length = 0;
    const allowed = await verifyPrivilegeGate(
      {
        comment: { user: { login: 'attacker' } },
        sender: { login: 'octocat', author_association: 'OWNER' },
      },
      'comment.created',
      'owner/repo',
      'token',
    );

    expect(allowed).toBe(false);
    expect(queried.some((u) => u.includes('attacker'))).toBe(true);
    expect(queried.some((u) => u.includes('octocat'))).toBe(false);
  });

  it('does not share a cached positive across repositories', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"permission":"admin"}', { status: 200 }) as unknown as Response,
    ) as unknown as typeof fetch;
    await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/one',
      'token',
    );

    const queried: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      queried.push(url);
      return new Response('{"message":"Not Found"}', { status: 404 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/two',
      'token',
    );
    expect(allowed).toBe(false);
    expect(queried.length).toBeGreaterThan(0);
  });

  // The bus dispatches subscribers in concurrent batches, so several can reach
  // the gate for the same actor in the same tick. One in-flight request must
  // serve all of them.
  it('collapses concurrent verifications of the same identity into one request', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('{"permission":"admin"}', { status: 200 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const results = await Promise.all([
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
    ]);

    expect(results).toEqual([true, true, true]);
    expect(calls).toBe(1);
  });

  it('re-verifies on the next call after an in-flight check settles', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('{"permission":"admin"}', { status: 200 }) as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/repo',
      'token',
    );
    // A settled in-flight entry must not be reused as a cached positive; the
    // timestamp cache is what answers this call, silently.
    await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/repo',
      'token',
    );

    expect(calls).toBe(1);
  });
});

// A cached positive is only an optimization. Nothing about it may extend the
// window in which a revoked collaborator still counts as privileged, so the TTL
// has to be pinned from the outside. `Date.now` is stubbed rather than faked
// with timers so nothing here has to wait in real time.
describe('privilege cache lifetime', () => {
  const realFetch = globalThis.fetch;
  const BASE = 1_700_000_000_000;
  // Hard-coded on purpose. Importing the constant would make every offset
  // below move with it, so a widened TTL would stay green. A silent widening
  // trades authorization freshness for latency and must fail a test that also
  // exercises the cache.
  const TTL_MS = 60_000;

  // Owned here, not by each test body: a test that stubs the clock outside a
  // try/finally would otherwise freeze `Date.now` for every remaining test in
  // this process, making the TTL unreachable from then on.
  let restoreClock: (() => void) | null = null;

  /** Stub the clock and a collaborator-permission endpoint that counts its calls. */
  function stubClockAndApi(initialPermission: string | undefined): {
    calls: () => number;
    setNow: (ms: number) => void;
    revoke: () => void;
  } {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(BASE);
    restoreClock = () => spy.mockRestore();
    const state = { permission: initialPermission, calls: 0 };
    globalThis.fetch = vi.fn(async () => {
      state.calls++;
      return state.permission === undefined
        ? (new Response('{"message":"Not Found"}', { status: 404 }) as unknown as Response)
        : (new Response(`{"permission":"${state.permission}"}`, {
            status: 200,
          }) as unknown as Response);
    }) as unknown as typeof fetch;
    return {
      calls: () => state.calls,
      setNow: (ms: number) => spy.mockReturnValue(ms),
      revoke: () => {
        state.permission = undefined;
      },
    };
  }

  beforeEach(() => {
    clearPrivilegeVerificationCache();
  });

  afterEach(() => {
    restoreClock?.();
    restoreClock = null;
    // `vi.restoreAllMocks()` is deliberately not used here: it also resets the
    // file-level `vi.fn()` mocks that the blocks above depend on, which is a
    // trap for any test appended after this one.
    globalThis.fetch = realFetch;
    clearPrivilegeVerificationCache();
  });

  it('re-verifies once the TTL elapses', async () => {
    const clock = stubClockAndApi('admin');

    await expect(
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
    ).resolves.toBe(true);
    expect(clock.calls()).toBe(1);

    // One millisecond before the TTL the entry is still honoured, with no
    // second round-trip — otherwise the cache has no reason to exist.
    clock.setNow(BASE + TTL_MS - 1);
    await expect(
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
    ).resolves.toBe(true);
    expect(clock.calls()).toBe(1);

    // At the TTL the entry is stale. The collaborator has since been removed,
    // so the API now denies and the gate must follow the API, not the cache.
    clock.revoke();
    clock.setNow(BASE + TTL_MS);
    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/repo',
      'token',
    );
    expect(allowed).toBe(false);
    expect(clock.calls()).toBe(2);
  });

  // A backwards clock step (NTP correction, suspend/resume, container clock
  // jump) makes `now - at` negative, and a negative number is trivially under
  // any TTL — so without an explicit `now >= at` the entry survives until the
  // clock catches back up, which is unbounded rather than the documented 60s.
  it('re-verifies when the clock steps backwards past the warm-up instant', async () => {
    const clock = stubClockAndApi('admin');

    await expect(
      verifyPrivilegeGate(
        { comment: { user: { login: 'octocat' } } },
        'comment.created',
        'owner/repo',
        'token',
      ),
    ).resolves.toBe(true);
    expect(clock.calls()).toBe(1);

    // Ten minutes BACK, then the collaborator is revoked. `now - at` is now
    // negative, which no TTL comparison can reject on its own.
    clock.setNow(BASE - 10 * 60_000);
    clock.revoke();

    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'comment.created',
      'owner/repo',
      'token',
    );
    expect(allowed).toBe(false);
    expect(clock.calls()).toBe(2);
  });

  // The cache is bounded at 1000 entries, and it has to evict the LEAST
  // recently used identity. `Map.set` on an existing key keeps its original
  // position, so without a delete-before-set the identity an owner re-verifies
  // all day stays first in line for eviction and pays an extra round-trip on
  // its next command.
  it('evicts the least recently used entry when the cache is full', async () => {
    const clock = stubClockAndApi('admin');
    const gate = (login: string): Promise<boolean> =>
      verifyPrivilegeGate(
        { comment: { user: { login } } },
        'comment.created',
        'owner/repo',
        'token',
      );

    for (let i = 1; i <= 1000; i++) {
      await gate(`user${i}`);
    }
    expect(clock.calls()).toBe(1000);

    // Let the whole cache go stale, then re-verify the very first entry: a real
    // round-trip that re-stamps it — and must make it the most recent entry.
    clock.setNow(BASE + TTL_MS);
    await expect(gate('user1')).resolves.toBe(true);
    expect(clock.calls()).toBe(1001);

    // One more distinct login pushes the cache over its cap, so the oldest
    // remaining key goes — `user2`, not the just-touched `user1`.
    await gate('user1001');
    expect(clock.calls()).toBe(1002);

    await expect(gate('user1')).resolves.toBe(true);
    expect(clock.calls()).toBe(1002);
  });
});
