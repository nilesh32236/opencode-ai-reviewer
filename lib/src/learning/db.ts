import * as fs from 'fs';
import * as path from 'path';
import { JsonDatabase } from './json-db.js';

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

class PostgresAdapter implements DbAdapter {
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

class MysqlAdapter implements DbAdapter {
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

class SqliteAdapter implements DbAdapter {
  private db: SqliteDatabase;
  private stmtCache = new Map<string, ReturnType<SqliteDatabase['prepare']>>();

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  private prepareStmt(sql: string): ReturnType<SqliteDatabase['prepare']> {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
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

class JsonDbAdapter implements DbAdapter {
  private db: JsonDatabase;

  constructor(db: JsonDatabase) {
    this.db = db;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.db.prepare(sql).run(...params);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const backup = JSON.stringify(this.db.data);
    try {
      const res = await fn();
      return res;
    } catch (e) {
      this.db.data = JSON.parse(backup);
      this.db.save();
      throw e;
    }
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
      throw new Error(`Failed to connect to PostgreSQL: ${e}`);
    }
  }

  if (dbPathOrUrl.startsWith('mysql://')) {
    try {
      const mysql = req('mysql2/promise');
      const connection = await mysql.createConnection(dbPathOrUrl);
      return new MysqlAdapter(connection);
    } catch (e) {
      throw new Error(`Failed to connect to MySQL: ${e}`);
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
  } catch (_e) {
    // Falls back to JSON database if better-sqlite3 cannot be loaded
    const jsonPath = dbPathOrUrl.endsWith('.db')
      ? dbPathOrUrl.replace(/\.db$/, '.json')
      : dbPathOrUrl;
    const db = new JsonDatabase(jsonPath);
    return new JsonDbAdapter(db);
  }
}
