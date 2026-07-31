import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as path from 'path';
import type { LearningQuality } from '../../types/index.js';
import { Logger } from '../../utils/logger.js';
import { JsonDatabase } from '../json-db.js';
import { deriveFileExtensions, generateId } from '../schema.js';
import type {
  CustomRuleRow,
  FeedbackBreakdown,
  FeedbackInput,
  FindingInput,
  FindingRow,
  LatencyStats,
  PatternInput,
  PatternRow,
  PerPRStats,
  ReviewMetricsRow,
  ReviewQualityRow,
  SeverityDistribution,
  TelemetryStats,
} from '../types.js';
import type {
  DbAdapter,
  LearningRepository,
  MysqlConnection,
  PostgresClient,
  SqliteDatabase,
} from './types.js';

const req = createRequire(__filename);

/**
 * Sanitize connection strings in error messages to avoid leaking credentials.
 * Replaces credentials in URLs with `<redacted>`.
 * @param err - The error object or message to sanitize.
 * @returns The sanitized error message string with credentials redacted.
 */
export function sanitizeDbError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/((?:postgres|mysql|mongodb):\/\/)[^@\s]+@/gi, '$1<redacted>@');
}

/**
 * Translate SQLite query to Postgres/MySQL if needed.
 * Converts positional `?` placeholders to Postgres `$N` style,
 * normalizes datetime functions, and converts INSERT OR REPLACE
 * to INSERT ... ON CONFLICT DO UPDATE for Postgres.
 *
 * @param sql - Original SQLite SQL statement.
 * @param dialect - Target SQL dialect.
 * @returns Translated SQL string.
 */
export function translateQuery(sql: string, dialect: 'postgres' | 'mysql' | 'sqlite'): string {
  let cleanSql = sql.trim().replace(/\s+/g, ' ');
  if (dialect === 'postgres') {
    let index = 1;
    cleanSql = cleanSql.replace(/\?/g, () => `$${index++}`);
    cleanSql = cleanSql.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');
    cleanSql = cleanSql.replace(
      /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/gi,
      (_match, table: string, columnsStr: string) => {
        const cols = columnsStr.split(',').map((c: string) => c.trim());
        const updateSet = cols
          .filter((c: string) => c !== 'id')
          .map((c: string) => `${c} = EXCLUDED.${c}`)
          .join(', ');
        return `INSERT INTO ${table} (${columnsStr}) ON CONFLICT (id) DO UPDATE SET ${updateSet}`;
      },
    );
    if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(cleanSql)) {
      cleanSql = cleanSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
      if (!/ON\s+CONFLICT/i.test(cleanSql)) {
        cleanSql = `${cleanSql.replace(/;?\s*$/, '')} ON CONFLICT DO NOTHING`;
      }
    }
  } else if (dialect === 'mysql') {
    cleanSql = cleanSql.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');
    cleanSql = cleanSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT IGNORE INTO');
    cleanSql = cleanSql.replace(/;\s*$/, '');
    cleanSql = cleanSql.replace(
      /ON CONFLICT\s*\([^)]+\)\s*DO\s+UPDATE\s+SET\s+([\s\S]+?)$/gi,
      (_match, setClause: string) => {
        const convertedSet = setClause.replace(/excluded\.(\w+)/g, 'VALUES($1)');
        return `ON DUPLICATE KEY UPDATE ${convertedSet}`;
      },
    );
  }
  return cleanSql;
}

/**
 * Abstract SQL adapter implementing the LearningRepository interface.
 * Subclasses provide the concrete SQL execution primitives (exec, run, all, get, transaction)
 * while this class implements all the domain logic for findings, feedback, patterns, etc.
 */
export abstract class SqlAdapter implements LearningRepository {
  protected fpRateCache: { rate: number; timestamp: number } | null = null;
  private static readonly FP_RATE_CACHE_TTL = 600_000;

