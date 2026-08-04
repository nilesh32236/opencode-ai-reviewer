import type { LearningFeedback, LearningQuality, RateLimitTier } from '../types/index.js';
import type { CustomRuleRow, FindingRow, PatternRow, ReviewQualityRow } from './rows.js';

export type { CustomRuleRow, FindingRow, PatternRow, ReviewQualityRow };
export type { RateLimitTier };

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

/** Input data for recording a rate-limited action in the learning store. */
export interface RateLimitActionInput {
  /** Repository in owner/repo format. */
  repo: string;
  /** GitHub username of the actor. */
  githubUser: string;
  /** PR (or issue) number the action targeted. */
  prNumber: number;
  /** Command name that was run (e.g. 'review', 'fix', 'conversation'). */
  action: string;
  /** Cost tier of the action ('command' or 'interactive'). */
  tier: RateLimitTier;
  /** Estimated tokens consumed by the action. */
  tokensUsed: number;
}

/** Filter for counting rate-limit action rows. */
export interface RateLimitCountFilter {
  /** Restrict to this repository. */
  repo?: string;
  /** Restrict to this GitHub user. */
  user?: string;
  /** Restrict to this tier. */
  tier?: RateLimitTier;
  /** Only count rows created at or after this epoch millisecond timestamp. */
  sinceMs: number;
}

/** A row from the rate_limits tracking table. */
export interface RateLimitRow {
  id: string;
  repo: string;
  github_user: string;
  pr_number: number;
  action: string;
  tier: string;
  tokens_used: number;
  created_at: string;
}

/** Input data for creating a persisted conversation session (upsert by id). */
export interface ConversationSessionInput {
  /** Deterministic session id (repo/pr/thread anchor) used as the upsert key. */
  id: string;
  /** PR number the session belongs to. */
  prNumber: number;
  /** Repository in owner/repo format. */
  repo: string;
  /** Thread root comment id, for inline review-comment threads. */
  threadRootCommentId?: number;
  /** Whether the session anchors on an inline review comment thread. */
  isReviewComment: boolean;
  /** Number of assistant turns completed (default: 0). */
  turnCount?: number;
  /** Cumulative estimated tokens consumed by the session (default: 0). */
  tokenBudgetUsed?: number;
  /** Last file reference mentioned in the thread. */
  lastFileRef?: string;
  /** Last line reference mentioned in the thread. */
  lastLineRef?: number;
  /** Persisted sliding-window summary snapshot. */
  summarySnapshot?: string;
  /** Number of older messages covered by the summary snapshot. */
  summarizedCount?: number;
  /** Whether the thread has already been auto-closed. */
  alreadyClosed?: boolean;
  /** Epoch millisecond timestamp of the last activity. */
  lastActivityTimestamp?: number;
}

/**
 * Patch applied to an existing conversation session after a turn.
 * Only keys explicitly set are written (matching the JSON backend): `undefined`
 * keeps the stored value, while a non-undefined value — including `null` for the
 * nullable columns — clears it. All backends honor this contract.
 */
export type ConversationSessionPatch = Pick<
  ConversationSessionInput,
  | 'turnCount'
  | 'tokenBudgetUsed'
  | 'lastFileRef'
  | 'lastLineRef'
  | 'summarySnapshot'
  | 'summarizedCount'
  | 'alreadyClosed'
  | 'lastActivityTimestamp'
>;

/** A persisted conversation session row. */
export interface ConversationSessionRow {
  id: string;
  pr_number: number;
  repo: string;
  thread_root_comment_id: number | null;
  is_review_comment: number;
  turn_count: number;
  token_budget_used: number;
  last_file_ref: string | null;
  last_line_ref: number | null;
  summary_snapshot: string | null;
  summarized_count: number | null;
  already_closed: number;
  last_activity_timestamp: number;
  created_at: string;
  updated_at: string;
}

