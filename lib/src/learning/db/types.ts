import type { LearningRepository } from '../types.js';

export type { LearningRepository };

/**
 * Low-level database adapter interface.
 * @deprecated Use `LearningRepository` instead. This interface will be removed
 * in a future release. Callers should migrate to `LearningRepository` methods
 * directly. Tracked in #123.
 */
export interface DbAdapter {
  /**
   * Execute a raw SQL statement.
   * @param sql - SQL statement to execute.
   * @returns A promise that resolves when execution completes.
   */
  exec(sql: string): Promise<void>;
  /**
   * Execute a SQL statement and return the number of affected rows.
   * @param sql - SQL statement to execute.
   * @param params - Optional parameters for the SQL statement.
   * @returns Object with the number of changed rows.
   */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /**
   * Execute a SQL query and return all matching rows.
   * @param sql - SQL statement to execute.
   * @param params - Optional parameters for the SQL statement.
   * @returns Array of result rows.
   */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Execute a SQL query and return the first matching row.
   * @param sql - SQL statement to execute.
   * @param params - Optional parameters for the SQL statement.
   * @returns The first result row, or undefined if no match.
   */
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /**
   * Execute operations within a transaction.
   * @param fn - Async function containing transactional operations.
   * @returns The return value of the transaction function.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Close the database connection.
   * @returns A promise that resolves when the connection is closed.
   */
  close(): Promise<void>;
}

export interface PostgresClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
  end(): Promise<void>;
}

export interface MysqlConnection {
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>;
  end(): Promise<void>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}
