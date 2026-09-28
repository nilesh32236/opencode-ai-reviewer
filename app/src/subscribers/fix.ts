import { Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  EventBus,
  GitHubEvent,
  ParsedCommand,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { handleCommand } from '../handlers/commands.js';
import { isBotUser } from '../utils/bot.js';
import {
  getSenderLogin,
  getSenderUser,
  isPrivilegedAuthor,
  postPrivilegeDenial,
  satisfiesPrivilegeGate,
  verifyCollaboratorPermission,
  verifyPrivilegeGate,
} from '../utils/privilege.js';
import { checkRateLimit, recordRateLimit } from '../utils/rate-limit.js';
import {
  type RepoFilter,
  repoFilter as defaultRepoFilter,
  isRepoAllowed,
} from '../utils/repo-filter.js';
import { getToken } from '../utils/token.js';

/**
 * Create a subscriber that handles `/fix` commands and `autofix-trigger` label events.
 *
 * The `issue.labeled` autofix path is additionally gated on the label actor:
 * the sender must be a bot (automation re-applying the label) or a
 * server-verified privileged collaborator (hint + collaborator-permission API
 * lookup, fail closed). Events with no sender login fail closed. Anyone able
 * to apply a label must not be able to trigger a full LLM run with zero
 * privilege check.
 * @param rateLimiter - The shared rate limiter for cost control.
 * @param config - The resolved agent configuration (built once at startup).
 * @param eventBus - Optional event bus for publishing pipeline events.
 * @param repoFilter - Optional repo allowlist/denylist override (defaults to the shared process-wide filter).
 * @returns A subscriber object for the fix command.
 */
export function createFixSubscriber(
  rateLimiter: RateLimiter,
  config: AgentConfig,
  eventBus?: EventBus,
  repoFilter?: RepoFilter,
): Subscriber {
  const logger = new Logger('FixSubscriber');
  return {
    name: 'FixSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created', 'issue.labeled'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const fixPayload = event.payload as Record<string, unknown>;
        const fixComment = fixPayload.comment as Record<string, string> | undefined;
        const fixIssue = fixPayload.issue as Record<string, unknown> | undefined;
        const fixLabels = fixIssue?.labels as Array<Record<string, string>> | undefined;

        let parsed: ParsedCommand | null = null;
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          parsed = fixComment?.body ? parseCommand(fixComment.body) : null;
          if (!parsed || parsed.command !== 'fix') return;
        }

        // Repository allowlist/denylist gate: never spend LLM budget on repos
        // the operator excluded.
        if (!isRepoAllowed(event.repo || '', repoFilter ?? defaultRepoFilter)) {
          logger.info(
            `Skipping /fix for ${event.repo}#${event.prNumber || 0} — repository filtered out`,
          );
          return;
        }

        if (event.type === 'issue.labeled') {
          const labels = fixLabels?.map((l) => l.name) || [];
          if (!labels.includes('autofix-trigger')) return;
          if (fixIssue?.pull_request) return;
          // Label-actor privilege gate: anyone able to apply a label must
          // not be able to trigger a full LLM run. Bot senders (automation
          // re-applying the label) pass without an API round-trip; human
          // senders must both carry a privileged hint AND verify
          // server-side via the collaborator-permission API. Synthetic
          // events with no sender login fail closed (real GitHub deliveries
          // always include a sender).
          const sender = getSenderUser(fixPayload);
          const senderLogin = getSenderLogin(fixPayload);
          if (!senderLogin) {
            logger.info(
              `Skipping /fix for ${event.repo}#${event.prNumber || 0} — labeled event has no sender login`,
            );
            return;
          }
          if (!isBotUser(sender)) {
            const senderAssociation = (fixPayload.sender as Record<string, unknown> | undefined)
              ?.author_association as string | undefined;
            if (!isPrivilegedAuthor(senderAssociation)) {
              logger.info(
                `Skipping /fix for ${event.repo}#${event.prNumber || 0} — unprivileged label actor`,
              );
              return;
            }
            let labelToken: string;
            try {
              labelToken = getToken();
            } catch {
              logger.info(
                `Skipping /fix for ${event.repo}#${event.prNumber || 0} — no token to verify label actor`,
              );
              return;
            }
            const verified = await verifyCollaboratorPermission(
              event.repo || '',
              senderLogin,
              labelToken,
            );
            if (!verified) {
              logger.info(
                `Skipping /fix for ${event.repo}#${event.prNumber || 0} — label actor failed server verification`,
              );
              return;
            }
          }
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        // Cost-incurring command: only privileged authors may trigger it.
        // The `author_association` hint is a fast-path only — privileged
        // hints are verified server-side (fail closed on API error) before
        // any LLM budget is spent; user-invoked comment commands fail closed
        // when the association is missing.
        if (!satisfiesPrivilegeGate(event.payload, event.type)) {
          logger.info(`Skipping /fix for ${event.repo}#${prNumber} — unprivileged author`);
          await postPrivilegeDenial(event.repo || '', prNumber, 'fix');
          return;
        }
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          let verifyToken: string;
          try {
            verifyToken = getToken();
          } catch {
            logger.info(`Skipping /fix for ${event.repo}#${prNumber} — no token to verify author`);
            await postPrivilegeDenial(event.repo || '', prNumber, 'fix');
            return;
          }
          const verified = await verifyPrivilegeGate(event.payload, event.repo || '', verifyToken);
          if (!verified) {
            logger.info(
              `Skipping /fix for ${event.repo}#${prNumber} — author failed server verification`,
            );
            await postPrivilegeDenial(event.repo || '', prNumber, 'fix');
            return;
          }
        }

        const reservation = await checkRateLimit(rateLimiter, event, 'command', 'fix');
        if (!reservation) return;

        await handleCommand(
          'fix',
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parsed ?? undefined,
          signal,
          eventBus,
          event.correlationId,
        );
        await recordRateLimit(rateLimiter, event, 'command', 'fix', reservation);
      } catch (err) {
        logger.error(
          `FixSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}
