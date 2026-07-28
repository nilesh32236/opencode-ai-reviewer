import type { LearningFeedback, LearningQuality } from '../types/index.js';
import type { CustomRuleRow, FindingRow, PatternRow, ReviewQualityRow } from './json-db.js';

export type { CustomRuleRow, FindingRow, PatternRow, ReviewQualityRow };

/** Input data for recording a single review finding. */
export interface FindingInput {
  id?: string;
  prNumber: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  durationMs?: number;
  tokensUsed?: number;
  commentId?: number; // GitHub comment ID
}

/** Aggregated telemetry statistics for review executions. */
export interface TelemetryStats {
  avgDurationMs: number;
  totalReviews: number;
  totalTokensUsed: number;
  avgTokensPerReview: number;
}

/** Input data for recording a feedback signal on a finding. */
export interface FeedbackInput {
  findingId: string;
  signalType: LearningFeedback['signalType'];
  signalValue: string;
  prNumber: number;
}

/** Input data for recording a detected pattern. */
export interface PatternInput {
  patternKey: string;
  messageCluster: string[];
  frequency: number;
  fileTypes: string[];
}

/**
 * Repository interface for the learning store.
 * Implementations can back this with SQLite, PostgreSQL, MySQL, or JSON.
 * All methods are async and should handle connection failures gracefully.
 */
export interface LearningRepository {
  /**
   * Close the database connection.
   * @returns Promise that resolves when the connection is closed.
   */
  close(): Promise<void>;
  /**
   * Execute a raw SQL statement.
   * @param sql - SQL statement to execute.
   * @returns Promise that resolves when execution completes.
   */
  exec(sql: string): Promise<void>;

