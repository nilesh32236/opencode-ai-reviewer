import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_CACHE_TTL_MS,
  clearPrivilegeVerificationCache,
  getAuthorAssociation,
  isPrivilegedAuthor,
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

  it('satisfiesPrivilegeGate denies unprivileged and fails closed when missing', () => {
    expect(satisfiesPrivilegeGate({ comment: { author_association: 'NONE' } })).toBe(false);
    expect(satisfiesPrivilegeGate({ comment: { author_association: 'OWNER' } })).toBe(true);
    // User-invoked comment events fail closed when the association is absent.
    expect(satisfiesPrivilegeGate({})).toBe(false);
    expect(satisfiesPrivilegeGate({}, 'comment.created')).toBe(false);
    expect(satisfiesPrivilegeGate({}, 'review_comment.created')).toBe(false);
    // Allowlisted system events (e.g. issue.labeled autofix-trigger) stay open.
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

describe('verifyPrivilegeGate()', () => {
  const realFetch = globalThis.fetch;
  // Clears the module-global positive cache so each case really hits the API.
  const clear = (): void => clearPrivilegeVerificationCache();

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearPrivilegeVerificationCache();
    vi.restoreAllMocks();
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
    clear();

    const allowed = await verifyPrivilegeGate(
      {
        comment: { user: { login: 'attacker' } },
        // The privileged hint is on the SENDER, as in a forged payload.
        sender: { login: 'octocat', author_association: 'OWNER' },
      },
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
    clear();

    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } }, sender: { login: 'octocat' } },
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(true);
    expect(queried.some((u) => u.includes('octocat'))).toBe(true);
  });

  it('consults the sender for an event that carries no comment', async () => {
    const queried: string[] = [];
    stubApi(queried);
    clear();

    const allowed = await verifyPrivilegeGate(
      { sender: { login: 'octocat' } },
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(true);
    expect(queried.some((u) => u.includes('octocat'))).toBe(true);
  });

  it('fails closed when the comment carries no login', async () => {
    const queried: string[] = [];
    stubApi(queried);
    clear();

    const allowed = await verifyPrivilegeGate(
      { comment: { user: {} }, sender: { login: 'octocat' } },
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(false);
    expect(queried).toHaveLength(0);
  });

  // The gate must not fall open when the API errors.
  it.each([
    ['throws', () => Promise.reject(new Error('network down'))],
    ['401', () => Promise.resolve(new Response('', { status: 401 }))],
    ['403', () => Promise.resolve(new Response('', { status: 403 }))],
    ['500', () => Promise.resolve(new Response('', { status: 500 }))],
  ])('fails closed when the API %s', async (_label, impl) => {
    globalThis.fetch = vi.fn(impl as never) as unknown as typeof fetch;
    clear();

    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } }, sender: { login: 'octocat' } },
      'owner/repo',
      'test-token',
    );

    expect(allowed).toBe(false);
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
    vi.restoreAllMocks();
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
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 'token'),
    ).resolves.toBe(true);
    expect(queried.length).toBe(1);

    // A cache HIT must be silent. Asserting the warm-up proves the entry was
    // written; this proves it is actually READ back, so the negative cases
    // below cannot be satisfied by a cache that never warms at all.
    await expect(
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 'token'),
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
    await verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/one', 'token');

    const queried: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      queried.push(url);
      return new Response('{"message":"Not Found"}', { status: 404 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const allowed = await verifyPrivilegeGate(
      { comment: { user: { login: 'octocat' } } },
      'owner/two',
      'token',
    );
    expect(allowed).toBe(false);
    expect(queried.length).toBeGreaterThan(0);
  });
});

// Two gaps a fresh-context review found in the cache-isolation block:
//
//  1. The warm-up was unasserted, so under a mutation that stops the cache
//     being written (or read) these tests still passed -- they never established
//     that a warm positive exists at all.
//  2. Nothing pinned the 60s TTL, even though the whole premise is a *bounded*
//     revocation lag. It could become 10 minutes with a green suite.
//  3. `now - at < TTL` is TRUE for a future-dated entry, so a backward clock step
//     made a cached positive valid indefinitely. The production guard is fixed;
//     these hold it there.
describe('privilege cache bounds', () => {
  const ENV = 'INPUT_REQUIRE_OPENCODE_CHECKSUM';
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearPrivilegeVerificationCache();
    delete process.env[ENV];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearPrivilegeVerificationCache();
  });

  it('pins the documented 60s TTL', () => {
    expect(PERMISSION_CACHE_TTL_MS).toBe(60_000);
  });

  const allow = () =>
    (globalThis.fetch = vi.fn(
      async () => new Response('{"permission":"admin"}', { status: 200 }) as unknown as Response,
    ) as unknown as typeof fetch);
  const deny = () =>
    (globalThis.fetch = vi.fn(
      async () => new Response('{"message":"Not Found"}', { status: 404 }) as unknown as Response,
    ) as unknown as typeof fetch);

  it('serves a cached positive only WITHIN the TTL, then re-verifies', async () => {
    const t0 = Date.now();
    let clock = t0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    allow();
    // warm-up IS asserted: a cache that never warms must fail here
    await expect(
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 't'),
    ).resolves.toBe(true);

    // Just inside the TTL: still cached, no new API call.
    clock = t0 + PERMISSION_CACHE_TTL_MS - 1;
    const allowMock = allow(); // resets the call count
    await expect(
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 't'),
    ).resolves.toBe(true);
    expect(allowMock).not.toHaveBeenCalled();

    // Just past it: must re-verify, and a denial must be honoured.
    clock = t0 + PERMISSION_CACHE_TTL_MS + 1;
    deny();
    await expect(
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 't'),
    ).resolves.toBe(false);
    spy.mockRestore();
  });

  it('rejects a FUTURE-dated cache entry instead of trusting it forever', async () => {
    allow();
    await expect(
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 't'),
    ).resolves.toBe(true);

    // Clock steps BACKWARD (NTP correction). A future-dated entry must be
    // treated as stale, so the gate re-verifies and honours the denial.
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0 - 10 * 60_000);
    deny();
    await expect(
      verifyPrivilegeGate({ comment: { user: { login: 'octocat' } } }, 'owner/repo', 't'),
    ).resolves.toBe(false);
    expect(globalThis.fetch).toHaveBeenCalled();
    spy.mockRestore();
  });
});
