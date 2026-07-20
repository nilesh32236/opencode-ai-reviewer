import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JsonDatabase } from '../src/learning/json-db.js';
import {
  type DbAdapter,
  MysqlAdapter,
  PostgresAdapter,
  JsonDbAdapter,
  SqliteAdapter,
  connectDb,
} from '../src/learning/db.js';

// ---------------------------------------------------------------------------
// JSON DB Adapter tests
// ---------------------------------------------------------------------------
describe('JsonDatabase', () => {
  let dbPath: string;
  let jsonDb: JsonDatabase;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'json-db-test-')), 'test.json');
    jsonDb = new JsonDatabase(dbPath);
  });

  afterEach(async () => {
    await jsonDb.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it('exec ignores CREATE TABLE statements', () => {
    jsonDb.exec('CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY)');
    expect(jsonDb.data.findings).toEqual([]);
  });

  describe('run (INSERT)', () => {
    it('inserts a finding', () => {
      const result = jsonDb.handleSql(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f1', 1, 'issue', 'critical', 'src/a.ts', 10, 'msg', 'suggestion'],
      );
      expect(result.changes).toBe(1);
      expect(jsonDb.data.findings).toHaveLength(1);
      expect(jsonDb.data.findings[0].id).toBe('f1');
    });

    it('inserts feedback', () => {
      jsonDb.handleSql(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f1', 1, 'issue', 'critical', 'a.ts', 1, 'msg', null],
      );
      const result = jsonDb.handleSql(
        'INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number) VALUES (?, ?, ?, ?, ?)',
        ['fb1', 'f1', 'dismissed', 'fp', 1],
      );
      expect(result.changes).toBe(1);
      expect(jsonDb.data.feedback).toHaveLength(1);
    });

    it('inserts review quality', () => {
      const result = jsonDb.handleSql(
        'INSERT INTO review_quality (id, pr_number, actionability_score, accuracy_score, coverage_score, consistency_score) VALUES (?, ?, ?, ?, ?, ?)',
        ['rq1', 1, 80, 90, 70, 85],
      );
      expect(result.changes).toBe(1);
      expect(jsonDb.data.review_quality).toHaveLength(1);
    });

    it('inserts custom rule', () => {
      const result = jsonDb.handleSql(
        'INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)',
        ['cr1', 'Always handle errors', 'auto', 'pending'],
      );
      expect(result.changes).toBe(1);
      expect(jsonDb.data.custom_rules).toHaveLength(1);
    });

    it('inserts prompt override', () => {
      const result = jsonDb.handleSql(
        'INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before) VALUES (?, ?, ?, ?)',
        ['po1', 'general', 'Be thorough', 0.15],
      );
      expect(result.changes).toBe(1);
      expect(jsonDb.data.prompt_overrides).toHaveLength(1);
    });

    it('inserts pattern', () => {
      const result = jsonDb.handleSql(
        'INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
        ['p1', 'missing-errors', '["Missing error"]', 3, '.ts'],
      );
      expect(result.changes).toBe(1);
      expect(jsonDb.data.patterns).toHaveLength(1);
    });

    it('inserts meta_review_counter only once', () => {
      jsonDb.handleSql('INSERT INTO meta_review_counter (id, count) VALUES (1, 0)');
      expect(jsonDb.data.meta_review_counter).toHaveLength(1);
      const result = jsonDb.handleSql('INSERT INTO meta_review_counter (id, count) VALUES (1, 0)');
      expect(result.changes).toBe(0);
    });
  });

  describe('run (DELETE)', () => {
    beforeEach(() => {
      jsonDb.handleSql(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f1', 1, 'issue', 'minor', 'a.ts', 1, 'msg', null],
      );
      jsonDb.handleSql(
        'INSERT INTO feedback (id, finding_id, signal_type, signal_value, pr_number) VALUES (?, ?, ?, ?, ?)',
        ['fb1', 'f1', 'dismissed', 'fp', 1],
      );
    });

    it('deletes feedback by PR number', () => {
      const result = jsonDb.handleSql('DELETE FROM feedback WHERE pr_number = ?', [1]);
      expect(result.changes).toBe(1);
      expect(jsonDb.data.feedback).toHaveLength(0);
    });

    it('deletes findings by PR number', () => {
      const result = jsonDb.handleSql('DELETE FROM findings WHERE pr_number = ?', [1]);
      expect(result.changes).toBe(1);
      expect(jsonDb.data.findings).toHaveLength(0);
    });

    it('returns 0 when no matching PR', () => {
      const result = jsonDb.handleSql('DELETE FROM findings WHERE pr_number = ?', [999]);
      expect(result.changes).toBe(0);
    });
  });

  describe('run (UPDATE)', () => {
    beforeEach(() => {
      jsonDb.handleSql(
        'INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)',
        ['cr1', 'Test rule', 'auto', 'pending'],
      );
      jsonDb.handleSql(
        'INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
        ['p1', 'test-pattern', '["msg"]', 1, '.ts'],
      );
    });

    it('updates meta_review_counter', () => {
      jsonDb.handleSql('UPDATE meta_review_counter SET count = ? WHERE id = 1', [5]);
      expect(jsonDb.data.meta_review_counter[0].count).toBe(5);
    });

    it('resets meta_review_counter', () => {
      jsonDb.handleSql('UPDATE meta_review_counter SET count = 5 WHERE id = 1', [5]);
      jsonDb.handleSql('UPDATE meta_review_counter SET count = 0 WHERE id = 1');
      expect(jsonDb.data.meta_review_counter[0].count).toBe(0);
    });

    it('approves custom rule', () => {
      jsonDb.handleSql('UPDATE custom_rules SET status = \'active\', approved_at = datetime(\'now\') WHERE id = ?', ['cr1']);
      expect(jsonDb.data.custom_rules[0].status).toBe('active');
      expect(jsonDb.data.custom_rules[0].approved_at).toBeTruthy();
    });

    it('declines custom rule', () => {
      jsonDb.handleSql('UPDATE custom_rules SET status = \'declined\' WHERE id = ?', ['cr1']);
      expect(jsonDb.data.custom_rules[0].status).toBe('declined');
    });

    it('updates pattern frequency', () => {
      jsonDb.handleSql('UPDATE patterns SET frequency = ?, last_seen = datetime(\'now\'), file_types = ? WHERE pattern_key = ?', [3, '.ts,.js', 'test-pattern']);
      expect(jsonDb.data.patterns[0].frequency).toBe(3);
    });
  });

  describe('get (SELECT single row)', () => {
    it('retrieves meta_review_counter', () => {
      const result = jsonDb.handleSql('SELECT count FROM meta_review_counter WHERE id = 1');
      expect(result.row).toBeDefined();
      expect((result.row as { count: number }).count).toBe(0);
    });

    it('retrieves feedback count', () => {
      const result = jsonDb.handleSql('SELECT COUNT(*) as count FROM feedback');
      expect((result.row as { count: number }).count).toBe(0);
    });

    it('retrieves pattern by key', () => {
      jsonDb.handleSql(
        'INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
        ['p1', 'unique-key', '["msg"]', 2, '.ts'],
      );
      const result = jsonDb.handleSql('SELECT id, frequency FROM patterns WHERE pattern_key = ?', ['unique-key']);
      expect(result.row).toBeDefined();
      expect((result.row as { id: string; frequency: number }).frequency).toBe(2);
    });

    it('returns undefined for missing pattern', () => {
      const result = jsonDb.handleSql('SELECT id, frequency FROM patterns WHERE pattern_key = ?', ['nonexistent']);
      expect(result.row).toBeUndefined();
    });
  });

  describe('all (SELECT multiple rows)', () => {
    beforeEach(() => {
      jsonDb.handleSql(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f1', 1, 'issue', 'minor', 'a.ts', 1, 'Issue A', null],
      );
      jsonDb.handleSql(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f2', 1, 'strength', null, 'b.ts', 2, 'Strength A', null],
      );
      jsonDb.handleSql(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f3', 2, 'issue', 'critical', 'c.ts', 3, 'Issue B', null],
      );
    });

    it('gets findings by type', () => {
      const result = jsonDb.handleSql('SELECT * FROM findings WHERE type = ? ORDER BY created_at DESC LIMIT ?', ['issue', 10]);
      expect(result.rows).toHaveLength(2);
    });

    it('gets findings by PR number', () => {
      const result = jsonDb.handleSql('SELECT * FROM findings WHERE pr_number = ? ORDER BY created_at DESC LIMIT ?', [1, 10]);
      expect(result.rows).toHaveLength(2);
    });

    it('gets all findings with limit', () => {
      const result = jsonDb.handleSql('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?', [2]);
      expect(result.rows).toHaveLength(2);
    });

    it('gets active custom rules', () => {
      jsonDb.handleSql(
        'INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)',
        ['cr1', 'Active rule', 'auto', 'active'],
      );
      jsonDb.handleSql(
        'INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)',
        ['cr2', 'Pending rule', 'manual', 'pending'],
      );
      const result = jsonDb.handleSql("SELECT rule_text FROM custom_rules WHERE status = 'active'");
      expect(result.rows).toHaveLength(1);
    });

    it('gets prompt overrides by category', () => {
      jsonDb.handleSql(
        'INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before) VALUES (?, ?, ?, ?)',
        ['po1', 'general', 'General override', 0.1],
      );
      const result = jsonDb.handleSql("SELECT override_text FROM prompt_overrides WHERE category = 'general'");
      expect(result.rows).toHaveLength(1);
    });

    it('gets prompt overrides by IN clause', () => {
      jsonDb.handleSql(
        'INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before) VALUES (?, ?, ?, ?)',
        ['po1', '.ts', 'TS override', 0.1],
      );
      jsonDb.handleSql(
        'INSERT INTO prompt_overrides (id, category, override_text, false_positive_rate_before) VALUES (?, ?, ?, ?)',
        ['po2', '.js', 'JS override', 0.1],
      );
      const result = jsonDb.handleSql('SELECT override_text FROM prompt_overrides WHERE category IN (?, ?)', ['.ts', '.js']);
      expect(result.rows).toHaveLength(2);
    });

    it('gets patterns by frequency', () => {
      jsonDb.handleSql(
        'INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
        ['p1', 'freq3', '["msg"]', 3, '.ts'],
      );
      jsonDb.handleSql(
        'INSERT INTO patterns (id, pattern_key, message_cluster, frequency, file_types, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
        ['p2', 'freq1', '["msg"]', 1, '.ts'],
      );
      const result = jsonDb.handleSql('SELECT * FROM patterns WHERE frequency >= ? ORDER BY frequency DESC', [2]);
      expect(result.rows).toHaveLength(1);
    });

    it('gets pending custom rules', () => {
      jsonDb.handleSql(
        'INSERT INTO custom_rules (id, rule_text, source, status) VALUES (?, ?, ?, ?)',
        ['cr1', 'Pending', 'auto', 'pending'],
      );
      const result = jsonDb.handleSql("SELECT * FROM custom_rules WHERE status = 'pending'");
      expect(result.rows).toHaveLength(1);
    });

    it('gets finding messages', () => {
      const result = jsonDb.handleSql('SELECT message, file FROM findings ORDER BY created_at DESC LIMIT ?', [10]);
      expect(result.rows).toHaveLength(3);
      expect((result.rows as Array<{ message: string }>)[0].message).toBeTruthy();
    });
  });

  describe('transaction', () => {
    it('commits changes on success', async () => {
      const fn = () => {
        jsonDb.handleSql(
          'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ['t1', 1, 'issue', 'minor', 'a.ts', 1, 'transactional', null],
        );
      };
      const txn = jsonDb.transaction(fn);
      txn();
      expect(jsonDb.data.findings).toHaveLength(1);
    });

    it('rolls back changes on error', async () => {
      const fn = () => {
        jsonDb.handleSql(
          'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ['t1', 1, 'issue', 'minor', 'a.ts', 1, 'will-rollback', null],
        );
        throw new Error('rollback');
      };
      const txn = jsonDb.transaction(fn);
      expect(() => txn()).toThrow('rollback');
      expect(jsonDb.data.findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// JsonDbAdapter tests
// ---------------------------------------------------------------------------
describe('JsonDbAdapter', () => {
  let dbPath: string;
  let jsonDb: JsonDatabase;
  let adapter: JsonDbAdapter;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'json-adapter-test-')), 'test.json');
    jsonDb = new JsonDatabase(dbPath);
    adapter = new JsonDbAdapter(jsonDb);
  });

  afterEach(async () => {
    await adapter.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it('run inserts a finding', async () => {
    const result = await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f1', 1, 'issue', 'critical', 'a.ts', 10, 'test', null],
    );
    expect(result.changes).toBe(1);
  });

  it('get retrieves a row', async () => {
    await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f1', 1, 'issue', 'minor', 'a.ts', 1, 'msg', null],
    );
    const row = await adapter.get<{ message: string }>(
      'SELECT message, file FROM findings ORDER BY created_at DESC LIMIT ?',
      [1],
    );
    expect(row).toBeDefined();
    expect(row!.message).toBe('msg');
  });

  it('all retrieves multiple rows', async () => {
    await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f1', 1, 'issue', 'minor', 'a.ts', 1, 'A', null],
    );
    await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f2', 1, 'issue', 'minor', 'b.ts', 2, 'B', null],
    );
    const rows = await adapter.all<{ message: string }>('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?', [10]);
    expect(rows).toHaveLength(2);
  });

  it('exec handles CREATE TABLE', async () => {
    await adapter.exec('CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY)');
    // Should not throw
  });

  it('transaction commits changes', async () => {
    await adapter.transaction(async () => {
      await adapter.run(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['t1', 99, 'issue', 'minor', 'a.ts', 1, 'txn', null],
      );
    });
    const rows = await adapter.all('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?', [10]);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SqliteAdapter tests (requires better-sqlite3)
// ---------------------------------------------------------------------------
describe('SqliteAdapter', () => {
  let dbPath: string;
  let adapter: DbAdapter;

  beforeEach(async () => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-adapter-test-')), 'test.db');
    adapter = await connectDb(dbPath);
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      /* ok */
    }
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it('exec creates tables and run inserts data', async () => {
    await adapter.exec(
      'CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, pr_number INTEGER, type TEXT, severity TEXT, file TEXT, line INTEGER, message TEXT, suggestion TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    );
    await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f1', 1, 'issue', 'critical', 'a.ts', 10, 'test msg', null],
    );
    const rows = await adapter.all<{ id: string; message: string }>(
      'SELECT id, message FROM findings ORDER BY created_at DESC LIMIT ?',
      [10],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('test msg');
  });

  it('get returns undefined for missing rows', async () => {
    await adapter.exec(
      'CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, pr_number INTEGER, type TEXT, severity TEXT, file TEXT, line INTEGER, message TEXT, suggestion TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    );
    const row = await adapter.get<{ id: string }>('SELECT id FROM findings WHERE id = ?', ['nonexistent']);
    expect(row).toBeUndefined();
  });

  it('run returns changes count', async () => {
    await adapter.exec(
      'CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, pr_number INTEGER, type TEXT, severity TEXT, file TEXT, line INTEGER, message TEXT, suggestion TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    );
    const result = await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f1', 1, 'issue', 'minor', 'a.ts', 1, 'msg', null],
    );
    expect(result.changes).toBe(1);
  });

  it('transaction rolls back on error', async () => {
    await adapter.exec(
      'CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, pr_number INTEGER, type TEXT, severity TEXT, file TEXT, line INTEGER, message TEXT, suggestion TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    );
    await expect(
      adapter.transaction(async () => {
        await adapter.run(
          'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ['t1', 1, 'issue', 'minor', 'a.ts', 1, 'will-rollback', null],
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const rows = await adapter.all('SELECT * FROM findings', []);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PostgresAdapter tests (mocked)
// ---------------------------------------------------------------------------
describe('PostgresAdapter', () => {
  it('run translates ? to $1 and returns changes', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query: mockQuery, end: vi.fn().mockResolvedValue(undefined) };
    const adapter = new PostgresAdapter(client);

    const result = await adapter.run(
      'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['f1', 1, 'issue', 'critical', 'a.ts', 10, 'msg', null],
    );
    expect(result.changes).toBe(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('$1'),
      expect.any(Array),
    );
  });

  it('get returns first row', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'f1', message: 'test' }] });
    const client = { query: mockQuery, end: vi.fn().mockResolvedValue(undefined) };
    const adapter = new PostgresAdapter(client);

    const row = await adapter.get<{ id: string }>('SELECT id FROM findings WHERE id = ?', ['f1']);
    expect(row!.id).toBe('f1');
  });

  it('transaction wraps with BEGIN/COMMIT', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const client = { query: mockQuery, end: vi.fn().mockResolvedValue(undefined) };
    const adapter = new PostgresAdapter(client);

    await adapter.transaction(async () => {
      await adapter.run('DELETE FROM feedback WHERE pr_number = ?', [1]);
    });

    const calls = mockQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  it('all returns rows array', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 2, rows: [{ id: 'f1' }, { id: 'f2' }] });
    const client = { query: mockQuery, end: vi.fn().mockResolvedValue(undefined) };
    const adapter = new PostgresAdapter(client);

    const rows = await adapter.all<{ id: string }>('SELECT id FROM findings');
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// MysqlAdapter tests (mocked)
// ---------------------------------------------------------------------------
describe('MysqlAdapter', () => {
  it('run returns affected rows', async () => {
    const mockExecute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, undefined]);
    const connection = { execute: mockExecute, end: vi.fn().mockResolvedValue(undefined), beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined) };
    const adapter = new MysqlAdapter(connection);

    const result = await adapter.run('DELETE FROM feedback WHERE pr_number = ?', [1]);
    expect(result.changes).toBe(1);
  });

  it('all returns rows array', async () => {
    const mockExecute = vi.fn().mockResolvedValue([[{ id: 'f1' }, { id: 'f2' }], undefined]);
    const connection = { execute: mockExecute, end: vi.fn().mockResolvedValue(undefined), beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined) };
    const adapter = new MysqlAdapter(connection);

    const rows = await adapter.all<{ id: string }>('SELECT id FROM findings');
    expect(rows).toHaveLength(2);
  });

  it('get returns first row', async () => {
    const mockExecute = vi.fn().mockResolvedValue([[{ id: 'f1', message: 'test' }], undefined]);
    const connection = { execute: mockExecute, end: vi.fn().mockResolvedValue(undefined), beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined) };
    const adapter = new MysqlAdapter(connection);

    const row = await adapter.get<{ id: string }>('SELECT id FROM findings');
    expect(row!.id).toBe('f1');
  });

  it('transaction wraps with beginTransaction/commit', async () => {
    const mockExecute = vi.fn().mockResolvedValue([[[]], undefined]);
    const connection = { execute: mockExecute, end: vi.fn().mockResolvedValue(undefined), beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined) };
    const adapter = new MysqlAdapter(connection);

    await adapter.transaction(async () => {
      await adapter.run('DELETE FROM feedback WHERE pr_number = ?', [1]);
    });

    expect(connection.beginTransaction).toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalled();
  });
});
