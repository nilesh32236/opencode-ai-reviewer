import * as fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'path';
import type { LearningQuality } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { deriveFileExtensions, generateId } from './schema.js';
import type {
  ConversationSessionInput,
  ConversationSessionPatch,
  ConversationSessionRow,
  ConversationTurnInput,
  ConversationTurnRow,
  FeedbackBreakdown,
  FeedbackInput,
  FindingInput,
  LatencyStats,
  LearningRepository,
  PatternInput,
  PerPRStats,
  RateLimitActionInput,
  RateLimitCountFilter,
  RateLimitRow,
  ReviewMetricsRow,
  SeverityDistribution,
  TelemetryStats,
} from './types.js';

/** Database row for a code review finding. */
export interface FindingRow {
  id: string;
  pr_number: number;
  type: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  duration_ms?: number;
  tokens_used?: number;
  comment_id?: number;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  finding_id: string;
  signal_type: string;
  signal_value?: string;
  pr_number: number;
  created_at: string;
}

/** Database row for review quality metrics. */
export interface ReviewQualityRow {
  id: string;
  pr_number: number;
  actionability_score: number;
  accuracy_score: number;
  coverage_score: number;
  consistency_score: number;
  duration_ms?: number;
  tokens_used?: number;
  created_at: string;
}

/** Database row for a detected pattern. */
export interface PatternRow {
  id: string;
  pattern_key: string;
  message_cluster: string;
  frequency: number;
  file_types?: string;
  first_seen: string;
  last_seen: string;
}

/** Database row for a custom review rule. */
export interface CustomRuleRow {
  id: string;
  rule_text: string;
  source: string;
  status: string;
  approved_at?: string;
}

interface PromptOverrideRow {
  id: string;
  category: string;
  override_text: string;
  false_positive_rate_before?: number;
  created_at: string;
}

interface MetaReviewCounterRow {
  id: number;
  count: number;
}

/**
 * Dismissal signal values that indicate a finding is a genuine false positive
 * and should therefore suppress future flags. `/dismiss out_of_scope` and
 * `/dismiss other` mean the finding is valid but not applicable to this PR —
 * those are recorded for metrics but must not generate 'DO NOT flag' rules.
 * Legacy FeedbackSubscriber dismissal signals (review/comment dismissed or
 * deleted) represent real dismissal actions and remain suppression-worthy.
 */
const SUPPRESSING_DISMISS_SIGNALS = new Set<string>([
  'false_positive',
  'intentional',
  'review_dismissed',
  'comment_dismissed',
  'comment_deleted',
]);

export { SUPPRESSING_DISMISS_SIGNALS };

/**
 * In-memory JSON-backed database implementing the LearningRepository interface.
 * Persists data to disk as JSON. Directly operates on in-memory arrays for all
 * CRUD operations without SQL parsing.
 *
 * Data is written to disk with a debounced save (100ms) and flushed synchronously
 * on process exit.
 */
export class JsonDatabase implements LearningRepository {
  public data: {
    findings: FindingRow[];
    feedback: FeedbackRow[];
    review_quality: ReviewQualityRow[];
    patterns: PatternRow[];
    custom_rules: CustomRuleRow[];
    prompt_overrides: PromptOverrideRow[];
    meta_review_counter: MetaReviewCounterRow[];
    review_metrics?: ReviewMetricsRow[];
    rate_limits: RateLimitRow[];
    conversation_sessions: ConversationSessionRow[];
    conversation_turns: ConversationTurnRow[];
  };
  private filePath: string;
  private inTransaction = false;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   *
   * @param filePath - Path to the JSON file for data persistence.
   */
  constructor(filePath: string) {
    this.filePath = filePath.endsWith('.db') ? filePath.replace(/\.db$/, '.json') : filePath;
    this.data = {
      findings: [],
      feedback: [],
      review_quality: [],
      patterns: [],
      custom_rules: [],
      prompt_overrides: [],
      meta_review_counter: [],
      rate_limits: [],
      conversation_sessions: [],
      conversation_turns: [],
    };
    this.load();
    if (this.data.rate_limits === undefined) {
      this.data.rate_limits = [];
    }
    if (this.data.conversation_sessions === undefined) {
      this.data.conversation_sessions = [];
    }
    if (this.data.conversation_turns === undefined) {
      this.data.conversation_turns = [];
    }
    if (this.data.meta_review_counter.length === 0) {
      this.data.meta_review_counter.push({ id: 1, count: 0 });
      this.save();
    }
    process.on('beforeExit', () => {
      this.flushSync();
    });
  }

