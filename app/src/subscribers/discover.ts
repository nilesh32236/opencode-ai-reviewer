import { GitHubHelper, Logger, PatternDetector, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, Subscriber } from '@opencode-pr-agent/lib';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/discover` commands to surface recurring review patterns.
 * @param learningStore - The learning store instance for pattern discovery.
 * @returns A subscriber object for the discover command.
 */
export function createDiscoverSubscriber(learningStore: LearningStore): Subscriber {
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
      } catch (err) {
        logger.error(`DiscoverSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
