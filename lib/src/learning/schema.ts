import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), '.opencode', 'learning.db');

export function getDbPath(): string {
  return DB_PATH;
}

export function getDatabase(dbPath = DB_PATH): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  return db;
}

export function applyMigrations(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        type TEXT NOT NULL,
        severity TEXT,
        file TEXT,
        line INTEGER,
        message TEXT NOT NULL,
        suggestion TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        signal_value TEXT,
        pr_number INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (finding_id) REFERENCES findings(id)
      );

      CREATE TABLE IF NOT EXISTS review_quality (
        id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        actionability_score REAL NOT NULL,
        accuracy_score REAL NOT NULL,
        coverage_score REAL NOT NULL,
        consistency_score REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        pattern_key TEXT NOT NULL UNIQUE,
        message_cluster TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        file_types TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_rules (
        id TEXT PRIMARY KEY,
        rule_text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL DEFAULT 'pending',
        approved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS prompt_overrides (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        override_text TEXT NOT NULL,
        false_positive_rate_before REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS meta_review_counter (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        count INTEGER NOT NULL DEFAULT 0
      );
    `);
  });
  migrate();

  const row = db.prepare('SELECT count FROM meta_review_counter WHERE id = 1').get() as { count: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta_review_counter (id, count) VALUES (1, 0)').run();
  }
}

export function generateId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
