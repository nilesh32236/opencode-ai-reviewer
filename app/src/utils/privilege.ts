import { GitHubHelper, Logger } from '@opencode-pr-agent/lib';
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
 * Mirrors `GET /repos/{owner}/{repo}/collaborators/{username}/permission`:
 * `admin`/`maintain`/`write` may spend shared model budget; `read`/`none`
 * may not.
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
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      },
    );
    if (!res.ok) {
      logger.warn(
        `Collaborator-permission check for ${username} failed closed (status ${res.status})`,
      );
      return false;
    }
    const body = (await res.json()) as { permission?: unknown };
    return isPrivilegedPermissionLevel(
      typeof body?.permission === 'string' ? body.permission : undefined,
    );
  } catch (err) {
    logger.warn(
      `Collaborator-permission check for ${username} failed closed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
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
  if (!isPrivilegedAuthor(getAuthorAssociation(payload))) return false;
  const username = getSenderLogin(payload);
  if (!username) {
    const comment = (payload as Record<string, unknown> | null)?.comment as
      | Record<string, unknown>
      | undefined;
    const commentUser = comment?.user as Record<string, unknown> | undefined;
    const commentLogin =
      typeof commentUser?.login === 'string' ? (commentUser.login as string) : undefined;
    if (!commentLogin) return false;
    return verifyCollaboratorPermission(repo, commentLogin, token, fetchFn, signal);
  }
  return verifyCollaboratorPermission(repo, username, token, fetchFn, signal);
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
