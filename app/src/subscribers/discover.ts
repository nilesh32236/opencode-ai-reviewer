import { GitHubHelper, Logger, PatternDetector, parseCommand } from '@opencode-pr-agent/lib';
import type { GitHubEvent, LearningStore, RateLimiter, Subscriber } from '@opencode-pr-agent/lib';
import {
  postPrivilegeDenial,
  satisfiesPrivilegeGate,
  verifyPrivilegeGate,
} from '../utils/privilege.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import {
  type RepoFilter,
  repoFilter as defaultRepoFilter,
  isRepoAllowed,
} from '../utils/repo-filter.js';
import { getToken } from '../utils/token.js';

/** Number of prior reviews to scan when discovering recurring patterns. */
const DISCOVER_WINDOW_DEFAULT = 2;

/**
 * Create a subscriber that handles `/discover` commands to surface recurring review patterns.
 * @param learningStore - The learning store instance for pattern discovery.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param repoFilter - Optional repo allowlist/denylist override (defaults to the shared process-wide filter).
 * @returns A subscriber object for the discover command.
 */
export function createDiscoverSubscriber(
  learningStore: LearningStore,
  rateLimiter: RateLimiter,
  repoFilter?: RepoFilter,
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

        if (!isRepoAllowed(event.repo || '', repoFilter ?? defaultRepoFilter)) {
          logger.info(
            `Skipping /discover for ${event.repo}#${issueNumber} — repository filtered out`,
          );
          return;
        }

        if (!satisfiesPrivilegeGate(event.payload, event.type)) {
          logger.info(`Skipping /discover for ${event.repo}#${issueNumber} — unprivileged author`);
          await postPrivilegeDenial(event.repo || '', issueNumber, 'discover');
          return;
        }
        // The hint above is sender-controlled. Confirm the acting identity
        // against the GitHub API before spending any budget: a forged
        // author_association must not be sufficient on its own.
        let verifyToken: string;
        try {
          verifyToken = getToken();
        } catch {
          logger.info(`Skipping /discover for ${event.repo} — no token to verify author`);
          await postPrivilegeDenial(event.repo || '', issueNumber, 'discover');
          return;
        }
        if (!(await verifyPrivilegeGate(event.payload, event.repo || '', verifyToken))) {
          logger.info(
            `Skipping /discover for ${event.repo}#${issueNumber} — author failed server verification`,
          );
          await postPrivilegeDenial(event.repo || '', issueNumber, 'discover');
          return;
        }

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'discover');
        if (!reservation) return;

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
