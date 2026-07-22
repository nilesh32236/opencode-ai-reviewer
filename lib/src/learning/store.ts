import type { LearningFeedback, LearningQuality } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { connectDb, sanitizeDbError } from './db.js';
import { applyMigrations, getDbPath } from './schema.js';
import type { LearningRepository } from './types.js';

/**
 * Persistent storage for review findings, feedback signals, quality metrics,
 * patterns, custom rules, and prompt overrides.
 *
 * Backed by SQLite (preferred), PostgreSQL, MySQL, or a JSON-file fallback.
 * Connection is established lazily on the first operation.
 */
export class LearningStore {
  private repoPromise: Promise<LearningRepository>;

  /**
   * @param dbPathOrUrl - Database path or connection URL.
   *                      Defaults to `DATABASE_URL` env var or `.opencode/learning.db`.
   *                      Retries connection up to 3 times with 1s backoff between attempts.
   */
  constructor(dbPathOrUrl?: string) {
    this.repoPromise = (async () => {
      const target = process.env.DATABASE_URL || dbPathOrUrl || getDbPath();
      const maxRetries = 3;
      let repo: LearningRepository | undefined;
      const errors: string[] = [];
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          repo = await connectDb(target);
          await applyMigrations(repo);
          return repo;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(msg);
          if (repo) {
            try {
              await repo.close();
            } catch {
              /* cleanup best-effort */
            }
            repo = undefined;
          }
          if (attempt === maxRetries) throw err;
          const connLogger = new Logger('LearningStore');
          connLogger.warn(
            `DB connection attempt ${attempt} failed, retrying: ${sanitizeDbError(err)}`,
          );
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      throw new Error('Failed to connect to database after retries: ' + errors.join('; '));
    })();
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    const repo = await this.repoPromise;
    await repo.close();
  }

  /**
   * Record a single review finding.
   *
   * @param finding - Finding data including PR number, type, severity, file, and message.
   * @returns The generated finding ID.
   * @throws If the database operation fails.
   */
  async recordFinding(finding: {
    id?: string;
    prNumber: number;
    type: string;
    severity?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }): Promise<string> {
    const repo = await this.repoPromise;
    return repo.recordFinding(finding);
  }

  /**
   * Record multiple findings in a single transaction.
   *
   * @param findings - Array of finding objects.
   * @returns Array of generated finding IDs.
   * @throws If the database operation fails.
   */
  async recordFindings(
    findings: Array<{
      prNumber: number;
      type: string;
      severity?: string;
      file?: string;
      line?: number;
      message: string;
      suggestion?: string;
    }>,
  ): Promise<string[]> {
    if (findings.length === 0) return [];
    const repo = await this.repoPromise;
    return repo.recordFindings(findings);
  }

  /**
   * Delete all findings and associated feedback for a given PR.
   *
   * @param prNumber - PR number to delete data for.
   * @returns Number of deleted finding rows.
   */
  async deleteFindings(prNumber: number): Promise<number> {
    const repo = await this.repoPromise;
    return repo.deleteFindings(prNumber);
  }

  /**
   * Retrieve findings filtered by type, ordered by creation date descending.
   *
   * @param type - Finding type to filter by.
   * @param limit - Maximum number of results (default: 50).
   * @returns Array of finding rows.
   */
  async getFindingsByType(type: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const repo = await this.repoPromise;
    return repo.getFindingsByType(type, limit);
  }

  /**
   * Retrieve findings, optionally filtered by PR number.
   *
   * @param prNumber - Optional PR number to filter by.
   * @param limit - Maximum number of results (default: 100).
   * @returns Array of finding rows.
   */
  async getFindings(prNumber?: number, limit = 100): Promise<Array<Record<string, unknown>>> {
    const repo = await this.repoPromise;
    return repo.getFindings(prNumber, limit);
  }

  /**
   * Record a single feedback signal for a finding.
   * Errors are logged but not thrown (degraded gracefully).
   *
   * @param feedback - Feedback data including finding ID, signal type, and value.
   */
  async recordFeedback(feedback: {
    findingId: string;
    signalType: LearningFeedback['signalType'];
    signalValue: string;
    prNumber: number;
  }): Promise<void> {
    try {
      const repo = await this.repoPromise;
      await repo.recordFeedback(feedback);
    } catch (err) {
      const logger = new Logger('LearningStore');
      logger.warn('Failed to record feedback', err);
    }
  }

  /**
   * Record multiple feedback signals in a single transaction.
   *
   * @param feedbacks - Array of feedback objects.
   */
  async recordFeedbackBatch(
    feedbacks: Array<{
      findingId: string;
      signalType: LearningFeedback['signalType'];
      signalValue: string;
      prNumber: number;
    }>,
  ): Promise<void> {
    if (feedbacks.length === 0) return;
    const repo = await this.repoPromise;
    await repo.recordFeedbackBatch(feedbacks);
  }

  /**
   * Retrieve recent finding messages (for pattern discovery or display).
   *
   * @param limit - Maximum number of messages (default: 100).
   * @returns Array of objects with message text and optional file path.
   */
  async getFindingMessages(limit = 100): Promise<Array<{ message: string; file?: string }>> {
    const repo = await this.repoPromise;
    return repo.getFindingMessages(limit);
  }

