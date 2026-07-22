import * as fs from 'fs';
import * as path from 'path';
import type { LearningFeedback, LearningQuality } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { JsonDatabase } from './json-db.js';
import { generateId } from './schema.js';
import type { FeedbackInput, FindingInput, LearningRepository, PatternInput } from './types.js';

export function sanitizeDbError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/([a-z][a-z0-9+.-]+:\/\/)[^@\s]+@/gi, '$1<redacted>@');
}

/**
 * Dynamic require() for optional DB drivers (pg, mysql2, better-sqlite3) that may not be installed.
 * Uses `unknown` to force callers to cast the return value appropriately at the call site,
 * which is safer than `any` because it requires explicit type assertion.
 * In ESM contexts this throws unconditionally.
 */
const req: ((moduleName: string) => unknown) | ((moduleName: string) => never) =
  typeof require !== 'undefined'
    ? require
    : (moduleName: string) => {
        throw new Error(`Dynamic require not supported for ${moduleName}`);
      };

/**
 * @deprecated Use `LearningRepository` instead. This interface will be removed
 * in a future release. Callers should migrate to `LearningRepository` methods
 * directly. Tracked in #123.
 */
export interface DbAdapter {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PostgresClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
  end(): Promise<void>;
}

interface MysqlConnection {
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>;
  end(): Promise<void>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
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
function translateQuery(sql: string, dialect: 'postgres' | 'mysql' | 'sqlite'): string {
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
  }
  return cleanSql;
}

export abstract class SqlAdapter implements LearningRepository {
  abstract exec(sql: string): Promise<void>;
  abstract run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  abstract all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  abstract get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    await this.run(
      `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        finding.prNumber,
        finding.type,
        finding.severity || null,
        finding.file || null,
        finding.line || null,
        finding.message,
        finding.suggestion || null,
      ],
    );
    return id;
  }

  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    if (findings.length === 0) return [];
    return this.transaction(async () => {
      const ids = findings.map(() => generateId());
      const placeholders = findings.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = findings.flatMap((f, i) => [
        ids[i],
        f.prNumber,
        f.type,
        f.severity || null,
        f.file || null,
        f.line || null,
        f.message,
        f.suggestion || null,
      ]);
      await this.run(
        `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES ${placeholders}`,
        values,
      );
      return ids;
    });
  }

  async deleteFindings(prNumber: number): Promise<number> {
    return this.transaction(async () => {
      await this.run('DELETE FROM feedback WHERE pr_number = ?', [prNumber]);
      const result = await this.run('DELETE FROM findings WHERE pr_number = ?', [prNumber]);
      return result.changes;
    });
  }

  async getFindingsByType(type: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    return this.all('SELECT * FROM findings WHERE type = ? ORDER BY created_at DESC LIMIT ?', [
      type,
      limit,
    ]);
  }

  async getFindings(prNumber?: number, limit = 100): Promise<Array<Record<string, unknown>>> {
    if (prNumber) {
      return this.all(
        'SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?',
        [prNumber, limit],
      );
    }
    return this.all('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?', [limit]);
  }

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

  async getFalsePositiveRate(): Promise<number> {
    const [total, disputed] = await Promise.all([
      this.get<{ count: number }>('SELECT COUNT(*) as count FROM feedback'),
      this.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM feedback WHERE signal_type IN ('dismissed', 'disputed_comment')",
      ),
    ]);
    if (!total || total.count === 0) return 0;
    if (!disputed) return 0;
    return disputed.count / total.count;
  }

  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const extensions = [
      ...new Set(
        filePaths.map((f) => {
          const ext = f.split('.').pop();
          return ext ? `.${ext}` : '';
        }),
      ),
    ].filter(Boolean);

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

  async recordQuality(quality: LearningQuality): Promise<void> {
    await this.run(
      `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        quality.prNumber,
        quality.actionabilityScore,
        quality.accuracyScore,
        quality.coverageScore,
        quality.consistencyScore,
      ],
    );
  }

  async getQualityTrends(limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.all('SELECT * FROM review_quality ORDER BY created_at DESC LIMIT ?', [limit]);
  }

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

  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    if (patterns.length === 0) return;
    await this.transaction(async () => {
      for (const pattern of patterns) {
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
      }
    });
  }

  async getPatterns(minFrequency = 3): Promise<Array<Record<string, unknown>>> {
    return this.all('SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC', [
      minFrequency,
    ]);
  }

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

  async getPendingRules(): Promise<Array<Record<string, unknown>>> {
    return this.all("SELECT * FROM custom_rules WHERE status = 'pending'");
  }

  async approveRule(ruleId: string): Promise<void> {
    await this.run(
      "UPDATE custom_rules SET status = 'active', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
      [ruleId],
    );
  }

  async declineRule(ruleId: string): Promise<void> {
    await this.run("UPDATE custom_rules SET status = 'declined' WHERE id = ?", [ruleId]);
  }

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

  async resetCounter(): Promise<void> {
    await this.run('UPDATE meta_review_counter SET count = 0 WHERE id = 1');
  }
}

