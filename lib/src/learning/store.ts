import type { LearningFeedback, LearningQuality } from '../types/index.js';
import { type DbAdapter, connectDb } from './db.js';
import { applyMigrations, generateId, getDbPath } from './schema.js';

export class LearningStore {
  private dbPromise: Promise<DbAdapter>;

  constructor(dbPathOrUrl?: string) {
    this.dbPromise = (async () => {
      const target = process.env.DATABASE_URL || dbPathOrUrl || getDbPath();
      const maxRetries = 3;
      let db: DbAdapter | undefined;
      const errors: string[] = [];
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          db = await connectDb(target);
          await applyMigrations(db);
          return db;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(msg);
          if (db) {
            try {
              await db.close();
            } catch {
              /* cleanup best-effort */
            }
            db = undefined;
          }
          if (attempt === maxRetries) break;
          console.warn(`DB connection attempt ${attempt} failed, retrying: ${msg}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      throw new Error('Failed to connect to database after retries: ' + errors.join('; '));
    })();
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    await db.close();
  }

  async recordFinding(finding: {
    id?: string;
    prNumber: number;
    type: string;
    severity?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }): Promise<string> {
    const db = await this.dbPromise;
    const id = finding.id || generateId();
    await db.run(
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

  async recordFindings(
    findings: Array<{
      prNumber: number;
      type: string;
      severity?: string;
      file?: string;
      line?: number;
      message: string;
      suggestion?: string;
    }>,
  ): Promise<string[]> {
    if (findings.length === 0) return [];
    const db = await this.dbPromise;
    return db.transaction(async () => {
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
      await db.run(
        `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES ${placeholders}`,
        values,
      );
      return ids;
    });
  }

  async deleteFindings(prNumber: number): Promise<number> {
    const db = await this.dbPromise;
    return db.transaction(async () => {
      await db.run('DELETE FROM feedback WHERE pr_number = ?', [prNumber]);
      const result = await db.run('DELETE FROM findings WHERE pr_number = ?', [prNumber]);
      return result.changes;
    });
  }

  async getFindingsByType(type: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const db = await this.dbPromise;
    return db.all('SELECT * FROM findings WHERE type = ? ORDER BY created_at DESC LIMIT ?', [
      type,
      limit,
    ]);
  }

  async getFindings(prNumber?: number, limit = 100): Promise<Array<Record<string, unknown>>> {
    const db = await this.dbPromise;
    if (prNumber) {
      return db.all('SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?', [
        prNumber,
        limit,
      ]);
    }
    return db.all('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  async recordFeedback(feedback: {
    findingId: string;
    signalType: LearningFeedback['signalType'];
    signalValue: string;
    prNumber: number;
  }): Promise<void> {
    try {
      const db = await this.dbPromise;
      await db.run(
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
    } catch (err) {
      console.warn(`Failed to record feedback: ${err instanceof Error ? err.message : err}`);
    }
  }

  async recordFeedbackBatch(
    feedbacks: Array<{
      findingId: string;
      signalType: LearningFeedback['signalType'];
      signalValue: string;
      prNumber: number;
    }>,
  ): Promise<void> {
    if (feedbacks.length === 0) return;
    const db = await this.dbPromise;
    await db.transaction(async () => {
      const placeholders = feedbacks.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const values = feedbacks.flatMap((fb) => [
        generateId(),
        fb.findingId,
        fb.signalType,
        fb.signalValue,
        fb.prNumber,
      ]);
      await db.run(
        `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number) VALUES ${placeholders}`,
        values,
      );
    });
  }

  async getFindingMessages(limit = 100): Promise<Array<{ message: string; file?: string }>> {
    const db = await this.dbPromise;
    return db.all<{ message: string; file: string }>(
      'SELECT message, file FROM findings ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
  }

  async getFalsePositiveRate(): Promise<number> {
    const db = await this.dbPromise;
    const total = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM feedback');
    if (!total || total.count === 0) return 0;

    const disputed = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM feedback WHERE signal_type IN ('dismissed', 'disputed_comment')",
    );
    if (!disputed) return 0;

    return disputed.count / total.count;
  }

  async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    try {
      const db = await this.dbPromise;

      const extensions = [
        ...new Set(
          filePaths.map((f) => {
            const ext = f.split('.').pop();
            return ext ? `.${ext}` : '';
          }),
        ),
      ].filter(Boolean);

      const queries: Promise<unknown[]>[] = [
        db
          .all<{ rule_text: string }>("SELECT rule_text FROM custom_rules WHERE status = 'active'")
          .catch(() => []),
        db
          .all<{ override_text: string }>(
            "SELECT override_text FROM prompt_overrides WHERE category = 'general'",
          )
          .catch(() => []),
      ];

      if (extensions.length > 0) {
        const placeholders = extensions.map(() => '?').join(',');
        queries.push(
          db
            .all<{ override_text: string }>(
              `SELECT override_text FROM prompt_overrides WHERE category IN (${placeholders})`,
              extensions,
            )
            .catch(() => []),
        );
      }

      const results = await Promise.all(queries.map((q) => q.catch(() => [])));

      const lessons: string[] = [];
      for (const result of results) {
        for (const item of result as Array<{ rule_text?: string; override_text?: string }>) {
          lessons.push(item.rule_text || item.override_text || '');
        }
      }

      return lessons.filter(Boolean);
    } catch {
      return [];
    }
  }

  async recordQuality(quality: LearningQuality): Promise<void> {
    try {
      const db = await this.dbPromise;
      await db.run(
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
    } catch (err) {
      console.warn(`Failed to record quality: ${err instanceof Error ? err.message : err}`);
    }
  }

  async getQualityTrends(limit = 20): Promise<Array<Record<string, unknown>>> {
    const db = await this.dbPromise;
    return db.all('SELECT * FROM review_quality ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  async incrementAndCheckMetaReviewInterval(interval: number): Promise<boolean> {
    const db = await this.dbPromise;
    return db.transaction(async () => {
      const row = await db.get<{ count: number }>(
        'SELECT count FROM meta_review_counter WHERE id = 1',
      );
      if (!row) return false;

      const newCount = row.count + 1;
      await db.run('UPDATE meta_review_counter SET count = ? WHERE id = 1', [newCount]);

      return newCount % interval === 0;
    });
  }

  async recordPattern(pattern: {
    patternKey: string;
    messageCluster: string[];
    frequency: number;
    fileTypes: string[];
  }): Promise<void> {
    const db = await this.dbPromise;
    await db.transaction(async () => {
      const existing = await db.get<{ id: string; frequency: number }>(
        'SELECT id, frequency FROM patterns WHERE pattern_key = ?',
        [pattern.patternKey],
      );

      if (existing) {
        await db.run(
          `UPDATE patterns SET frequency = ?, last_seen = CURRENT_TIMESTAMP, file_types = ? WHERE pattern_key = ?`,
          [existing.frequency + 1, pattern.fileTypes.join(','), pattern.patternKey],
        );
      } else {
        await db.run(
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

  async getPatterns(minFrequency = 3): Promise<Array<Record<string, unknown>>> {
    const db = await this.dbPromise;
    return db.all('SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC', [
      minFrequency,
    ]);
  }

  async addCustomRule(ruleText: string, source: 'auto' | 'manual'): Promise<string> {
    const db = await this.dbPromise;
    const id = generateId();
    await db.run('INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)', [
      id,
      ruleText,
      source,
      'pending',
    ]);
    return id;
  }

  async getPendingRules(): Promise<Array<Record<string, unknown>>> {
    const db = await this.dbPromise;
    return db.all("SELECT * FROM custom_rules WHERE status = 'pending'");
  }

  async approveRule(ruleId: string): Promise<void> {
    const db = await this.dbPromise;
    await db.run(
      "UPDATE custom_rules SET status = 'active', approved_at = CURRENT_TIMESTAMP WHERE id = ?",
      [ruleId],
    );
  }

  async declineRule(ruleId: string): Promise<void> {
    const db = await this.dbPromise;
    await db.run("UPDATE custom_rules SET status = 'declined' WHERE id = ?", [ruleId]);
  }

  async addPromptOverride(
    category: string,
    overrideText: string,
    fpRateBefore: number,
  ): Promise<void> {
    try {
      const db = await this.dbPromise;
      await db.run(
        `INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before)
         VALUES (?, ?, ?, ?)`,
        [generateId(), category, overrideText, fpRateBefore],
      );
    } catch (err) {
      console.warn(`Failed to add prompt override: ${err instanceof Error ? err.message : err}`);
    }
  }

  async resetCounter(): Promise<void> {
    const db = await this.dbPromise;
    await db.run('UPDATE meta_review_counter SET count = 0 WHERE id = 1');
  }
}
