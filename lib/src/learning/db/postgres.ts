import { SqlAdapter, translateQuery } from './sql-adapter.js';
import type { DbAdapter, PostgresClient } from './types.js';

export class PostgresAdapter extends SqlAdapter implements DbAdapter {
  private client: PostgresClient;
  private translateCache = new Map<string, string>();
  private static readonly MAX_TRANSLATE_CACHE = 100;

  /**
   * Create a new PostgresAdapter.
   * @param client - Postgres client instance.
   */
  constructor(client: PostgresClient) {
    super();
    this.client = client;
  }

  private cachedTranslate(sql: string): string {
    let translated = this.translateCache.get(sql);
    if (translated) {
      this.translateCache.delete(sql);
      this.translateCache.set(sql, translated);
      return translated;
    }
    if (this.translateCache.size >= PostgresAdapter.MAX_TRANSLATE_CACHE) {
      const firstKey = this.translateCache.keys().next().value;
      if (firstKey) this.translateCache.delete(firstKey);
    }
    translated = translateQuery(sql, 'postgres');
    this.translateCache.set(sql, translated);
    return translated;
  }

  /**
   * Execute a raw SQL statement.
   * @param sql - SQL statement to execute.
   */
  async exec(sql: string): Promise<void> {
    const pgSql = this.cachedTranslate(sql);
    await this.client.query(pgSql);
  }

  /**
   * Execute a SQL statement and return the number of affected rows.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns Object with the number of changed rows.
   */
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const pgSql = this.cachedTranslate(sql);
    const res = await this.client.query(pgSql, params);
    return { changes: res.rowCount ?? 0 };
  }

  /**
   * Execute a SQL query and return all matching rows.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns Array of result rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pgSql = this.cachedTranslate(sql);
    const res = await this.client.query(pgSql, params);
    return res.rows as T[];
  }

  /**
   * Execute a SQL query and return the first matching row.
   * @param sql - SQL statement to execute.
   * @param params - Query parameters.
   * @returns The first result row, or undefined if no match.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const pgSql = this.cachedTranslate(sql);
    const res = await this.client.query(pgSql, params);
    return res.rows[0] as T | undefined;
  }

  /**
   * Execute operations within a transaction.
   * @param fn - Async function containing transactional operations.
   * @returns The return value of the transaction function.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const res = await fn();
      await this.client.query('COMMIT');
      return res;
    } catch (e) {
      await this.client.query('ROLLBACK');
      throw e;
    }
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    await this.client.end();
  }
}
