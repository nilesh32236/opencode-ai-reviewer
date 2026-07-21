import type { LearningStore } from '../learning/store.js';
import type { GitHubEvent, Subscriber } from '../types/index.js';

const APPROVE_RULE_RE = /^\/approve-rule\s+(\S+)/;

export class RuleApprovalSubscriber implements Subscriber {
  name = 'RuleApprovalSubscriber';
  subscribedEvents = ['comment.created', 'review_comment.created'];

  constructor(private store: LearningStore) {}

  async handle(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { comment?: { body?: string } };
    const body = payload?.comment?.body || '';
    if (!body) return;

    const match = body.match(APPROVE_RULE_RE);
    if (!match) return;

    const ruleId = match[1];
    try {
      await this.store.approveRule(ruleId);
    } catch (err) {
      console.error(
        `Failed to approve rule ${ruleId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
