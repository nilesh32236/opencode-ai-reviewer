import path from 'path';
import type { DbAdapter } from './db.js';

const DB_PATH = path.join(process.cwd(), '.opencode', 'learning.db');

export function getDbPath(): string {
  return DB_PATH;
}

export async function applyMigrations(db: DbAdapter): Promise<void> {
  try {
    await db.transaction(async () => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY,
          pr_number INTEGER NOT NULL,
          type TEXT NOT NULL,
          severity TEXT,
          file TEXT,
          line INTEGER,
          message TEXT NOT NULL,
          suggestion TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL,
          signal_type TEXT NOT NULL,
          signal_value TEXT,
          pr_number INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (finding_id) REFERENCES findings(id)
        );
      `);

      await db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_pr_number ON findings(pr_number)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_created_at ON findings(created_at)`);

      await db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_finding_id ON feedback(finding_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_pr_number ON feedback(pr_number)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_signal_type ON feedback(signal_type)`);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS review_quality (
          id TEXT PRIMARY KEY,
          pr_number INTEGER NOT NULL,
          actionability_score REAL NOT NULL,
          accuracy_score REAL NOT NULL,
          coverage_score REAL NOT NULL,
          consistency_score REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_review_quality_created_at ON review_quality(created_at)`,
      );

      await db.exec(`
        CREATE TABLE IF NOT EXISTS patterns (
          id TEXT PRIMARY KEY,
          pattern_key TEXT NOT NULL UNIQUE,
          message_cluster TEXT NOT NULL,
          frequency INTEGER NOT NULL DEFAULT 1,
          file_types TEXT,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL
        );
      `);

      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_patterns_frequency ON patterns(frequency DESC)`,
      );
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_patterns_key ON patterns(pattern_key)`);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS custom_rules (
          id TEXT PRIMARY KEY,
          rule_text TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'auto',
          status TEXT NOT NULL DEFAULT 'pending',
          approved_at TEXT
        );
      `);

      await db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_rules_status ON custom_rules(status)`);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_overrides (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          override_text TEXT NOT NULL,
          false_positive_rate_before REAL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_prompt_overrides_category ON prompt_overrides(category)`,
      );

      await db.exec(`
        CREATE TABLE IF NOT EXISTS meta_review_counter (
          id INTEGER PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0
        );
      `);

      const existing = await db.get<{ count: number }>(
        'SELECT count FROM meta_review_counter WHERE id = 1',
      );
      if (!existing) {
        await db.run('INSERT INTO meta_review_counter (id, count) VALUES (1, 0)');
      }
    });
  } catch (err) {
    console.error(`Migration failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export function generateId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
