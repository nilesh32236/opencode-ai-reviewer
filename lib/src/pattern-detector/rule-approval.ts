import type { GitHubEvent, Subscriber } from '../types/index.js';
import { LearningStore } from '../learning/store.js';

const APPROVE_RULE_RE = /^\/approve-rule\s+(\S+)/;

export class RuleApprovalSubscriber implements Subscriber {
  name = 'RuleApprovalSubscriber';
  subscribedEvents = ['comment.created'];

  constructor(private store: LearningStore) {}

  async handle(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { body?: string };
    const body = payload?.body || '';
    if (!body) return;

    const match = body.match(APPROVE_RULE_RE);
    if (!match) return;

    const ruleId = match[1];
    this.store.approveRule(ruleId);
  }
}
