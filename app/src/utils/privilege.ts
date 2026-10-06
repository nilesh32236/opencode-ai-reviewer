import {
  GitHubHelper,
  Logger,
  hasWritePermission,
  resolveActingLogin,
  withRetry,
} from '@opencode-pr-agent/lib';
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
 * The comparison itself is owned by lib
 * (`isPrivilegedPermissionLevel`, shared with `action/src/comment-commands.ts`)
 * so the two wrappers cannot disagree about which levels are privileged or how
 * a value is normalized. Re-exported here for the app's existing importers.
 */
export { isPrivilegedPermissionLevel } from '@opencode-pr-agent/lib';

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

/** TTL for cached positive privilege verifications (short — permissions change). */
// 60s bounds how long a POSITIVE verification is reused. Nothing in the suite
// pinned this value, so it could silently become 10 minutes -- or Infinity --
// with every test still green. Exported so a test can hold it here.
export const PERMISSION_CACHE_TTL_MS = 60_000;

/** Cache of recently verified privileged actors: `repo:login` → timestamp. */
const verifiedPermissionCache = new Map<string, number>();

/**
 * Clear the positive-verification cache (test seam so permission changes and
 * per-test fetch stubs are always honored).
 */
export function clearPrivilegeVerificationCache(): void {
  verifiedPermissionCache.clear();
}

function permissionCacheKey(repo: string, username: string): string {
  return `${repo.toLowerCase()}:${username.toLowerCase()}`;
}

function isCachedVerified(repo: string, username: string, now: number = Date.now()): boolean {
  const at = verifiedPermissionCache.get(permissionCacheKey(repo, username));
  // The `now >= at` guard is load-bearing, not defensive noise. `now - at <
  // TTL` alone is TRUE for any FUTURE-dated entry, because the difference is
  // negative. A backward clock step (NTP correction, or a host whose clock
  // jumped forward when the entry was written) would therefore make a cached
  // positive valid INDEFINITELY -- unbounded privilege lifetime, not the
  // <=60s revocation lag this cache is documented to have.
  return at !== undefined && now >= at && now - at < PERMISSION_CACHE_TTL_MS;
}

function markVerified(repo: string, username: string, now: number = Date.now()): void {
  verifiedPermissionCache.set(permissionCacheKey(repo, username), now);
  // Bound the cache so a broad scan of distinct logins cannot grow it
  // unboundedly over process lifetime.
  if (verifiedPermissionCache.size > 1000) {
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
  const url = `https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`;
  // The bounded attempt (per-attempt AbortSignal.timeout) and the
  // fail-closed decision are owned by lib so `action/` cannot ship an
  // unbounded or differently-normalized twin of this gate. Only the transport
  // (and the app's 429/5xx-vs-403/404 classification and positive cache) is
  // app-specific.
  const allowed = await hasWritePermission(
    username,
    async (_login, attemptSignal) => {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: attemptSignal,
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
    signal,
  );
  if (allowed) markVerified(repo, username);
  return allowed;
}

/**
 * Authoritative privilege check for cost-incurring commands.
 *
 * Uses `author_association` as a fast-path hint (unprivileged/missing hints
 * fail closed immediately), then verifies privileged hints server-side via
 * `verifyCollaboratorPermission`. Fails closed when the API check errors or
 * when no token/username/repo is available to verify with.
 * @param payload - Raw webhook payload.
 * @param repo - Repository in "owner/repo" form.
 * @param token - GitHub token for the verification API call.
 * @param fetchFn - Fetch implementation (defaults to global fetch; injectable for tests).
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns True only when the actor is verified privileged.
 */
export async function verifyPrivilegeGate(
  payload: unknown,
  repo: string,
  token: string,
  fetchFn?: PermissionFetch,
  signal?: AbortSignal,
): Promise<boolean> {
  // Which identity gets verified is the whole point of this function, so it is
  // decided by WHERE the actor came from, not by which object happened to carry
  // a privileged hint. That rule is owned by lib (`resolveActingLogin`) and is
  // shared with `action/src/comment-commands.ts`, whose hand-rolled twin used
  // to fall back to `github.context.actor` when a comment payload named no
  // author — trusting the workflow-run author as if they wrote the comment.
  const resolved = resolveActingLogin(payload);
  if (!resolved.login) return false;
  return verifyCollaboratorPermission(repo, resolved.login, token, fetchFn, signal);
}

/**
 * Extract the commenter's `author_association` from a webhook payload.
 * Prefers `comment.author_association`, then `sender.author_association`.
 *
 * NOTE: this value is webhook-supplied and must be treated as a hint only.
 * Cost-incurring paths must confirm it with `verifyCollaboratorPermission` /
 * `verifyPrivilegeGate`, which fail closed when the API check errors.
 * @param payload - Raw webhook payload.
 * @returns The association string, or undefined when absent.
 */
export function getAuthorAssociation(payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const comment = p.comment as Record<string, unknown> | undefined;
  const sender = p.sender as Record<string, unknown> | undefined;
  const fromComment =
    typeof comment?.author_association === 'string'
      ? (comment.author_association as string)
      : undefined;
  if (fromComment) return fromComment;
  return typeof sender?.author_association === 'string'
    ? (sender.author_association as string)
    : undefined;
}

/**
 * Event types for system-triggered flows that carry no comment author and are
 * therefore exempt from the privilege gate (fail-open). User-invoked comment
 * events (`comment.created`, `review_comment.created`) always fail closed when
 * the association is missing.
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
 * Post a brief permission-denied notice when an unprivileged user triggers a
 * cost-incurring command. Best-effort: failures are logged, never thrown.
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