/** Input data for recording a single conversation turn. */
export interface ConversationTurnInput {
  /** Session id the turn belongs to. */
  sessionId: string;
  /** 1-indexed turn number within the session. */
  turnNumber: number;
  /** Message role. */
  role: 'user' | 'assistant';
  /** Message body (markdown). */
  body: string;
  /** Optional file reference mentioned in the message. */
  fileRef?: string;
  /** Optional line reference mentioned in the message. */
  lineRef?: number;
  /** Optional estimated tokens consumed by the turn. */
  tokensUsed?: number;
}

/** A persisted conversation turn row. */
export interface ConversationTurnRow {
  id: string;
  session_id: string;
  turn_number: number;
  role: string;
  body: string;
  file_ref: string | null;
  line_ref: number | null;
  tokens_used: number;
  created_at: string;
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

  /**
   * Retrieve per-PR finding statistics (avg, distribution).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns PerPRStats with total PRs, avg findings, and percentile estimates.
   */
  getPerPRStats(sinceDays?: number): Promise<PerPRStats>;
  /**
   * Retrieve feedback counts grouped by signal_type and signal_value.
   * @param sinceDays - Optional filter to only include feedback from the last N days.
   * @returns FeedbackBreakdown with grouped feedback counts.
   */
  getFeedbackBreakdown(sinceDays?: number): Promise<FeedbackBreakdown>;
  /**
   * Retrieve review latency statistics (time from PR creation to review).
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns LatencyStats with avg, min, max, and median latency.
   */
  getLatencyStats(sinceDays?: number): Promise<LatencyStats>;
  /**
   * Compute and insert a new aggregated metrics row into review_metrics.
   * @param periodType - 'daily' or 'weekly'.
   * @returns Promise that resolves when aggregation is complete.
   */
  aggregateMetrics(periodType: 'daily' | 'weekly'): Promise<void>;
  /**
   * Retrieve pre-computed review metrics rows.
   * @param periodType - 'daily' or 'weekly'.
   * @param limit - Maximum number of rows (default: 10).
   * @returns Array of review_metrics rows.
   */
  getMetrics(periodType: 'daily' | 'weekly', limit?: number): Promise<ReviewMetricsRow[]>;
  /**
   * Get severity distribution of findings.
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns SeverityDistribution with counts per severity level.
   */
  getSeverityDistribution(sinceDays?: number): Promise<SeverityDistribution>;

