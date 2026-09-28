import { GitHubHelper, Logger, combineSignals, withRetry } from '@opencode-pr-agent/lib';
import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import { getToken } from './token.js';

const logger = new Logger('Privilege');

/**
 * GitHub `author_association` values considered privileged enough to trigger
 * LLM-costly slash commands. Mirrors the dismiss path (`handlers/dismiss.ts`):
 * only owners, members, and collaborators may spend shared model budget.
 */
const PRIVILEGED_AUTHOR_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

/**
 * Marker for the permission-denied notice, scoped per command so concurrent denials don't clobber each other.
 * @param command - Slash command name (e.g. 'fix').
 * @returns The HTML comment marker for the denial notice.
 */
export const privilegeDenialMarker = (command: string): string =>
  `<!-- permission-denied:${command} -->`;

/**
 * Whether a GitHub `author_association` value is privileged.
 * @param association - The commenter's `author_association` value (or undefined).
 * @returns True for OWNER/MEMBER/COLLABORATOR, false otherwise (including missing).
 */
export function isPrivilegedAuthor(association?: string): boolean {
  if (!association) return false;
  return (PRIVILEGED_AUTHOR_ASSOCIATIONS as readonly string[]).includes(association);
}

/**
 * Repository permission levels considered privileged (server-verified).
 *
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission` reports
 * `permission` in {admin, write, read, none}; the finer-grained `maintain` and
 * `triage` levels appear only in the sibling `role_name` field and are NOT
 * accepted here. `maintain` is listed defensively so a caller that already
 * resolved `role_name` is not silently under-approximated; `triage` is
 * deliberately excluded — it sits below `write`, which is the spend threshold.
 * Do not widen this list by reading `role_name` values wholesale: doing so would
 * also admit `triage` and custom role names, silently lowering the bar.
 */
const PRIVILEGED_REPO_PERMISSIONS = ['admin', 'maintain', 'write'] as const;

/**
 * Whether a server-resolved repository permission is privileged.
 * @param permission - Raw `permission` value from the collaborators API.
 * @returns True for admin/maintain/write (case-insensitive), false otherwise.
 */
export function isPrivilegedPermissionLevel(permission?: string): boolean {
  if (!permission) return false;
  return (PRIVILEGED_REPO_PERMISSIONS as readonly string[]).includes(
    permission.trim().toLowerCase(),
  );
}

/**
 * Extract the event sender's login from a webhook payload.
 * @param payload - Raw webhook payload.
 * @returns The sender login, or undefined when absent.
 */
export function getSenderLogin(payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const sender = p.sender as Record<string, unknown> | undefined;
  return typeof sender?.login === 'string' ? (sender.login as string) : undefined;
}

/**
 * Extract the event sender as a bot-checkable user object.
 * @param payload - Raw webhook payload.
 * @returns The sender `{ login, type }` shape, or undefined when absent.
 */
export function getSenderUser(payload: unknown): { login?: string; type?: string } | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const sender = p.sender as Record<string, unknown> | undefined;
  if (!sender) return undefined;
  const user: { login?: string; type?: string } = {};
  if (typeof sender.login === 'string') user.login = sender.login as string;
  if (typeof sender.type === 'string') user.type = sender.type as string;
  return user;
}