  /**
   * Calculate the false-positive rate as the ratio of disputed/dismissed feedback
   * signals to all feedback signals.
   *
   * @returns A number between 0 and 1 representing the FP rate.
   */
  async getFalsePositiveRate(): Promise<number> {
    const repo = await this.repoPromise;
    return repo.getFalsePositiveRate();
  }

  /**
   * Query active custom rules and prompt overrides relevant to the given file paths.
   * Matches rules by file extension.
   *
   * @param filePaths - File paths to find relevant lessons for.
   * @returns Array of lesson text strings.
   */
  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    try {
      const repo = await this.repoPromise;
      return repo.getRelevantLessons(filePaths);
    } catch {
      return [];
    }
  }

  /**
   * Record a review quality assessment.
   * Errors are logged but not thrown.
   *
   * @param quality - Quality scores (actionability, accuracy, coverage, consistency).
   */
  async recordQuality(quality: LearningQuality): Promise<void> {
    try {
      const repo = await this.repoPromise;
      await repo.recordQuality(quality);
    } catch (err) {
      const logger = new Logger('LearningStore');
      logger.warn('Failed to record quality', err);
    }
  }

  /**
   * Retrieve recent review quality scores.
   *
   * @param limit - Maximum number of results (default: 20).
   * @returns Array of review_quality rows.
   */
  async getQualityTrends(limit = 20): Promise<Array<Record<string, unknown>>> {
    const repo = await this.repoPromise;
    return repo.getQualityTrends(limit);
  }

  /**
   * Increment the meta-review counter and check whether it is time to run a meta-review.
   *
   * @param interval - Trigger meta-review every N reviews.
   * @returns True if a meta-review should be run.
   */
  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    const repo = await this.repoPromise;
    return repo.incrementAndCheckMetaReviewInterval(interval);
  }

  /**
   * Record or update a pattern (upsert by patternKey).
   *
   * @param pattern.patternKey - Unique key identifying the pattern.
   * @param pattern.messageCluster - Example messages matching this pattern.
   * @param pattern.frequency - Observed frequency count.
   * @param pattern.fileTypes - File extensions where the pattern was found.
   */
  async recordPattern(pattern: {
    patternKey: string;
    messageCluster: string[];
    frequency: number;
    fileTypes: string[];
  }): Promise<void> {
    const repo = await this.repoPromise;
    await repo.recordPattern(pattern);
  }

  /**
   * Record multiple patterns, each upserted by patternKey.
   *
   * @param patterns - Array of pattern objects.
   */
  async recordPatterns(
    patterns: Array<{
      patternKey: string;
      messageCluster: string[];
      frequency: number;
      fileTypes: string[];
    }>,
  ): Promise<void> {
    if (patterns.length === 0) return;
    const repo = await this.repoPromise;
    await repo.recordPatterns(patterns);
  }

  /**
   * Retrieve patterns with frequency above a threshold, ordered by frequency descending.
   *
   * @param minFrequency - Minimum frequency threshold (default: 3).
   * @returns Array of pattern rows.
   */
  async getPatterns(minFrequency = 3): Promise<Array<Record<string, unknown>>> {
    const repo = await this.repoPromise;
    return repo.getPatterns(minFrequency);
  }

  /**
   * Add a new custom rule as pending approval.
   *
   * @param ruleText - Rule description text.
   * @param source - Origin of the rule ('auto' for discovered, 'manual' for user-defined).
   * @returns The generated rule ID.
   */
  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    const repo = await this.repoPromise;
    return repo.addCustomRule(ruleText, source);
  }

  /**
   * Retrieve all custom rules with status 'pending'.
   *
   * @returns Array of pending rule rows.
   */
  async getPendingRules(): Promise<Array<Record<string, unknown>>> {
    const repo = await this.repoPromise;
    return repo.getPendingRules();
  }

  /**
   * Approve a pending custom rule, marking it as active.
   *
   * @param ruleId - ID of the rule to approve.
   */
  async approveRule(ruleId: string): Promise<void> {
    const repo = await this.repoPromise;
    await repo.approveRule(ruleId);
  }

  /**
   * Decline a pending custom rule.
   *
   * @param ruleId - ID of the rule to decline.
   */
  async declineRule(ruleId: string): Promise<void> {
    const repo = await this.repoPromise;
    await repo.declineRule(ruleId);
  }

  /**
   * Add a prompt override to influence future review prompts.
   * Errors are logged but not thrown.
   *
   * @param category - Override category (e.g. 'general' or a file extension).
   * @param overrideText - Prompt text to inject.
   * @param fpRateBefore - False-positive rate at the time of creation.
   */
  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    try {
      const repo = await this.repoPromise;
      await repo.addPromptOverride(category, overrideText, fpRateBefore);
    } catch (err) {
      const logger = new Logger('LearningStore');
      logger.warn('Failed to add prompt override', err);
    }
  }

  /**
   * Reset the meta-review counter to 0.
   */
  async resetCounter(): Promise<void> {
    const repo = await this.repoPromise;
    await repo.resetCounter();
  }
}
