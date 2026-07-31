import { SqlAdapter } from './sql-adapter.js';
import type { DbAdapter, SqliteDatabase } from './types.js';

/**
 * SQLite database adapter implementing the DbAdapter interface.
 * Uses a bounded prepared-statement cache backed by better-sqlite3.
 */
export class SqliteAdapter extends SqlAdapter implements DbAdapter {
  private db: SqliteDatabase;
  private stmtCache = new Map<string, ReturnType<SqliteDatabase['prepare']>>();
  private readonly maxCacheSize: number;
  /**
   * Create a new SqliteAdapter.
   * @param db - SQLite database instance.
   * @param maxCacheSize - Maximum prepared statement cache size (default: 100).
   */
  constructor(db: SqliteDatabase, maxCacheSize = 300) {
    super();
    this.db = db;
    this.maxCacheSize = maxCacheSize;
  }

  private prepareStmt(sql: string): ReturnType<SqliteDatabase['prepare']> {
    let stmt = this.stmtCache.get(sql);
    if (stmt) {
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, stmt);
      return stmt;
    }
    const normalized = sql.trim().replace(/\s+/g, ' ');
    if (normalized !== sql) {
      stmt = this.stmtCache.get(normalized);
      if (stmt) {
        this.stmtCache.delete(normalized);
        this.stmtCache.set(normalized, stmt);
        this.stmtCache.set(sql, stmt);
        return stmt;
      }
    }
    // Count unique prepared statements (by object reference) for eviction
    if (this.stmtCache.size >= this.maxCacheSize) {
      const uniqueStmts = new Set(this.stmtCache.values());
      if (uniqueStmts.size >= this.maxCacheSize) {
        const firstKey = this.stmtCache.keys().next().value;
        if (firstKey) this.stmtCache.delete(firstKey);
      }
    }
    stmt = this.db.prepare(normalized);
    this.stmtCache.set(normalized, stmt);
    if (normalized !== sql) {
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Execute a raw SQL statement.
   * @param sql - SQL statement to execute.
   */
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /**
   * Execute a SQL statement and return the number of affected rows.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns Object with the number of changed rows.
   */
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = this.prepareStmt(sql).run(...params);
    return { changes: res.changes };
  }

  /**
   * Execute a SQL query and return all matching rows.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns Array of result rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.prepareStmt(sql).all(...params) as T[];
  }

  /**
   * Execute a SQL query and return the first matching row.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns The first result row, or undefined if no match.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.prepareStmt(sql).get(...params) as T | undefined;
  }

  /**
   * Execute operations within a transaction.
   * @param fn - Async function containing transactional operations.
   * @returns The return value of the transaction function.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const res = await fn();
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    this.db.close();
  }
}
