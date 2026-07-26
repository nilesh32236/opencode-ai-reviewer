import type { LearningFeedback, LearningQuality } from '../types/index.js';

/** Input data for recording a single review finding. */
export interface FindingInput {
  /**
   *
   */
  id?: string;
  /**
   *
   */
  prNumber: number;
  /**
   *
   */
  type: string;
  /**
   *
   */
  severity?: string;
  /**
   *
   */
  file?: string;
  /**
   *
   */
  line?: number;
  /**
   *
   */
  message: string;
  /**
   *
   */
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
  /**
   *
   */
  findingId: string;
  /**
   *
   */
  signalType: LearningFeedback['signalType'];
  /**
   *
   */
  signalValue: string;
  /**
   *
   */
  prNumber: number;
}

/** Input data for recording a detected pattern. */
export interface PatternInput {
  /**
   *
   */
  patternKey: string;
  /**
   *
   */
  messageCluster: string[];
  /**
   *
   */
  frequency: number;
  /**
   *
   */
  fileTypes: string[];
}

/**
 * Repository interface for the learning store.
 * Implementations can back this with SQLite, PostgreSQL, MySQL, or JSON.
 * All methods are async and should handle connection failures gracefully.
 */
export interface LearningRepository {
  /**
   *
   */
  close(): Promise<void>;
  /**
   *
   * @param sql
   */
  exec(sql: string): Promise<void>;

  /**
   *
   * @param finding
   */
  recordFinding(finding: FindingInput): Promise<string>;
  /**
   *
   * @param findings
   */
  recordFindings(findings: FindingInput[]): Promise<string[]>;
  /**
   *
   * @param prNumber
   */
  deleteFindings(prNumber: number): Promise<number>;
  /**
   *
   * @param type
   * @param limit
   */
  getFindingsByType(type: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  /**
   *
   * @param prNumber
   * @param limit
   */
  getFindings(prNumber?: number, limit?: number): Promise<Array<Record<string, unknown>>>;
  /**
   *
   * @param feedback
   */
  recordFeedback(feedback: FeedbackInput): Promise<void>;
  /**
   *
   * @param feedbacks
   */
  recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void>;
  /**
   *
   * @param limit
   * @param sinceDays
   */
  getFindingMessages(
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  /**
   *
   * @param limit
   * @param sinceDays
   */
  getDistinctFindingMessages(
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  /**
   *
   * @param fileType
   * @param limit
   * @param sinceDays
   */
  getFindingMessagesByFileType(
    fileType: string,
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  /**
   *
   */
  getFalsePositiveRate(): Promise<number>;
  /**
   *
   * @param filePaths
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
   *
   * @param quality
   */
  recordQuality(quality: LearningQuality): Promise<void>;
  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  getTelemetryStats(sinceDays?: number): Promise<TelemetryStats>;
  getQualityTrends(limit?: number): Promise<Array<Record<string, unknown>>>;
  /**
   *
   * @param interval
   */
  incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean>;
  /**
   *
   * @param pattern
   */
  recordPattern(pattern: PatternInput): Promise<void>;
  /**
   *
   * @param patterns
   */
  recordPatterns(patterns: PatternInput[]): Promise<void>;
  /**
   *
   * @param minFrequency
   */
  getPatterns(minFrequency?: number): Promise<Array<Record<string, unknown>>>;
  /**
   *
   * @param ruleText
   * @param source
   */
  addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string>;
  /**
   *
   */
  getPendingRules(): Promise<Array<Record<string, unknown>>>;
  /**
   *
   * @param ruleId
   */
  approveRule(ruleId: string): Promise<void>;
  /**
   *
   * @param ruleId
   */
  declineRule(ruleId: string): Promise<void>;
  /**
   *
   * @param category
   * @param overrideText
   * @param fpRateBefore
   */
  addPromptOverride(category: string, overrideText: string, fpRateBefore: number): Promise<void>;
  /**
   *
   */
  resetCounter(): Promise<void>;
}
