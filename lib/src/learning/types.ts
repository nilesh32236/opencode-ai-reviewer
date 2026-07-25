import type { LearningFeedback, LearningQuality } from '../types/index.js';

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
  close(): Promise<void>;
  exec(sql: string): Promise<void>;

  recordFinding(finding: FindingInput): Promise<string>;
  recordFindings(findings: FindingInput[]): Promise<string[]>;
  deleteFindings(prNumber: number): Promise<number>;
  getFindingsByType(type: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  getFindings(prNumber?: number, limit?: number): Promise<Array<Record<string, unknown>>>;
  recordFeedback(feedback: FeedbackInput): Promise<void>;
  recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void>;
  getFindingMessages(
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  getDistinctFindingMessages(
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  getFindingMessagesByFileType(
    fileType: string,
    limit?: number,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>>;
  getFalsePositiveRate(): Promise<number>;
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
  recordQuality(quality: LearningQuality): Promise<void>;
  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  getTelemetryStats(sinceDays?: number): Promise<TelemetryStats>;
  getQualityTrends(limit?: number): Promise<Array<Record<string, unknown>>>;
  incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean>;
  recordPattern(pattern: PatternInput): Promise<void>;
  recordPatterns(patterns: PatternInput[]): Promise<void>;
  getPatterns(minFrequency?: number): Promise<Array<Record<string, unknown>>>;
  addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string>;
  getPendingRules(): Promise<Array<Record<string, unknown>>>;
  approveRule(ruleId: string): Promise<void>;
  declineRule(ruleId: string): Promise<void>;
  addPromptOverride(category: string, overrideText: string, fpRateBefore: number): Promise<void>;
  resetCounter(): Promise<void>;
}
