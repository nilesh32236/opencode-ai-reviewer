/**
 * Single owner for the collaborator-authorization check.
 *
 * Previously implemented twice with drift: `app/src/utils/privilege.ts`
 * (`verifyCollaboratorPermission` / `verifyPrivilegeGate`) and
 * `action/src/comment-commands.ts` (`verifyCommentActorPermission`). The
 * action copy fell back to the workflow actor when no comment login was
 * found, compared the permission case-sensitively, and had no lookup
 * timeout or positive cache. Both wrappers must call these helpers so the
 * authorization rule cannot diverge again.
 */

/** Repository permission levels considered privileged (server-verified). */
export const PRIVILEGED_REPO_PERMISSIONS = ['admin', 'maintain', 'write'] as const;

/**
 * Whether a server-resolved repository permission is privileged.
 * Normalizes with `trim().toLowerCase()` so e.g. `'Write'` is accepted.
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
 * Resolve the acting identity from a comment/review webhook payload.
 *
 * Fail-closed: when a comment or review payload object is present but
 * carries no login, no fallback identity is returned — trusting the
 * workflow actor as if they wrote the comment would let anyone trigger
 * force-pushes and PR creation via a read-only comment.
 * @param payload - Raw webhook payload (may be undefined).
 * @param workflowActor - Workflow actor login (e.g. `github.context.actor`).
 * @returns The comment/review author login, the workflow actor only when no
 * comment/review payload exists, or `undefined` when unknown.
 */
export function resolveCommentAuthor(payload: unknown, workflowActor?: string): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const comment = p.comment as { user?: { login?: string } } | undefined;
  const review = p.review as { user?: { login?: string } } | undefined;
  const commentLogin = comment?.user?.login;
  if (typeof commentLogin === 'string' && commentLogin) return commentLogin;
  const reviewLogin = review?.user?.login;
  if (typeof reviewLogin === 'string' && reviewLogin) return reviewLogin;
  // A comment/review payload object exists but names no author: fail closed.
  if (comment !== undefined || review !== undefined) return undefined;
  if (typeof workflowActor === 'string' && workflowActor) return workflowActor;
  return undefined;
}

/** Minimal collaborator-permission adapter injected by callers (test seam). */
export interface CollaboratorPermissionAdapter {
  /**
   * Resolve the collaborator permission level for a user.
   * @param owner - Repository owner.
   * @param repo - Repository name.
   * @param username - GitHub login of the actor to verify.
   * @returns Raw permission string (e.g. `'write'`).
   */
  getPermissionLevel(owner: string, repo: string, username: string): Promise<string>;
}

/**
 * Whether a login holds write permission on a repository.
 * Normalizes the resolved level via {@link isPrivilegedPermissionLevel}.
 * @param adapter - Permission lookup adapter.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param login - GitHub login of the actor to verify.
 * @returns True only when the API reports admin/maintain/write.
 */
export async function hasWritePermission(
  adapter: CollaboratorPermissionAdapter,
  owner: string,
  repo: string,
  login: string,
): Promise<boolean> {
  if (!owner || !repo || !login) return false;
  try {
    const permission = await adapter.getPermissionLevel(owner, repo, login);
    return isPrivilegedPermissionLevel(permission);
  } catch {
    return false;
  }
}
