import * as core from '@actions/core';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { LearningStore } from './store.js';

const DISPUTE_KEYWORDS = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];

/**
 * Subscribes to review dismissal and comment events to record feedback signals.
 * Maps user actions (dismissals, dispute comments) to feedback entries for
 * false-positive rate calculation and learning.
 */
export class FeedbackSubscriber implements Subscriber {
  name = 'FeedbackSubscriber';
  subscribedEvents = [
    'review.dismissed',
    'review_comment.dismissed',
    'review_comment.deleted',
    'comment.created',
    'review_comment.created',
  ];

  constructor(private store: LearningStore) {}

  /**
   * Route an event to the appropriate handler based on event type.
   */
  async handle(event: GitHubEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    try {
      switch (event.type) {
        case 'review.dismissed':
          await this.handleReviewDismissed(event);
          break;
        case 'review_comment.dismissed':
        case 'review_comment.deleted':
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

  /**
   * Handle a review dismissal event — marks all findings for that PR as dismissed.
   */
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
    const validFindings = findings.filter((f) => f.id && typeof f.id === 'string');
    if (validFindings.length === 0) return;
    try {
      await this.store.recordFeedbackBatch(
        validFindings.map((f) => ({
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

  /**
   * Handle a review comment dismissal or deletion event.
   * Maps the dismissed comment body to the most recent findings for that PR
   * and records a 'dismissed' feedback signal.
   */
  private async handleReviewCommentDismissed(event: GitHubEvent): Promise<void> {
    const payload = event.payload as {
      comment?: {
        body?: string;
        path?: string;
        line?: number;
        original_line?: number;
        user?: { login?: string; type?: string };
      };
      pull_request?: { number?: number };
    };
    const prNumber = payload?.pull_request?.number || event.prNumber || 0;
    if (!prNumber) return;

    // Only process dismissals of bot comments
    const user = payload?.comment?.user;
    const commentUser = user?.login || '';
    const isBot =
      user?.type === 'Bot' ||
      commentUser.endsWith('[bot]') ||
      commentUser.toLowerCase().includes('opencode');

    if (!isBot) {
      return;
    }

    let findings: Array<Record<string, unknown>>;
    try {
      findings = await this.store.getFindings(prNumber, 10);
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.error(`Failed to get findings for pr ${prNumber}`, err);
      return;
    }
    if (findings.length === 0) return;

    const commentPath = payload.comment?.path;
    const commentLine = payload.comment?.line || payload.comment?.original_line;

    // Correlate findings with dismissed comment location metadata
    const matchedFindings = findings.filter((f) => {
      if (!f.id || typeof f.id !== 'string') return false;
      if (commentPath && typeof f.file === 'string' && f.file !== commentPath) {
        return false;
      }
      if (commentLine && typeof f.line === 'number' && f.line !== commentLine) {
        return false;
      }
      return true;
    });

    if (matchedFindings.length === 0) return;

    try {
      await this.store.recordFeedbackBatch(
        matchedFindings.map((f) => ({
          findingId: f.id as string,
          signalType: 'dismissed' as const,
          signalValue:
            event.type === 'review_comment.deleted' ? 'comment_deleted' : 'comment_dismissed',
          prNumber,
        })),
      );
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.warn(`Failed to record feedback for dismissed comment on pr ${prNumber}`, err);
    }
  }

  /**
   * Handle a comment created event — checks for dispute keywords and records feedback.
   */
  private async handleCommentCreated(event: GitHubEvent): Promise<void> {
    const payload = event.payload as { comment?: { body?: string }; issue?: { number?: number } };
    const body = payload?.comment?.body || '';
    const prNumber = payload?.issue?.number || event.prNumber || 0;
    if (!prNumber || !body) return;

    const lower = body.toLowerCase();
    const isDispute = DISPUTE_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isDispute) return;

    let findings: Array<Record<string, unknown>>;
    try {
      findings = await this.store.getFindings(prNumber, 5);
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.error(`Failed to get findings for pr ${prNumber}`, err);
      return;
    }
    if (findings.length === 0) return;
    const validFindings = findings.filter((f) => f.id && typeof f.id === 'string');
    if (validFindings.length === 0) return;
    try {
      await this.store.recordFeedbackBatch(
        validFindings.map((f) => ({
          findingId: f.id as string,
          signalType: 'disputed_comment' as const,
          signalValue: body.slice(0, 200),
          prNumber,
        })),
      );
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.warn(`Failed to record feedback batch for pr ${prNumber}`, err);
    }
  }
}