  /**
   * Record a rate-limited action (slash command, conversation, or reply).
   * The returned ID can be passed to completeRateLimitAction to reconcile the
   * estimated token charge with actual usage after the run finishes.
   * @param input - Rate limit action data including repo, user, PR, tier, and tokens.
   * @returns The generated row ID.
   */
  recordRateLimitAction(input: RateLimitActionInput): Promise<string>;
  /**
   * Reconcile a previously reserved rate-limit row with its actual token usage.
   * Used to close the check-then-run race: a row is reserved at check time and
   * updated here after the run completes (including failed runs, which keep the
   * reserved estimate so they still count toward limits).
   * @param id - Row ID returned by recordRateLimitAction.
   * @param tokensUsed - Actual tokens consumed by the run.
   * @returns Promise that resolves when the row is updated.
   */
  completeRateLimitAction(id: string, tokensUsed: number): Promise<void>;
  /**
   * Count rate-limit action rows matching a filter.
   * @param filter - Filter with optional repo/user/tier and required sinceMs cutoff.
   * @returns The number of matching rows.
   */
  countRateLimitActions(filter: RateLimitCountFilter): Promise<number>;
  /**
   * Sum the tokens_used of all rate-limit rows created at or after sinceMs.
   * @param sinceMs - Only include rows at or after this epoch millisecond timestamp.
   * @returns Total estimated tokens consumed in the window.
   */
  sumRateLimitTokens(sinceMs: number): Promise<number>;
  /**
   * Get the most recent rate-limit action timestamp for a repo, PR, and tier.
   * PR/issue numbers are scoped per repository, so the repo dimension is
   * required to avoid cross-repo cooldown collisions.
   * @param repo - Repository in owner/repo format.
   * @param prNumber - PR number to look up.
   * @param tier - Tier ('command' or 'interactive') to look up.
   * @returns Epoch millisecond timestamp of the last action, or null if none.
   */
  getLastRateLimitTime(repo: string, prNumber: number, tier: string): Promise<number | null>;
  /**
   * Aggregate rate-limit action counts grouped by repository.
   * @param sinceMs - Only include rows at or after this epoch millisecond timestamp.
   * @param limit - Maximum number of results (default: 10).
   * @param tier - Optional tier filter (e.g. 'command' to match hourly enforcement).
   * @returns Array of repo/count pairs ordered by count descending.
   */
  getRateLimitUsageByRepo(
    sinceMs: number,
    limit?: number,
    tier?: string,
  ): Promise<Array<{ repo: string; count: number }>>;
  /**
   * Aggregate rate-limit action counts grouped by GitHub user.
   * @param sinceMs - Only include rows at or after this epoch millisecond timestamp.
   * @param limit - Maximum number of results (default: 10).
   * @returns Array of user/count pairs ordered by count descending.
   */
  getRateLimitUsageByUser(
    sinceMs: number,
    limit?: number,
  ): Promise<Array<{ user: string; count: number }>>;
  /**
   * Delete rate-limit rows for a repo, user, or (with no args) all rows.
   * @param repo - Optional repository to reset.
   * @param user - Optional GitHub user to reset.
   * @returns Number of deleted rows.
   */
  resetRateLimits(repo?: string, user?: string): Promise<number>;
  /**
   * Delete rate-limit rows older than the given timestamp.
   * @param olderThanMs - Rows created before this epoch millisecond timestamp are deleted.
   * @returns Number of deleted rows.
   */
  cleanupRateLimits(olderThanMs: number): Promise<number>;

  /**
   * Create a persisted conversation session when none exists for the id, or
   * return the id of the existing session. Existing rows are never modified.
   * @param input - Session anchor and initial state.
   * @returns The session id (the deterministic `input.id`).
   */
  getOrCreateConversationSession(input: ConversationSessionInput): Promise<string>;
  /**
   * Retrieve a persisted conversation session by id.
   * @param id - Deterministic session id.
   * @returns The session row, or null when no session exists.
   */
  getConversationSession(id: string): Promise<ConversationSessionRow | null>;
  /**
   * Update a persisted conversation session with post-turn state.
   * @param id - Session id to update.
   * @param patch - State fields to write (null-safe merge).
   * @returns Promise that resolves when the session is updated.
   */
  updateConversationSession(id: string, patch: ConversationSessionPatch): Promise<void>;
  /**
   * Record a single conversation turn.
   * @param input - Turn data (session id, turn number, role, body).
   * @returns The generated turn id.
   */
  addConversationTurn(input: ConversationTurnInput): Promise<string>;
  /**
   * Retrieve persisted turns for a session, ordered by turn number.
   * @param sessionId - Session id to load turns for.
   * @param limit - Maximum number of turns to return (default: 100).
   * @returns Array of turn rows.
   */
  getConversationTurns(sessionId: string, limit?: number): Promise<ConversationTurnRow[]>;
  /**
   * Delete conversation sessions idle for longer than the given threshold,
   * along with their turns. Intended to bound storage and PII retention via a
   * periodic/scheduled cleanup job.
   * @param olderThanMs - Sessions with last activity before this epoch
   * millisecond timestamp are deleted.
   * @returns Number of deleted rows (turns + sessions).
   */
  cleanupConversations(olderThanMs: number): Promise<number>;
}

/** Per-PR finding statistics. */
export interface PerPRStats {
  /** Total number of PRs reviewed. */
  totalPrs: number;
  /** Total number of findings across all PRs. */
  totalFindings: number;
  /** Average findings per PR. */
  avgFindingsPerPr: number;
  /** Median (P50) findings per PR. */
  p50FindingsPerPr: number;
  /** P90 findings per PR. */
  p90FindingsPerPr: number;
  /** Maximum findings in a single PR. */
  maxFindingsInPr: number;
}