  abstract exec(sql: string): Promise<void>;
  abstract run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  abstract all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  abstract get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  /**
   * Record a single review finding.
   * @param finding - Finding data to record.
   * @returns The generated finding ID.
   */
  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    await this.run(
      `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion, duration_ms, tokens_used, comment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        finding.prNumber,
        finding.type,
        finding.severity ?? null,
        finding.file ?? null,
        finding.line ?? null,
        finding.message,
        finding.suggestion ?? null,
        finding.durationMs ?? null,
        finding.tokensUsed ?? null,
        finding.commentId ?? null,
      ],
    );
    return id;
  }

  /**
   * Record multiple findings in a single transaction.
   * @param findings - Array of finding data to record.
   * @returns Array of generated finding IDs.
   */
  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    if (findings.length === 0) return [];
    return this.transaction(async () => {
      const ids = findings.map(() => generateId());
      const placeholders = findings.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = findings.flatMap((f, i) => [
        ids[i],
        f.prNumber,
        f.type,
        f.severity ?? null,
        f.file ?? null,
        f.line ?? null,
        f.message,
        f.suggestion ?? null,
        f.durationMs ?? null,
        f.tokensUsed ?? null,
        f.commentId ?? null,
      ]);
      await this.run(
        `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion, duration_ms, tokens_used, comment_id) VALUES ${placeholders}`,
        values,
      );
      return ids;
    });
  }

  /**
   * Delete all findings and associated feedback for a given PR.
   * @param prNumber - PR number to delete data for.
   * @returns Number of deleted finding rows.
   */
  async deleteFindings(prNumber: number): Promise<number> {
    return this.transaction(async () => {
      await this.run('DELETE FROM feedback WHERE pr_number = ?', [prNumber]);
      const result = await this.run('DELETE FROM findings WHERE pr_number = ?', [prNumber]);
      return result.changes;
    });
  }

  /**
   * Retrieve findings filtered by type, ordered by created_at DESC.
   * @param type - Finding type to filter by.
   * @param limit - Maximum number of results (default: 50).
   * @returns Array of finding rows.
   */
  async getFindingsByType(type: string, limit = 50): Promise<FindingRow[]> {
    const rows = await this.all(
      'SELECT * FROM findings WHERE type = ? ORDER BY created_at DESC LIMIT ?',
      [type, limit],
    );
    return rows as FindingRow[];
  }

  /**
   * Retrieve findings, optionally filtered by PR number.
   * @param prNumber - Optional PR number to filter by.
   * @param limit - Maximum number of results (default: 100).
   * @returns Array of finding rows.
   */
  async getFindings(prNumber?: number, limit = 100): Promise<FindingRow[]> {
    if (prNumber) {
      const rows = await this.all(
        'SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?',
        [prNumber, limit],
      );
      return rows as FindingRow[];
    }
    const rows = await this.all('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows as FindingRow[];
  }

  /**
   * Record a feedback signal for a finding.
   * @param feedback - Feedback data including finding ID and signal type.
   */
  async recordFeedback(feedback: FeedbackInput): Promise<void> {
    await this.run(
      `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number)
       VALUES (?, ?, ?, ?, ?)`,
      [
        generateId(),
        feedback.findingId,
        feedback.signalType,
        feedback.signalValue,
        feedback.prNumber,
      ],
    );
  }

  /**
   * Record multiple feedback signals in a single transaction.
   * @param feedbacks - Array of feedback data to record.
   */
  async recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void> {
    if (feedbacks.length === 0) return;
    await this.transaction(async () => {
      const placeholders = feedbacks.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const values = feedbacks.flatMap((fb) => [
        generateId(),
        fb.findingId,
        fb.signalType,
        fb.signalValue,
        fb.prNumber,
      ]);
      await this.run(
        `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number) VALUES ${placeholders}`,
        values,
      );
    });
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
    if (sinceDays) {
      return this.all<{ message: string; file: string }>(
        "SELECT message, file FROM findings WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?",
        [`-${sinceDays} days`, limit],
      );
    }
    return this.all<{ message: string; file: string }>(
      'SELECT message, file FROM findings ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
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
    if (sinceDays) {
      return this.all<{ message: string; file: string }>(
        "SELECT message, file FROM findings WHERE created_at >= datetime('now', ?) GROUP BY message ORDER BY MAX(created_at) DESC LIMIT ?",
        [`-${sinceDays} days`, limit],
      );
    }
    return this.all<{ message: string; file: string }>(
      'SELECT message, file FROM findings GROUP BY message ORDER BY MAX(created_at) DESC LIMIT ?',
      [limit],
    );
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
    const filePattern = `%${fileType}`;
    if (sinceDays) {
      return this.all<{ message: string; file: string }>(
        "SELECT message, file FROM findings WHERE file LIKE ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?",
        [filePattern, `-${sinceDays} days`, limit],
      );
    }
    return this.all<{ message: string; file: string }>(
      'SELECT message, file FROM findings WHERE file LIKE ? ORDER BY created_at DESC LIMIT ?',
      [filePattern, limit],
    );
  }

  /**
   * Calculate false-positive rate as ratio of disputed/dismissed feedback
   * signals to all feedback signals.
   * @returns The false-positive rate as a number between 0 and 1.
   */
  async getFalsePositiveRate(): Promise<number> {
    const now = Date.now();
    if (this.fpRateCache && now - this.fpRateCache.timestamp < SqlAdapter.FP_RATE_CACHE_TTL) {
      return this.fpRateCache.rate;
    }
    const row = await this.get<{ total: number; disputed: number }>(
      "SELECT COUNT(*) as total, SUM(CASE WHEN signal_type IN ('dismissed', 'disputed_comment') THEN 1 ELSE 0 END) as disputed FROM feedback",
    );
    if (!row || row.total === 0) return 0;
    const rate = row.disputed / row.total;
    this.fpRateCache = { rate, timestamp: now };
    return rate;
  }

  /**
   * Get active custom rules and prompt overrides relevant to the given file paths.
   * @param filePaths - File paths to derive relevant extensions.
   * @returns Array of relevant rule texts and prompt override texts.
   */
  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const extensions = deriveFileExtensions(filePaths);

    const queries: Promise<unknown[]>[] = [
      this.all<{ rule_text: string }>(
        "SELECT rule_text FROM custom_rules WHERE status = 'active'",
      ).catch(() => []),
      this.all<{ override_text: string }>(
        "SELECT override_text FROM prompt_overrides WHERE category = 'general'",
      ).catch(() => []),
    ];

    if (extensions.length > 0) {
      const placeholders = extensions.map(() => '?').join(',');
      queries.push(
        this.all<{ override_text: string }>(
          `SELECT override_text FROM prompt_overrides WHERE category IN (${placeholders})`,
          extensions,
        ).catch(() => []),
      );
    }

    const results = await Promise.all(queries);
    const lessons: string[] = [];
    for (const result of results) {
      for (const item of result as Array<{ rule_text?: string; override_text?: string }>) {
        lessons.push(item.rule_text || item.override_text || '');
      }
    }
    return lessons.filter(Boolean);
  }

  /**
   * Get false-positive suppression rules from dismissed/disputed feedback.
   * @param filePaths - File paths to derive relevant extensions.
   * @param limit - Maximum number of suppression rules (default: 20).
   * @returns Array of suppression rule strings.
   */
  async getFalsePositiveRules(filePaths: string[], limit = 20): Promise<string[]> {
    const extensions = deriveFileExtensions(filePaths);

    let extFilter = '';
    const params: unknown[] = [limit];
    if (extensions.length > 0) {
      extFilter = `AND (f.file IS NULL OR ${extensions.map(() => `f.file LIKE ?`).join(' OR ')})`;
      params.unshift(...extensions.map((e) => `%${e}`));
    }

    try {
      const rows = await this.all<{ message: string; file: string | null; signal_count: number }>(
        `SELECT f.message, f.file, COUNT(fb.id) as signal_count
         FROM findings f
         INNER JOIN feedback fb ON fb.finding_id = f.id
         WHERE fb.signal_type IN ('dismissed', 'disputed_comment')
         ${extFilter}
         GROUP BY f.message, f.file
         ORDER BY signal_count DESC
         LIMIT ?`,
        params,
      );
      return rows.map((r) => {
        const fileHint = r.file ? ` (in ${r.file.split('/').pop()})` : '';
        return `DO NOT flag: "${r.message.slice(0, 150)}"${fileHint} — user feedback indicates this is intentional (dismissed ${r.signal_count} time(s))`;
      });
    } catch {
      return [];
    }
  }

  /**
   * Record a review quality assessment.
   * @param quality - Quality assessment data to record.
   */
  async recordQuality(quality: LearningQuality): Promise<void> {
    await this.run(
      `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score, duration_ms, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        quality.prNumber,
        quality.actionabilityScore,
        quality.accuracyScore,
        quality.coverageScore,
        quality.consistencyScore,
        quality.durationMs ?? null,
        quality.tokensUsed ?? null,
      ],
    );
  }

  /**
   * Retrieve aggregated telemetry statistics for review executions.
   *
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns TelemetryStats with average duration, total reviews, and token usage.
   */
  async getTelemetryStats(sinceDays?: number): Promise<TelemetryStats> {
    const cutoffDate = sinceDays
      ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
      : null;
    const dateFilter = cutoffDate ? 'AND created_at >= ?' : '';
    const params: unknown[] = cutoffDate ? [cutoffDate] : [];
    const row = await this.get<{
      avg_duration: number | null;
      total_reviews: number;
      total_tokens: number | null;
    }>(
      `SELECT
        AVG(duration_ms) as avg_duration,
        COUNT(*) as total_reviews,
        SUM(tokens_used) as total_tokens
       FROM review_quality
       WHERE duration_ms IS NOT NULL ${dateFilter}`,
      params,
    );
    if (!row || row.total_reviews === 0) {
      return { avgDurationMs: 0, totalReviews: 0, totalTokensUsed: 0, avgTokensPerReview: 0 };
    }
    const avgDuration = row.avg_duration ?? 0;
    const totalTokens = row.total_tokens ?? 0;
    return {
      avgDurationMs: Math.round(avgDuration),
      totalReviews: row.total_reviews,
      totalTokensUsed: totalTokens,
      avgTokensPerReview: row.total_reviews > 0 ? Math.round(totalTokens / row.total_reviews) : 0,
    };
  }

  /**
   * Retrieve recent review quality scores, ordered by created_at DESC.
   * @param limit - Maximum number of results (default: 20).
   * @returns Array of quality trend records.
   */
  async getQualityTrends(limit = 20): Promise<ReviewQualityRow[]> {
    const rows = await this.all(
      'SELECT * FROM review_quality WHERE actionability_score > 0 OR accuracy_score > 0 OR coverage_score > 0 OR consistency_score > 0 ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return rows as ReviewQualityRow[];
  }

  /**
   * Increment the meta-review counter and check whether it's time to run a meta-review.
   * @param interval - Review interval threshold.
   * @returns True if a meta-review should be triggered.
   */
  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    return this.transaction(async () => {
      const row = await this.get<{ count: number }>(
        'SELECT count FROM meta_review_counter WHERE id = 1',
      );
      if (!row) return false;

      const newCount = row.count + 1;
      await this.run('UPDATE meta_review_counter SET count = ? WHERE id = 1', [newCount]);
      return newCount % interval === 0;
    });
  }

  /**
   * Record or update a pattern (upsert by patternKey).
   * @param pattern - Pattern data to upsert.
   */
  async recordPattern(pattern: PatternInput): Promise<void> {
    await this.transaction(async () => {
      const existing = await this.get<{ id: string; frequency: number }>(
        'SELECT id, frequency FROM patterns WHERE pattern_key = ?',
        [pattern.patternKey],
      );

      if (existing) {
        await this.run(
          `UPDATE patterns SET frequency = ?, last_seen = CURRENT_TIMESTAMP, file_types = ? WHERE pattern_key = ?`,
          [existing.frequency + 1, pattern.fileTypes.join(','), pattern.patternKey],
        );
      } else {
        await this.run(
          `INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            generateId(),
            pattern.patternKey,
            JSON.stringify(pattern.messageCluster),
            pattern.frequency,
            pattern.fileTypes.join(','),
          ],
        );
      }
    });
  }

  /**
   * Record multiple patterns, each upserted by patternKey.
   * @param patterns - Array of pattern data to upsert.
   */
  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    if (patterns.length === 0) return;
    const placeholders = patterns
      .map(() => '(?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
      .join(', ');
    const values: unknown[] = [];
    for (const pattern of patterns) {
      values.push(
        generateId(),
        pattern.patternKey,
        JSON.stringify(pattern.messageCluster),
        pattern.frequency,
        pattern.fileTypes.join(','),
      );
    }
    await this.run(
      `INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen)
       VALUES ${placeholders}
       ON CONFLICT (pattern_key) DO UPDATE SET
         frequency = frequency + excluded.frequency,
         last_seen = CURRENT_TIMESTAMP,
         file_types = excluded.file_types`,
      values,
    );
  }

  /**
   * Retrieve patterns with frequency above a threshold, ordered by frequency DESC.
   * @param minFrequency - Minimum frequency threshold (default: 3).
   * @returns Array of pattern records.
   */
  async getPatterns(minFrequency = 3): Promise<PatternRow[]> {
    const rows = await this.all(
      'SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC',
      [minFrequency],
    );
    return rows as PatternRow[];
  }

  /**
   * Add a new custom rule as pending approval.
   * @param ruleText - Rule text content.
   * @param source - Rule source type ('auto' or 'manual').
   * @returns The generated rule ID.
   */
  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    const id = generateId();
    await this.run('INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)', [
      id,
      ruleText,
      source,
      'pending',
    ]);
    return id;
  }

  /**
   * Get all custom rules with status 'pending'.
   * @returns Array of pending rule records.
   */
  async getPendingRules(): Promise<CustomRuleRow[]> {
    const rows = await this.all("SELECT * FROM custom_rules WHERE status = 'pending'");
    return rows as CustomRuleRow[];
  }

  /**
   * Approve a pending custom rule, marking it as active.
   * @param ruleId - Rule ID to approve.
   */
  async approveRule(ruleId: string): Promise<void> {
    await this.run(
      "UPDATE custom_rules SET status = 'active', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
      [ruleId],
    );
  }

  /**
   * Decline a pending custom rule.
   * @param ruleId - Rule ID to decline.
   */
  async declineRule(ruleId: string): Promise<void> {
    await this.run("UPDATE custom_rules SET status = 'declined' WHERE id = ?", [ruleId]);
  }

  /**
   * Add a prompt override to influence future review prompts.
   * @param category - Override category.
   * @param overrideText - Override text content.
   * @param fpRateBefore - False-positive rate before override.
   */
  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    await this.run(
      `INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before)
       VALUES (?, ?, ?, ?)`,
      [generateId(), category, overrideText, fpRateBefore],
    );
  }

  /**
   * Reset the meta-review counter to 0.
   */
  async resetCounter(): Promise<void> {
    await this.run('UPDATE meta_review_counter SET count = 0 WHERE id = 1');
  }

  /**
   * Retrieve per-PR finding statistics.
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns PerPRStats with total PRs, avg findings, and distribution estimates.
   */
  async getPerPRStats(sinceDays?: number): Promise<PerPRStats> {
    const cutoffDate = sinceDays
      ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
      : null;
    const dateFilter = cutoffDate ? 'WHERE created_at >= ?' : '';
    const params: unknown[] = cutoffDate ? [cutoffDate] : [];

    const perPr = await this.all<{ pr_number: number; cnt: number }>(
      `SELECT pr_number, COUNT(*) as cnt FROM findings ${dateFilter} GROUP BY pr_number`,
      params,
    );

    if (perPr.length === 0) {
      return {
        totalPrs: 0,
        totalFindings: 0,
        avgFindingsPerPr: 0,
        p50FindingsPerPr: 0,
        p90FindingsPerPr: 0,
        maxFindingsInPr: 0,
      };
    }

    const counts = perPr.map((r) => r.cnt).sort((a, b) => a - b);
    const totalFindings = counts.reduce((sum, c) => sum + c, 0);
    const avg = totalFindings / counts.length;
    const mid = Math.floor(counts.length / 2);
    const p50 =
      counts.length % 2 === 0 ? Math.round((counts[mid - 1] + counts[mid]) / 2) : counts[mid];
    const p90 = counts[Math.floor(counts.length * 0.9)] ?? 0;

    return {
      totalPrs: counts.length,
      totalFindings,
      avgFindingsPerPr: Math.round(avg * 100) / 100,
      p50FindingsPerPr: p50,
      p90FindingsPerPr: p90,
      maxFindingsInPr: counts[counts.length - 1] ?? 0,
    };
  }

  /**
   * Retrieve feedback counts grouped by signal_type and signal_value.
   * @param sinceDays - Optional filter to only include feedback from the last N days.
   * @returns FeedbackBreakdown with grouped feedback counts.
   */
  async getFeedbackBreakdown(sinceDays?: number): Promise<FeedbackBreakdown> {
    const cutoffDate = sinceDays
      ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
      : null;
    const dateFilter = cutoffDate ? 'WHERE created_at >= ?' : '';
    const params: unknown[] = cutoffDate ? [cutoffDate] : [];

    const rows = await this.all<{ signal_type: string; count: number }>(
      `SELECT signal_type, COUNT(*) as count FROM feedback ${dateFilter} GROUP BY signal_type`,
      params,
    );

    let totalFeedback = 0;
    let dismissedCount = 0;
    let disputedCount = 0;
    const bySignalType: Record<string, number> = {};

    for (const row of rows) {
      bySignalType[row.signal_type] = row.count;
      totalFeedback += row.count;
      if (row.signal_type === 'dismissed') dismissedCount += row.count;
      if (row.signal_type === 'disputed_comment') disputedCount += row.count;
    }

    return {
      totalFeedback,
      dismissedCount,
      disputedCount,
      acceptedCount: totalFeedback - dismissedCount - disputedCount,
      bySignalType,
    };
  }

  /**
   * Retrieve review latency statistics from review_quality timestamps.
   * @param sinceDays - Optional filter to only include reviews from the last N days.
   * @returns LatencyStats with avg, min, max, and median latency.
   */
  async getLatencyStats(sinceDays?: number): Promise<LatencyStats> {
    const cutoffDate = sinceDays
      ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
      : null;
    const dateFilter = cutoffDate ? 'AND created_at >= ?' : '';
    const params: unknown[] = cutoffDate ? [cutoffDate] : [];

    const rows = await this.all<{ duration_ms: number | null }>(
      `SELECT duration_ms FROM review_quality WHERE duration_ms IS NOT NULL ${dateFilter}`,
      params,
    );

    if (rows.length === 0) {
      return {
        avgLatencyMs: 0,
        minLatencyMs: 0,
        maxLatencyMs: 0,
        medianLatencyMs: 0,
        totalReviews: 0,
      };
    }

    const durations = rows.map((r) => r.duration_ms as number).sort((a, b) => a - b);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? Math.round((durations[mid - 1] + durations[mid]) / 2)
        : durations[mid];

    return {
      avgLatencyMs: Math.round(total / durations.length),
      minLatencyMs: durations[0],
      maxLatencyMs: durations[durations.length - 1],
      medianLatencyMs: median,
      totalReviews: durations.length,
    };
  }

  /**
   * Compute and insert a new aggregated metrics row into review_metrics.
   * @param periodType - 'daily' or 'weekly'.
   */
  async aggregateMetrics(periodType: 'daily' | 'weekly'): Promise<void> {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let periodStart: Date;
    let periodEnd: Date;

    if (periodType === 'daily') {
      periodEnd = new Date(now);
      periodStart = new Date(now - dayMs);
    } else {
      periodEnd = new Date(now);
      periodStart = new Date(now - 7 * dayMs);
    }

    const startStr = periodStart.toISOString();
    const endStr = periodEnd.toISOString();
    const cutoffStr = periodStart.toISOString().replace('T', ' ').slice(0, 19);

    const perPRStats = await this.getPerPRStats(periodType === 'daily' ? 1 : 7);
    const feedbackBreakdown = await this.getFeedbackBreakdown(periodType === 'daily' ? 1 : 7);
    const latencyStats = await this.getLatencyStats(periodType === 'daily' ? 1 : 7);

    const fpRate =
      feedbackBreakdown.totalFeedback > 0
        ? (feedbackBreakdown.dismissedCount + feedbackBreakdown.disputedCount) /
          feedbackBreakdown.totalFeedback
        : 0;

    const qualityRow = await this.get<{
      avg_actionability: number | null;
      avg_accuracy: number | null;
      avg_coverage: number | null;
      avg_consistency: number | null;
      avg_tokens: number | null;
      total_tokens: number | null;
    }>(
      `SELECT
        AVG(actionability_score) as avg_actionability,
        AVG(accuracy_score) as avg_accuracy,
        AVG(coverage_score) as avg_coverage,
        AVG(consistency_score) as avg_consistency,
        AVG(tokens_used) as avg_tokens,
        SUM(tokens_used) as total_tokens
       FROM review_quality
       WHERE created_at >= ?`,
      [cutoffStr],
    );

    const id = generateId();

    await this.run(
      `INSERT INTO review_metrics
       (id, period_start, period_end, period_type,
        total_prs, total_findings, avg_findings_per_pr,
        total_feedback, dismissed_count, disputed_count, false_positive_rate,
        avg_review_duration_ms, total_tokens_used, avg_tokens_per_review,
        avg_actionability_score, avg_accuracy_score, avg_coverage_score, avg_consistency_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        startStr,
        endStr,
        periodType,
        perPRStats.totalPrs,
        perPRStats.totalFindings,
        perPRStats.avgFindingsPerPr,
        feedbackBreakdown.totalFeedback,
        feedbackBreakdown.dismissedCount,
        feedbackBreakdown.disputedCount,
        fpRate,
        latencyStats.avgLatencyMs,
        qualityRow?.total_tokens ?? 0,
        qualityRow?.avg_tokens ? Math.round(qualityRow.avg_tokens) : 0,
        qualityRow?.avg_actionability ?? null,
        qualityRow?.avg_accuracy ?? null,
        qualityRow?.avg_coverage ?? null,
        qualityRow?.avg_consistency ?? null,
      ],
    );
  }

  /**
   * Retrieve pre-computed review metrics rows.
   * @param periodType - 'daily' or 'weekly'.
   * @param limit - Maximum number of rows (default: 10).
   * @returns Array of review_metrics rows.
   */
  async getMetrics(periodType: 'daily' | 'weekly', limit = 10): Promise<ReviewMetricsRow[]> {
    const rows = await this.all(
      'SELECT * FROM review_metrics WHERE period_type = ? ORDER BY period_start DESC LIMIT ?',
      [periodType, limit],
    );
    return rows as ReviewMetricsRow[];
  }

  /**
   * Get severity distribution of findings.
   * @param sinceDays - Optional filter to only include findings from the last N days.
   * @returns SeverityDistribution with counts per severity level.
   */
  async getSeverityDistribution(sinceDays?: number): Promise<SeverityDistribution> {
    const cutoffDate = sinceDays
      ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
      : null;
    const dateFilter = cutoffDate ? 'WHERE created_at >= ?' : '';
    const params: unknown[] = cutoffDate ? [cutoffDate] : [];

    const rows = await this.all<{ severity: string | null; cnt: number }>(
      `SELECT severity, COUNT(*) as cnt FROM findings ${dateFilter} GROUP BY severity`,
      params,
    );

    const dist: SeverityDistribution = { critical: 0, important: 0, minor: 0, unknown: 0 };
    for (const row of rows) {
      const sev = (row.severity || 'unknown').toLowerCase();
      if (sev === 'critical') dist.critical = row.cnt;
      else if (sev === 'important') dist.important = row.cnt;
      else if (sev === 'minor') dist.minor = row.cnt;
      else dist.unknown += row.cnt;
    }
    return dist;
  }
}

