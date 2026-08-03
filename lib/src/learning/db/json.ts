import type { LearningQuality } from '../../types/index.js';
import type { JsonDatabase } from '../json-db.js';
import type {
  ConversationSessionInput,
  ConversationSessionPatch,
  ConversationSessionRow,
  ConversationTurnInput,
  ConversationTurnRow,
  CustomRuleRow,
  FeedbackBreakdown,
  FeedbackInput,
  FindingInput,
  FindingRow,
  LatencyStats,
  PatternInput,
  PatternRow,
  PerPRStats,
  RateLimitActionInput,
  RateLimitCountFilter,
  ReviewMetricsRow,
  ReviewQualityRow,
  SeverityDistribution,
  TelemetryStats,
} from '../types.js';
import type { DbAdapter, LearningRepository } from './types.js';

/**
 * JSON file-backed implementation of the LearningRepository and DbAdapter interfaces.
 * Delegates all domain methods to a JsonDatabase instance. Raw SQL operations are
 * not supported and throw an error; callers should use the repository methods instead.
 */
export class JsonDbAdapter implements DbAdapter, LearningRepository {
  private db: JsonDatabase;

  /**
   * Create a new JsonDbAdapter.
   * @param db - JsonDatabase instance.
   */
  constructor(db: JsonDatabase) {
    this.db = db;
  }

  /**
   * Execute a raw SQL statement.
   * @param sql - SQL statement to execute.
   */
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /**
   * Execute a SQL statement and return the number of affected rows.
   * @param _sql - SQL statement (unused).
   * @param _params - Query parameters (unused).
   */
  async run(_sql: string, _params: unknown[] = []): Promise<{ changes: number }> {
    throw new Error(
      'SQL operations are not supported in JSON fallback mode. Use LearningRepository methods instead.',
    );
  }

  /**
   * Execute a SQL query and return all matching rows.
   * @param _sql - SQL statement (unused).
   * @param _params - Query parameters (unused).
   */
  async all<T>(_sql: string, _params: unknown[] = []): Promise<T[]> {
    throw new Error(
      'SQL operations are not supported in JSON fallback mode. Use LearningRepository methods instead.',
    );
  }

  /**
   * Execute a SQL query and return the first matching row.
   * @param _sql - SQL statement (unused).
   * @param _params - Query parameters (unused).
   */
  async get<T>(_sql: string, _params: unknown[] = []): Promise<T | undefined> {
    throw new Error(
      'SQL operations are not supported in JSON fallback mode. Use LearningRepository methods instead.',
    );
  }

  /**
   * Execute operations within a transaction.
   * @param fn - Async function containing transactional operations.
   * @returns The return value of the transaction function.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const txn = this.db.transaction(fn);
    return txn();
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Record a single review finding.
   * @param finding - Finding data to record.
   * @returns The generated finding ID.
   */
  async recordFinding(finding: FindingInput): Promise<string> {
    return this.db.recordFinding(finding);
  }