/** Minimal fetch shape for the collaborator-permission lookup (test seam). */
export type PermissionFetch = (
  url: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * TTL for cached positive privilege verifications (short — permissions change).
 * Deliberately private: widening it trades authorization freshness for latency,
 * so the bound is pinned by the behavioural tests in
 * `app/tests/utils/privilege.test.ts` (which hard-code 60s rather than import
 * it), not by a change-gate assertion on the constant.
 */
const PERMISSION_CACHE_TTL_MS = 60_000;

/** Per-request timeout for the collaborator-permission lookup. */
const PERMISSION_LOOKUP_TIMEOUT_MS = 5_000;

/** Cap on cached entries, so a broad scan of logins cannot grow the map forever. */
const PERMISSION_CACHE_MAX_ENTRIES = 1000;

/** Cache of recently verified privileged actors: `repo:login` → timestamp. */
const verifiedPermissionCache = new Map<string, number>();

/**
 * In-flight verifications keyed like the cache, so concurrent subscribers that
 * reach the gate for the same actor in the same tick share one API round-trip
 * instead of each issuing an identical request. Entries are removed as soon as
 * the lookup settles.
 */
const inFlightPermissionChecks = new Map<string, Promise<boolean>>();

/**
 * Clear the positive-verification cache (test seam so permission changes and
 * per-test fetch stubs are always honored).
 */
export function clearPrivilegeVerificationCache(): void {
  verifiedPermissionCache.clear();
  inFlightPermissionChecks.clear();
}

function permissionCacheKey(repo: string, username: string): string {
  return `${repo.toLowerCase()}:${username.toLowerCase()}`;
}

function isCachedVerified(repo: string, username: string): boolean {
  const now = Date.now();
  const at = verifiedPermissionCache.get(permissionCacheKey(repo, username));
  // `now >= at` is load-bearing, not defensive noise. A clock step backwards
  // (NTP correction, suspend/resume, container clock jump) makes `now - at`
  // negative, and a negative number is trivially `< TTL` — so without this
  // clause the entry stays valid not for the documented ≤60s but until the
  // clock catches back up, which can be unbounded. A stamp in the future means
  // the clock moved, so the entry is untrustworthy either way: re-verify.
  return at !== undefined && now >= at && now - at < PERMISSION_CACHE_TTL_MS;
}

function markVerified(repo: string, username: string): void {
  const key = permissionCacheKey(repo, username);
  // Delete before re-set: `Map.set` on an existing key keeps its original
  // position, so without this the most frequently re-verified identity stays
  // first in line for eviction and pays an extra round-trip on its next command.
  verifiedPermissionCache.delete(key);
  verifiedPermissionCache.set(key, Date.now());
  if (verifiedPermissionCache.size > PERMISSION_CACHE_MAX_ENTRIES) {
    const oldest = verifiedPermissionCache.keys().next().value;
    if (oldest !== undefined) verifiedPermissionCache.delete(oldest);
  }
}

/**
 * Server-side privilege verification via the GitHub collaborators API.
 *
 * `author_association` is webhook-supplied and can be forged, replayed, or
 * stale — treat it as a fast-path hint only. This lookup resolves the actor's
 * actual repository permission and fails closed (false) on any API error,
 * missing token, or missing username/repo.
 * @param repo - Repository in "owner/repo" form.
 * @param username - GitHub login of the actor to verify.
 * @param token - GitHub token for the API call.
 * @param fetchFn - Fetch implementation (defaults to global fetch; injectable for tests).
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns True only when the API reports admin/maintain/write.
 */
export async function verifyCollaboratorPermission(
  repo: string,
  username: string,
  token: string,
  fetchFn: PermissionFetch = fetch as unknown as PermissionFetch,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!repo || !repo.includes('/') || !username || !token) return false;
  if (isCachedVerified(repo, username)) return true;
  const key = permissionCacheKey(repo, username);
  // The event bus dispatches subscribers in concurrent batches, so several can
  // reach the gate for the same actor in the same tick. Sharing the in-flight
  // promise collapses those into one collaborator-permission request.
  const pending = inFlightPermissionChecks.get(key);
  if (pending) return pending;
  const check = runCollaboratorPermissionCheck(repo, username, token, fetchFn, signal).finally(
    () => {
      inFlightPermissionChecks.delete(key);
    },
  );
  inFlightPermissionChecks.set(key, check);
  return check;
}

/**
 * Perform one uncached collaborator-permission lookup, failing closed on every
 * error path. Split out of `verifyCollaboratorPermission` so the cache and the
 * in-flight de-duplication wrap a single implementation.
 * @param repo - Repository in "owner/repo" form.
 * @param username - GitHub login of the actor to verify.
 * @param token - GitHub token for the API call.
 * @param fetchFn - Fetch implementation.
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns True only when the API reports a privileged permission level.
 */
