import { Logger, createGuardedCommandSubscriber } from '@opencode-pr-agent/lib';
import type { RateLimitResult, RateLimiter } from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, ParsedCommand, Subscriber } from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { postPrivilegeDenial, satisfiesPrivilegeGate } from '../utils/privilege.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';

/**
 * Create a subscriber that handles `/setup` commands on comments.
 *
 * Uses the shared guarded-subscriber pipeline (single owner in lib/) with a
 * documented exception: no pipeline privilege gate (checked manually
 * in-handler so the denial notice names the command), plus a lightweight
 * command-tier rate limit. `/setup` spends no LLM budget but still performs
 * a full git clone plus diagnostics per invocation, so unthrottled
 * invocations would exhaust disk/CPU/network bounded only by the global
 * concurrency semaphore.
 * @param config - The resolved agent configuration (built once at startup).
 * @param rateLimiter - Optional shared rate limiter; when omitted (tests),
 * rate limiting is skipped.
 * @returns A subscriber object for the setup command.
 */
export function createSetupSubscriber(
  config: AgentConfig,
  rateLimiter?: RateLimiter | null,
): Subscriber {
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
        // Diagnostics reveal environment-dependent config (token/provider key
        // presence, MCP status): only privileged authors may trigger them.
        if (!satisfiesPrivilegeGate(event.payload, event.type)) {
          logger.info(`Skipping /setup for ${event.repo}#${issueNumber} — unprivileged author`);
          await postPrivilegeDenial(event.repo || '', issueNumber, 'setup');
          return;
        }
        // Lightweight command-tier throttle: /setup spends no LLM budget but
        // each invocation clones plus runs diagnostics, so spam would exhaust
        // disk/CPU/network. Denied invocations stop before the clone.
        let reservation: RateLimitResult | null = null;
        if (rateLimiter) {
          reservation = await checkRateLimit(rateLimiter, event, 'command', 'setup');
          if (!reservation) return;
        }
        try {
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
        } finally {
          if (rateLimiter && reservation) {
            await recordRateLimit(rateLimiter, event, 'command', 'setup', reservation);
          }
        }
      } catch (err) {
        logger.error(
          `SetupSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  });
}
