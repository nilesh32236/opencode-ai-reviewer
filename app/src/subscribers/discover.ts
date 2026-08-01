import { GitHubHelper, Logger, PatternDetector, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/discover` commands to surface recurring review patterns.
 * @param learningStore - The learning store instance for pattern discovery.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @returns A subscriber object for the discover command.
 */
export function createDiscoverSubscriber(
  learningStore: LearningStore,
  rateLimiter: RateLimiter,
): Subscriber {
  const logger = new Logger('DiscoverSubscriber');
  return {
    name: 'DiscoverSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, string> | undefined;
        const parsed = comment?.body ? parseCommand(comment.body) : null;
        if (!parsed || parsed.command !== 'discover') return;

        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'discover');
        if (!reservation) return;

        const DISCOVER_WINDOW_DEFAULT = 2;
        const detector = new PatternDetector(learningStore);
        const patterns = await detector.discover(DISCOVER_WINDOW_DEFAULT);

        const gh = new GitHubHelper(getToken(), event.repo || '');

        let body = '## 🔍 Discovered Patterns\n\n';
        if (patterns.length === 0) {
          body += 'No recurring patterns found in recent reviews.';
        } else {
          body += 'The following recurring review patterns were discovered:\n\n';
          for (const p of patterns) {
            body += `- **Pattern:** ${p.patternKey}\n  - Frequency: ${p.frequency}\n  - File types: ${p.fileTypes.join(', ')}\n\n`;
          }
        }

        await gh.postOrUpdateComment(issueNumber, '<!-- discovered-patterns -->', body);
        await recordRateLimit(rateLimiter, event, 'command', 'discover', reservation);
      } catch (err) {
        logger.error(`DiscoverSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
