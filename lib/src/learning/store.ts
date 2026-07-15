import type { LearningFeedback, LearningQuality } from '../types/index.js';
import { type DbAdapter, connectDb } from './db.js';
import { applyMigrations, generateId, getDbPath } from './schema.js';

export class LearningStore {
  private dbPromise: Promise<DbAdapter>;

  constructor(dbPathOrUrl?: string) {
    this.dbPromise = (async () => {
      const target = process.env.DATABASE_URL || dbPathOrUrl || getDbPath();
      const db = await connectDb(target);
      await applyMigrations(db);
      return db;
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
      `INSERT OR REPLACE INTO findings (id, pr_number, type, severity, file, line, message, suggestion)
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
      const ids: string[] = [];
      for (const finding of findings) {
        ids.push(await this.recordFinding(finding));
      }
      return ids;
    });
  }

  async deleteFindings(prNumber: number): Promise<number> {
    const db = await this.dbPromise;
    const result = await db.run('DELETE FROM findings WHERE pr_number = ?', [prNumber]);
    return result.changes;
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
  }

  async recordFeedbackBatch(
    feedbacks: Array<{
      findingId: string;
      signalType: LearningFeedback['signalType'];
      signalValue: string;
      prNumber: number;
    }>,
  ): Promise<void> {
    const db = await this.dbPromise;
    await db.transaction(async () => {
      for (const fb of feedbacks) {
        await db.run(
          `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number)
           VALUES (?, ?, ?, ?, ?)`,
          [generateId(), fb.findingId, fb.signalType, fb.signalValue, fb.prNumber],
        );
      }
    });
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
    const db = await this.dbPromise;
    const lessons: string[] = [];

    const rules = await db.all<{ rule_text: string }>(
      "SELECT rule_text FROM custom_rules WHERE status = 'active'",
    );
    for (const rule of rules) {
      lessons.push(rule.rule_text);
    }

    const generalOverrides = await db.all<{ override_text: string }>(
      "SELECT override_text FROM prompt_overrides WHERE category = 'general'",
    );
    for (const o of generalOverrides) {
      lessons.push(o.override_text);
    }

    const extensions = [
      ...new Set(
        filePaths.map((f) => {
          const ext = f.split('.').pop();
          return ext ? `.${ext}` : '';
        }),
      ),
    ].filter(Boolean);

    if (extensions.length > 0) {
      const placeholders = extensions.map(() => '?').join(',');
      const overrides = await db.all<{ override_text: string }>(
        `SELECT override_text FROM prompt_overrides WHERE category IN (${placeholders})`,
        extensions,
      );
      for (const o of overrides) {
        lessons.push(o.override_text);
      }
    }

    return lessons;
  }

  async recordQuality(quality: LearningQuality): Promise<void> {
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
    const db = await this.dbPromise;
    await db.run(
      `INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before)
       VALUES (?, ?, ?, ?)`,
      [generateId(), category, overrideText, fpRateBefore],
    );
  }

  async resetCounter(): Promise<void> {
    const db = await this.dbPromise;
    await db.run('UPDATE meta_review_counter SET count = 0 WHERE id = 1');
  }
}
