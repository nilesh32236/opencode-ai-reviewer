import { SqlAdapter, translateQuery } from './sql-adapter.js';
import type { DbAdapter, MysqlConnection } from './types.js';

/**
 * MySQL database adapter implementing the DbAdapter interface.
 * Translates SQLite-flavored SQL to MySQL syntax and executes it via a mysql2 connection.
 */
export class MysqlAdapter extends SqlAdapter implements DbAdapter {
  private connection: MysqlConnection;
  private translateCache = new Map<string, string>();
  private static readonly MAX_TRANSLATE_CACHE = 100;

  /**
   * Create a new MysqlAdapter.
   * @param connection - MySQL connection instance.
   */
  constructor(connection: MysqlConnection) {
    super();
    this.connection = connection;
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
   * @param fn - Async function containing transactional operations.
   * @returns The return value of the transaction function.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.connection.beginTransaction();
    try {
      const res = await fn();
      await this.connection.commit();
      return res;
    } catch (e) {
      await this.connection.rollback();
      throw e;
    }
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    await this.connection.end();
  }
}
