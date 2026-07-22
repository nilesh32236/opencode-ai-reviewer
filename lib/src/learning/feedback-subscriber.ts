import * as core from '@actions/core';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { LearningStore } from './store.js';

const DISPUTE_KEYWORDS = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];

export class FeedbackSubscriber implements Subscriber {
  name = 'FeedbackSubscriber';
  subscribedEvents = [
    'review.dismissed',
    'review_comment.dismissed',
    'comment.created',
    'review_comment.created',
  ];

  constructor(private store: LearningStore) {}

  async handle(event: GitHubEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'review.dismissed':
          await this.handleReviewDismissed(event);
          break;
        case 'review_comment.dismissed':
          await this.handleReviewCommentDismissed(event);
          break;
        case 'comment.created':
        case 'review_comment.created':
          await this.handleCommentCreated(event);
          break;
      }
    } catch (err) {
      core.warning(
        `FeedbackSubscriber failed for PR #${event.prNumber} (event: ${event.type}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async handleReviewDismissed(event: GitHubEvent): Promise<void> {
    const payload = event.payload as {
      review?: { id?: number };
      pull_request?: { number?: number };
    };
    const prNumber = payload?.pull_request?.number || event.prNumber || 0;
    if (!prNumber) return;

    let findings: Array<Record<string, unknown>>;
    try {
      findings = await this.store.getFindings(prNumber);
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.error(`Failed to get findings for pr ${prNumber}`, err);
      return;
    }
    if (findings.length === 0) return;
    try {
      await this.store.recordFeedbackBatch(
        findings.map((f) => ({
          findingId: f.id as string,
          signalType: 'dismissed' as const,
          signalValue: 'review_dismissed',
          prNumber,
        })),
      );
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.error(`Failed to record feedback batch for pr ${prNumber}`, err);
    }
  }

  private async handleReviewCommentDismissed(_event: GitHubEvent): Promise<void> {
    // No reliable way to map a dismissed comment to a finding without
    // linking review_comment IDs in the findings table
  }

  private async handleCommentCreated(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { comment?: { body?: string }; issue?: { number?: number } };
    const body = payload?.comment?.body || '';
    const prNumber = payload?.issue?.number || event.prNumber || 0;
    if (!prNumber || !body) return;

    const lower = body.toLowerCase();
    const isDispute = DISPUTE_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isDispute) return;

    const findings = await this.store.getFindings(prNumber, 5);
    if (findings.length === 0) return;
    await this.store.recordFeedbackBatch(
      findings.map((f) => ({
        findingId: f.id as string,
        signalType: 'disputed_comment' as const,
        signalValue: body.slice(0, 200),
        prNumber,
      })),
    );
  }
}