/** Feedback breakdown by signal type and value. */
export interface FeedbackBreakdown {
  /** Total number of feedback signals. */
  totalFeedback: number;
  /** Number of dismissed feedback signals. */
  dismissedCount: number;
  /** Number of disputed feedback signals. */
  disputedCount: number;
  /** Number of accepted feedback signals. */
  acceptedCount: number;
  /** Feedback count grouped by signal type. */
  bySignalType: Record<string, number>;
}

/** Review latency statistics. */
export interface LatencyStats {
  /** Average review latency in milliseconds. */
  avgLatencyMs: number;
  /** Minimum review latency in milliseconds. */
  minLatencyMs: number;
  /** Maximum review latency in milliseconds. */
  maxLatencyMs: number;
  /** Median review latency in milliseconds. */
  medianLatencyMs: number;
  /** Total number of reviews measured. */
  totalReviews: number;
}

/** A row from the review_metrics summary table. */
export interface ReviewMetricsRow {
  /** Unique identifier for the metrics row. */
  id: string;
  /** Start of the aggregation period. */
  period_start: string;
  /** End of the aggregation period. */
  period_end: string;
  /** Type of period (daily or weekly). */
  period_type: string;
  /** Total PRs reviewed in the period. */
  total_prs: number;
  /** Total findings in the period. */
  total_findings: number;
  /** Average findings per PR. */
  avg_findings_per_pr: number | null;
  /** Total feedback signals received. */
  total_feedback: number;
  /** Number of dismissed feedback signals. */
  dismissed_count: number;
  /** Number of disputed feedback signals. */
  disputed_count: number;
  /** Rate of false positive feedback. */
  false_positive_rate: number | null;
  /** Average review duration in milliseconds. */
  avg_review_duration_ms: number | null;
  /** Total tokens used in the period. */
  total_tokens_used: number | null;
  /** Average tokens per review. */
  avg_tokens_per_review: number | null;
  /** Average actionability score. */
  avg_actionability_score: number | null;
  /** Average accuracy score. */
  avg_accuracy_score: number | null;
  /** Average coverage score. */
  avg_coverage_score: number | null;
  /** Average consistency score. */
  avg_consistency_score: number | null;
  /** Timestamp when the row was created. */
  created_at: string;
}

/** Severity distribution of findings. */
export interface SeverityDistribution {
  /** Count of critical severity findings. */
  critical: number;
  /** Count of important severity findings. */
  important: number;
  /** Count of minor severity findings. */
  minor: number;
  /** Count of unknown severity findings. */
  unknown: number;
}

/** Structured metrics report for display. */
export interface ReviewMetricsReport {
  /** Type of period (daily or weekly). */
  periodType: 'daily' | 'weekly';
  /** Start of the report period. */
  periodStart: string;
  /** End of the report period. */
  periodEnd: string;
  /** Overview statistics. */
  overview: {
    /** Total PRs reviewed. */
    totalPrs: number;
    /** Total findings. */
    totalFindings: number;
    /** Average findings per PR. */
    avgFindingsPerPr: number;
  };
  /** Quality metrics. */
  quality: {
    /** Rate of true positive feedback. */
    truePositiveRate: number;
    /** Rate of false positive feedback. */
    falsePositiveRate: number;
    /** Rate of dismissed feedback. */
    dismissalRate: number;
    /** Overall accuracy score. */
    accuracyScore: number | null;
    /** Overall actionability score. */
    actionabilityScore: number | null;
  };
  /** Performance metrics. */
  performance: {
    /** Average review duration in milliseconds. */
    avgReviewDurationMs: number;
    /** Total tokens used. */
    totalTokensUsed: number;
    /** Average tokens per review. */
    avgTokensPerReview: number;
  };
  /** Optional severity distribution. */
  severityDistribution?: SeverityDistribution;
  /** Optional trends data (pre-computed rows). */
  trends?: ReviewMetricsRow[];
}
