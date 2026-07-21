import type { EventCategory, GitHubEvent } from '../types/index.js';
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

export class EventRouter {
  constructor(private bus: EventBus) {}

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
      console.error(`Failed to publish event ${type}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

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
