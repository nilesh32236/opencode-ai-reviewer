import type { GitHubEvent, Subscriber } from '../types/index.js';
import { LearningStore } from './store.js';

const DISPUTE_KEYWORDS = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];

export class FeedbackSubscriber implements Subscriber {
  name = 'FeedbackSubscriber';
  subscribedEvents = ['review.dismissed', 'review_comment.dismissed', 'comment.created'];

  constructor(private store: LearningStore) {}

  async handle(event: GitHubEvent): Promise<void> {
    switch (event.type) {
      case 'review.dismissed':
        await this.handleReviewDismissed(event);
        break;
      case 'review_comment.dismissed':
        await this.handleReviewCommentDismissed(event);
        break;
      case 'comment.created':
        await this.handleCommentCreated(event);
        break;
    }
  }

  private async handleReviewDismissed(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { review?: { id?: number }; pull_request?: { number?: number } };
    const prNumber = payload?.pull_request?.number || event.prNumber || 0;
    if (!prNumber) return;

    const findings = this.store.getFindings(prNumber);
    for (const finding of findings) {
      this.store.recordFeedback({
        findingId: finding.id as string,
        signalType: 'dismissed',
        signalValue: 'review_dismissed',
        prNumber,
      });
    }
  }

  private async handleReviewCommentDismissed(event: GitHubEvent): Promise<void> {
    const prNumber = event.prNumber || 0;
    if (!prNumber) return;

    this.store.recordFeedback({
      findingId: `review_${event.timestamp}`,
      signalType: 'dismissed',
      signalValue: 'comment_dismissed',
      prNumber,
    });
  }

  private async handleCommentCreated(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { body?: string; issue?: { number?: number } };
    const body = payload?.body || '';
    const prNumber = payload?.issue?.number || event.prNumber || 0;
    if (!prNumber || !body) return;

    const lower = body.toLowerCase();
    const isDispute = DISPUTE_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isDispute) return;

    const findings = this.store.getFindings(prNumber, 5);
    for (const finding of findings) {
      this.store.recordFeedback({
        findingId: finding.id as string,
        signalType: 'disputed_comment',
        signalValue: body.slice(0, 200),
        prNumber,
      });
    }
  }
}