export class PostgresAdapter extends SqlAdapter implements DbAdapter {
  private client: PostgresClient;

  constructor(client: PostgresClient) {
    super();
    this.client = client;
  }

  async exec(sql: string): Promise<void> {
    const pgSql = translateQuery(sql, 'postgres');
    await this.client.query(pgSql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const pgSql = translateQuery(sql, 'postgres');
    const res = await this.client.query(pgSql, params);
    return { changes: res.rowCount ?? 0 };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pgSql = translateQuery(sql, 'postgres');
    const res = await this.client.query(pgSql, params);
    return res.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const pgSql = translateQuery(sql, 'postgres');
    const res = await this.client.query(pgSql, params);
    return res.rows[0] as T | undefined;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const res = await fn();
      await this.client.query('COMMIT');
      return res;
    } catch (e) {
      await this.client.query('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export class MysqlAdapter extends SqlAdapter implements DbAdapter {
  private connection: MysqlConnection;

  constructor(connection: MysqlConnection) {
    super();
    this.connection = connection;
  }

  async exec(sql: string): Promise<void> {
    const mysqlSql = translateQuery(sql, 'mysql');
    await this.connection.execute(mysqlSql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const mysqlSql = translateQuery(sql, 'mysql');
    const [result] = await this.connection.execute(mysqlSql, params);
    const affectedRows = (result as { affectedRows?: number })?.affectedRows ?? 0;
    return { changes: affectedRows };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const mysqlSql = translateQuery(sql, 'mysql');
    const [rows] = await this.connection.execute(mysqlSql, params);
    return rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const mysqlSql = translateQuery(sql, 'mysql');
    const [rows] = await this.connection.execute(mysqlSql, params);
    return (rows as T[])[0];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.connection.beginTransaction();
    try {
      const res = await fn();
      await this.connection.commit();
      return res;
    } catch (e) {
      await this.connection.rollback();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.connection.end();
  }
}

export class SqliteAdapter implements DbAdapter, LearningRepository {
  private db: SqliteDatabase;
  private stmtCache = new Map<string, ReturnType<SqliteDatabase['prepare']>>();
  private readonly maxCacheSize: number;

  constructor(db: SqliteDatabase, maxCacheSize = 100) {
    this.db = db;
    this.maxCacheSize = maxCacheSize;
  }

  private prepareStmt(sql: string): ReturnType<SqliteDatabase['prepare']> {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    let stmt = this.stmtCache.get(normalized);
    if (stmt) {
      this.stmtCache.delete(normalized);
      this.stmtCache.set(normalized, stmt);
      return stmt;
    }
    if (this.stmtCache.size >= this.maxCacheSize) {
      const firstKey = this.stmtCache.keys().next().value;
      if (firstKey) this.stmtCache.delete(firstKey);
    }
    stmt = this.db.prepare(normalized);
    this.stmtCache.set(normalized, stmt);
    return stmt;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = this.prepareStmt(sql).run(...params);
    return { changes: res.changes };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.prepareStmt(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.prepareStmt(sql).get(...params) as T | undefined;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const res = await fn();
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async recordFinding(finding: FindingInput): Promise<string> {
    const id = finding.id || generateId();
    this.prepareStmt(
      `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      finding.prNumber,
      finding.type,
      finding.severity || null,
      finding.file || null,
      finding.line || null,
      finding.message,
      finding.suggestion || null,
    );
    return id;
  }

  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    if (findings.length === 0) return [];
    return this.transaction(async () => {
      const ids = findings.map(() => generateId());
      const placeholders = findings.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = findings.flatMap((f, i) => [
        ids[i],
        f.prNumber,
        f.type,
        f.severity || null,
        f.file || null,
        f.line || null,
        f.message,
        f.suggestion || null,
      ]);
      this.prepareStmt(
        `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES ${placeholders}`,
      ).run(...values);
      return ids;
    });
  }

  async deleteFindings(prNumber: number): Promise<number> {
    return this.transaction(async () => {
      this.prepareStmt('DELETE FROM feedback WHERE pr_number = ?').run(prNumber);
      const result = this.prepareStmt('DELETE FROM findings WHERE pr_number = ?').run(prNumber);
      return result.changes;
    });
  }

  async getFindingsByType(type: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    return this.prepareStmt(
      'SELECT * FROM findings WHERE type = ? ORDER BY created_at DESC LIMIT ?',
    ).all(type, limit) as Array<Record<string, unknown>>;
  }

  async getFindings(prNumber?: number, limit = 100): Promise<Array<Record<string, unknown>>> {
    if (prNumber) {
      return this.prepareStmt(
        'SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?',
      ).all(prNumber, limit) as Array<Record<string, unknown>>;
    }
    return this.prepareStmt('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?').all(
      limit,
    ) as Array<Record<string, unknown>>;
  }

  async recordFeedback(feedback: FeedbackInput): Promise<void> {
    this.prepareStmt(
      `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      generateId(),
      feedback.findingId,
      feedback.signalType,
      feedback.signalValue,
      feedback.prNumber,
    );
  }

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
      this.prepareStmt(
        `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number) VALUES ${placeholders}`,
      ).run(...values);
    });
  }

  async getFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    if (sinceDays) {
      return this.prepareStmt(
        "SELECT message, file FROM findings WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?",
      ).all(`-${sinceDays} days`, limit) as Array<{ message: string; file: string }>;
    }
    return this.prepareStmt(
      'SELECT message, file FROM findings ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as Array<{ message: string; file: string }>;
  }

  async getDistinctFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    if (sinceDays) {
      return this.prepareStmt(
        "SELECT message, file FROM findings WHERE created_at >= datetime('now', ?) GROUP BY message ORDER BY MAX(created_at) DESC LIMIT ?",
      ).all(`-${sinceDays} days`, limit) as Array<{ message: string; file: string }>;
    }
    return this.prepareStmt(
      'SELECT message, file FROM findings GROUP BY message ORDER BY MAX(created_at) DESC LIMIT ?',
    ).all(limit) as Array<{ message: string; file: string }>;
  }

  async getFindingMessagesByFileType(
    fileType: string,
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    const filePattern = `%${fileType}`;
    if (sinceDays) {
      return this.prepareStmt(
        "SELECT message, file FROM findings WHERE file LIKE ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?",
      ).all(filePattern, `-${sinceDays} days`, limit) as Array<{ message: string; file: string }>;
    }
    return this.prepareStmt(
      'SELECT message, file FROM findings WHERE file LIKE ? ORDER BY created_at DESC LIMIT ?',
    ).all(filePattern, limit) as Array<{ message: string; file: string }>;
  }

  async getFalsePositiveRate(): Promise<number> {
    const total = this.prepareStmt('SELECT COUNT(*) as count FROM feedback').get() as
      | { count: number }
      | undefined;
    const disputed = this.prepareStmt(
      "SELECT COUNT(*) as count FROM feedback WHERE signal_type IN ('dismissed', 'disputed_comment')",
    ).get() as { count: number } | undefined;
    if (!total || total.count === 0) return 0;
    if (!disputed) return 0;
    return disputed.count / total.count;
  }

  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const extensions = [
      ...new Set(
        filePaths.map((f) => {
          const ext = f.split('.').pop();
          return ext ? `.${ext}` : '';
        }),
      ),
    ].filter(Boolean);

    const queries: Promise<unknown[]>[] = [
      Promise.resolve(
        this.prepareStmt(
          "SELECT rule_text FROM custom_rules WHERE status = 'active'",
        ).all() as Array<{ rule_text: string }>,
      ).catch(() => []),
      Promise.resolve(
        this.prepareStmt(
          "SELECT override_text FROM prompt_overrides WHERE category = 'general'",
        ).all() as Array<{ override_text: string }>,
      ).catch(() => []),
    ];

    if (extensions.length > 0) {
      const placeholders = extensions.map(() => '?').join(',');
      queries.push(
        Promise.resolve(
          this.prepareStmt(
            `SELECT override_text FROM prompt_overrides WHERE category IN (${placeholders})`,
          ).all(...extensions) as Array<{ override_text: string }>,
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

  async recordQuality(quality: LearningQuality): Promise<void> {
    this.prepareStmt(
      `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId(),
      quality.prNumber,
      quality.actionabilityScore,
      quality.accuracyScore,
      quality.coverageScore,
      quality.consistencyScore,
    );
  }

  async getQualityTrends(limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.prepareStmt('SELECT * FROM review_quality ORDER BY created_at DESC LIMIT ?').all(
      limit,
    ) as Array<Record<string, unknown>>;
  }

  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    return this.transaction(async () => {
      const row = this.prepareStmt('SELECT count FROM meta_review_counter WHERE id = 1').get() as
        | { count: number }
        | undefined;
      if (!row) return false;

      const newCount = row.count + 1;
      this.prepareStmt('UPDATE meta_review_counter SET count = ? WHERE id = 1').run(newCount);
      return newCount % interval === 0;
    });
  }

  async recordPattern(pattern: PatternInput): Promise<void> {
    await this.transaction(async () => {
      const existing = this.prepareStmt(
        'SELECT id, frequency FROM patterns WHERE pattern_key = ?',
      ).get(pattern.patternKey) as { id: string; frequency: number } | undefined;

      if (existing) {
        this.prepareStmt(
          `UPDATE patterns SET frequency = ?, last_seen = CURRENT_TIMESTAMP, file_types = ? WHERE pattern_key = ?`,
        ).run(existing.frequency + 1, pattern.fileTypes.join(','), pattern.patternKey);
      } else {
        this.prepareStmt(
          `INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ).run(
          generateId(),
          pattern.patternKey,
          JSON.stringify(pattern.messageCluster),
          pattern.frequency,
          pattern.fileTypes.join(','),
        );
      }
    });
  }

  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    if (patterns.length === 0) return;
    await this.transaction(async () => {
      for (const pattern of patterns) {
        const existing = this.prepareStmt(
          'SELECT id, frequency FROM patterns WHERE pattern_key = ?',
        ).get(pattern.patternKey) as { id: string; frequency: number } | undefined;

        if (existing) {
          this.prepareStmt(
            `UPDATE patterns SET frequency = ?, last_seen = CURRENT_TIMESTAMP, file_types = ? WHERE pattern_key = ?`,
          ).run(existing.frequency + 1, pattern.fileTypes.join(','), pattern.patternKey);
        } else {
          this.prepareStmt(
            `INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          ).run(
            generateId(),
            pattern.patternKey,
            JSON.stringify(pattern.messageCluster),
            pattern.frequency,
            pattern.fileTypes.join(','),
          );
        }
      }
    });
  }

  async getPatterns(minFrequency = 3): Promise<Array<Record<string, unknown>>> {
    return this.prepareStmt(
      'SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC',
    ).all(minFrequency) as Array<Record<string, unknown>>;
  }

  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    const id = generateId();
    this.prepareStmt(
      'INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)',
    ).run(id, ruleText, source, 'pending');
    return id;
  }

  async getPendingRules(): Promise<Array<Record<string, unknown>>> {
    return this.prepareStmt("SELECT * FROM custom_rules WHERE status = 'pending'").all() as Array<
      Record<string, unknown>
    >;
  }

  async approveRule(ruleId: string): Promise<void> {
    this.prepareStmt(
      "UPDATE custom_rules SET status = 'active', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(ruleId);
  }

  async declineRule(ruleId: string): Promise<void> {
    this.prepareStmt("UPDATE custom_rules SET status = 'declined' WHERE id = ?").run(ruleId);
  }

  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    this.prepareStmt(
      `INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before)
       VALUES (?, ?, ?, ?)`,
    ).run(generateId(), category, overrideText, fpRateBefore);
  }

  async resetCounter(): Promise<void> {
    this.prepareStmt('UPDATE meta_review_counter SET count = 0 WHERE id = 1').run();
  }
}

/**
 * Adapter that wraps `JsonDatabase` behind the `DbAdapter` and `LearningRepository`
 * interfaces. Prefer using `LearningRepository` methods directly; the `DbAdapter`
 * (`run`/`all`/`get` via regex-based SQL dispatch) is deprecated.
 */
export class JsonDbAdapter implements DbAdapter, LearningRepository {
  private db: JsonDatabase;

  constructor(db: JsonDatabase) {
    this.db = db;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.dispatch(sql, params);
    return { changes: result.changes ?? 0 };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = this.db.dispatch(sql, params);
    return (result.rows ?? []) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = this.db.dispatch(sql, params);
    return (result.row ?? (result.rows as T[] | undefined)?.[0]) as T | undefined;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const txn = this.db.transaction(fn);
    return txn();
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async recordFinding(finding: FindingInput): Promise<string> {
    return this.db.recordFinding(finding);
  }

  async recordFindings(findings: FindingInput[]): Promise<string[]> {
    return this.db.recordFindings(findings);
  }

  async deleteFindings(prNumber: number): Promise<number> {
    return this.db.deleteFindings(prNumber);
  }

  async getFindingsByType(type: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    return this.db.getFindingsByType(type, limit);
  }

  async getFindings(prNumber?: number, limit = 100): Promise<Array<Record<string, unknown>>> {
    return this.db.getFindings(prNumber, limit);
  }

  async recordFeedback(feedback: FeedbackInput): Promise<void> {
    return this.db.recordFeedback(feedback);
  }

  async recordFeedbackBatch(feedbacks: FeedbackInput[]): Promise<void> {
    return this.db.recordFeedbackBatch(feedbacks);
  }

  async getFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    return this.db.getFindingMessages(limit, sinceDays);
  }

  async getDistinctFindingMessages(
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    return this.db.getDistinctFindingMessages(limit, sinceDays);
  }

  async getFindingMessagesByFileType(
    fileType: string,
    limit = 100,
    sinceDays?: number,
  ): Promise<Array<{ message: string; file?: string }>> {
    return this.db.getFindingMessagesByFileType(fileType, limit, sinceDays);
  }

  async getFalsePositiveRate(): Promise<number> {
    return this.db.getFalsePositiveRate();
  }

  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    return this.db.getRelevantLessons(filePaths);
  }

  async recordQuality(quality: LearningQuality): Promise<void> {
    return this.db.recordQuality(quality);
  }

  async getQualityTrends(limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.db.getQualityTrends(limit);
  }

  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    return this.db.incrementAndCheckMetaReviewInterval(interval);
  }

  async recordPattern(pattern: PatternInput): Promise<void> {
    return this.db.recordPattern(pattern);
  }

  async recordPatterns(patterns: PatternInput[]): Promise<void> {
    return this.db.recordPatterns(patterns);
  }

  async getPatterns(minFrequency = 3): Promise<Array<Record<string, unknown>>> {
    return this.db.getPatterns(minFrequency);
  }

  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    return this.db.addCustomRule(ruleText, source);
  }

  async getPendingRules(): Promise<Array<Record<string, unknown>>> {
    return this.db.getPendingRules();
  }

  async approveRule(ruleId: string): Promise<void> {
    return this.db.approveRule(ruleId);
  }

  async declineRule(ruleId: string): Promise<void> {
    return this.db.declineRule(ruleId);
  }

  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    return this.db.addPromptOverride(category, overrideText, fpRateBefore);
  }

  async resetCounter(): Promise<void> {
    return this.db.resetCounter();
  }
}

export async function connectDb(dbPathOrUrl: string): Promise<LearningRepository & DbAdapter> {
  if (dbPathOrUrl.startsWith('postgres://') || dbPathOrUrl.startsWith('postgresql://')) {
    try {
      const { Client } = req('pg') as {
        Client: new (config: { connectionString: string }) => PostgresClient;
      };
      const client = new Client({ connectionString: dbPathOrUrl });
      await client.connect();
      return new PostgresAdapter(client);
    } catch (e) {
      throw new Error(`Failed to connect to PostgreSQL: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (dbPathOrUrl.startsWith('mysql://')) {
    try {
      const mysql = req('mysql2/promise') as {
        createConnection: (url: string) => Promise<MysqlConnection>;
      };
      const connection = await mysql.createConnection(dbPathOrUrl);
      return new MysqlAdapter(connection);
    } catch (e) {
      throw new Error(`Failed to connect to MySQL: ${e instanceof Error ? e.message : e}`);
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
    return new SqliteAdapter(db);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const isMissingDriver =
      errMsg.includes('Cannot find module') ||
      errMsg.includes('Module not found') ||
      errMsg.includes('Could not locate the bindings file') ||
      errMsg.includes('Cannot locate the bindings file') ||
      errMsg.includes('require');
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
    return new JsonDbAdapter(jsonDb);
  }
}
