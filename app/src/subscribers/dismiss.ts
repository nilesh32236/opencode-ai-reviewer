import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { handleDismissCommand } from '../handlers/dismiss.js';
import { buildConfig } from '../utils/config.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/dismiss <reason>` commands issued as
 * replies on bot review threads. Dismissals are recorded in the learning store
 * so future reviews can avoid repeating the flagged pattern.
 * @param learningStore - The learning store used to persist dismissal feedback.
 * @returns A subscriber object for the dismiss event.
 */
export function createDismissSubscriber(learningStore: LearningStore): Subscriber {
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
        if (user?.type === 'Bot') return;

        const parentId = comment.in_reply_to_id as number | undefined;
        if (!parentId) return;

        const body = comment.body as string | undefined;
        if (!body) return;

        const parsed = parseCommand(body);
        if (!parsed || parsed.command !== 'dismiss') return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const config = buildConfig();
        await handleDismissCommand(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          learningStore,
          parentId,
          parsed,
        );
      } catch (err) {
        logger.error(`DismissSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