/**
 * Connect to a database by URL/connection string.
 * Supports PostgreSQL (pg), MySQL (mysql2), SQLite (better-sqlite3),
 * and falls back to a JSON file database if no SQL driver is available.
 * The connection string prefix determines the driver:
 * - `postgres://` or `postgresql://` → PostgreSQL
 * - `mysql://` → MySQL
 * - Anything else → SQLite (then JSON fallback)
 * @param dbPathOrUrl - Database connection string or file path.
 * @returns A connected database adapter implementing both LearningRepository and DbAdapter.
 */
export async function connectDb(dbPathOrUrl: string): Promise<LearningRepository & DbAdapter> {
  if (dbPathOrUrl.startsWith('postgres://') || dbPathOrUrl.startsWith('postgresql://')) {
    try {
      const { Client } = req('pg') as {
        Client: new (config: { connectionString: string }) => PostgresClient;
      };
      const client = new Client({ connectionString: dbPathOrUrl });
      await client.connect();
      const { PostgresAdapter } = await import('./postgres.js');
      return new PostgresAdapter(client);
    } catch (e) {
      throw new Error(`Failed to connect to PostgreSQL: ${sanitizeDbError(e)}`);
    }
  }

  if (dbPathOrUrl.startsWith('mysql://')) {
    try {
      const mysql = req('mysql2/promise') as {
        createConnection: (url: string) => Promise<MysqlConnection>;
      };
      const connection = await mysql.createConnection(dbPathOrUrl);
      const { MysqlAdapter } = await import('./mysql.js');
      return new MysqlAdapter(connection);
    } catch (e) {
      throw new Error(`Failed to connect to MySQL: ${sanitizeDbError(e)}`);
    }
  }

  // Fallback to SQLite or JSON
  try {
    const Database = req('better-sqlite3') as new (path: string) => SqliteDatabase;
    const dir = path.dirname(dbPathOrUrl);
    if (dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new Database(dbPathOrUrl);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const { SqliteAdapter } = await import('./sqlite.js');
    return new SqliteAdapter(db);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const isMissingDriver =
      errMsg.includes('Cannot find module') ||
      errMsg.includes('Module not found') ||
      errMsg.includes('Could not locate the bindings file') ||
      errMsg.includes('Cannot locate the bindings file') ||
      errMsg.includes('ERR_REQUIRE_ESM');
    if (!isMissingDriver) {
      throw e;
    }
    const logger = new Logger('LearningStore');
    logger.warn(
      `better-sqlite3 not available: ${sanitizeDbError(e)}. Falling back to JSON database`,
    );
    const jsonPath = dbPathOrUrl.endsWith('.db')
      ? dbPathOrUrl.replace(/\.db$/, '.json')
      : dbPathOrUrl;
    const jsonDb = new JsonDatabase(jsonPath);
    const { JsonDbAdapter } = await import('./json.js');
    return new JsonDbAdapter(jsonDb);
  }
}
