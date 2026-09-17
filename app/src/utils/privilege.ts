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
 * Extract the commenter's `author_association` from a webhook payload.
 * Prefers `comment.author_association`, then `sender.author_association`.
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
 * Decide whether an expensive slash-command event satisfies the privilege gate.
 *
 * Fails closed when an association is present but unprivileged, and also when
 * the association is absent on user-invoked comment events (a missing
 * `author_association` on a comment payload must not bypass the gate).
 * Fail-open applies only to explicitly allowlisted system events (e.g.
 * `issue.labeled` autofix-trigger flows, which carry no comment author) via
 * the `eventType` parameter.
 *
 * @param payload - Raw webhook payload.
 * @param eventType - Optional event type (e.g. `comment.created`,
 * `issue.labeled`); when omitted, a missing association fails closed.
 * @returns True when the command may proceed.
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
 * `GitHubHelper` built from the ambient token, preserving current behavior.
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
