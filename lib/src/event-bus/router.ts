import type { EventCategory, GitHubEvent } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { EventBus } from './bus.js';

const EVENT_CATEGORY_MAP: Record<string, EventCategory> = {
  'pull_request.opened': 'pr',
  'pull_request.synchronize': 'pr',
  'pull_request.labeled': 'pr',
  'pull_request_review.submitted': 'review',
  'pull_request_review.dismissed': 'review',
  'pull_request_review_comment.dismissed': 'review',
  'pull_request_review_comment.created': 'comment',
  'pull_request_review_comment.deleted': 'comment',
  'issue_comment.created': 'comment',
  'issues.labeled': 'issue',
  'issues.opened': 'issue',
};

const EVENT_TYPE_MAP: Record<string, string> = {
  'pull_request.opened': 'pr.opened',
  'pull_request.synchronize': 'pr.synchronize',
  'pull_request.labeled': 'pr.labeled',
  'pull_request_review.submitted': 'review.submitted',
  'pull_request_review.dismissed': 'review.dismissed',
  'pull_request_review_comment.dismissed': 'review_comment.dismissed',
  'pull_request_review_comment.created': 'review_comment.created',
  'pull_request_review_comment.deleted': 'review_comment.deleted',
  'issue_comment.created': 'comment.created',
  'issues.labeled': 'issue.labeled',
  'issues.opened': 'issue.opened',
};

/**
 * Routes incoming GitHub webhook events to the EventBus.
 * Maps raw GitHub event names to internal event types and categories,
 * extracts PR context (repo, PR number) from the payload, and
 * publishes structured events for subscriber consumption.
 */
export class EventRouter {
  /**
   * @param bus The event bus instance to publish events to
   */
  constructor(private bus: EventBus) {}

  /**
   * Handle an incoming raw GitHub event: map it to an internal type,
   * extract PR context, and publish to the event bus.
   * Errors are logged but not re-thrown to prevent webhook retries.
   *
   * NOTE: this layer performs no authentication — callers (Probot `onAny`,
   * GitHub Action dispatch) must authenticate/verify the webhook upstream.
   * Unknown `rawEvent` names are rejected fail-closed (logged, not published)
   * against the explicit `EVENT_CATEGORY_MAP` allowlist, and the payload is
   * shape-validated before publishing.
   * @param rawEvent The raw GitHub webhook event name
   * @param payload The raw webhook payload
   */
  async handle(rawEvent: string, payload: unknown): Promise<void> {
    const category = EVENT_CATEGORY_MAP[rawEvent];
    const type = EVENT_TYPE_MAP[rawEvent];
    if (!category || !type) {
      new Logger('EventRouter', { eventType: rawEvent }).warn(
        `Rejected unknown event "${rawEvent}": not in the allowlist, skipping publish`,
      );
      return;
    }
    if (typeof payload !== 'object' || payload === null) {
      new Logger('EventRouter', { eventType: type }).warn(
        `Rejected event "${rawEvent}": payload must be a non-null object`,
      );
      return;
    }
    const rawRepo = (payload as { repository?: { full_name?: string } }).repository?.full_name;
    let repo: string | undefined;
    if (rawRepo !== undefined) {
      if (typeof rawRepo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(rawRepo)) {
        repo = rawRepo;
      } else {
        new Logger('EventRouter', { eventType: type }).warn(
          `Ignoring malformed repository.full_name in "${rawEvent}" payload`,
        );
      }
    }
    const rawPrNumber = extractPRNumber(payload);
    let prNumber: number | undefined;
    if (rawPrNumber !== undefined) {
      if (Number.isInteger(rawPrNumber) && rawPrNumber > 0) {
        prNumber = rawPrNumber;
      } else {
        new Logger('EventRouter', { eventType: type, repo }).warn(
          `Ignoring malformed PR number in "${rawEvent}" payload`,
        );
      }
    }
    // One correlation ID per incoming webhook so every downstream log line
    // (subscriber → engine → pipeline event) can be traced back to it.
    const correlationId = Logger.generateCorrelationId();

    const event: GitHubEvent = {
      type,
      category,
      payload,
      timestamp: Date.now(),
      repo,
      prNumber,
      correlationId,
    };

    try {
      await this.bus.publish(event);
    } catch (err) {
      const logger = new Logger('EventRouter', { eventType: type, repo, correlationId });
      logger.error(`Failed to publish event ${type}`, err);
    }
  }
}

/**
 * Extract PR number from a webhook payload.
 * Checks pull_request, issue, and top-level number fields.
 * @param payload The raw webhook payload
 * @returns The PR number if found, otherwise undefined
 */
function extractPRNumber(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const asNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  if (p.pull_request && typeof p.pull_request === 'object') {
    const n = asNumber((p.pull_request as { number?: unknown }).number);
    if (n !== undefined) return n;
  }
  if (p.issue && typeof p.issue === 'object') {
    const n = asNumber((p.issue as { number?: unknown }).number);
    if (n !== undefined) return n;
  }
  return asNumber(p.number);
}
