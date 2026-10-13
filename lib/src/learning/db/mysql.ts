import { SqlAdapter, translateQuery } from './sql-adapter.js';
import type { DbAdapter, MysqlConnection, MysqlPool } from './types.js';

/**
 * MySQL database adapter implementing the DbAdapter interface.
 * Translates SQLite-flavored SQL to MySQL syntax and executes it via a mysql2 connection.
 *
 * Single-connection mode serializes all transactions behind a promise-chain
 * mutex (see {@link SqlAdapter.serializeTransaction}) because two concurrent
 * BEGIN/COMMIT sequences cannot interleave on one connection — throughput is
 * capped at one transaction at a time by design. For concurrent reviews,
 * pass a `mysql2/promise` Pool instead: non-transactional queries run
 * directly on the pool and each transaction checks out a dedicated
 * connection, so transactions no longer single-flight each other.
 */
export class MysqlAdapter extends SqlAdapter implements DbAdapter {
  private connection: MysqlConnection | MysqlPool;
  private translateCache = new Map<string, string>();
  private static readonly MAX_TRANSLATE_CACHE = 100;

  /**
   * Create a new MysqlAdapter.
   * @param connection - MySQL connection instance, or a mysql2/promise Pool
   * for concurrent workloads (backward-compatible: a single connection
   * behaves exactly as before).
   */
  constructor(connection: MysqlConnection | MysqlPool) {
    super();
    this.connection = connection;
  }

  /**
   * Whether the backing handle is a pool (has `getConnection`).
   * @returns True when a pool was provided.
   */
  private isPool(): boolean {
    return (
      typeof (this.connection as MysqlPool).getConnection === 'function' &&
      typeof this.connection.execute === 'function'
    );
  }

  private cachedTranslate(sql: string): string {
    let translated = this.translateCache.get(sql);
    if (translated) {
      this.translateCache.delete(sql);
      this.translateCache.set(sql, translated);
      return translated;
    }
    if (this.translateCache.size >= MysqlAdapter.MAX_TRANSLATE_CACHE) {
      const firstKey = this.translateCache.keys().next().value;
      if (firstKey) this.translateCache.delete(firstKey);
    }
    translated = translateQuery(sql, 'mysql');
    this.translateCache.set(sql, translated);
    return translated;
  }

  /**
   * Execute a raw SQL statement.
   * @param sql - SQL statement to execute.
   */
  async exec(sql: string): Promise<void> {
    const mysqlSql = this.cachedTranslate(sql);
    await this.connection.execute(mysqlSql);
  }

  /**
   * Execute a SQL statement and return the number of affected rows.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns Object with the number of changed rows.
   */
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const mysqlSql = this.cachedTranslate(sql);
    const [result] = await this.connection.execute(mysqlSql, params);
    const affectedRows = (result as { affectedRows?: number })?.affectedRows ?? 0;
    return { changes: affectedRows };
  }

  /**
   * Execute a SQL query and return all matching rows.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns Array of result rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const mysqlSql = this.cachedTranslate(sql);
    const [rows] = await this.connection.execute(mysqlSql, params);
    return rows as T[];
  }

  /**
   * Execute a SQL query and return the first matching row.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns The first result row, or undefined if no match.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const mysqlSql = this.cachedTranslate(sql);
    const [rows] = await this.connection.execute(mysqlSql, params);
    return (rows as T[])[0];
  }

  /**
   * Execute operations within a transaction.
   *
   * Single-connection mode serializes behind a promise-chain mutex so
   * concurrent callers never interleave begin/commit on the one shared
   * connection (one transaction at a time by design). Pool mode checks out a
   * dedicated connection per transaction, so concurrent transactions proceed
   * in parallel up to the pool size.
   * @param fn - Async function containing transactional operations.
   * @returns The return value of the transaction function.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isPool()) {
      const pool = this.connection as MysqlPool;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        try {
          const res = await fn();
          await conn.commit();
          return res;
        } catch (e) {
          try {
            await conn.rollback();
          } catch (rollbackErr) {
            // Preserve the root cause: a failed rollback must never mask the
            // original error that triggered it.
            (e as Error & { suppressed?: unknown }).suppressed = rollbackErr;
          }
          throw e;
        }
      } finally {
        conn.release();
      }
    }
    return this.serializeTransaction(async () => {
      const conn = this.connection as MysqlConnection;
      await conn.beginTransaction();
      try {
        const res = await fn();
        await conn.commit();
        return res;
      } catch (e) {
        try {
          await conn.rollback();
        } catch (rollbackErr) {
          // Preserve the root cause: a failed rollback must never mask the
          // original error that triggered it.
          (e as Error & { suppressed?: unknown }).suppressed = rollbackErr;
        }
        throw e;
      }
    });
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    await this.connection.end();
  }
}
