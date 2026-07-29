import * as fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'path';
import type { LearningQuality } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { deriveFileExtensions, generateId } from './schema.js';
import type {
  FeedbackBreakdown,
  FeedbackInput,
  FindingInput,
  LatencyStats,
  LearningRepository,
  PatternInput,
  PerPRStats,
  ReviewMetricsRow,
  SeverityDistribution,
  TelemetryStats,
} from './types.js';

/**
 *
 */
export interface FindingRow {
  /**
   *
   */
  id: string;
  /**
   *
   */
  pr_number: number;
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
  /**
   *
   */
  duration_ms?: number;
  /**
   *
   */
  tokens_used?: number;
  /**
   *
   */
  comment_id?: number;
  /**
   *
   */
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

/**
 *
 */
export interface ReviewQualityRow {
  /**
   *
   */
  id: string;
  /**
   *
   */
  pr_number: number;
  /**
   *
   */
  actionability_score: number;
  /**
   *
   */
  accuracy_score: number;
  /**
   *
   */
  coverage_score: number;
  /**
   *
   */
  consistency_score: number;
  /**
   *
   */
  duration_ms?: number;
  /**
   *
   */
  tokens_used?: number;
  /**
   *
   */
  created_at: string;
}

/**
 *
 */
export interface PatternRow {
  /**
   *
   */
  id: string;
  /**
   *
   */
  pattern_key: string;
  /**
   *
   */
  message_cluster: string;
  /**
   *
   */
  frequency: number;
  /**
   *
   */
  file_types?: string;
  /**
   *
   */
  first_seen: string;
  /**
   *
   */
  last_seen: string;
}

/**
 *
 */
export interface CustomRuleRow {
  /**
   *
   */
  id: string;
  /**
   *
   */
  rule_text: string;
  /**
   *
   */
  source: string;
  /**
   *
   */
  status: string;
  /**
   *
   */
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
 * In-memory JSON-backed database implementing the LearningRepository interface.
 * Persists data to disk as JSON. Directly operates on in-memory arrays for all
 * CRUD operations without SQL parsing.
 *
 * Data is written to disk with a debounced save (100ms) and flushed synchronously
 * on process exit.
 */
export class JsonDatabase implements LearningRepository {
  /**
   *
   */
  public data: {
    findings: FindingRow[];
    feedback: FeedbackRow[];
    review_quality: ReviewQualityRow[];
    patterns: PatternRow[];
    custom_rules: CustomRuleRow[];
    prompt_overrides: PromptOverrideRow[];
    meta_review_counter: MetaReviewCounterRow[];
    review_metrics?: ReviewMetricsRow[];
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
    };
    this.load();
    if (this.data.meta_review_counter.length === 0) {
      this.data.meta_review_counter.push({ id: 1, count: 0 });
      this.save();
    }
    process.on('beforeExit', () => {
      this.flushSync();
    });
  }

  private load() {
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

  /**
   *
   */
  public async flush(): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    await this.writeToDisk();
  }

  /**
   *
   */
  public flushSync(): void {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
    } catch (err) {
      const logger = new Logger('JsonDatabase');
      logger.warn(`Failed to flush JSON database`, err);
    }
  }

  /**
   *
   */
  public save() {
    if (this.inTransaction) return;
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }
    this.flushSync();
  }

  private async writeToDisk() {
    try {
      const dir = path.dirname(this.filePath);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(this.filePath, JSON.stringify(this.data), 'utf-8');
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

  /**
   *
   */
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

    // Build a set of finding IDs that have dismissed/disputed feedback
    const disputedFindingIds = new Set<string>();
    for (const fb of this.data.feedback) {
      if (fb.signal_type === 'dismissed' || fb.signal_type === 'disputed_comment') {
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

  /**
   *
   */
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
      p90FindingsPerPr: counts[Math.floor(counts.length * 0.9)] || 0,
      maxFindingsInPr: counts[counts.length - 1] || 0,
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

    let totalTokens = 0;
    let avgActionability: number | null = null;
    let avgAccuracy: number | null = null;
    let avgCoverage: number | null = null;
    let avgConsistency: number | null = null;

    const rowsWithTokens = qualityRows.filter(
      (r): r is typeof r & { tokens_used: number } => r.tokens_used !== undefined,
    );

    if (qualityRows.length > 0) {
      totalTokens = rowsWithTokens.reduce((s, r) => s + r.tokens_used, 0);
      avgActionability =
        qualityRows.reduce((s, r) => s + r.actionability_score, 0) / qualityRows.length;
      avgAccuracy = qualityRows.reduce((s, r) => s + r.accuracy_score, 0) / qualityRows.length;
      avgCoverage = qualityRows.reduce((s, r) => s + r.coverage_score, 0) / qualityRows.length;
      avgConsistency =
        qualityRows.reduce((s, r) => s + r.consistency_score, 0) / qualityRows.length;
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
}
