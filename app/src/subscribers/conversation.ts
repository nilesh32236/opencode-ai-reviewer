import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConversationStateManager, Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  LearningStore,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleConversation } from '../handlers/conversation.js';
import { isBotLogin } from '../utils/bot.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles @mention conversations and `/ask` follow-up
 * questions on PRs.
 *
 * A long-lived `ConversationStateManager` is owned by the subscriber so tracked
 * state (turn count, summary snapshots) survives across individual webhook
 * turns — otherwise every @mention would start with empty state and the sliding
 * window/summarization logic would never accumulate. Persisted per-thread
 * session state in the learning store is restored into this manager on each
 * turn so it also survives app restarts.
 *
 * The `/ask` command (when enabled via `config.conversation.askCommandEnabled`)
 * triggers a conversation even without an @mention. Both entry points flow
 * through the same `handleConversation` so session state is always captured
 * (Option A — unified conversation pipeline).
 *
 * @param learningStore - The learning store instance for context and patterns.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @returns A subscriber object for conversation handling.
 */
export function createConversationSubscriber(
  learningStore: LearningStore,
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
): Subscriber {
  const logger = new Logger('ConversationSubscriber');
  const conversationStateManager = new ConversationStateManager();
  return {
    name: 'ConversationSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const convPayload = event.payload as Record<string, unknown>;
        const convComment = convPayload.comment as Record<string, unknown> | undefined;
        const convBody = (convComment?.body as string) || '';
        const convUser = (convComment?.user as Record<string, string>)?.login || '';

        if (!config.conversation.enabled) return;

        const mentionHandle = config.conversation.mentionHandle;

        const mentioned = convBody.toLowerCase().includes(`@${mentionHandle.toLowerCase()}`);
        const askEnabled = config.conversation.askCommandEnabled !== false;
        const isAsk = askEnabled && parseCommand(convBody)?.command === 'ask';

        // /ask works without an @mention; everything else requires the mention.
        if (!mentioned && !isAsk) return;

        if (
          isBotLogin(convUser) ||
          convUser.includes('github-actions') ||
          convUser.toLowerCase().includes(mentionHandle.toLowerCase())
        ) {
          return;
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const commentId = (convComment?.id as number) || 0;
        if (!commentId) return;

        const isReviewComment = event.type === 'review_comment.created';

        const action = isAsk ? 'ask' : 'conversation';
        const reservation = await checkRateLimit(rateLimiter, event, 'interactive', action);
        if (!reservation) return;

        // Each conversation gets its own scratch directory under the OS temp dir
        // so concurrent webhooks (Probot handles them concurrently) never clobber
        // each other's `.opencode/conversation-output.txt` / `conversation-summary.txt`.
        // The directory is removed when the turn finishes so temp dirs do not
        // accumulate across every conversation event.
        const convWorkDir = path.join(
          os.tmpdir(),
          'opencode-conv',
          `${(event.repo || '').replace('/', '-')}-${prNumber}-${commentId}`,
        );

        try {
          await handleConversation(
            commentId,
            prNumber,
            event.repo || '',
            getToken(),
            config,
            isReviewComment,
            learningStore,
            signal,
            convWorkDir,
            conversationStateManager,
            eventBus,
            event.correlationId,
          );
        } finally {
          try {
            rmSync(convWorkDir, { recursive: true, force: true });
          } catch (rmErr) {
            logger.warn(
              `Failed to clean up conversation work dir ${convWorkDir}: ${
                rmErr instanceof Error ? rmErr.message : rmErr
              }`,
            );
          }
        }
        await recordRateLimit(rateLimiter, event, 'interactive', action, reservation);
      } catch (err) {
        logger.error(
          `ConversationSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
