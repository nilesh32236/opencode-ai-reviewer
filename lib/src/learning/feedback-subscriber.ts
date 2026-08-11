import * as core from '@actions/core';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { parseCommand } from '../utils/command-match.js';
import { Logger } from '../utils/logger.js';
import type { LearningStore } from './store.js';
import type { FindingRow } from './types.js';

const DISPUTE_KEYWORDS = ['false positive', 'not an issue', 'wrong', 'incorrect', 'false alarm'];

// Aligned with dismiss.ts (MAX_FINDINGS = 1000): a dispute aimed at an older
// finding on a busy PR (20+ findings) must still be correlatable.
const MAX_FINDINGS = 1000;
const DEBOUNCE_MS = 60_000;

/** Matches `path/to/file.ext:12` or `file.ext:12-30` references in comment text. */
const FILE_LINE_RE = /([A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]{1,10}):(\d+)(?:-(\d+))?/g;

/** A parsed `file:line` reference extracted from a comment body. */
interface FileLineRef {
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * Extract `file:line` references from a comment body.
 * Returns an empty array when the body contains no file references.
 * @param body - The comment body text.
 * @returns Array of parsed file/line references.
 */
function parseFileLineRefs(body: string): FileLineRef[] {
  const refs: FileLineRef[] = [];
  for (const match of body.matchAll(FILE_LINE_RE)) {
    const file = match[1];
    const startLine = Number(match[2]);
    const endLine = match[3] ? Number(match[3]) : startLine;
    if (file && Number.isFinite(startLine) && startLine > 0) {
      refs.push({ file, startLine, endLine: endLine > startLine ? endLine : startLine });
    }
  }
  return refs;
}

/**
 * Determine whether a finding matches a parsed `file:line` reference.
 * A finding matches when its file path matches the reference and its line
 * (when known) falls within the referenced line range.
 * @param finding - The finding to test.
 * @param ref - The parsed file/line reference.
 * @returns True when the finding matches the reference.
 */
function matchesFileLineRef(finding: FindingRow, ref: FileLineRef): boolean {
  if (typeof finding.file !== 'string' || !finding.file) return false;
  const fFile = finding.file.replace(/\\/g, '/');
  const refFile = ref.file.replace(/\\/g, '/');
  const fileMatches =
    fFile === refFile ||
    fFile.endsWith(`/${refFile}`) ||
    refFile.endsWith(`/${fFile}`) ||
    fFile.endsWith(refFile) ||
    refFile.endsWith(fFile);
  if (!fileMatches) return false;
  if (typeof finding.line !== 'number' || finding.line <= 0) return true;
  return finding.line >= ref.startLine && finding.line <= ref.endLine;
}

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

