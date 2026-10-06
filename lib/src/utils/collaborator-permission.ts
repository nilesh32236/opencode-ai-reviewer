/**
 * Single owner for the collaborator-authorization decision.
 *
 * This logic existed twice with the same name and two answers. `app/src/utils/
 * privilege.ts` (verifyPrivilegeGate / verifyCollaboratorPermission) and
 * `action/src/comment-commands.ts` (verifyCommentActorPermission) both decide
 * whether a commenter may trigger force-pushes and PR creation, and they had
 * drifted in ways that change *who is authorized*:
 *
 *  1. **Identity.** The action fell back to `github.context.actor` whenever no
 *     comment/review login was found, so on a comment event the author of the
 *     workflow run was trusted as if they had written the comment. The app
 *     refuses that fallback whenever a comment payload is present. A forged
 *     payload is exactly the threat this gate exists to stop.
 *  2. **Permission set.** The action compared `admin`/`write`/`maintain`
 *     case-sensitively with no trim, so a `Write` response denied the action
 *     and allowed the app.
 *  3. **Transport.** Only the app bounded each lookup with
 *     `AbortSignal.timeout`, so a hung permission call could burn a wrapper's
 *     entire job budget.
 *
 * Identity resolution and permission-level normalization are transport
 * independent, so they live here. The lookup itself stays injected (octokit in
 * the action, `fetch` in the app) because the two wrappers authenticate
 * differently and only the app's transport has a positive-verification cache.
 */
import { withRetry } from './retry.js';

/**
 * Repository permission levels that may spend shared model budget.
 * Mirrors `GET /repos/{owner}/{repo}/collaborators/{username}/permission`:
 * `admin`/`maintain`/`write` may; `read`/`none` may not.
 */
const PRIVILEGED_REPO_PERMISSIONS = ['admin', 'maintain', 'write'] as const;

/**
 * Whether a server-resolved repository permission is privileged.
 *
 * Normalizes with `trim().toLowerCase()`: GitHub documents these values as
 * lowercase, but proxies and API-version skew do return `Write`, and a
 * capitalization difference must not flip an authorization decision.
 * @param permission - Raw `permission` value from the collaborators API.
 * @returns True for admin/maintain/write (trimmed, case-insensitive).
 */
export function isPrivilegedPermissionLevel(permission?: string): boolean {
  if (!permission) return false;
  return (PRIVILEGED_REPO_PERMISSIONS as readonly string[]).includes(
    permission.trim().toLowerCase(),
  );
}

/** Result of {@link resolveActingLogin}. */
export interface ResolvedActingLogin {
  /**
   * The login to verify, or `undefined` when the event carries no usable
   * identity. Always `undefined` when a comment/review payload is present but
   * names no author — never the workflow actor.
   */
  login?: string;
  /** Where the login came from, for diagnostics. */
  source: 'comment' | 'review' | 'sender' | 'fallback' | 'none';
  /**
   * True when the payload carries a comment or review. Callers MUST NOT
   * substitute an ambient workflow actor in that case.
   */
  hasCommentPayload: boolean;
}

function readLogin(user: unknown): string | undefined {
  const login = (user as { login?: unknown } | undefined)?.login;
  return typeof login === 'string' && login.length > 0 ? login : undefined;
}

/**
 * Resolve the identity whose repository permission decides authorization.
 *
 * The rule is decided by WHERE the actor came from, not by which object
 * happened to carry a privileged hint: on any event carrying a comment or
 * review, the acting identity is that comment's author, full stop. `sender` (and
 * an explicitly supplied `fallbackActor`, such as the workflow actor) is
 * consulted only for events with no comment, where the sender genuinely is the
 * actor. GitHub never sends `sender !== comment.user`, so the mismatched shape
 * only arises from a forged payload — which is precisely what this gate exists
 * to reject, so it fails closed rather than trusting the privileged side.
 * @param payload - Raw webhook payload (or `github.context.payload`).
 * @param fallbackActor - Ambient actor (e.g. `github.context.actor`), used ONLY
 * when the payload carries no comment or review.
 * @returns The login to verify plus its provenance and whether a comment was present.
 */
export function resolveActingLogin(payload: unknown, fallbackActor?: string): ResolvedActingLogin {
  const p = (payload ?? {}) as Record<string, unknown>;
  const comment = p.comment as Record<string, unknown> | undefined;
  const review = p.review as Record<string, unknown> | undefined;
  if (comment) {
    // Fail closed: a comment payload with no author must not resolve to the
    // workflow actor.
    const login = readLogin(comment.user);
    return {
      ...(login ? { login } : {}),
      source: login ? 'comment' : 'none',
      hasCommentPayload: true,
    };
  }
  if (review) {
    const login = readLogin(review.user);
    return {
      ...(login ? { login } : {}),
      source: login ? 'review' : 'none',
      hasCommentPayload: true,
    };
  }
  const sender = readLogin(p.sender);
  if (sender) return { login: sender, source: 'sender', hasCommentPayload: false };
  if (fallbackActor) return { login: fallbackActor, source: 'fallback', hasCommentPayload: false };
  return { source: 'none', hasCommentPayload: false };
}

/** Per-request timeout for a collaborator-permission lookup. */
export const PERMISSION_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Resolve one repository permission via an injected transport, with a bounded
 * per-attempt timeout and transient-failure retries.
 *
 * Both wrappers authenticate differently (the action through octokit, the app
 * through `fetch`), so the transport is injected; what lives here is the
 * fail-closed shape — every attempt is bounded so a hung call cannot consume a
 * wrapper's whole job budget, and any non-privileged result (including
 * `undefined`) denies.
 * @param login - Actor login to verify.
 * @param lookup - Transport; receives the login plus a per-attempt AbortSignal
 * and resolves the raw permission string, or `undefined` to deny.
 * @param signal - Optional caller AbortSignal combined with the attempt timeout.
 * @returns The raw permission string, or `undefined` when denied/unavailable.
 */
export async function fetchCollaboratorPermission(
  login: string,
  lookup: (login: string, signal: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return withRetry(
    async () => {
      const timeoutSignal = AbortSignal.timeout(PERMISSION_LOOKUP_TIMEOUT_MS);
      const combined =
        signal === undefined
          ? timeoutSignal
          : typeof AbortSignal.any === 'function'
            ? AbortSignal.any([signal, timeoutSignal])
            : signal;
      return lookup(login, combined);
    },
    { maxRetries: 3, baseDelayMs: 300, maxDelayMs: 2000, operationName: 'collaboratorPermission' },
  );
}

/**
 * Whether a login holds write/admin permission, per an injected transport.
 *
 * The single owner of the *decision*: identity-independent normalization
 * ({@link isPrivilegedPermissionLevel}) and fail-closed semantics. Both wrappers
 * call this so a `Write` response, a missing permission field, and a transport
 * error deny identically in `action/` and `app/`.
 * @param login - Actor login to verify (empty/undefined denies).
 * @param lookup - Transport; receives the login plus a per-attempt AbortSignal.
 * @param signal - Optional caller AbortSignal combined with the attempt timeout.
 * @returns True only when the transport reports admin/maintain/write.
 */
export async function hasWritePermission(
  login: string | undefined,
  lookup: (login: string, signal: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!login) return false;
  try {
    const permission = await fetchCollaboratorPermission(login, lookup, signal);
    return isPrivilegedPermissionLevel(permission);
  } catch {
    // Fail closed: an unreachable or erroring permission API must never widen
    // access. Transient failures have already been retried above.
    return false;
  }
}
