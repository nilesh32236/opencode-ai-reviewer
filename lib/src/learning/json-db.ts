import * as fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'path';
import type { LearningQuality } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { generateId } from './schema.js';
import type {
  FeedbackInput,
  FindingInput,
  LearningRepository,
  PatternInput,
  TelemetryStats,
} from './types.js';

interface FindingRow {
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

interface ReviewQualityRow {
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

interface PatternRow {
  id: string;
  pattern_key: string;
  message_cluster: string;
  frequency: number;
  file_types?: string;
  first_seen: string;
  last_seen: string;
}

interface CustomRuleRow {
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
  };
  private filePath: string;
  private inTransaction = false;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   *
   * @param filePath
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
    if (this.writeTimeout) clearTimeout(this.writeTimeout);
    this.writeTimeout = setTimeout(() => {
      this.writeTimeout = null;
      this.writeToDisk();
    }, 100);
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
   *
   * @param _sql
   */
  pragma(_sql: string): void {}

  /**
   *
   * @param _sql
   */
  exec(_sql: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   *
   * @param fn
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
   *
   * @param finding
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
   *
   * @param findings
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
    this.flushSync();
    return ids;
  }

  /**
   *
   * @param prNumber
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
   *
   * @param type
   * @param limit
   */
  async getFindingsByType(type: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    return [...this.data.findings]
      .filter((f) => f.type === type)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit) as unknown as Array<Record<string, unknown>>;
  }

  /**
   *
   * @param prNumber
   * @param limit
   */
  async getFindings(prNumber?: number, limit = 100): Promise<Array<Record<string, unknown>>> {
    let results = [...this.data.findings].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (prNumber) {
      results = results.filter((f) => f.pr_number === prNumber);
    }
    return results.slice(0, limit) as unknown as Array<Record<string, unknown>>;
  }

  /**
   *
   * @param feedback
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
   *
   * @param feedbacks
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
   *
   * @param limit
   * @param sinceDays
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
   *
   * @param limit
   * @param sinceDays
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
   *
   * @param fileType
   * @param limit
   * @param sinceDays
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
   *
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
   *
   * @param filePaths
   */
  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const extensions = [
      ...new Set(
        (filePaths || [])
          .filter((f): f is string => typeof f === 'string' && Boolean(f))
          .map((f) => {
            const parts = f.split('.');
            const ext = parts.length > 1 ? parts.pop() : '';
            return ext ? `.${ext}` : '';
          }),
      ),
    ].filter(Boolean);

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
   *
   * @param filePaths
   * @param limit
   */
  async getFalsePositiveRules(filePaths: string[], limit = 20): Promise<string[]> {
    const extensions = [
      ...new Set(
        (filePaths || [])
          .filter((f): f is string => typeof f === 'string' && Boolean(f))
          .map((f) => {
            const parts = f.split('.');
            const ext = parts.length > 1 ? parts.pop() : '';
            return ext ? `.${ext}` : '';
          }),
      ),
    ].filter(Boolean);

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
   *
   * @param quality
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
  async getQualityTrends(limit = 20): Promise<Array<Record<string, unknown>>> {
    return [...this.data.review_quality]
      .filter(
        (r) =>
          r.actionability_score > 0 ||
          r.accuracy_score > 0 ||
          r.coverage_score > 0 ||
          r.consistency_score > 0,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit) as unknown as Array<Record<string, unknown>>;
  }

  /**
   *
   * @param interval
   */
  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (!entry) return false;
    entry.count += 1;
    this.save();
    return entry.count % interval === 0;
  }

  /**
   *
   * @param pattern
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
   *
   * @param patterns
   */
  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    if (patterns.length === 0) return;
    for (const pattern of patterns) {
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
    }
    this.save();
  }

  /**
   *
   * @param minFrequency
   */
  async getPatterns(minFrequency = 3): Promise<Array<Record<string, unknown>>> {
    return [...this.data.patterns]
      .filter((p) => p.frequency >= minFrequency)
      .sort((a, b) => b.frequency - a.frequency) as unknown as Array<Record<string, unknown>>;
  }

  /**
   *
   * @param ruleText
   * @param source
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
   *
   */
  async getPendingRules(): Promise<Array<Record<string, unknown>>> {
    return this.data.custom_rules.filter((r) => r.status === 'pending') as unknown as Array<
      Record<string, unknown>
    >;
  }

  /**
   *
   * @param ruleId
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
   *
   * @param ruleId
   */
  async declineRule(ruleId: string): Promise<void> {
    const entry = this.data.custom_rules.find((x) => x.id === ruleId);
    if (entry) {
      entry.status = 'declined';
      this.save();
    }
  }

  /**
   *
   * @param category
   * @param overrideText
   * @param fpRateBefore
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

  async resetCounter(): Promise<void> {
    const entry = this.data.meta_review_counter.find((x) => x.id === 1);
    if (entry) {
      entry.count = 0;
      this.save();
    }
  }
}
