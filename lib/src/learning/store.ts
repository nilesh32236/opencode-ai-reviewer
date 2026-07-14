import Database from 'better-sqlite3';
import { getDatabase, generateId, getDbPath } from './schema.js';
import type { LearningFeedback, LearningQuality } from '../types/index.js';

export class LearningStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = getDatabase(dbPath || getDbPath());
  }

  close(): void {
    this.db.close();
  }

  recordFinding(finding: {
    id?: string;
    prNumber: number;
    type: string;
    severity?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }): string {
    const id = finding.id || generateId();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO findings (id, pr_number, type, severity, file, line, message, suggestion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(id, finding.prNumber, finding.type, finding.severity || null, finding.file || null, finding.line || null, finding.message, finding.suggestion || null);
    return id;
  }

  recordFindings(findings: Array<{
    prNumber: number;
    type: string;
    severity?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>): string[] {
    const batch = this.db.transaction(() => {
      return findings.map((finding) => this.recordFinding(finding));
    });
    return batch();
  }

  deleteFindings(prNumber: number): number {
    const result = this.db
      .prepare('DELETE FROM findings WHERE pr_number = ?')
      .run(prNumber);
    return result.changes;
  }

  getFindingsByType(type: string, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM findings WHERE type = ? ORDER BY created_at DESC LIMIT ?')
      .all(type, limit) as Array<Record<string, unknown>>;
  }

  getFindings(prNumber?: number, limit = 100): Array<Record<string, unknown>> {
    if (prNumber) {
      return this.db
        .prepare('SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?')
        .all(prNumber, limit) as Array<Record<string, unknown>>;
    }
    return this.db
      .prepare('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  recordFeedback(feedback: {
    findingId: string;
    signalType: LearningFeedback['signalType'];
    signalValue: string;
    prNumber: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(generateId(), feedback.findingId, feedback.signalType, feedback.signalValue, feedback.prNumber);
  }

  getFalsePositiveRate(): number {
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM feedback')
      .get() as { count: number };
    if (total.count === 0) return 0;

    const disputed = this.db
      .prepare("SELECT COUNT(*) as count FROM feedback WHERE signal_type IN ('dismissed', 'disputed_comment')")
      .get() as { count: number };

    return disputed.count / total.count;
  }

  getRelevantLessons(filePaths: string[]): string[] {
    const lessons: string[] = [];

    const rules = this.db
      .prepare("SELECT rule_text FROM custom_rules WHERE status = 'active'")
      .all() as Array<{ rule_text: string }>;

    for (const rule of rules) {
      lessons.push(rule.rule_text);
    }

    const generalOverrides = this.db
      .prepare("SELECT override_text FROM prompt_overrides WHERE category = 'general'")
      .all() as Array<{ override_text: string }>;
    for (const o of generalOverrides) {
      lessons.push(o.override_text);
    }

    const extensions = [...new Set(filePaths.map((f) => {
      const ext = f.split('.').pop();
      return ext ? `.${ext}` : '';
    }))];

    for (const ext of extensions) {
      if (!ext) continue;
      const overrides = this.db
        .prepare('SELECT override_text FROM prompt_overrides WHERE category = ?')
        .all(ext) as Array<{ override_text: string }>;
      for (const o of overrides) {
        lessons.push(o.override_text);
      }
    }

    return lessons;
  }

  recordQuality(quality: LearningQuality): void {
    this.db
      .prepare(
        `INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generateId(),
        quality.prNumber,
        quality.actionabilityScore,
        quality.accuracyScore,
        quality.coverageScore,
        quality.consistencyScore,
      );
  }

  getQualityTrends(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM review_quality ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  incrementAndCheckMetaReviewInterval(interval: number): boolean {
    const tick = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT count FROM meta_review_counter WHERE id = 1')
        .get() as { count: number } | undefined;

      if (!row) return false;

      const newCount = row.count + 1;
      this.db.prepare('UPDATE meta_review_counter SET count = ? WHERE id = 1').run(newCount);

      return newCount % interval === 0;
    });
    return tick();
  }

  recordPattern(pattern: {
    patternKey: string;
    messageCluster: string[];
    frequency: number;
    fileTypes: string[];
  }): void {
    const upsert = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id, frequency FROM patterns WHERE pattern_key = ?')
        .get(pattern.patternKey) as { id: string; frequency: number } | undefined;

      if (existing) {
        this.db
          .prepare(
            "UPDATE patterns SET frequency = ?, last_seen = datetime('now'), file_types = ? WHERE pattern_key = ?",
          )
          .run(existing.frequency + 1, pattern.fileTypes.join(','), pattern.patternKey);
      } else {
        this.db
          .prepare(
            `INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
          )
          .run(
            generateId(),
            pattern.patternKey,
            JSON.stringify(pattern.messageCluster),
            pattern.frequency,
            pattern.fileTypes.join(','),
          );
      }
    });
    upsert();
  }

  getPatterns(minFrequency = 3): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC')
      .all(minFrequency) as Array<Record<string, unknown>>;
  }

  addCustomRule(ruleText: string, source: 'auto' | 'manual'): string {
    const id = generateId();
    this.db
      .prepare('INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)')
      .run(id, ruleText, source, 'pending');
    return id;
  }

  getPendingRules(): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM custom_rules WHERE status = 'pending'")
      .all() as Array<Record<string, unknown>>;
  }

  approveRule(ruleId: string): void {
    this.db
      .prepare("UPDATE custom_rules SET status = 'active', approved_at = datetime('now') WHERE id = ?")
      .run(ruleId);
  }

  declineRule(ruleId: string): void {
    this.db
      .prepare("UPDATE custom_rules SET status = 'declined' WHERE id = ?")
      .run(ruleId);
  }

  addPromptOverride(category: string, overrideText: string, fpRateBefore: number): void {
    this.db
      .prepare(
        `INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before)
         VALUES (?, ?, ?, ?)`,
      )
      .run(generateId(), category, overrideText, fpRateBefore);
  }

  resetCounter(): void {
    this.db.prepare('UPDATE meta_review_counter SET count = 0 WHERE id = 1').run();
  }
}