async function runCollaboratorPermissionCheck(
  repo: string,
  username: string,
  token: string,
  fetchFn: PermissionFetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = `https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`;
  try {
    // Bound every attempt with a timeout and retry transient (429/5xx,
    // network) failures via withRetry; deterministic denials (403/404 on a
    // non-collaborator) fail closed immediately without retrying. Positive
    // verifications are cached briefly so hot comment paths do not add a
    // blocking API round-trip per command.
    const permission = await withRetry(
      async () => {
        // `combineSignals` is used rather than an inline `AbortSignal.any` so
        // the per-attempt timeout cannot be dropped on a fallback path.
        const combined = combineSignals(signal, AbortSignal.timeout(PERMISSION_LOOKUP_TIMEOUT_MS));
        const res = await fetchFn(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: combined,
        });
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            const retryable = new Error(
              `Collaborator-permission lookup transient failure (status ${res.status})`,
            ) as Error & { status?: number };
            retryable.status = res.status;
            throw retryable;
          }
          logger.warn(
            `Collaborator-permission check for ${username} failed closed (status ${res.status})`,
          );
          return undefined;
        }
        const body = (await res.json()) as { permission?: unknown };
        return typeof body?.permission === 'string' ? body.permission : undefined;
      },
      {
        maxRetries: 3,
        baseDelayMs: 300,
        maxDelayMs: 2000,
        operationName: 'verifyCollaboratorPermission',
        signal,
      },
    );
    if (!isPrivilegedPermissionLevel(permission)) return false;
    markVerified(repo, username);
    return true;
  } catch (err) {
    logger.warn(
      `Collaborator-permission check for ${username} failed closed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Internal event types whose acting identity is the comment author. */
const COMMENT_EVENT_TYPES: readonly string[] = [
  'comment.created',
  'review_comment.created',
] as const;

/**
 * Authoritative privilege check for cost-incurring commands.
 *
 * Which identity gets verified is the whole point of this function, so it is
 * decided by the EVENT TYPE — the one field a forger cannot supply, because
 * `EventRouter` maps it from a fixed allowlist — and never by which object in
 * the payload happened to carry something.
 *
 * On a comment event the acting identity is `comment.user.login`. Inferring
 * "this is a comment event" from the payload's own `comment` key was the bug
 * fixed here twice over: it verified the privileged *sender* while someone else
 * acted whenever the hint came from the sender (F1), and it verified the sender
 * again on any comment event that arrived without a usable `comment` block.
 * `sender` is consulted only for non-comment events, where the sender is
 * genuinely the actor.
 *
 * Fails closed when the API check errors or when no token/username/repo is
 * available to verify with.
 * @param payload - Raw webhook payload.
 * @param eventType - Internal event type from the router (e.g. `comment.created`).
 * @param repo - Repository in "owner/repo" form.
 * @param token - GitHub token for the verification API call.
 * @param fetchFn - Fetch implementation (defaults to global fetch; injectable for tests).
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns True only when the acting identity is verified privileged.
 */
export async function verifyPrivilegeGate(
  payload: unknown,
  eventType: string,
  repo: string,
  token: string,
  fetchFn?: PermissionFetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const p = (payload ?? {}) as Record<string, unknown>;
  if ((COMMENT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    const comment = p.comment as Record<string, unknown> | undefined;
    const commentUser = comment?.user as Record<string, unknown> | undefined;
    const commentLogin = typeof commentUser?.login === 'string' ? commentUser.login : undefined;
    if (!commentLogin) return false;
    return verifyCollaboratorPermission(repo, commentLogin, token, fetchFn, signal);
  }
  const sender = p.sender as Record<string, unknown> | undefined;
  const senderLogin = typeof sender?.login === 'string' ? sender.login : undefined;
  if (!senderLogin) return false;
  return verifyCollaboratorPermission(repo, senderLogin, token, fetchFn, signal);
}

/**
 * Extract the commenter's `author_association` from a webhook payload.
 * Prefers `comment.author_association`, then `sender.author_association`.
 *
 * "Absent" and "present but unusable" are different answers. A comment block
 * that carries `author_association: ''`/`null`/a number is the ACTOR's own
 * (unusable) value, and borrowing the sender's association for it is the same
 * "hint taken from a different identity" shape the server-side gate rejects —
 * so such a payload yields undefined, which fails the gate closed.
 *
 * NOTE: this value is webhook-supplied and must be treated as a hint only.
 * Cost-incurring paths must confirm it with `verifyCollaboratorPermission` /
 * `verifyPrivilegeGate`, which fail closed when the API check errors.
 * @param payload - Raw webhook payload.
 * @returns The association string, or undefined when absent or unusable.
 */
export function getAuthorAssociation(payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const comment = p.comment as Record<string, unknown> | undefined;
  const sender = p.sender as Record<string, unknown> | undefined;
  if (comment && 'author_association' in comment) {
    const value = comment.author_association;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  return typeof sender?.author_association === 'string' ? sender.author_association : undefined;
}

/**
 * Event types for system-triggered flows that carry no comment author and are
 * therefore exempt from the privilege gate (fail-open). User-invoked comment
 * events (`comment.created`, `review_comment.created`) always fail closed when
 * the association is missing.
 *
 * These entries are a FORWARD CONTRACT, not a live guarantee: each one is
 * currently only reachable from a subscriber that has already gated the label or
 * command actor itself, so no path depends on the fail-open today. A new
 * subscriber on any of these event types inherits a silent fail-open, so it MUST
 * verify its actor (sender privilege or bot) before spending LLM budget — the
 * same obligation the `issue.labeled` autofix path discharges in `fix.ts`.
 */
export const SYSTEM_EVENT_ALLOWLIST: readonly string[] = [
  'issue.labeled',
  'pr.opened',
  'pr.synchronize',
] as const;

/**
 * Decide whether an expensive slash-command event satisfies the fast-path
 * privilege gate.
 *
 * WARNING: this checks only the webhook-supplied `author_association` hint,
 * which can be forged, replayed, or stale. Cost-incurring handlers must
 * follow it with `verifyCollaboratorPermission` / `verifyPrivilegeGate`
 * (which fail closed on API error) for the authoritative decision.
 *
 * Fails closed when an association is present but unprivileged, and also when
 * the association is absent on user-invoked comment events (a missing
 * `author_association` on a comment payload must not bypass the gate).
 * Fail-open applies only to explicitly allowlisted system events (e.g.
 * `issue.labeled` autofix-trigger flows, which carry no comment author) via
 * the `eventType` parameter — callers MUST additionally verify the label
 * actor (sender privilege or bot) before spending LLM budget.
 *
 * @param payload - Raw webhook payload.
 * @param eventType - Optional event type (e.g. `comment.created`,
 * `issue.labeled`); when omitted, a missing association fails closed.
 * @returns True when the command may proceed to server-side verification.
 */
export function satisfiesPrivilegeGate(payload: unknown, eventType?: string): boolean {
  const association = getAuthorAssociation(payload);
  if (association === undefined) {
    return (
      eventType !== undefined && (SYSTEM_EVENT_ALLOWLIST as readonly string[]).includes(eventType)
    );
  }
  return isPrivilegedAuthor(association);
}

/**
 * Minimum interval between two denial notices for the same repo+command, and a
 * cap on how many are tracked.
 */
const DENIAL_MIN_INTERVAL_MS = 60_000;
const DENIAL_MAX_TRACKED = 1000;

/** Last denial-notice timestamp per `repo:command`, so a flood is bounded. */
const lastDenialAt = new Map<string, number>();

/**
 * Clear the denial-notice throttle bookkeeping (test seam, so a test asserting
 * that a notice WAS posted is not suppressed by an earlier test in the same
 * process).
 */
export function clearPrivilegeDenialThrottle(): void {
  lastDenialAt.clear();
}

/**
 * Post a brief permission-denied notice when an unprivileged user triggers a
 * cost-incurring command. Best-effort: failures are logged, never thrown.
 *
 * The denial path is the cheapest thing an unprivileged caller can trigger —
 * every subscriber denies BEFORE `checkRateLimit`, so a flood of `/fix` comments
 * from any account that can comment would otherwise become a flood of
 * app-authored public comments. Notices are therefore throttled per repo+command
 * and the bookkeeping map is capped, so the throttle cannot itself be a leak.
 * @param repo - Repository in "owner/repo" form.
 * @param prNumber - PR/issue number to post the notice on.
 * @param command - Command name (e.g. 'fix').
 * @param adapter - Optional platform adapter (test seam). Defaults to a
 * `GitHubHelper` built from the environment token (legacy behavior).
 */
export async function postPrivilegeDenial(
  repo: string,
  prNumber: number,
  command: string,
  adapter?: PlatformAdapter,
): Promise<void> {
  if (!repo || !prNumber || prNumber <= 0) return;
  const key = `${repo.toLowerCase()}:${command.toLowerCase()}`;
  const now = Date.now();
  // Same clock-step hazard as `isCachedVerified`, one layer down: `now - last`
  // goes negative after a backwards step, and a negative number is trivially
  // below any interval, so the throttle would silence every future denial until
  // the clock caught back up. `now >= last` makes a future-dated stamp a miss;
  // the re-stamp below then re-anchors the window to the new clock.
  const lastAt = lastDenialAt.get(key);
  if (lastAt !== undefined && now >= lastAt && now - lastAt < DENIAL_MIN_INTERVAL_MS) return;
  // Delete before re-set, for the same LRU reason as `markVerified`: `Map.set`
  // on an existing key keeps its position, so the most frequently denied
  // repo+command would otherwise stay first in line for eviction.
  lastDenialAt.delete(key);
  lastDenialAt.set(key, now);
  if (lastDenialAt.size > DENIAL_MAX_TRACKED) {
    const oldest = lastDenialAt.keys().next().value;
    if (oldest !== undefined) lastDenialAt.delete(oldest);
  }
  try {
    const gh = adapter ?? new GitHubHelper(getToken(), repo);
    await gh.postOrUpdateComment(
      prNumber,
      privilegeDenialMarker(command),
      `⛔ Only repository collaborators can run \`/${command}\`. Your association does not have permission.`,
    );
  } catch (err) {
    logger.warn(
      `Failed to post privilege-denial notice for /${command}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