  /**
   *
   * @param store - The learning store instance used to record feedback signals.
   * @param debounceMs - Minimum interval between processing events for the same PR.
   */
  constructor(
    private store: LearningStore,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  private readonly lastProcessedAt = new Map<string, number>();

  /**
   * Route an event to the appropriate handler based on event type.
   * @param event - The GitHub webhook event data.
   * @param signal - Optional abort signal to cancel handling.
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
   * @param event - The GitHub webhook event data for the dismissal.
   */
  private async handleReviewDismissed(event: GitHubEvent): Promise<void> {
    const payload = event.payload as {
      review?: { id?: number };
      pull_request?: { number?: number };
    };
    const prNumber = payload?.pull_request?.number || event.prNumber || 0;
    if (!prNumber) return;

    let findings: FindingRow[];
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
          findingId: f.id,
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
   * @param event - The GitHub webhook event data for the comment dismissal.
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

    let findings: FindingRow[];
    try {
      findings = await this.store.getFindings(prNumber);
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
          findingId: f.id,
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
   * @param event - The GitHub webhook event data for the created comment.
   */
  private async handleCommentCreated(event: GitHubEvent): Promise<void> {
    const payload = event.payload as {
      comment?: {
        body?: string;
        in_reply_to_id?: number | null;
        path?: string;
        line?: number;
        start_line?: number;
        original_line?: number;
        user?: { login?: string; type?: string };
      };
      issue?: { number?: number };
    };
    const body = payload?.comment?.body || '';
    const prNumber = payload?.issue?.number || event.prNumber || 0;
    if (!prNumber || !body) return;

    // Never record dispute feedback for the bot's own replies (conversational
    // replies, dismissal acks). The bot often echoes the user's dispute words
    // ("not an issue", "wrong") when answering, which would otherwise record a
    // disputed signal against its own finding, inflate the false-positive rate,
    // and (after 3 occurrences) generate a suppression rule for a genuine issue.
    const user = payload?.comment?.user;
    const commentUser = user?.login || '';
    const isBot =
      user?.type === 'Bot' ||
      commentUser.endsWith('[bot]') ||
      commentUser.toLowerCase().includes('opencode');
    if (isBot) return;

    // Only process threaded replies to existing comments (bot review comments);
    // ignore top-level comments even when they contain dispute keywords.
    if (!payload?.comment?.in_reply_to_id) return;

    // Slash-command replies (e.g. /dismiss false positive) are handled by their
    // dedicated subscribers — do not let their keywords trigger dispute
    // feedback on top of the command's own recorded feedback.
    if (parseCommand(body)) return;

    const now = Date.now();
    // Debounce per (prNumber, thread) instead of per PR: two different threads
    // disputed within the window are both legitimate signals and must both be
    // recorded; only rapid repeats on the SAME thread are collapsed.
    const inReplyToId = payload.comment?.in_reply_to_id ?? 0;
    const debounceKey = `${prNumber}#${inReplyToId}`;
    const lastProcessed = this.lastProcessedAt.get(debounceKey);
    if (lastProcessed !== undefined && now - lastProcessed < this.debounceMs) return;

    const lower = body.toLowerCase();
    const isDispute = DISPUTE_KEYWORDS.some((kw) => lower.includes(kw));
    if (!isDispute) return;

    let findings: FindingRow[];
    try {
      findings = await this.store.getFindings(prNumber, MAX_FINDINGS);
    } catch (err) {
      const logger = new Logger('FeedbackSubscriber', { prNumber });
      logger.error(`Failed to get findings for pr ${prNumber}`, err);
      return;
    }
    if (findings.length === 0) return;

    const refs = parseFileLineRefs(body);
    if (refs.length === 0 && payload.comment?.path) {
      // Derive a scope from the replied-to review-comment's location. GitHub
      // populates `line` (and `start_line` for multi-line ranges) on thread
      // comments; comments on the file/diff header or on outdated positions
      // may only carry `original_line`. Fall back through those fields. When a
      // positive line is available, scope to that line. Without a positive
      // line we deliberately do NOT expand to the whole file: a file-only
      // scope would mark every finding on that file as disputed, poisoning
      // suppression rules (3 such comments generate rules for every message in
      // the file, scoped repo-wide by extension).
      const commentLine =
        payload.comment.line ?? payload.comment.original_line ?? payload.comment.start_line;
      const lineIsPositive = Number.isInteger(commentLine) && (commentLine as number) > 0;
      if (!lineIsPositive) return;
      refs.push({
        file: payload.comment.path,
        startLine: commentLine as number,
        endLine: commentLine as number,
      });
    }
    if (refs.length === 0) return;
    const validFindings = findings.filter(
      (f) => f.id && typeof f.id === 'string' && refs.some((ref) => matchesFileLineRef(f, ref)),
    );
    if (validFindings.length === 0) return;
    // Record the debounce timestamp only after we have confirmed matching
    // findings for a valid scope. An earlier placement would let unscoped
    // disputes consume the debounce window and silently drop a subsequent
    // scoped dispute that arrived within debounceMs.
    this.lastProcessedAt.set(debounceKey, now);
    try {
      await this.store.recordFeedbackBatch(
        validFindings.map((f) => ({
          findingId: f.id,
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
