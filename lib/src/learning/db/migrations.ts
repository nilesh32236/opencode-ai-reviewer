/**
 * Database migrations for performance optimization.
 * This module provides SQL migration scripts to add missing indexes and optimize queries.
 */

/**
 * Migration definition with version, description, and SQL statements.
 */
export interface Migration {
  /** Migration version (incremental) */
  version: number;
  /** Human-readable description of the migration */
  description: string;
  /** SQL statements to execute for this migration */
  sql: string[];
}

/**
 * All database migrations in order.
 * Each migration should be idempotent (safe to run multiple times).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Add indexes for frequently queried columns in findings table',
    sql: [
      // Index on pr_number for filtering findings by PR
      `CREATE INDEX IF NOT EXISTS idx_findings_pr_number ON findings(pr_number)`,
      // Index on created_at for time-based queries
      `CREATE INDEX IF NOT EXISTS idx_findings_created_at ON findings(created_at)`,
      // Index on type for filtering by finding type
      `CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type)`,
      // Index on severity for severity-based queries
      `CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity)`,
      // Index on file for file-based queries
      `CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(file)`,
    ],
  },
  {
    version: 2,
    description: 'Add indexes for feedback table',
    sql: [
      // Index on finding_id for joining with findings
      `CREATE INDEX IF NOT EXISTS idx_feedback_finding_id ON feedback(finding_id)`,
      // Index on signal_type for filtering by feedback type
      `CREATE INDEX IF NOT EXISTS idx_feedback_signal_type ON feedback(signal_type)`,
      // Index on pr_number for PR-based queries
      `CREATE INDEX IF NOT EXISTS idx_feedback_pr_number ON feedback(pr_number)`,
      // Index on created_at for time-based queries
      `CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at)`,
      // Composite index for common query patterns
      `CREATE INDEX IF NOT EXISTS idx_feedback_signal_pr ON feedback(signal_type, pr_number)`,
    ],
  },
  {
    version: 3,
    description: 'Add indexes for review_quality table',
    sql: [
      // Index on pr_number for PR-based queries
      `CREATE INDEX IF NOT EXISTS idx_review_quality_pr_number ON review_quality(pr_number)`,
      // Index on created_at for time-based queries
      `CREATE INDEX IF NOT EXISTS idx_review_quality_created_at ON review_quality(created_at)`,
    ],
  },
  {
    version: 4,
    description: 'Add indexes for patterns table',
    sql: [
      // Index on pattern_key for lookups
      `CREATE INDEX IF NOT EXISTS idx_patterns_pattern_key ON patterns(pattern_key)`,
      // Index on frequency for frequency-based queries
      `CREATE INDEX IF NOT EXISTS idx_patterns_frequency ON patterns(frequency)`,
      // Index on last_seen for time-based queries
      `CREATE INDEX IF NOT EXISTS idx_patterns_last_seen ON patterns(last_seen)`,
    ],
  },
  {
    version: 5,
    description: 'Add indexes for custom_rules table',
    sql: [
      // Index on status for filtering by rule status
      `CREATE INDEX IF NOT EXISTS idx_custom_rules_status ON custom_rules(status)`,
      // Index on source for filtering by rule source
      `CREATE INDEX IF NOT EXISTS idx_custom_rules_source ON custom_rules(source)`,
    ],
  },
  {
    version: 6,
    description: 'Add indexes for rate_limits table',
    sql: [
      // Index on repo for repository-based queries
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_repo ON rate_limits(repo)`,
      // Index on github_user for user-based queries
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_github_user ON rate_limits(github_user)`,
      // Index on pr_number for PR-based queries
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_pr_number ON rate_limits(pr_number)`,
      // Index on tier for tier-based queries
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_tier ON rate_limits(tier)`,
      // Index on created_at for time-based queries
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_created_at ON rate_limits(created_at)`,
      // Composite index for common query patterns
      `CREATE INDEX IF NOT EXISTS idx_rate_limits_repo_user_tier ON rate_limits(repo, github_user, tier)`,
    ],
  },
  {
    version: 7,
    description: 'Add indexes for conversation_sessions and conversation_turns tables',
    sql: [
      // Index on session_id for conversation_turns
      `CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_id ON conversation_turns(session_id)`,
      // Index on turn_number for ordering
      `CREATE INDEX IF NOT EXISTS idx_conversation_turns_turn_number ON conversation_turns(turn_number)`,
      // Index on repo for conversation_sessions
      `CREATE INDEX IF NOT EXISTS idx_conversation_sessions_repo ON conversation_sessions(repo)`,
      // Index on pr_number for conversation_sessions
      `CREATE INDEX IF NOT EXISTS idx_conversation_sessions_pr_number ON conversation_sessions(pr_number)`,
      // Index on last_activity_timestamp for cleanup
      `CREATE INDEX IF NOT EXISTS idx_conversation_sessions_last_activity ON conversation_sessions(last_activity_timestamp)`,
    ],
  },
  {
    version: 8,
    description: 'Add composite indexes for common query patterns',
    sql: [
      // Composite index for findings by PR and type
      `CREATE INDEX IF NOT EXISTS idx_findings_pr_type ON findings(pr_number, type)`,
      // Composite index for findings by PR and severity
      `CREATE INDEX IF NOT EXISTS idx_findings_pr_severity ON findings(pr_number, severity)`,
      // Composite index for feedback by PR and signal type
      `CREATE INDEX IF NOT EXISTS idx_feedback_pr_signal ON feedback(pr_number, signal_type)`,
    ],
  },
  {
    version: 9,
    description: 'Add database optimization pragmas for SQLite',
    sql: [
      // Enable WAL mode for better concurrency
      `PRAGMA journal_mode = WAL`,
      // Set busy timeout for concurrent access
      `PRAGMA busy_timeout = 5000`,
      // Optimize synchronous behavior
      `PRAGMA synchronous = NORMAL`,
      // Increase cache size for better performance
      `PRAGMA cache_size = -20000`, // 20MB cache
      // Enable foreign keys (if not already enabled)
      `PRAGMA foreign_keys = ON`,
    ],
  },
];

/**
 * Get the current migration version from the database.
 * @param repo - The database repository.
 * @returns The current migration version.
 */
