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
  'issue_comment.created': 'comment',
  'issues.labeled': 'issue',
};

const EVENT_TYPE_MAP: Record<string, string> = {
  'pull_request.opened': 'pr.opened',
  'pull_request.synchronize': 'pr.synchronize',
  'pull_request.labeled': 'pr.labeled',
  'pull_request_review.submitted': 'review.submitted',
  'pull_request_review.dismissed': 'review.dismissed',
  'pull_request_review_comment.dismissed': 'review_comment.dismissed',
  'pull_request_review_comment.created': 'review_comment.created',
  'issue_comment.created': 'comment.created',
  'issues.labeled': 'issue.labeled',
};

/**
 * Routes incoming GitHub webhook events to the EventBus.
 * Maps raw GitHub event names to internal event types and categories,
 * extracts PR context (repo, PR number) from the payload, and
 * publishes structured events for subscriber consumption.
 */
export class EventRouter {
  constructor(private bus: EventBus) {}

  /**
   * Handle an incoming raw GitHub event: map it to an internal type,
   * extract PR context, and publish to the event bus.
   * Errors are logged but not re-thrown to prevent webhook retries.
   */
  async handle(rawEvent: string, payload: unknown): Promise<void> {
    const category = EVENT_CATEGORY_MAP[rawEvent] || 'internal';
    const type = EVENT_TYPE_MAP[rawEvent] || rawEvent;
    const repo =
      typeof payload === 'object' && payload !== null
        ? (payload as { repository?: { full_name?: string } }).repository?.full_name
        : undefined;
    const prNumber = extractPRNumber(payload);

    const event: GitHubEvent = {
      type,
      category,
      payload,
      timestamp: Date.now(),
      repo,
      prNumber,
    };

    try {
      await this.bus.publish(event);
    } catch (err) {
      const logger = new Logger('EventRouter', { eventType: type, repo });
      logger.error(`Failed to publish event ${type}`, err);
    }
  }
}

/**
 * Extract PR number from a webhook payload.
 * Checks pull_request, issue, and top-level number fields.
 */
function extractPRNumber(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.pull_request && typeof p.pull_request === 'object') {
    return (p.pull_request as { number?: number }).number;
  }
  if (p.issue && typeof p.issue === 'object') {
    return (p.issue as { number?: number }).number;
  }
  if (p.number && typeof p.number === 'number') return p.number;
  return undefined;
}
