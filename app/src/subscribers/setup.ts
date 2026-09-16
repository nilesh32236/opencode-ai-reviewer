import { Logger, createGuardedCommandSubscriber } from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, ParsedCommand, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';

/**
 * Create a subscriber that handles `/setup` commands on comments.
 *
 * Uses the shared guarded-subscriber pipeline (single owner in lib/) with an
 * intentional documented exception: no privilege gate and no rate limit.
 * `/setup` runs read-only pre-flight diagnostics (never spends LLM budget on
 * code changes) and must produce a report even when rate limiting is
 * unavailable, so gates are disabled here rather than forgotten.
 * @param config - The resolved agent configuration (built once at startup).
 * @returns A subscriber object for the setup command.
 */
export function createSetupSubscriber(config: AgentConfig): Subscriber {
  const logger = new Logger('SetupSubscriber');
  return createGuardedCommandSubscriber({
    name: 'SetupSubscriber',
    command: 'setup',
    events: ['comment.created', 'review_comment.created'],
    requirePrivilege: false,
    requireRateLimit: false,
    handler: async (event: GitHubEvent, parsed: ParsedCommand | null, signal?: AbortSignal) => {
      try {
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        // Pass the raw token (possibly empty) so the setup engine can produce a
        // diagnostic report instead of aborting the flow before it starts.
        const token = process.env.GITHUB_TOKEN || '';
        await handleCommand(
          'setup',
          issueNumber,
          event.repo || '',
          token,
          config,
          parsed ?? undefined,
          signal,
          undefined,
          event.correlationId,
        );
      } catch (err) {
        logger.error(
          `SetupSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  });
}
