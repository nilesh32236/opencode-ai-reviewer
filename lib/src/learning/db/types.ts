import type { LearningRepository } from '../types.js';

export type { LearningRepository };

/**
 * Low-level database adapter interface.
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

/**
 * Minimal PostgreSQL client interface (subset of the `pg` package).
 */
export interface PostgresClient {
  /**
   * Establish the database connection.
   * @returns A promise that resolves once connected.
   */
  connect(): Promise<void>;
  /**
   * Execute a SQL query.
   * @param sql - SQL statement to execute.
   * @param params - Optional query parameters.
   * @returns The query result containing the affected row count and returned rows.
   */
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
  /**
   * Close the database connection.
   * @returns A promise that resolves once closed.
   */
  end(): Promise<void>;
}

/**
 * Minimal MySQL connection interface (subset of the `mysql2/promise` package).
 */
export interface MysqlConnection {
  /**
   * Execute a SQL query.
   * @param sql - SQL statement to execute.
   * @param params - Optional query parameters.
   * @returns A tuple of the result rows and the result metadata.
   */
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>;
  /**
   * Close the database connection.
   * @returns A promise that resolves once closed.
   */
  end(): Promise<void>;
  /**
   * Begin a transaction.
   * @returns A promise that resolves once the transaction begins.
   */
  beginTransaction(): Promise<void>;
  /**
   * Commit the current transaction.
   * @returns A promise that resolves once committed.
   */
  commit(): Promise<void>;
  /**
   * Roll back the current transaction.
   * @returns A promise that resolves once rolled back.
   */
  rollback(): Promise<void>;
}

/**
 * Minimal SQLite database interface (subset of the `better-sqlite3` package).
 */
export interface SqliteDatabase {
  /**
   * Execute raw SQL statements.
   * @param sql - SQL statement(s) to execute.
   */
  exec(sql: string): void;
  /**
   * Run a pragma statement.
   * @param sql - Pragma statement to run.
   * @returns The pragma result.
   */
  pragma(sql: string): unknown;
  /**
   * Prepare a SQL statement for repeated execution.
   * @param sql - SQL statement to prepare.
   * @returns A prepared statement object.
   */
  prepare(sql: string): {
    /**
     * Execute the statement with the given bind parameters.
     * @param params - Bind parameters.
     * @returns The number of changed rows.
     */
    run(...params: unknown[]): { changes: number };
    /**
     * Execute the statement and return all matching rows.
     * @param params - Bind parameters.
     * @returns Array of result rows.
     */
    all(...params: unknown[]): unknown[];
    /**
     * Execute the statement and return the first matching row.
     * @param params - Bind parameters.
     * @returns The first result row, or undefined if no match.
     */
    get(...params: unknown[]): unknown;
  };
  /**
   * Close the database.
   */
  close(): void;
}