  /**
   * Record multiple findings in a single transaction.
   * @param findings - Array of finding data to record.
   * @returns Array of generated finding IDs.
   */
  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    return this.db.recordFindings(findings);
  }

  /**
   * Delete all findings and associated feedback for a given PR.
   * @param prNumber - PR number to delete data for.
   * @returns Number of deleted finding rows.
   */
  async deleteFindings(prNumber: number): Promise<number> {
    return this.db.deleteFindings(prNumber);
  }

  /**
   * Retrieve findings filtered by type, ordered by created_at DESC.
   * @param type - Finding type to filter by.
   * @param limit - Maximum number of results (default: 50).
   * @returns Array of finding rows.
   */
  async getFindingsByType(type: string, limit = 50): Promise<FindingRow[]> {
    return this.db.getFindingsByType(type, limit);
  }

  /**
   * Retrieve findings, optionally filtered by PR number.
   * @param prNumber - Optional PR number to filter by.
   * @param limit - Maximum number of results (default: 100).
   * @returns Array of finding rows.
   */
  async getFindings(prNumber?: number, limit = 100): Promise<FindingRow[]> {
    return this.db.getFindings(prNumber, limit);
  }

  /**
   * Record a feedback signal for a finding.
   * @param feedback - Feedback data including finding ID and signal type.
   * @returns A promise that resolves when the feedback is recorded.
   */
  async recordFeedback(feedback: FeedbackInput): Promise<void> {
    return this.db.recordFeedback(feedback);
  }

  /**
   * Record multiple feedback signals in a single transaction.
   * @param feedbacks - Array of feedback data to record.
   * @returns A promise that resolves when the feedbacks are recorded.
   */
  async recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void> {
    return this.db.recordFeedbackBatch(feedbacks);
  }

  /**
   * Retrieve recent finding messages for pattern discovery.
   * @param limit - Maximum number of messages (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of objects with message text and optional file path.
   */
  async getFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    return this.db.getFindingMessages(limit, sinceDays);
  }

  /**
   * Retrieve deduplicated finding messages for O(N^2) clustering.
   * @param limit - Maximum number of results (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of deduplicated objects with message text and optional file path.
   */
  async getDistinctFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    return this.db.getDistinctFindingMessages(limit, sinceDays);
  }

  /**
   * Retrieve finding messages filtered by file extension.
   * @param fileType - File extension filter (e.g. '.ts').
   * @param limit - Maximum number of results (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of objects with message text and optional file path.
   */
  async getFindingMessagesByFileType(
    fileType: string,
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    return this.db.getFindingMessagesByFileType(fileType, limit, sinceDays);
  }

  /**
   * Calculate false-positive rate as ratio of disputed/dismissed feedback
   * signals to all feedback signals.
   * @returns The false-positive rate as a number between 0 and 1.
   */
  async getFalsePositiveRate(): Promise<number> {
    return this.db.getFalsePositiveRate();
  }

  /**
   * Get active custom rules and prompt overrides relevant to the given file paths.
   * @param filePaths - File paths to derive relevant extensions.
   * @returns Array of relevant rule texts and prompt override texts.
   */
  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    return this.db.getRelevantLessons(filePaths);
  }

  /**
   * Get false-positive suppression rules from dismissed/disputed feedback.
   * @param filePaths - File paths to derive relevant extensions.
   * @param limit - Maximum number of suppression rules (default: 20).
   * @returns Array of suppression rule strings.
   */
  async getFalsePositiveRules(filePaths: string[], limit = 20): Promise<string[]> {
    return this.db.getFalsePositiveRules(filePaths, limit);
  }

  /**
   * Record a review quality assessment.
   * @param quality - Quality assessment data to record.
   * @returns A promise that resolves when the quality is recorded.
   */
  async recordQuality(quality: LearningQuality): Promise<void> {
    return this.db.recordQuality(quality);
  }

  /**
   * Retrieve recent review quality scores, ordered by created_at DESC.
   * @param limit - Maximum number of results (default: 20).
   * @returns Array of quality trend records.
   */
  async getQualityTrends(limit = 20): Promise<ReviewQualityRow[]> {
    return this.db.getQualityTrends(limit);
  }

  /**
   * Increment the meta-review counter and check whether it's time to run a meta-review.
   * @param interval - Review interval threshold.
   * @returns True if a meta-review should be triggered.
   */
  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    return this.db.incrementAndCheckMetaReviewInterval(interval);
  }

  /**
   * Record or update a pattern (upsert by patternKey).
   * @param pattern - Pattern data to upsert.
   * @returns A promise that resolves when the pattern is recorded.
   */
  async recordPattern(pattern: PatternInput): Promise<void> {
    return this.db.recordPattern(pattern);
  }

  /**
   * Record multiple patterns, each upserted by patternKey.
   * @param patterns - Array of pattern data to upsert.
   * @returns A promise that resolves when the patterns are recorded.
   */
  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    return this.db.recordPatterns(patterns);
  }

  /**
   * Retrieve patterns with frequency above a threshold, ordered by frequency DESC.
   * @param minFrequency - Minimum frequency threshold (default: 3).
   * @returns Array of pattern records.
   */
  async getPatterns(minFrequency = 3): Promise<PatternRow[]> {
    return this.db.getPatterns(minFrequency);
  }

  /**
   * Add a new custom rule as pending approval.
   * @param ruleText - Rule text content.
   * @param source - Rule source type ('auto' or 'manual').
   * @returns The generated rule ID.
   */
  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    return this.db.addCustomRule(ruleText, source);
  }

  /**
   * Get all custom rules with status 'pending'.
   * @returns Array of pending rule records.
   */
  async getPendingRules(): Promise<CustomRuleRow[]> {
    return this.db.getPendingRules();
  }

  /**
   * Approve a pending custom rule, marking it as active.
   * @param ruleId - Rule ID to approve.
   * @returns A promise that resolves when the rule is approved.
   */
  async approveRule(ruleId: string): Promise<void> {
    return this.db.approveRule(ruleId);
  }

  /**
   * Decline a pending custom rule.
   * @param ruleId - Rule ID to decline.
   * @returns A promise that resolves when the rule is declined.
   */
  async declineRule(ruleId: string): Promise<void> {
    return this.db.declineRule(ruleId);
  }

  /**
   * Add a prompt override to influence future review prompts.
   * @param category - Override category.
   * @param overrideText - Override text content.
   * @param fpRateBefore - False-positive rate before override.
   * @returns A promise that resolves when the override is added.
   */
  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    return this.db.addPromptOverride(category, overrideText, fpRateBefore);
  }

  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  async getTelemetryStats(sinceDays?: number): Promise<TelemetryStats> {
    return this.db.getTelemetryStats(sinceDays);
  }
  /**
   * Reset the meta-review counter to 0.
   * @returns A promise that resolves when the counter is reset.
   */
  async resetCounter(): Promise<void> {
    return this.db.resetCounter();
  }

  /**
   * Retrieve per-PR finding statistics.
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns PerPRStats with default values.
   */
  async getPerPRStats(sinceDays?: number): Promise<PerPRStats> {
    return this.db.getPerPRStats(sinceDays);
  }

  /**
   * Retrieve feedback counts grouped by signal_type and signal_value.
   * @param sinceDays - Optional filter to only include feedback from the last N days.
   * @returns FeedbackBreakdown with default values.
   */
  async getFeedbackBreakdown(sinceDays?: number): Promise<FeedbackBreakdown> {
    return this.db.getFeedbackBreakdown(sinceDays);
  }

  /**
   * Retrieve review latency statistics.
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns LatencyStats with default values.
   */
  async getLatencyStats(sinceDays?: number): Promise<LatencyStats> {
    return this.db.getLatencyStats(sinceDays);
  }

  /**
   * Compute and insert a new aggregated metrics row.
   * @param periodType - 'daily' or 'weekly'.
   * @returns A promise that resolves when the aggregation is complete.
   */
  async aggregateMetrics(periodType: 'daily' | 'weekly'): Promise<void> {
    return this.db.aggregateMetrics(periodType);
  }

  /**
   * Retrieve pre-computed review metrics rows.
   * @param periodType - 'daily' or 'weekly'.
   * @param limit - Maximum number of rows (default: 10).
   * @returns Array of review_metrics rows.
   */
  async getMetrics(periodType: 'daily' | 'weekly', limit = 10): Promise<ReviewMetricsRow[]> {
    return this.db.getMetrics(periodType, limit);
  }

  /**
   * Get severity distribution of findings.
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns SeverityDistribution with default values.
   */
  async getSeverityDistribution(sinceDays?: number): Promise<SeverityDistribution> {
    return this.db.getSeverityDistribution(sinceDays);
  }

  /**
   * Record a rate-limited action.
   * @param input - Rate limit action data to append.
   * @returns The generated row ID, for later token reconciliation.
   */
  async recordRateLimitAction(input: RateLimitActionInput): Promise<string> {
    return this.db.recordRateLimitAction(input);
  }

  /**
   * Reconcile a reserved rate-limit row with its actual token usage.
   * @param id - Row ID returned by recordRateLimitAction.
   * @param tokensUsed - Actual tokens consumed by the run.
   * @returns A promise that resolves when the reconciliation is complete.
   */
  async completeRateLimitAction(id: string, tokensUsed: number): Promise<void> {
    return this.db.completeRateLimitAction(id, tokensUsed);
  }

  /**
   * Count rate-limit rows matching a filter.
   * @param filter - Filter with optional repo/user/tier and required sinceMs cutoff.
   * @returns The number of matching rows.
   */
  async countRateLimitActions(filter: RateLimitCountFilter): Promise<number> {
    return this.db.countRateLimitActions(filter);
  }

  /**
   * Sum the tokens_used of all rate-limit rows at or after sinceMs.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @returns Total estimated tokens consumed in the window.
   */
  async sumRateLimitTokens(sinceMs: number): Promise<number> {
    return this.db.sumRateLimitTokens(sinceMs);
  }

  /**
   * Get the most recent rate-limit action time for a repo, PR, and tier.
   * @param repo - Repository in owner/repo format.
   * @param prNumber - PR number to look up.
   * @param tier - Tier ('command' or 'interactive').
   * @returns Epoch millisecond timestamp of the last action, or null if none.
   */
  async getLastRateLimitTime(repo: string, prNumber: number, tier: string): Promise<number | null> {
    return this.db.getLastRateLimitTime(repo, prNumber, tier);
  }

  /**
   * Aggregate rate-limit counts grouped by repository.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @param limit - Maximum number of results (default: 10).
   * @param tier - Optional tier filter (e.g. 'command' to match hourly enforcement).
   * @returns Array of repo/count pairs ordered by count descending.
   */
  async getRateLimitUsageByRepo(
    sinceMs: number,
    limit = 10,
    tier?: string,
  ): Promise<Array<{ repo: string; count: number }>> {
    return this.db.getRateLimitUsageByRepo(sinceMs, limit, tier);
  }

  /**
   * Aggregate rate-limit counts grouped by GitHub user.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @param limit - Maximum number of results (default: 10).
   * @returns Array of user/count pairs ordered by count descending.
   */
  async getRateLimitUsageByUser(
    sinceMs: number,
    limit = 10,
  ): Promise<Array<{ user: string; count: number }>> {
    return this.db.getRateLimitUsageByUser(sinceMs, limit);
  }

  /**
   * Delete rate-limit rows for a repo, user, or (with no args) all rows.
   * @param repo - Optional repository to reset.
   * @param user - Optional GitHub user to reset.
   * @returns Number of deleted rows.
   */
  async resetRateLimits(repo?: string, user?: string): Promise<number> {
    return this.db.resetRateLimits(repo, user);
  }

  /**
   * Delete rate-limit rows older than the given timestamp.
   * @param olderThanMs - Rows created before this epoch millisecond timestamp are deleted.
   * @returns Number of deleted rows.
   */
  async cleanupRateLimits(olderThanMs: number): Promise<number> {
    return this.db.cleanupRateLimits(olderThanMs);
  }

  /**
   * Create a persisted conversation session when none exists for the id.
   * @param input - Session anchor and initial state.
   * @returns The deterministic session id.
   */
  async getOrCreateConversationSession(input: ConversationSessionInput): Promise<string> {
    return this.db.getOrCreateConversationSession(input);
  }

  /**
   * Retrieve a persisted conversation session by id.
   * @param id - Deterministic session id.
   * @returns The session row, or null when no session exists.
   */
  async getConversationSession(id: string): Promise<ConversationSessionRow | null> {
    return this.db.getConversationSession(id);
  }

  /**
   * Update a persisted conversation session with post-turn state.
   * @param id - Session id to update.
   * @param patch - State fields to write.
   */
  async updateConversationSession(id: string, patch: ConversationSessionPatch): Promise<void> {
    return this.db.updateConversationSession(id, patch);
  }

  /**
   * Record a single conversation turn.
   * @param input - Turn data.
   * @returns The generated turn id.
   */
  async addConversationTurn(input: ConversationTurnInput): Promise<string> {
    return this.db.addConversationTurn(input);
  }

  /**
   * Retrieve persisted turns for a session, ordered by turn number.
   * @param sessionId - Session id to load turns for.
   * @param limit - Maximum number of turns to return.
   * @returns Array of turn rows.
   */
  async getConversationTurns(sessionId: string, limit?: number): Promise<ConversationTurnRow[]> {
    return this.db.getConversationTurns(sessionId, limit);
  }
}
