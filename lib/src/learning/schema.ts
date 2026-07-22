import path from 'path';
import { Logger } from '../utils/logger.js';

const DB_PATH = path.join(process.cwd(), '.opencode', 'learning.db');

export function getDbPath(): string {
  return DB_PATH;
}

export interface MigrationRunner {
  exec(sql: string): Promise<void>;
}

export async function applyMigrations(runner: MigrationRunner): Promise<void> {
  try {
    await runner.exec(`
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

    await runner.exec(`
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

    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_findings_pr_number ON findings(pr_number)`);
    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type)`);
    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_findings_created_at ON findings(created_at)`);

    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_finding_id ON feedback(finding_id)`);
    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_pr_number ON feedback(pr_number)`);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_feedback_signal_type ON feedback(signal_type)`,
    );

    await runner.exec(`
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
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_review_quality_created_at ON review_quality(created_at)`,
    );

    await runner.exec(`
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

    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_patterns_frequency ON patterns(frequency DESC)`,
    );
    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_patterns_key ON patterns(pattern_key)`);

    await runner.exec(`
      CREATE TABLE IF NOT EXISTS custom_rules (
        id TEXT PRIMARY KEY,
        rule_text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL DEFAULT 'pending',
        approved_at TEXT
      );
    `);

    await runner.exec(`CREATE INDEX IF NOT EXISTS idx_custom_rules_status ON custom_rules(status)`);

    await runner.exec(`
      CREATE TABLE IF NOT EXISTS prompt_overrides (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        override_text TEXT NOT NULL,
        false_positive_rate_before REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_prompt_overrides_category ON prompt_overrides(category)`,
    );

    await runner.exec(`
      CREATE TABLE IF NOT EXISTS meta_review_counter (
        id INTEGER PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
    `);

    await runner.exec('INSERT OR IGNORE INTO meta_review_counter (id, count) VALUES (1, 0)');
  } catch (err) {
    const logger = new Logger('LearningStore');
    logger.error('Migration failed', err);
    throw err;
  }
}

export function generateId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
