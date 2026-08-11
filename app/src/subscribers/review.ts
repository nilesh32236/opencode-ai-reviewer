import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  LearningStore,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handlePRReview } from '../handlers/pr-review.js';
import { isBotUser } from '../utils/bot.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles PR review, re-review on push, and `/review` commands.
 * @param learningStore - The learning store instance for review context.
 * @param bus - The event bus used by the review engine to publish pipeline events.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @returns A subscriber object for the review command.
 */
export function createReviewSubscriber(
  learningStore: LearningStore,
  bus: EventBus,
  rateLimiter: RateLimiter,
  config: AgentConfig,
): Subscriber {
  const logger = new Logger('ReviewSubscriber');
  // Single-flight map: one in-flight review handler per (repo, prNumber) so two
  // concurrent events for the same PR (e.g. pr.synchronize + /review comment)
  // serialize instead of both posting a review. The joining invocation awaits
  // the first, then no-ops — the engine's dedup marks the join as `skipped`.
  const inFlightHandlers = new Map<string, Promise<unknown>>();
  return {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const evPayload = event.payload as Record<string, unknown>;
          const commentBody = (evPayload.comment as Record<string, string> | undefined)?.body;
          const parsed = commentBody ? parseCommand(commentBody) : null;
          if (!parsed || parsed.command !== 'review') return;
        }

        const evPayload = event.payload as Record<string, unknown>;
        const pullRequest = evPayload.pull_request as Record<string, unknown> | undefined;
        const prUser = pullRequest?.user as Record<string, string> | undefined;
        const prLabels = pullRequest?.labels as Array<Record<string, string>> | undefined;

        if (event.type === 'pr.opened' || event.type === 'pr.synchronize') {
          if (isBotUser(prUser)) return;
          const labels = prLabels?.map((l) => l.name) || [];
          if (labels.some((l) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l)))
            return;
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        // Auto-triggered events (pr.opened / pr.synchronize) go through the same
        // command-tier guardrails, but no user invoked the bot, so a denial comment
        // would be misleading — enforce silently in that case.
        const isCommandInvoked =
          event.type === 'comment.created' || event.type === 'review_comment.created';
        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'review', {
          postDenialComment: isCommandInvoked,
        });
        if (!reservation) return;

        const previousHeadSha =
          event.type === 'pr.synchronize'
            ? (evPayload.before as string) ||
              ((evPayload.pull_request as Record<string, unknown> | undefined)?.before as string)
            : undefined;

        // Serialize concurrent events for the same PR. A joining event waits
        // for the in-flight handler and then no-ops; only the first invocation
        // actually reviews (its engine run is not dedup-skipped).
        const key = `${event.repo || ''}#${prNumber}`;
        const existing = inFlightHandlers.get(key);
        if (existing) {
          logger.info(`Review already in progress for ${key} — joining existing run`);
          await existing;
          return;
        }
        const handler = (async () => {
          const result = await handlePRReview(
            prNumber,
            event.repo || '',
            getToken(),
            config,
            learningStore,
            undefined,
            previousHeadSha,
            bus,
            event.correlationId,
            // A user-invoked /review command must bypass the dedup cache so it
            // always re-reviews the current head. Auto events (opened/synchronize)
            // keep the cache to avoid redundant re-review work.
            { forceReview: isCommandInvoked },
          );
          if (result) {
            await recordRateLimit(
              rateLimiter,
              event,
              'command',
              'review',
              reservation,
              result.usage?.totalTokens,
            );
          }
        })().finally(() => {
          inFlightHandlers.delete(key);
        });
        inFlightHandlers.set(key, handler);
        await handler;
      } catch (err) {
        logger.error(`ReviewSubscriber failed: ${err instanceof Error ? err.message : err}`, {
          correlationId: event.correlationId,
        });
      }
    },
  };
}