  private load() {
    const tmpPath = this.filePath + '.tmp';
    if (fs.existsSync(tmpPath)) {
      try {
        fs.rmSync(tmpPath);
      } catch {
        /* ok */
      }
    }
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(content);
      } catch {
        const logger = new Logger('JsonDatabase');
        logger.warn('Failed to parse JSON database, starting with empty data');
      }
    }
  }

  /** Flush pending writes to disk. */
  public async flush(): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    await this.writeToDisk();
  }

  /** Synchronously flush pending writes to disk. */
  public flushSync(): void {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.data), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      const logger = new Logger('JsonDatabase');
      logger.warn(`Failed to flush JSON database`, err);
    }
  }

  /** Schedule a deferred write to disk. */
  public save() {
    if (this.inTransaction) return;
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
    }
    this.writeTimeout = setTimeout(() => {
      this.writeTimeout = null;
      this.writeToDisk().catch((err) => {
        const logger = new Logger('JsonDatabase');
        logger.warn(`Failed to execute async debounced save`, err);
      });
    }, 100);
  }

  private async writeToDisk() {
    try {
      const dir = path.dirname(this.filePath);
      await fsPromises.mkdir(dir, { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      await fsPromises.writeFile(tmpPath, JSON.stringify(this.data), 'utf-8');
      await fsPromises.rename(tmpPath, this.filePath);
    } catch (err) {
      const logger = new Logger('JsonDatabase');
      logger.warn(`Failed to save JSON database`, err);
    }
  }

  /**
   * Set a pragma on the database (no-op in JSON-backed implementation).
   * @param _sql - SQL pragma statement (ignored).
   */
  pragma(_sql: string): void {}

  /**
   * Execute an SQL statement (no-op in JSON-backed implementation).
   * @param _sql - SQL statement (ignored).
   * @returns A resolved promise.
   */
  exec(_sql: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Execute a function within a transaction with automatic rollback on error.
   * @param fn - The function to execute within the transaction.
   * @returns The wrapped function with transaction support.
   */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const self = this;
    const wrapper: (...args: unknown[]) => unknown = function (this: unknown, ...args: unknown[]) {
      const backup = JSON.stringify(self.data);
      self.inTransaction = true;
      try {
        const res = fn.apply(this, args);
        if (res instanceof Promise) {
          return res
            .then((result) => {
              self.inTransaction = false;
              self.save();
              return result;
            })
            .catch((err) => {
              self.inTransaction = false;
              self.data = JSON.parse(backup);
              self.save();
              throw err;
            });
        }
        self.inTransaction = false;
        self.save();
        return res;
      } catch (err) {
        self.inTransaction = false;
        self.data = JSON.parse(backup);
        self.save();
        throw err;
      }
    };
    return wrapper as T;
  }

  /** Close the database and flush pending writes. */
  async close(): Promise<void> {
    this.flushSync();
  }

  // ─── LearningRepository implementation ───────────────────

  /**
   * Record a single finding.
   * @param finding - The finding input data.
   * @returns The generated or provided finding ID.
   */
  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    this.data.findings.push({
      id,
      pr_number: finding.prNumber,
      type: finding.type,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
      suggestion: finding.suggestion,
      duration_ms: finding.durationMs,
      tokens_used: finding.tokensUsed,
      comment_id: finding.commentId,
      created_at: new Date().toISOString(),
    });
    this.save();
    return id;
  }

  /**
   * Record multiple findings.
   * @param findings - Array of finding input data.
   * @returns Array of generated finding IDs.
   */
  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    if (findings.length === 0) return [];
    const ids = findings.map(() => generateId());
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      this.data.findings.push({
        id: ids[i],
        pr_number: f.prNumber,
        type: f.type,
        severity: f.severity,
        file: f.file,
        line: f.line,
        message: f.message,
        suggestion: f.suggestion,
        duration_ms: f.durationMs,
        tokens_used: f.tokensUsed,
        comment_id: f.commentId,
        created_at: new Date().toISOString(),
      });
    }
    this.save();
    return ids;
  }

  /**
   * Delete all findings and their feedback for a given PR number.
   * @param prNumber - The PR number to delete findings for.
   * @returns The number of deleted findings.
   */
  async deleteFindings(prNumber: number): Promise<number> {
    this.data.feedback = this.data.feedback.filter((f) => f.pr_number !== prNumber);
    const fBefore = this.data.findings.length;
    this.data.findings = this.data.findings.filter((f) => f.pr_number !== prNumber);
    const fChanges = fBefore - this.data.findings.length;
    this.save();
    return fChanges;
  }

  /**
   * Retrieve findings filtered by type.
   * @param type - The finding type to filter by.
   * @param limit - Maximum number of results (default: 50).
   * @returns Array of matching findings.
   */
  async getFindingsByType(type: string, limit = 50): Promise<FindingRow[]> {
    return [...this.data.findings]
      .filter((f) => f.type === type)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  /**
   * Retrieve findings, optionally filtered by PR number.
   * @param prNumber - Optional PR number to filter by.
   * @param limit - Maximum number of results (default: 100).
   * @returns Array of matching findings.
   */
  async getFindings(prNumber?: number, limit = 100): Promise<FindingRow[]> {
    let results = [...this.data.findings].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (prNumber) {
      results = results.filter((f) => f.pr_number === prNumber);
    }
    return results.slice(0, limit);
  }

  /**
   * Record a single feedback entry.
   * @param feedback - The feedback input data.
   */
  async recordFeedback(feedback: FeedbackInput): Promise<void> {
    this.data.feedback.push({
      id: generateId(),
      finding_id: feedback.findingId,
      signal_type: feedback.signalType,
      signal_value: feedback.signalValue,
      pr_number: feedback.prNumber,
      created_at: new Date().toISOString(),
    });
    this.save();
  }

  /**
   * Record multiple feedback entries in a batch.
   * @param feedbacks - Array of feedback input data.
   */
  async recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void> {
    if (feedbacks.length === 0) return;
    for (const fb of feedbacks) {
      this.data.feedback.push({
        id: generateId(),
        finding_id: fb.findingId,
        signal_type: fb.signalType,
        signal_value: fb.signalValue,
        pr_number: fb.prNumber,
        created_at: new Date().toISOString(),
      });
    }
    this.save();
  }

  /**
   * Retrieve recent finding messages.
   * @param limit - Maximum number of messages to return (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of finding messages with optional file paths.
   */
  async getFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    return [...this.data.findings]
      .filter((f) => !cutoff || new Date(f.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((f) => ({ message: f.message, file: f.file }));
  }

  /**
   * Retrieve distinct (deduplicated) finding messages.
   * @param limit - Maximum number of messages to return (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of unique finding messages with optional file paths.
   */
  async getDistinctFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const seen = new Set<string>();
    return [...this.data.findings]
      .filter((f) => !cutoff || new Date(f.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .filter((f) => {
        if (seen.has(f.message)) return false;
        seen.add(f.message);
        return true;
      })
      .slice(0, limit)
      .map((f) => ({ message: f.message, file: f.file }));
  }

  /**
   * Retrieve finding messages filtered by file type extension.
   * @param fileType - The file type extension to filter by (e.g. ".ts").
   * @param limit - Maximum number of messages to return (default: 100).
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns Array of matching finding messages with optional file paths.
   */
  async getFindingMessagesByFileType(
    fileType: string,
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const ext = fileType.startsWith('.') ? fileType : `.${fileType}`;
    return [...this.data.findings]
      .filter((f) => f.file?.endsWith(ext))
      .filter((f) => !cutoff || new Date(f.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((f) => ({ message: f.message, file: f.file }));
  }

  /**
   * Calculate the false positive rate from user feedback.
   * @returns The ratio of dismissed/disputed feedback to total feedback.
   */
  async getFalsePositiveRate(): Promise<number> {
    const total = this.data.feedback.length;
    if (total === 0) return 0;
    const disputed = this.data.feedback.filter((f) =>
      ['dismissed', 'disputed_comment'].includes(f.signal_type),
    ).length;
    return disputed / total;
  }

  /**
   * Retrieve relevant lessons based on the file paths being reviewed.
   * @param filePaths - Array of file paths to derive relevant lessons from.
   * @returns Array of lesson text strings.
   */
  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const extensions = deriveFileExtensions(filePaths);

    const lessons: string[] = [];
    for (const rule of this.data.custom_rules) {
      if (rule.status === 'active') {
        lessons.push(rule.rule_text);
      }
    }
    for (const po of this.data.prompt_overrides) {
      if (po.category === 'general') {
        lessons.push(po.override_text);
      }
    }
    if (extensions.length > 0) {
      for (const po of this.data.prompt_overrides) {
        if (extensions.includes(po.category)) {
          lessons.push(po.override_text);
        }
      }
    }
    return lessons;
  }

  /**
   * Retrieve rules derived from false positive feedback for the given file paths.
   * @param filePaths - Array of file paths to scope the rules to.
   * @param limit - Maximum number of rules to return (default: 20).
   * @returns Array of rule strings describing patterns to avoid flagging.
   */
  async getFalsePositiveRules(filePaths: string[], limit = 20): Promise<string[]> {
    const extensions = deriveFileExtensions(filePaths);

    // Build a set of finding IDs that have dismissal/dispute feedback
    // signalling a genuine false positive (a reason that means the finding is
    // wrong, not merely out of scope).
    const disputedFindingIds = new Set<string>();
    for (const fb of this.data.feedback) {
      if (
        fb.signal_type === 'disputed_comment' ||
        (fb.signal_type === 'dismissed' && SUPPRESSING_DISMISS_SIGNALS.has(fb.signal_value ?? ''))
      ) {
        disputedFindingIds.add(fb.finding_id);
      }
    }

    if (disputedFindingIds.size === 0) return [];

    // Group findings with disputed feedback by message + file
    const grouped = new Map<string, { message: string; file?: string; count: number }>();
    for (const finding of this.data.findings) {
      if (!disputedFindingIds.has(finding.id)) continue;
      if (
        extensions.length > 0 &&
        finding.file &&
        !extensions.some((ext) => finding.file?.endsWith(ext))
      ) {
        continue;
      }
      const key = `${finding.message}::${finding.file || ''}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { message: finding.message, file: finding.file, count: 1 });
      }
    }

    return [...grouped.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((r) => {
        const fileHint = r.file ? ` (in ${r.file.split('/').pop()})` : '';
        return `DO NOT flag: "${r.message.slice(0, 150)}"${fileHint} — user feedback indicates this is intentional (dismissed ${r.count} time(s))`;
      });
  }

  /**
   * Record a review quality score entry.
   * @param quality - The learning quality data to record.
   */
  async recordQuality(quality: LearningQuality): Promise<void> {
    this.data.review_quality.push({
      id: generateId(),
      pr_number: quality.prNumber,
      actionability_score: quality.actionabilityScore,
      accuracy_score: quality.accuracyScore,
      coverage_score: quality.coverageScore,
      consistency_score: quality.consistencyScore,
      duration_ms: quality.durationMs,
      tokens_used: quality.tokensUsed,
      created_at: new Date().toISOString(),
    });
    this.save();
  }

  /**
   * Retrieve recent review quality scores, excluding telemetry-only rows.
   *
   * @param limit - Maximum number of results (default: 20).
   * @returns Array of review_quality rows with at least one non-zero score.
   */
  async getQualityTrends(limit = 20): Promise<ReviewQualityRow[]> {
    return [...this.data.review_quality]
      .filter(
        (r) =>
          r.actionability_score > 0 ||
          r.accuracy_score > 0 ||
          r.coverage_score > 0 ||
          r.consistency_score > 0,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  /**
   * Increment the meta review counter and check if the interval has been reached.
   * @param interval - The interval to check against.
   * @returns True if the counter is a multiple of the interval.
   */
  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (!entry) return false;
    entry.count += 1;
    this.save();
    return entry.count % interval === 0;
  }

  /**
   * Record a single pattern, incrementing frequency if it already exists.
   * @param pattern - The pattern input data.
   */
  async recordPattern(pattern: PatternInput): Promise<void> {
    const existing = this.data.patterns.find((p) => p.pattern_key === pattern.patternKey);
    if (existing) {
      existing.frequency += 1;
      existing.last_seen = new Date().toISOString();
      existing.file_types = pattern.fileTypes.join(',');
    } else {
      this.data.patterns.push({
        id: generateId(),
        pattern_key: pattern.patternKey,
        message_cluster: JSON.stringify(pattern.messageCluster),
        frequency: pattern.frequency,
        file_types: pattern.fileTypes.join(','),
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      });
    }
    this.save();
  }

  /**
   * Record multiple patterns.
   * @param patterns - Array of pattern input data.
   */
  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    if (patterns.length === 0) return;
    for (const pattern of patterns) {
      const existing = this.data.patterns.find((p) => p.pattern_key === pattern.patternKey);
      if (existing) {
        existing.frequency += pattern.frequency;
        existing.last_seen = new Date().toISOString();
        existing.file_types = pattern.fileTypes.join(',');
      } else {
        this.data.patterns.push({
          id: generateId(),
          pattern_key: pattern.patternKey,
          message_cluster: JSON.stringify(pattern.messageCluster),
          frequency: pattern.frequency,
          file_types: pattern.fileTypes.join(','),
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        });
      }
    }
    this.save();
  }

  /**
   * Retrieve patterns with a frequency at or above the minimum threshold.
   * @param minFrequency - Minimum frequency threshold (default: 3).
   * @returns Array of matching patterns sorted by frequency descending.
   */
  async getPatterns(minFrequency = 3): Promise<PatternRow[]> {
    return [...this.data.patterns]
      .filter((p) => p.frequency >= minFrequency)
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Add a custom rule with pending status.
   * @param ruleText - The text/content of the rule.
   * @param source - The source of the rule ('auto' or 'manual').
   * @returns The generated rule ID.
   */
  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    const id = generateId();
    this.data.custom_rules.push({
      id,
      rule_text: ruleText,
      source,
      status: 'pending',
    });
    this.save();
    return id;
  }

  /**
   * Retrieve all custom rules with pending status.
   * @returns Array of pending custom rules.
   */
  async getPendingRules(): Promise<CustomRuleRow[]> {
    return this.data.custom_rules.filter((r) => r.status === 'pending');
  }

  /**
   * Approve a custom rule by setting its status to active.
   * @param ruleId - The ID of the rule to approve.
   */
  async approveRule(ruleId: string): Promise<void> {
    const entry = this.data.custom_rules.find((x) => x.id === ruleId);
    if (entry) {
      entry.status = 'active';
      entry.approved_at = new Date().toISOString();
      this.save();
    }
  }

  /**
   * Decline a custom rule by setting its status to declined.
   * @param ruleId - The ID of the rule to decline.
   */
  async declineRule(ruleId: string): Promise<void> {
    const entry = this.data.custom_rules.find((x) => x.id === ruleId);
    if (entry) {
      entry.status = 'declined';
      this.save();
    }
  }

  /**
   * Add a prompt override entry.
   * @param category - The category for the override.
   * @param overrideText - The override text content.
   * @param fpRateBefore - The false positive rate before this override.
   */
  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    this.data.prompt_overrides.push({
      id: generateId(),
      category,
      override_text: overrideText,
      false_positive_rate_before: fpRateBefore,
      created_at: new Date().toISOString(),
    });
    this.save();
  }

  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  async getTelemetryStats(sinceDays?: number): Promise<TelemetryStats> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const reviews = this.data.review_quality.filter(
      (r) => r.duration_ms != null && (!cutoff || new Date(r.created_at).getTime() >= cutoff),
    );
    if (reviews.length === 0) {
      return { avgDurationMs: 0, totalReviews: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
    }
    const totalDuration = reviews.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
    const totalTokens = reviews.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0);
    return {
      avgDurationMs: Math.round(totalDuration / reviews.length),
      totalReviews: reviews.length,
      totalTokensUsed: totalTokens,
      avgTokensPerReview: Math.round(totalTokens / reviews.length),
    };
  }

  /** Reset the review counter to zero. */
  async resetCounter(): Promise<void> {
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (entry) {
      entry.count = 0;
      this.save();
    }
  }

  /**
   * Retrieve per-PR finding statistics.
   * @param sinceDays - Optional filter.
   * @returns PerPRStats with default values.
   */
  async getPerPRStats(sinceDays?: number): Promise<PerPRStats> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const findings = cutoff
      ? this.data.findings.filter((f) => new Date(f.created_at).getTime() >= cutoff)
      : this.data.findings;

    const prMap = new Map<number, number>();
    for (const f of findings) {
      prMap.set(f.pr_number, (prMap.get(f.pr_number) || 0) + 1);
    }

    if (prMap.size === 0) {
      return {
        totalPrs: 0,
        totalFindings: 0,
        avgFindingsPerPr: 0,
        p50FindingsPerPr: 0,
        p90FindingsPerPr: 0,
        maxFindingsInPr: 0,
      };
    }

    const counts = [...prMap.values()].sort((a, b) => a - b);
    const totalFindings = counts.reduce((sum, c) => sum + c, 0);
    const avg = totalFindings / counts.length;

    return {
      totalPrs: counts.length,
      totalFindings,
      avgFindingsPerPr: Math.round(avg * 100) / 100,
      p50FindingsPerPr:
        counts.length % 2 === 0
          ? Math.round((counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2)
          : counts[Math.floor(counts.length / 2)],
      p90FindingsPerPr: counts[Math.floor(counts.length * 0.9)] ?? 0,
      maxFindingsInPr: counts[counts.length - 1] ?? 0,
    };
  }

  /**
   * Retrieve feedback breakdown.
   * @param sinceDays - Optional filter.
   * @returns FeedbackBreakdown with grouped counts.
   */
  async getFeedbackBreakdown(sinceDays?: number): Promise<FeedbackBreakdown> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const feedbacks = cutoff
      ? this.data.feedback.filter((f) => new Date(f.created_at).getTime() >= cutoff)
      : this.data.feedback;

    let dismissedCount = 0;
    let disputedCount = 0;
    const bySignalType: Record<string, number> = {};

    for (const fb of feedbacks) {
      bySignalType[fb.signal_type] = (bySignalType[fb.signal_type] || 0) + 1;
      if (fb.signal_type === 'dismissed') dismissedCount++;
      if (fb.signal_type === 'disputed_comment') disputedCount++;
    }

    return {
      totalFeedback: feedbacks.length,
      dismissedCount,
      disputedCount,
      acceptedCount: feedbacks.length - dismissedCount - disputedCount,
      bySignalType,
    };
  }

  /**
   * Retrieve latency statistics.
   * @param sinceDays - Optional filter.
   * @returns LatencyStats with default values.
   */
  async getLatencyStats(sinceDays?: number): Promise<LatencyStats> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const reviews = cutoff
      ? this.data.review_quality.filter((r) => new Date(r.created_at).getTime() >= cutoff)
      : this.data.review_quality;

    const durations = reviews
      .map((r) => r.duration_ms)
      .filter((d): d is number => d != null)
      .sort((a, b) => a - b);

    if (durations.length === 0) {
      return {
        avgLatencyMs: 0,
        minLatencyMs: 0,
        maxLatencyMs: 0,
        medianLatencyMs: 0,
        totalReviews: 0,
      };
    }

    return {
      avgLatencyMs: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
      minLatencyMs: durations[0],
      maxLatencyMs: durations[durations.length - 1],
      medianLatencyMs:
        durations.length % 2 === 0
          ? Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2)
          : durations[Math.floor(durations.length / 2)],
      totalReviews: durations.length,
    };
  }

  /**
   * Compute and insert a new aggregated metrics row (stub).
   * @param periodType - 'daily' or 'weekly'.
   */
  async aggregateMetrics(periodType: 'daily' | 'weekly'): Promise<void> {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const periodStart = periodType === 'daily' ? new Date(now - dayMs) : new Date(now - 7 * dayMs);
    const periodEnd = new Date(now);
    const sinceDays = periodType === 'daily' ? 1 : 7;

    const [perPrStats, feedbackBreakdown, latencyStats] = await Promise.all([
      this.getPerPRStats(sinceDays),
      this.getFeedbackBreakdown(sinceDays),
      this.getLatencyStats(sinceDays),
    ]);

    const fpRate =
      feedbackBreakdown.totalFeedback > 0
        ? (feedbackBreakdown.dismissedCount + feedbackBreakdown.disputedCount) /
          feedbackBreakdown.totalFeedback
        : 0;

    const qualityRows = this.data.review_quality.filter((r) => {
      const cutoff = periodStart.getTime();
      return new Date(r.created_at).getTime() >= cutoff;
    });

    // Zero-score rows are telemetry-only (pipeline stages with no quality
    // assessment); exclude them from quality averages like getQualityTrends does.
    const scoredRows = qualityRows.filter(
      (r) =>
        r.actionability_score > 0 ||
        r.accuracy_score > 0 ||
        r.coverage_score > 0 ||
        r.consistency_score > 0,
    );

    let totalTokens = 0;
    let avgActionability: number | null = null;
    let avgAccuracy: number | null = null;
    let avgCoverage: number | null = null;
    let avgConsistency: number | null = null;

    const rowsWithTokens = qualityRows.filter(
      (r): r is typeof r & { tokens_used: number } => typeof r.tokens_used === 'number',
    );

    if (rowsWithTokens.length > 0) {
      totalTokens = rowsWithTokens.reduce((s, r) => s + r.tokens_used, 0);
    }
    if (scoredRows.length > 0) {
      avgActionability =
        scoredRows.reduce((s, r) => s + r.actionability_score, 0) / scoredRows.length;
      avgAccuracy = scoredRows.reduce((s, r) => s + r.accuracy_score, 0) / scoredRows.length;
      avgCoverage = scoredRows.reduce((s, r) => s + r.coverage_score, 0) / scoredRows.length;
      avgConsistency = scoredRows.reduce((s, r) => s + r.consistency_score, 0) / scoredRows.length;
    }

    const row: ReviewMetricsRow = {
      id: generateId(),
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      period_type: periodType,
      total_prs: perPrStats.totalPrs,
      total_findings: perPrStats.totalFindings,
      avg_findings_per_pr: perPrStats.avgFindingsPerPr,
      total_feedback: feedbackBreakdown.totalFeedback,
      dismissed_count: feedbackBreakdown.dismissedCount,
      disputed_count: feedbackBreakdown.disputedCount,
      false_positive_rate: fpRate,
      avg_review_duration_ms: latencyStats.avgLatencyMs,
      total_tokens_used: totalTokens,
      avg_tokens_per_review:
        rowsWithTokens.length > 0 ? Math.round(totalTokens / rowsWithTokens.length) : 0,
      avg_actionability_score: avgActionability,
      avg_accuracy_score: avgAccuracy,
      avg_coverage_score: avgCoverage,
      avg_consistency_score: avgConsistency,
      created_at: new Date().toISOString(),
    };

    this.data.review_metrics = this.data.review_metrics || [];
    this.data.review_metrics.push(row);
    this.save();
  }

  /**
   * Retrieve pre-computed review metrics rows.
   * @param periodType - 'daily' or 'weekly'.
   * @param limit - Maximum number of rows (default: 10).
   * @returns Array of review_metrics rows.
   */
  async getMetrics(periodType: 'daily' | 'weekly', limit = 10): Promise<ReviewMetricsRow[]> {
    const rows = (this.data.review_metrics || []) as ReviewMetricsRow[];
    return rows
      .filter((r) => r.period_type === periodType)
      .sort((a, b) => b.period_start.localeCompare(a.period_start))
      .slice(0, limit);
  }

  /**
   * Get severity distribution of findings.
   * @param sinceDays - Optional filter.
   * @returns SeverityDistribution with counts.
   */
  async getSeverityDistribution(sinceDays?: number): Promise<SeverityDistribution> {
    const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
    const findings = cutoff
      ? this.data.findings.filter((f) => new Date(f.created_at).getTime() >= cutoff)
      : this.data.findings;

    const dist: SeverityDistribution = { critical: 0, important: 0, minor: 0, unknown: 0 };
    for (const f of findings) {
      const sev = (f.severity || 'unknown').toLowerCase();
      if (sev === 'critical') dist.critical++;
      else if (sev === 'important') dist.important++;
      else if (sev === 'minor') dist.minor++;
      else dist.unknown++;
    }
    return dist;
  }

  // ─── Rate limit tracking ─────────────────────────────────

  /**
   * Record a rate-limited action.
   * @param input - Rate limit action data to append.
   * @returns The generated row ID, for later token reconciliation.
   */
  async recordRateLimitAction(input: RateLimitActionInput): Promise<string> {
    const id = generateId();
    this.data.rate_limits.push({
      id,
      repo: input.repo,
      github_user: input.githubUser,
      pr_number: input.prNumber,
      action: input.action,
      tier: input.tier,
      tokens_used: input.tokensUsed,
      created_at: new Date().toISOString(),
    });
    this.save();
    return id;
  }

  /**
   * Reconcile a reserved rate-limit row with its actual token usage.
   * @param id - Row ID returned by recordRateLimitAction.
   * @param tokensUsed - Actual tokens consumed by the run.
   */
  async completeRateLimitAction(id: string, tokensUsed: number): Promise<void> {
    const row = this.data.rate_limits.find((r) => r.id === id);
    if (!row) return;
    row.tokens_used = tokensUsed;
    this.save();
  }

  /**
   * Count rate-limit rows matching a filter.
   * @param filter - Filter with optional repo/user/tier and required sinceMs cutoff.
   * @returns The number of matching rows.
   */
  async countRateLimitActions(filter: RateLimitCountFilter): Promise<number> {
    return this.data.rate_limits.filter((r) => {
      const ts = Date.parse(r.created_at);
      if (Number.isNaN(ts) || ts < filter.sinceMs) return false;
      if (filter.repo && r.repo !== filter.repo) return false;
      if (filter.user && r.github_user !== filter.user) return false;
      if (filter.tier && r.tier !== filter.tier) return false;
      return true;
    }).length;
  }

  /**
   * Sum the tokens_used of all rate-limit rows at or after sinceMs.
   * @param sinceMs - Window cutoff as an epoch millisecond timestamp.
   * @returns Total estimated tokens consumed in the window.
   */
  async sumRateLimitTokens(sinceMs: number): Promise<number> {
    return this.data.rate_limits.reduce((sum, r) => {
      const ts = Date.parse(r.created_at);
      if (!Number.isNaN(ts) && ts >= sinceMs) {
        return sum + (r.tokens_used || 0);
      }
      return sum;
    }, 0);
  }

  /**
   * Get the most recent rate-limit action time for a repo, PR, and tier.
   * PR/issue numbers are scoped per repository, so the repo dimension is
   * required to avoid cross-repo cooldown collisions.
   * @param repo - Repository in owner/repo format.
   * @param prNumber - PR number to look up.
   * @param tier - Tier ('command' or 'interactive').
   * @returns Epoch millisecond timestamp of the last action, or null if none.
   */
  async getLastRateLimitTime(repo: string, prNumber: number, tier: string): Promise<number | null> {
    let last: number | null = null;
    for (const r of this.data.rate_limits) {
      if (r.repo !== repo || r.pr_number !== prNumber || r.tier !== tier) continue;
      const ts = Date.parse(r.created_at);
      if (!Number.isNaN(ts) && (last === null || ts > last)) {
        last = ts;
      }
    }
    return last;
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
    const counts = new Map<string, number>();
    for (const r of this.data.rate_limits) {
      const ts = Date.parse(r.created_at);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      if (tier && r.tier !== tier) continue;
      counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([repo, count]) => ({ repo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
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
    const counts = new Map<string, number>();
    for (const r of this.data.rate_limits) {
      const ts = Date.parse(r.created_at);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      counts.set(r.github_user, (counts.get(r.github_user) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([user, count]) => ({ user, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Delete rate-limit rows for a repo, user, or (with no args) all rows.
   * @param repo - Optional repository to reset.
   * @param user - Optional GitHub user to reset.
   * @returns Number of deleted rows.
   */
  async resetRateLimits(repo?: string, user?: string): Promise<number> {
    const before = this.data.rate_limits.length;
    if (!repo && !user) {
      this.data.rate_limits = [];
    } else {
      this.data.rate_limits = this.data.rate_limits.filter((r) => {
        if (repo && r.repo === repo) return false;
        if (user && r.github_user === user) return false;
        return true;
      });
    }
    this.save();
    return before - this.data.rate_limits.length;
  }

  /**
   * Delete rate-limit rows older than the given timestamp.
   * @param olderThanMs - Rows created before this epoch millisecond timestamp are deleted.
   * @returns Number of deleted rows.
   */
  async cleanupRateLimits(olderThanMs: number): Promise<number> {
    const before = this.data.rate_limits.length;
    this.data.rate_limits = this.data.rate_limits.filter((r) => {
      const ts = Date.parse(r.created_at);
      return Number.isNaN(ts) || ts >= olderThanMs;
    });
    this.save();
    return before - this.data.rate_limits.length;
  }

  // ─── Conversation sessions ──────────────────────────────

  /**
   * Create a persisted conversation session when none exists for the id.
   * Existing rows are left untouched.
   * @param input - Session anchor and initial state.
   * @returns The deterministic session id.
   */
  async getOrCreateConversationSession(input: ConversationSessionInput): Promise<string> {
    const existing = this.data.conversation_sessions.find((s) => s.id === input.id);
    if (!existing) {
      this.data.conversation_sessions.push({
        id: input.id,
        pr_number: input.prNumber,
        repo: input.repo,
        thread_root_comment_id: input.threadRootCommentId ?? null,
        is_review_comment: input.isReviewComment ? 1 : 0,
        turn_count: input.turnCount ?? 0,
        token_budget_used: input.tokenBudgetUsed ?? 0,
        last_file_ref: input.lastFileRef ?? null,
        last_line_ref: input.lastLineRef ?? null,
        summary_snapshot: input.summarySnapshot ?? null,
        summarized_count: input.summarizedCount ?? null,
        already_closed: input.alreadyClosed ? 1 : 0,
        last_activity_timestamp: input.lastActivityTimestamp ?? Date.now(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      this.save();
    }
    return input.id;
  }

  /**
   * Retrieve a persisted conversation session by id.
   * @param id - Deterministic session id.
   * @returns The session row, or null when no session exists.
   */
  async getConversationSession(id: string): Promise<ConversationSessionRow | null> {
    return this.data.conversation_sessions.find((s) => s.id === id) ?? null;
  }

  /**
   * Update a persisted conversation session with post-turn state.
   * @param id - Session id to update.
   * @param patch - State fields to write (null-safe merge).
   */
  async updateConversationSession(id: string, patch: ConversationSessionPatch): Promise<void> {
    const session = this.data.conversation_sessions.find((s) => s.id === id);
    if (!session) return;
    if (patch.turnCount !== undefined) session.turn_count = patch.turnCount;
    if (patch.tokenBudgetUsed !== undefined) session.token_budget_used = patch.tokenBudgetUsed;
    if (patch.lastFileRef !== undefined) session.last_file_ref = patch.lastFileRef;
    if (patch.lastLineRef !== undefined) session.last_line_ref = patch.lastLineRef;
    if (patch.summarySnapshot !== undefined) session.summary_snapshot = patch.summarySnapshot;
    if (patch.summarizedCount !== undefined) session.summarized_count = patch.summarizedCount;
    if (patch.alreadyClosed !== undefined) session.already_closed = patch.alreadyClosed ? 1 : 0;
    if (patch.lastActivityTimestamp !== undefined) {
      session.last_activity_timestamp = patch.lastActivityTimestamp;
    }
    session.updated_at = new Date().toISOString();
    this.save();
  }

  /**
   * Record a single conversation turn.
   * @param input - Turn data (session id, turn number, role, body).
   * @returns The generated turn id.
   */
  async addConversationTurn(input: ConversationTurnInput): Promise<string> {
    const id = generateId();
    this.data.conversation_turns.push({
      id,
      session_id: input.sessionId,
      turn_number: input.turnNumber,
      role: input.role,
      body: input.body,
      file_ref: input.fileRef ?? null,
      line_ref: input.lineRef ?? null,
      tokens_used: input.tokensUsed ?? 0,
      created_at: new Date().toISOString(),
    });
    this.save();
    return id;
  }

  /**
   * Retrieve persisted turns for a session, ordered by turn number.
   * @param sessionId - Session id to load turns for.
   * @param limit - Maximum number of turns to return (default: 100).
   * @returns Array of turn rows.
   */
  async getConversationTurns(sessionId: string, limit = 100): Promise<ConversationTurnRow[]> {
    return this.data.conversation_turns
      .filter((t) => t.session_id === sessionId)
      .sort((a, b) => a.turn_number - b.turn_number)
      .slice(0, limit);
  }
}
