import path from 'path';
import { Logger } from '../utils/logger.js';

const DB_PATH = path.join(process.cwd(), '.opencode', 'learning.db');

/**
 * Get the default SQLite database path under `.opencode/learning.db`.
 * @returns The absolute path to the default database file.
 */
export function getDbPath(): string {
  return DB_PATH;
}

/** Interface for running database migrations. */
export interface MigrationRunner {
  /**
   * Execute a SQL migration statement.
   * @param sql - SQL statement to execute.
   * @returns Promise that resolves when execution completes.
   */
  exec(sql: string): Promise<void>;
}

/**
 * Apply all schema migrations to create the required tables and indexes
 * (findings, feedback, review_quality, patterns, custom_rules,
 * prompt_overrides, meta_review_counter). Idempotent — safe to run
 * on every startup.
 * @param runner - Database migration runner for executing SQL statements.
 */
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
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_findings_pr_created ON findings(pr_number, created_at DESC)`,
    );

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

    // Telemetry columns — idempotent migration guards
    const telemetryColumns = [
      'ALTER TABLE findings ADD COLUMN duration_ms INTEGER',
      'ALTER TABLE findings ADD COLUMN tokens_used INTEGER',
      'ALTER TABLE review_quality ADD COLUMN duration_ms INTEGER',
      'ALTER TABLE review_quality ADD COLUMN tokens_used INTEGER',
    ];
    for (const sql of telemetryColumns) {
      try {
        await runner.exec(sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name|already exists/i.test(message)) {
          throw err;
        }
      }
    }
    // Add comment_id column to findings table
    try {
      await runner.exec('ALTER TABLE findings ADD COLUMN comment_id INTEGER');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name|already exists/i.test(message)) {
        throw err;
      }
    }

    await runner.exec(`
      CREATE TABLE IF NOT EXISTS review_metrics (
        id TEXT PRIMARY KEY,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        period_type TEXT NOT NULL,
        total_prs INTEGER NOT NULL DEFAULT 0,
        total_findings INTEGER NOT NULL DEFAULT 0,
        avg_findings_per_pr REAL,
        total_feedback INTEGER NOT NULL DEFAULT 0,
        dismissed_count INTEGER NOT NULL DEFAULT 0,
        disputed_count INTEGER NOT NULL DEFAULT 0,
        false_positive_rate REAL,
        avg_review_duration_ms REAL,
        total_tokens_used INTEGER,
        avg_tokens_per_review REAL,
        avg_actionability_score REAL,
        avg_accuracy_score REAL,
        avg_coverage_score REAL,
        avg_consistency_score REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_review_metrics_period ON review_metrics(period_type, period_start)`,
    );

    // Rate limit tracking for the Probot app. Each row records one
    // rate-limited action (slash command, @mention conversation, or threaded
    // reply) so per-repo, per-user, per-PR cooldown, and daily token budget
    // limits can be enforced and persisted across app restarts.
    await runner.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id TEXT PRIMARY KEY,
        repo TEXT,
        github_user TEXT,
        pr_number INTEGER,
        action TEXT NOT NULL DEFAULT 'review',
        tier TEXT NOT NULL DEFAULT 'command',
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_repo_created ON rate_limits(repo, created_at)`,
    );
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_user_created ON rate_limits(github_user, created_at)`,
    );
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_repo_pr_tier ON rate_limits(repo, pr_number, tier)`,
    );
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_created ON rate_limits(created_at)`,
    );
  } catch (err) {
    const logger = new Logger('LearningStore');
    logger.error('Migration failed', err);
    throw err;
  }
}

/**
 * Generate a unique ID string for database records.
 * Format: `f_<timestamp>_<random>`.
 * @returns A unique ID string in the format `f_<timestamp>_<random>`.
 */
export function generateId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extract unique, non-empty dot-prefixed file extensions from a list of file paths.
 * @param filePaths - Array of file paths to extract extensions from.
 * @returns An array of unique file extensions like `['.ts', '.js']`.
 */
export function deriveFileExtensions(filePaths: string[]): string[] {
  return [
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
}
