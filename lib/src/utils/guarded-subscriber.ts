/**
 * Single owner for the subscriber command-guard pipeline.
 *
 * `app/src/subscribers/*.ts` copy-pasted parse → prNumber guard → privilege
 * gate → rate-limit check → handle → rate-limit record across ~12
 * subscribers, and `setup.ts` drifted (no privilege gate, no rate limit).
 * The next new command would likely forget one gate, opening LLM-budget
 * abuse or unthrottled runs. New subscribers must use
 * {@link createGuardedCommandSubscriber} so privilege/rate-limit enforcement
 * lives in one place. Privilege and rate-limit implementations are injected
 * (not imported) to avoid a `lib → app` dependency cycle.
 */

import type { GitHubEvent, Subscriber } from '../types/index.js';
import { parseCommand } from './command-match.js';
import type { ParsedCommand } from './command-match.js';

/** Privilege hooks injected by the host (app/). */
export interface PrivilegeHooks {
  /** Return true when the payload author may run cost-incurring commands. */
  satisfiesPrivilegeGate: (payload: unknown) => boolean;
  /** Post a denial notice for unprivileged authors. */
  postPrivilegeDenial?: (repo: string, prNumber: number, command: string) => Promise<void>;
}

/** Rate-limit hooks injected by the host (app/). */
export interface RateLimitHooks<TReservation = unknown> {
  /** Reserve a slot; return null when denied. */
  checkRateLimit: (
    event: GitHubEvent,
    tier: string,
    action: string,
  ) => Promise<TReservation | null>;
  /** Reconcile the reservation after the handler completes. */
  recordRateLimit?: (
    event: GitHubEvent,
    tier: string,
    action: string,
    reservation: TReservation | null,
  ) => Promise<void>;
}

/** Options for {@link createGuardedCommandSubscriber}. */
export interface GuardedSubscriberOptions<TReservation = unknown> {
  /** Subscriber name (e.g. `FixSubscriber`). */
  name: string;
  /** Slash command this subscriber handles (e.g. `fix`). */
  command: string;
  /** Events to subscribe to. */
  events: string[];
  /** Cost tier for rate limiting. Defaults to `'command'`. */
  tier?: string;
  /** When false, skip the privilege gate (document the exception). */
  requirePrivilege?: boolean;
  /** When false, skip rate limiting (document the exception). */
  requireRateLimit?: boolean;
  /** Extra event predicate (e.g. label checks for `issue.labeled`). */
  shouldHandle?: (event: GitHubEvent, parsed: ParsedCommand | null) => boolean;
  /** Privilege hooks (required when `requirePrivilege` is true). */
  privilege?: PrivilegeHooks;
  /** Rate-limit hooks (required when `requireRateLimit` is true). */
  rateLimit?: RateLimitHooks<TReservation>;
  /** The expensive command handler. */
  handler: (
    event: GitHubEvent,
    parsed: ParsedCommand | null,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/**
 * Create a subscriber encoding parse → prNumber guard → privilege gate →
 * rate-limit check → handler → rate-limit record exactly once.
 *
 * @param options - Single options object (command, tiers, hooks, handler).
 * @returns A subscriber with the full guard pipeline.
 */
export function createGuardedCommandSubscriber<TReservation = unknown>(
  options: GuardedSubscriberOptions<TReservation>,
): Subscriber {
  const {
    name,
    command,
    events,
    tier = 'command',
    requirePrivilege = true,
    requireRateLimit = true,
    shouldHandle,
    privilege,
    rateLimit,
    handler,
  } = options;
  return {
    name,
    subscribedEvents: events,
    async handle(event: GitHubEvent, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return;
      const payload = event.payload as Record<string, unknown>;
      const comment = payload.comment as { body?: string } | undefined;
      const parsed: ParsedCommand | null = comment?.body ? parseCommand(comment.body) : null;
      if (parsed && parsed.command !== command) return;
      if (!parsed && event.type !== 'issue.labeled') return;
      if (shouldHandle && !shouldHandle(event, parsed)) return;
      const prNumber = event.prNumber || 0;
      if (!prNumber) return;
      if (requirePrivilege && privilege) {
        if (!privilege.satisfiesPrivilegeGate(event.payload)) {
          if (privilege.postPrivilegeDenial) {
            await privilege.postPrivilegeDenial(event.repo || '', prNumber, command);
          }
          return;
        }
      }
      let reservation: TReservation | null = null;
      if (requireRateLimit && rateLimit) {
        reservation = await rateLimit.checkRateLimit(event, tier, command);
        if (!reservation) return;
      }
      await handler(event, parsed, signal);
      if (requireRateLimit && rateLimit?.recordRateLimit) {
        await rateLimit.recordRateLimit(event, tier, command, reservation);
      }
    },
  };
}
