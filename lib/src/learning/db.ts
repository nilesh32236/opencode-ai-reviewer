import * as fs from 'fs';
import * as path from 'path';
import { JsonDatabase } from './json-db.js';

export function sanitizeDbError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/([a-z][a-z0-9+.-]+:\/\/)[^@\s]+@/gi, '$1<redacted>@');
}

// @ts-ignore
const req =
  typeof require !== 'undefined'
    ? require
    : (moduleName: string) => {
        throw new Error(`Dynamic require not supported for ${moduleName}`);
      };

export interface DbAdapter {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PostgresClient {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
  end(): Promise<void>;
}

interface MysqlConnection {
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>;
  end(): Promise<void>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

// Translate SQLite query to Postgres/MySQL if needed
function translateQuery(sql: string, dialect: 'postgres' | 'mysql' | 'sqlite'): string {
  let cleanSql = sql.trim().replace(/\s+/g, ' ');
  if (dialect === 'postgres') {
    let index = 1;
    cleanSql = cleanSql.replace(/\?/g, () => `$${index++}`);
    cleanSql = cleanSql.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');
    if (
      cleanSql.startsWith('INSERT OR REPLACE INTO findings') ||
      cleanSql.startsWith('INSERT INTO findings')
    ) {
      cleanSql = `INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                  ON CONFLICT (id) DO UPDATE SET
                    pr_number = EXCLUDED.pr_number,
                    type = EXCLUDED.type,
                    severity = EXCLUDED.severity,
                    file = EXCLUDED.file,
                    line = EXCLUDED.line,
                    message = EXCLUDED.message,
                    suggestion = EXCLUDED.suggestion`;
    }
  } else if (dialect === 'mysql') {
    cleanSql = cleanSql.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');
  }
  return cleanSql;
}

export class PostgresAdapter implements DbAdapter {
  private client: PostgresClient;

  constructor(client: PostgresClient) {
    this.client = client;
  }

  async exec(sql: string): Promise<void> {
    const pgSql = translateQuery(sql, 'postgres');
    await this.client.query(pgSql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const pgSql = translateQuery(sql, 'postgres');
    const res = await this.client.query(pgSql, params);
    return { changes: res.rowCount ?? 0 };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pgSql = translateQuery(sql, 'postgres');
    const res = await this.client.query(pgSql, params);
    return res.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const pgSql = translateQuery(sql, 'postgres');
    const res = await this.client.query(pgSql, params);
    return res.rows[0] as T | undefined;
  }

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

  async close(): Promise<void> {
    await this.client.end();
  }
}

export class MysqlAdapter implements DbAdapter {
  private connection: MysqlConnection;

  constructor(connection: MysqlConnection) {
    this.connection = connection;
  }

  async exec(sql: string): Promise<void> {
    const mysqlSql = translateQuery(sql, 'mysql');
    await this.connection.execute(mysqlSql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const mysqlSql = translateQuery(sql, 'mysql');
    const [result] = await this.connection.execute(mysqlSql, params);
    const affectedRows = (result as { affectedRows?: number })?.affectedRows ?? 0;
    return { changes: affectedRows };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const mysqlSql = translateQuery(sql, 'mysql');
    const [rows] = await this.connection.execute(mysqlSql, params);
    return rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const mysqlSql = translateQuery(sql, 'mysql');
    const [rows] = await this.connection.execute(mysqlSql, params);
    return (rows as T[])[0];
  }

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

  async close(): Promise<void> {
    await this.connection.end();
  }
}

export class SqliteAdapter implements DbAdapter {
  private db: SqliteDatabase;
  private stmtCache = new Map<string, ReturnType<SqliteDatabase['prepare']>>();
  private readonly MAX_CACHE_SIZE = 100;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  private prepareStmt(sql: string): ReturnType<SqliteDatabase['prepare']> {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    let stmt = this.stmtCache.get(normalized);
    if (!stmt) {
      if (this.stmtCache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.stmtCache.keys().next().value;
        if (firstKey) this.stmtCache.delete(firstKey);
      }
      stmt = this.db.prepare(normalized);
      this.stmtCache.set(normalized, stmt);
    } else {
      this.stmtCache.delete(normalized);
      this.stmtCache.set(normalized, stmt);
    }
    return stmt;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = this.prepareStmt(sql).run(...params);
    return { changes: res.changes };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.prepareStmt(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.prepareStmt(sql).get(...params) as T | undefined;
  }

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

  async close(): Promise<void> {
    this.db.close();
  }
}

export class JsonDbAdapter implements DbAdapter {
  private db: JsonDatabase;

  constructor(db: JsonDatabase) {
    this.db = db;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.dispatch(sql, params);
    return { changes: result.changes ?? 0 };
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = this.db.dispatch(sql, params);
    return (result.rows ?? []) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = this.db.dispatch(sql, params);
    return (result.row ?? (result.rows as T[] | undefined)?.[0]) as T | undefined;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const txn = this.db.transaction(fn);
    return txn();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function connectDb(dbPathOrUrl: string): Promise<DbAdapter> {
  if (dbPathOrUrl.startsWith('postgres://') || dbPathOrUrl.startsWith('postgresql://')) {
    try {
      const { Client } = req('pg');
      const client = new Client({ connectionString: dbPathOrUrl });
      await client.connect();
      return new PostgresAdapter(client);
    } catch (e) {
      throw new Error(`Failed to connect to PostgreSQL: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (dbPathOrUrl.startsWith('mysql://')) {
    try {
      const mysql = req('mysql2/promise');
      const connection = await mysql.createConnection(dbPathOrUrl);
      return new MysqlAdapter(connection);
    } catch (e) {
      throw new Error(`Failed to connect to MySQL: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Fallback to SQLite or JSON
  try {
    const Database = req('better-sqlite3');
    const dir = path.dirname(dbPathOrUrl);
    if (dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new Database(dbPathOrUrl);
    db.pragma('journal_mode = WAL');
    return new SqliteAdapter(db);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const isMissingDriver =
      errMsg.includes('Cannot find module') ||
      errMsg.includes('Module not found') ||
      errMsg.includes('Could not locate the bindings file') ||
      errMsg.includes('Cannot locate the bindings file') ||
      errMsg.includes('require');
    if (!isMissingDriver) {
      throw e;
    }
    console.warn(
      `better-sqlite3 not available: ${sanitizeDbError(e)}. Falling back to JSON database`,
    );
    const jsonPath = dbPathOrUrl.endsWith('.db')
      ? dbPathOrUrl.replace(/\.db$/, '.json')
      : dbPathOrUrl;
    const db = new JsonDatabase(jsonPath);
    return new JsonDbAdapter(db);
  }
}
