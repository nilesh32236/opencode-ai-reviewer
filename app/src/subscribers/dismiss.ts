import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { handleDismissCommand, isPrivilegedAuthor } from '../handlers/dismiss.js';
import { isBotUser } from '../utils/bot.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/dismiss <reason>` commands issued as
 * replies on bot review threads. Dismissals are recorded in the learning store
 * so future reviews can avoid repeating the flagged pattern.
 *
 * Only privileged commenters (owner, member, or collaborator) may dismiss:
 * a dismissal hides a bot comment and writes 'dismissed' feedback into the
 * shared learning store, so unprivileged commenters on public PRs must not be
 * able to trigger it.
 * @param learningStore - The learning store used to persist dismissal feedback.
 * @param config - The resolved agent configuration (built once at startup).
 * @returns A subscriber object for the dismiss event.
 */
export function createDismissSubscriber(
  learningStore: LearningStore,
  config: AgentConfig,
): Subscriber {
  const logger = new Logger('DismissSubscriber');
  return {
    name: 'DismissSubscriber',
    subscribedEvents: ['review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown> | undefined;
        if (!comment) return;

        const user = comment.user as Record<string, unknown> | undefined;
        if (isBotUser(user)) return;

        const parentId = comment.in_reply_to_id as number | undefined;
        if (!parentId) return;

        const body = comment.body as string | undefined;
        if (!body) return;

        const parsed = parseCommand(body);
        if (!parsed || parsed.command !== 'dismiss') return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const authorAssociation = comment.author_association as string | undefined;
        if (!isPrivilegedAuthor(authorAssociation)) {
          const login = (user?.login as string | undefined) || 'unknown';
          logger.info(
            `User ${login} (association "${authorAssociation || 'none'}") is not authorized to dismiss — skipping`,
          );
          return;
        }

        await handleDismissCommand(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          learningStore,
          parentId,
          parsed,
          authorAssociation,
          signal,
        );
      } catch (err) {
        logger.error(`DismissSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