  /**
   * Record a single review finding and return its ID.
   * @param finding - Finding data to record.
   * @returns The generated finding ID.
   */
  recordFinding(finding: FindingInput): Promise<string>;
  /**
   * Record multiple findings and return their IDs.
   * @param findings - Array of finding data to record.
   * @returns Array of generated finding IDs.
   */
  recordFindings(findings: FindingInput[]): Promise<string[]>;
  /**
   * Delete all findings and feedback for a given PR.
   * @param prNumber - PR number to delete data for.
   * @returns Number of deleted finding rows.
   */
  deleteFindings(prNumber: number): Promise<number>;
  /**
   * Retrieve findings filtered by type, ordered by creation date descending.
   * @param type - Finding type to filter by.
   * @param limit - Maximum number of results (default: 50).
   * @returns Array of finding rows.
   */
  getFindingsByType(type: string, limit?: number): Promise<FindingRow[]>;
  /**
   * Retrieve findings, optionally filtered by PR number.
   * @param prNumber - Optional PR number to filter by.
   * @param limit - Maximum number of results (default: 100).
   * @returns Array of finding rows.
   */
  getFindings(prNumber?: number, limit?: number): Promise<FindingRow[]>;
  /**
   * Record a feedback signal for a finding.
   * @param feedback - Feedback data including finding ID and signal type.
   * @returns Promise that resolves when feedback is recorded.
   */
  recordFeedback(feedback: FeedbackInput): Promise<void>;
  /**
   * Record multiple feedback signals in a single transaction.
   * @param feedbacks - Array of feedback data to record.
   * @returns Promise that resolves when all feedback signals are recorded.
   */
  recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void>;
  /**
   * Retrieve recent finding messages for pattern discovery.
   * @param limit - Maximum number of messages (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of objects with message text and optional file path.
   */
  getFindingMessages(
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  /**
   * Retrieve deduplicated finding messages grouped by message text.
   * @param limit - Maximum number of unique messages (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of deduplicated objects with message text and optional file path.
   */
  getDistinctFindingMessages(
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  /**
   * Retrieve finding messages filtered by file extension.
   * @param fileType - File extension to filter by (e.g. '.ts', '.py').
   * @param limit - Maximum number of messages (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of objects with message text and optional file path.
   */
  getFindingMessagesByFileType(
    fileType: string,
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  /**
   * Calculate false-positive rate as ratio of disputed/dismissed feedback.
   * @returns A number between 0 and 1 representing the FP rate.
   */
  getFalsePositiveRate(): Promise<number>;
  /**
   * Query active custom rules and prompt overrides relevant to the given file paths.
   * @param filePaths - File paths to find relevant lessons for.
   * @returns Array of lesson text strings.
   */
  getRelevantLessons(filePaths: string[]): Promise<string[]>;
  /**
   * Retrieve false-positive suppression rules derived from user feedback (dismissed/disputed findings).
   * Returns rules formatted for direct injection into review prompts to prevent re-flagging known false positives.
   *
   * @param filePaths - File paths being reviewed (used for extension-based filtering).
   * @param limit - Maximum number of rules to return (default: 20).
   * @returns Array of rule text strings describing patterns the reviewer should NOT flag.
   */
  getFalsePositiveRules(filePaths: string[], limit?: number): Promise<string[]>;
  /**
   * Record a review quality assessment.
   * @param quality - Quality scores (actionability, accuracy, coverage, consistency).
   * @returns Promise that resolves when the quality assessment is recorded.
   */
  recordQuality(quality: LearningQuality): Promise<void>;
  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  getTelemetryStats(sinceDays?: number): Promise<TelemetryStats>;
  /**
   * Retrieve recent review quality scores, ordered by created_at DESC.
   * @param limit - Maximum number of results (default: 20).
   * @returns Array of review_quality rows.
   */
  getQualityTrends(limit?: number): Promise<ReviewQualityRow[]>;
  /**
   * Increment the meta-review counter and check whether it's time to run a meta-review.
   * @param interval - Trigger meta-review every N reviews.
   * @returns True if a meta-review should be triggered.
   */
  incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean>;
  /**
   * Record or update a pattern (upsert by patternKey).
   * @param pattern - Pattern data including key, message cluster, and frequency.
   * @returns Promise that resolves when the pattern is recorded.
   */
  recordPattern(pattern: PatternInput): Promise<void>;
  /**
   * Record multiple patterns, each upserted by patternKey.
   * @param patterns - Array of pattern data to record.
   * @returns Promise that resolves when all patterns are recorded.
   */
  recordPatterns(patterns: PatternInput[]): Promise<void>;
  /**
   * Retrieve patterns with frequency above a threshold, ordered by frequency descending.
   * @param minFrequency - Minimum frequency threshold (default: 3).
   * @returns Array of pattern rows.
   */
  getPatterns(minFrequency?: number): Promise<PatternRow[]>;
  /**
   * Add a new custom rule as pending approval.
   * @param ruleText - Rule description text.
   * @param source - Origin of the rule ('auto' for discovered, 'manual' for user-defined).
   * @returns The generated rule ID.
   */
  addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string>;
  /**
   * Retrieve all custom rules with status 'pending'.
   * @returns Array of pending rule rows.
   */
  getPendingRules(): Promise<CustomRuleRow[]>;
  /**
   * Approve a pending custom rule, marking it as active.
   * @param ruleId - ID of the rule to approve.
   * @returns Promise that resolves when the rule is approved.
   */
  approveRule(ruleId: string): Promise<void>;
  /**
   * Decline a pending custom rule.
   * @param ruleId - ID of the rule to decline.
   * @returns Promise that resolves when the rule is declined.
   */
  declineRule(ruleId: string): Promise<void>;
  /**
   * Add a prompt override to influence future review prompts.
   * @param category - Override category (e.g. 'general' or a file extension).
   * @param overrideText - Prompt text to inject.
   * @param fpRateBefore - False-positive rate at the time of creation.
   * @returns Promise that resolves when the prompt override is added.
   */
  addPromptOverride(category: string, overrideText: string, fpRateBefore: number): Promise<void>;
  /**
   * Reset the meta-review counter to 0.
   * @returns Promise that resolves when the counter is reset.
   */
  resetCounter(): Promise<void>;
}
