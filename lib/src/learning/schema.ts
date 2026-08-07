import * as crypto from 'crypto';
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
    await runner.exec(`DROP INDEX IF EXISTS idx_rate_limits_pr_tier`);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_repo_pr_tier ON rate_limits(repo, pr_number, tier)`,
    );
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_created ON rate_limits(created_at)`,
    );

    // Persisted multi-turn conversation state for the /ask + @mention flows.
    // Each row mirrors the in-memory ConversationState (turn count, summary
    // snapshot, auto-close flag) plus the anchor that identifies the thread, so
    // the sliding-window/summarization machinery survives app restarts.
    await runner.exec(`
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        thread_root_comment_id INTEGER,
        is_review_comment INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        token_budget_used INTEGER NOT NULL DEFAULT 0,
        last_file_ref TEXT,
        last_line_ref INTEGER,
        summary_snapshot TEXT,
        summarized_count INTEGER,
        already_closed INTEGER NOT NULL DEFAULT 0,
        last_activity_timestamp INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_conv_sessions_pr ON conversation_sessions(pr_number, repo)`,
    );

    await runner.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        body TEXT NOT NULL,
        file_ref TEXT,
        line_ref INTEGER,
        tokens_used INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
      );
    `);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_id, turn_number)`,
    );

    // Persisted, expiring suppression rules generated from dismissal feedback.
    // Each row captures a high-confidence false-positive pattern (message +
    // file extension) that should not be re-flagged, along with its lifecycle
    // (expiry time, review budget) and effectiveness counters. Generation,
    // expiry, and metrics are driven by the SuppressionSubscriber.
    await runner.exec(`
      CREATE TABLE IF NOT EXISTS suppression_rules (
        id TEXT PRIMARY KEY,
        pattern_key TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL,
        file_types TEXT,
        dismissal_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_active_at TEXT,
        expires_at TEXT,
        reviews_seen INTEGER NOT NULL DEFAULT 0,
        suppression_hits INTEGER NOT NULL DEFAULT 0
      );
    `);
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_suppression_rules_status ON suppression_rules(status)`,
    );
    await runner.exec(
      `CREATE INDEX IF NOT EXISTS idx_suppression_rules_expires ON suppression_rules(expires_at)`,
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
 * Compute a deterministic pattern key for a suppression rule based on the
 * finding message and (optional) file path. Used as the unique upsert key for
 * the `suppression_rules` table so repeat dismissals of the same pattern
 * refresh the existing rule rather than creating duplicates.
 *
 * The message and file components are length-prefixed before hashing so that
 * distinct (message, file) pairs can never produce the same digest (a plain
 * `::` separator is ambiguous when a message itself contains `::`).
 * @param message - The finding message text.
 * @param file - The finding file path, or undefined when no file was recorded.
 * @returns A stable SHA-256 hex digest of the length-prefixed message and file.
 */
export function hashPatternKey(message: string, file?: string): string {
  const f = file || '';
  return crypto
    .createHash('sha256')
    .update(`${message.length}:${message}${f.length}:${f}`)
    .digest('hex');
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

/**
 * Retention window for physically purging expired suppression rules. Rules
 * that have been inactive (both created and expired) longer than this are
 * deleted so the `suppression_rules` table cannot grow without bound.
 */
export const SUPPRESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sanitize a persisted finding message before it is injected into a review
 * prompt as a suppression rule. Finding messages are derived from untrusted
 * PR/code content, so newlines and delimiter-style tokens that could be
 * interpreted as instructions are collapsed into a single space, surrounding
 * whitespace is trimmed, and the result is clamped to a fixed length. This is
 * the rule-format-time partner to {@link sanitizePromptInput}, which wraps the
 * final prompt in data-only delimiters.
 * @param message - The persisted finding message text.
 * @returns A single-line, length-capped, prompt-safe message.
 */
export function sanitizeSuppressionMessage(message: string): string {
  return (message || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 150);
}