export async function getCurrentMigrationVersion(repo: { 
  get: <T>(sql: string, params?: unknown[]) => Promise<T | undefined>;
  run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
}): Promise<number> {
  try {
    // Try to get the migration version from the schema_migrations table
    const row = await repo.get<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration version in the database.
 * @param repo - The database repository.
 * @param version - The migration version to record.
 */
export async function recordMigrationVersion(
  repo: { run: (sql: string, params?: unknown[]) => Promise<{ changes: number }> },
  version: number
): Promise<void> {
  await repo.run(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`,
    [version]
  );
}

/**
 * Initialize the schema_migrations table if it doesn't exist.
 * @param repo - The database repository.
 */
export async function initializeMigrationsTable(
  repo: { run: (sql: string, params?: unknown[]) => Promise<{ changes: number }> }
): Promise<void> {
  await repo.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Apply all pending migrations to the database.
 * @param repo - The database repository.
 * @returns The number of migrations applied.
 */
export async function applyMigrations(repo: { 
  run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
  get: <T>(sql: string, params?: unknown[]) => Promise<T | undefined>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<number> {
  await initializeMigrationsTable(repo);
  
  const currentVersion = await getCurrentMigrationVersion(repo);
  let migrationsApplied = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      try {
        for (const sql of migration.sql) {
          await repo.run(sql);
        }
        await recordMigrationVersion(repo, migration.version);
        migrationsApplied++;
      } catch (err) {
        // Log error but continue with other migrations
        console.error(`Failed to apply migration ${migration.version}: ${migration.description}`, err);
      }
    }
  }

  return migrationsApplied;
}

/**
 * Get all migrations that have been applied.
 * @param repo - The database repository.
 * @returns Array of applied migration versions.
 */
export async function getAppliedMigrations(repo: { 
  all: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}): Promise<number[]> {
  try {
    const rows = await repo.all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version ASC'
    );
    return rows.map(row => row.version);
  } catch {
    return [];
  }
}

/**
 * Get all pending migrations (not yet applied).
 * @param repo - The database repository.
 * @returns Array of pending migrations.
 */
export async function getPendingMigrations(repo: { 
  all: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}): Promise<Migration[]> {
  const applied = await getAppliedMigrations(repo);
  const appliedSet = new Set(applied);
  return MIGRATIONS.filter(m => !appliedSet.has(m.version));
}

/**
 * Check if all migrations have been applied.
 * @param repo - The database repository.
 * @returns True if all migrations have been applied.
 */
export async function areAllMigrationsApplied(repo: { 
  all: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}): Promise<boolean> {
  const pending = await getPendingMigrations(repo);
  return pending.length === 0;
}

/**
 * Get the SQL for creating the schema_migrations table.
 * Can be used for initial schema setup.
 */
export function getSchemaMigrationsTableSQL(): string {
  return `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;
}
