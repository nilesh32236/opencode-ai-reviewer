import { GitHubHelper, Logger } from '@opencode-pr-agent/lib';
import { getToken } from './token.js';

const logger = new Logger('Privilege');

/**
 * GitHub `author_association` values considered privileged enough to trigger
 * LLM-costly slash commands. Mirrors the dismiss path (`handlers/dismiss.ts`):
 * only owners, members, and collaborators may spend shared model budget.
 */
const PRIVILEGED_AUTHOR_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

/** Marker for the single permission-denied notice per PR/issue. */
const PRIVILEGE_DENIAL_MARKER = '<!-- permission-denied -->';

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
 * Decide whether an expensive slash-command event satisfies the privilege gate.
 *
 * Fails closed when an association is present but unprivileged. When the
 * association is absent (e.g. `issue.labeled` autofix-trigger events, which
 * carry no comment author, or synthetic test events), the gate passes so
 * system-triggered flows are not blocked — real GitHub comment webhooks
 * always include `author_association`, so abuse attempts are still denied.
 *
 * @param payload - Raw webhook payload.
 * @returns True when the command may proceed.
 */
export function satisfiesPrivilegeGate(payload: unknown): boolean {
  const association = getAuthorAssociation(payload);
  if (association === undefined) return true;
  return isPrivilegedAuthor(association);
}

/**
 * Post a brief permission-denied notice when an unprivileged user triggers a
 * cost-incurring command. Best-effort: failures are logged, never thrown.
 * @param repo - Repository in "owner/repo" form.
 * @param prNumber - PR/issue number to post the notice on.
 * @param command - Command name (e.g. 'fix').
 */
export async function postPrivilegeDenial(
  repo: string,
  prNumber: number,
  command: string,
): Promise<void> {
  try {
    const gh = new GitHubHelper(getToken(), repo);
    await gh.postOrUpdateComment(
      prNumber,
      PRIVILEGE_DENIAL_MARKER,
      `⛔ Only repository collaborators can run \`/${command}\`. Your association does not have permission.`,
    );
  } catch (err) {
    logger.warn(
      `Failed to post privilege-denial notice for /${command}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
