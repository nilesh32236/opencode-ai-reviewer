/**
 * PostgreSQL client + migration runner for the platform.
 *
 * A single `pg` Pool serves the whole platform. Migrations are applied at boot
 * from numbered `.sql` files in `db/`, tracked in a `schema_migrations` table
 * so they run exactly once per database. Wrapped in `withRetry` so a not-yet-
 * ready database (e.g. the Postgres container still starting) does not crash
 * the platform at boot.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Logger, withRetry } from '@opencode-pr-agent/lib';
import pg from 'pg';

const logger = new Logger('PlatformDb');

/** Query result row type (loosely typed — callers assert their own shapes). */
export type DbRow = Record<string, unknown>;

/** Minimal task row shape used by the queue/worker (extend as needed). */
export interface TaskRow extends Record<string, unknown> {
  id: string;
  repo_id: string | null;
  repo: string | null;
  type: string;
  status: string;
  priority: number;
  pr_number: number | null;
  head_sha: string | null;
  workspace_path: string | null;
  result_data: unknown;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Database handle wrapping a pg Pool with typed helpers. */
export class PlatformDb {
  private readonly pool: pg.Pool;

  /**
   * Create the platform database handle.
   * @param connectionString - PostgreSQL connection URL.
   */
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  /**
   * Run a query and return all rows.
   * @param sql - SQL statement.
   * @param params - Query parameters.
   * @returns The matching rows.
   */
  async query<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  /**
   * Run a query and return a single row (or undefined when none match).
   * @param sql - SQL statement.
   * @param params - Query parameters.
   * @returns The first row, or undefined.
   */
  async queryOne<T extends DbRow = DbRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  /**
   * Run a statement that does not return rows.
   * @param sql - SQL statement.
   * @param params - Query parameters.
   */
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(sql, params);
  }

  /**
   * Check database connectivity with a lightweight query.
   * @returns True when the database responds.
   */
  async ping(): Promise<boolean> {
    try {
      const rows = await this.query<DbRow>('SELECT 1 AS ok');
      return rows.length === 1;
    } catch (err) {
      logger.warn(`Database ping failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Apply pending migrations from the `db` directory, tracked in
   * `schema_migrations`. Idempotent: already-applied migrations are skipped.
   * @param migrationsDir - Directory containing numbered `NNN-*.sql` files.
   */
  async migrate(migrationsDir: string): Promise<void> {
    await this.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const applied = new Set(
      (await this.query<DbRow>('SELECT version FROM schema_migrations')).map((r) =>
        String(r.version),
      ),
    );

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(migrationsDir, file), 'utf-8');
      // Run each migration inside a transaction so a failure never leaves a
      // half-applied schema.
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`Applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        client.release();
      }
    }
  }

  /**
   * Close the connection pool (for graceful shutdown).
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Connect to the database with retry, apply migrations, and return the handle.
 * @param connectionString - PostgreSQL connection URL.
 * @param migrationsDir - Directory of numbered `NNN-*.sql` migration files.
 * Defaults to the bundled `dist/db/migrations` directory (copied at build).
 * @returns A connected, migrated PlatformDb.
 */
export async function connectPlatformDb(
  connectionString: string,
  migrationsDir?: string,
): Promise<PlatformDb> {
  const db = new PlatformDb(connectionString);
  // Default resolves relative to the compiled output so it works in both dev
  // (src copied by postbuild) and the container (dist shipped in the image).
  const dir = migrationsDir ?? path.join(__dirname, 'migrations');
  // Retry with backoff so a starting Postgres container does not crash boot.
  await withRetry(
    async () => {
      const ok = await db.ping();
      if (!ok) throw new Error('Database not ready');
    },
    {
      maxRetries: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      retryUnknownStatus: true,
      operationName: 'platform-db-connect',
    },
  );
  await db.migrate(dir);
  return db;
}
