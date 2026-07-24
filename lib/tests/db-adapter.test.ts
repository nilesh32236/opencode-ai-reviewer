import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DbAdapter,
  JsonDbAdapter,
  MysqlAdapter,
  PostgresAdapter,
  SqliteAdapter,
  connectDb,
} from '../src/learning/db.js';
import { JsonDatabase } from '../src/learning/json-db.js';
import { applyMigrations } from '../src/learning/schema.js';
import type { LearningRepository } from '../src/learning/types.js';

// ---------------------------------------------------------------------------
// JSON DB tests — directly on LearningRepository methods
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

  describe('record (INSERT)', () => {
    it('records a finding', async () => {
      const id = await jsonDb.recordFinding({
        id: 'f1',
        prNumber: 1,
        type: 'issue',
        severity: 'critical',
        file: 'src/a.ts',
        line: 10,
        message: 'msg',
        suggestion: 'suggestion',
      });
      expect(id).toBe('f1');
      expect(jsonDb.data.findings).toHaveLength(1);
      expect(jsonDb.data.findings[0].id).toBe('f1');
    });

    it('records feedback', async () => {
      await jsonDb.recordFinding({
        id: 'f1',
        prNumber: 1,
        type: 'issue',
        severity: 'critical',
        file: 'a.ts',
        line: 1,
        message: 'msg',
      });
      await jsonDb.recordFeedback({
        findingId: 'f1',
        signalType: 'dismissed',
        signalValue: 'fp',
        prNumber: 1,
      });
      expect(jsonDb.data.feedback).toHaveLength(1);
    });

    it('records review quality', async () => {
      await jsonDb.recordQuality({
        prNumber: 1,
        actionabilityScore: 80,
        accuracyScore: 90,
        coverageScore: 70,
        consistencyScore: 85,
      });
      expect(jsonDb.data.review_quality).toHaveLength(1);
    });

    it('records custom rule', async () => {
      const id = await jsonDb.addCustomRule('Always handle errors', 'auto');
      expect(jsonDb.data.custom_rules).toHaveLength(1);
      expect(jsonDb.data.custom_rules[0].status).toBe('pending');
      expect(id).toBeTruthy();
    });

    it('records prompt override', async () => {
      await jsonDb.addPromptOverride('general', 'Be thorough', 0.15);
      expect(jsonDb.data.prompt_overrides).toHaveLength(1);
    });

    it('records pattern', async () => {
      await jsonDb.recordPattern({
        patternKey: 'missing-errors',
        messageCluster: ['Missing error'],
        frequency: 3,
        fileTypes: ['.ts'],
      });
      expect(jsonDb.data.patterns).toHaveLength(1);
    });

    it('meta_review_counter initialized on construction', () => {
      expect(jsonDb.data.meta_review_counter).toHaveLength(1);
      expect(jsonDb.data.meta_review_counter[0].count).toBe(0);
    });
  });

  describe('delete', () => {
    beforeEach(async () => {
      await jsonDb.recordFinding({
        id: 'f1',
        prNumber: 1,
        type: 'issue',
        severity: 'minor',
        file: 'a.ts',
        line: 1,
        message: 'msg',
      });
      await jsonDb.recordFeedback({
        findingId: 'f1',
        signalType: 'dismissed',
        signalValue: 'fp',
        prNumber: 1,
      });
    });

    it('deletes findings and feedback by PR number', async () => {
      const changes = await jsonDb.deleteFindings(1);
      expect(changes).toBe(1);
      expect(jsonDb.data.findings).toHaveLength(0);
      expect(jsonDb.data.feedback).toHaveLength(0);
    });

    it('returns 0 when no matching PR', async () => {
      const changes = await jsonDb.deleteFindings(999);
      expect(changes).toBe(0);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await jsonDb.addCustomRule('Test rule', 'auto');
      await jsonDb.recordPattern({
        patternKey: 'test-pattern',
        messageCluster: ['msg'],
        frequency: 1,
        fileTypes: ['.ts'],
      });
    });

    it('increments meta_review_counter', async () => {
      await jsonDb.incrementAndCheckMetaReviewInterval(1);
      expect(jsonDb.data.meta_review_counter[0].count).toBe(1);
    });

    it('resets meta_review_counter', async () => {
      await jsonDb.incrementAndCheckMetaReviewInterval(1);
      expect(jsonDb.data.meta_review_counter[0].count).toBe(1);
      await jsonDb.resetCounter();
      expect(jsonDb.data.meta_review_counter[0].count).toBe(0);
    });

    it('approves custom rule', async () => {
      const rules = await jsonDb.getPendingRules();
      const ruleId = rules[0].id as string;
      await jsonDb.approveRule(ruleId);
      expect(jsonDb.data.custom_rules[0].status).toBe('active');
      expect(jsonDb.data.custom_rules[0].approved_at).toBeTruthy();
    });

    it('declines custom rule', async () => {
      const rules = await jsonDb.getPendingRules();
      const ruleId = rules[0].id as string;
      await jsonDb.declineRule(ruleId);
      expect(jsonDb.data.custom_rules[0].status).toBe('declined');
    });

    it('increments pattern frequency on re-record', async () => {
      await jsonDb.recordPattern({
        patternKey: 'test-pattern',
        messageCluster: ['msg'],
        frequency: 1,
        fileTypes: ['.ts'],
      });
      expect(jsonDb.data.patterns[0].frequency).toBe(2);
    });
  });

  describe('get (single items)', () => {
    it('returns false positive rate as 0 when no feedback', async () => {
      const rate = await jsonDb.getFalsePositiveRate();
      expect(rate).toBe(0);
    });

    it('retrieves pattern by key via getPatterns', async () => {
      await jsonDb.recordPattern({
        patternKey: 'unique-key',
        messageCluster: ['msg'],
        frequency: 2,
        fileTypes: ['.ts'],
      });
      const patterns = await jsonDb.getPatterns(0);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].frequency).toBe(2);
    });

    it('returns no patterns for missing key', async () => {
      const patterns = await jsonDb.getPatterns(0);
      expect(patterns).toHaveLength(0);
    });
  });

  describe('get (multiple items)', () => {
    beforeEach(async () => {
      await jsonDb.recordFinding({
        id: 'f1',
        prNumber: 1,
        type: 'issue',
        severity: 'minor',
        file: 'a.ts',
        line: 1,
        message: 'Issue A',
      });
      await jsonDb.recordFinding({
        id: 'f2',
        prNumber: 1,
        type: 'strength',
        file: 'b.ts',
        line: 2,
        message: 'Strength A',
      });
      await jsonDb.recordFinding({
        id: 'f3',
        prNumber: 2,
        type: 'issue',
        severity: 'critical',
        file: 'c.ts',
        line: 3,
        message: 'Issue B',
      });
    });

    it('gets findings by type', async () => {
      const findings = await jsonDb.getFindingsByType('issue', 10);
      expect(findings).toHaveLength(2);
    });

    it('gets findings by PR number', async () => {
      const findings = await jsonDb.getFindings(1, 10);
      expect(findings).toHaveLength(2);
    });

    it('gets all findings with limit', async () => {
      const findings = await jsonDb.getFindings(undefined, 2);
      expect(findings).toHaveLength(2);
    });

    it('gets active custom rules via relevant lessons', async () => {
      await jsonDb.addCustomRule('Active rule', 'auto');
      await jsonDb.addCustomRule('Pending rule', 'manual');
      const pending = await jsonDb.getPendingRules();
      await jsonDb.approveRule(pending[0].id as string);
      const lessons = await jsonDb.getRelevantLessons([]);
      expect(lessons).toContain('Active rule');
    });

    it('gets prompt overrides by category via relevant lessons', async () => {
      await jsonDb.addPromptOverride('general', 'General override', 0.1);
      const lessons = await jsonDb.getRelevantLessons([]);
      expect(lessons).toContain('General override');
    });

    it('gets prompt overrides by IN clause via relevant lessons', async () => {
      await jsonDb.addPromptOverride('.ts', 'TS override', 0.1);
      await jsonDb.addPromptOverride('.js', 'JS override', 0.1);
      const lessons = await jsonDb.getRelevantLessons(['file.ts', 'file.js']);
      const overrideLessons = lessons.filter(
        (l) => l.includes('TS override') || l.includes('JS override'),
      );
      expect(overrideLessons).toHaveLength(2);
    });

    it('gets patterns by frequency', async () => {
      await jsonDb.recordPattern({
        patternKey: 'freq3',
        messageCluster: ['msg'],
        frequency: 3,
        fileTypes: ['.ts'],
      });
      await jsonDb.recordPattern({
        patternKey: 'freq1',
        messageCluster: ['msg'],
        frequency: 1,
        fileTypes: ['.ts'],
      });
      const patterns = await jsonDb.getPatterns(2);
      expect(patterns).toHaveLength(1);
    });

    it('gets pending custom rules', async () => {
      await jsonDb.addCustomRule('Pending', 'auto');
      const pending = await jsonDb.getPendingRules();
      expect(pending).toHaveLength(1);
    });

    it('gets finding messages', async () => {
      const messages = await jsonDb.getFindingMessages(10);
      expect(messages).toHaveLength(3);
      expect(messages[0].message).toBeTruthy();
    });
  });

  describe('transaction', () => {
    it('commits changes on success', async () => {
      const fn = async () => {
        await jsonDb.recordFinding({
          id: 't1',
          prNumber: 1,
          type: 'issue',
          severity: 'minor',
          file: 'a.ts',
          line: 1,
          message: 'transactional',
        });
      };
      const txn = jsonDb.transaction(fn);
      await txn();
      expect(jsonDb.data.findings).toHaveLength(1);
    });

    it('rolls back changes on error', async () => {
      const fn = async () => {
        await jsonDb.recordFinding({
          id: 't1',
          prNumber: 1,
          type: 'issue',
          severity: 'minor',
          file: 'a.ts',
          line: 1,
          message: 'will-rollback',
        });
        throw new Error('rollback');
      };
      const txn = jsonDb.transaction(fn);
      await expect(txn()).rejects.toThrow('rollback');
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

  it('run throws in JSON fallback mode', async () => {
    await expect(
      adapter.run(
        'INSERT INTO findings (id, pr_number, type, severity, file, line, message, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['f1', 1, 'issue', 'critical', 'a.ts', 10, 'test', null],
      ),
    ).rejects.toThrow('SQL operations are not supported');
  });

  it('get throws in JSON fallback mode', async () => {
    await expect(adapter.get('SELECT * FROM findings')).rejects.toThrow(
      'SQL operations are not supported',
    );
  });

  it('all throws in JSON fallback mode', async () => {
    await expect(adapter.all('SELECT * FROM findings')).rejects.toThrow(
      'SQL operations are not supported',
    );
  });

  it('exec handles CREATE TABLE', async () => {
    await adapter.exec('CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY)');
  });

  it('transaction commits changes using LearningRepository methods', async () => {
    await adapter.transaction(async () => {
      await adapter.recordFinding({
        id: 't1',
        prNumber: 99,
        type: 'issue',
        severity: 'minor',
        file: 'a.ts',
        line: 1,
        message: 'txn',
      });
    });
    const findings = await adapter.getFindings();
    expect(findings).toHaveLength(1);
  });

  it('delegates LearningRepository methods to JsonDatabase', async () => {
    const id = await adapter.addCustomRule('Test', 'auto');
    expect(id).toBeTruthy();
    const pending = await adapter.getPendingRules();
    expect(pending).toHaveLength(1);
    await adapter.approveRule(id);
    const lessons = await adapter.getRelevantLessons([]);
    expect(lessons).toContain('Test');
  });
});

// ---------------------------------------------------------------------------
// SqliteAdapter tests (runs against fallback JSON when better-sqlite3 unavailable)
// ---------------------------------------------------------------------------
describe('SqliteAdapter', () => {
  let dbPath: string;
  let adapter: DbAdapter & LearningRepository;

  beforeEach(async () => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-adapter-test-')), 'test.db');
    adapter = (await connectDb(dbPath)) as DbAdapter & LearningRepository;
    await applyMigrations(adapter);
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

  it('exec handles CREATE TABLE (no-op in JSON mode)', async () => {
    await adapter.exec(
      'CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, pr_number INTEGER, type TEXT, severity TEXT, file TEXT, line INTEGER, message TEXT, suggestion TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    );
  });

  it('recordFinding and getFindings work', async () => {
    const id = await adapter.recordFinding({
      id: 'f1',
      prNumber: 1,
      type: 'issue',
      severity: 'critical',
      file: 'a.ts',
      line: 10,
      message: 'test msg',
    });
    expect(id).toBe('f1');
    const findings = await adapter.getFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe('test msg');
  });

  it('returns empty array for missing findings', async () => {
    const findings = await adapter.getFindings(999);
    expect(findings).toHaveLength(0);
  });

  it('transaction rolls back on error', async () => {
    await expect(
      adapter.transaction(async () => {
        await adapter.recordFinding({
          id: 't1',
          prNumber: 1,
          type: 'issue',
          severity: 'minor',
          file: 'a.ts',
          line: 1,
          message: 'will-rollback',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const findings = await adapter.getFindings();
    expect(findings).toHaveLength(0);
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
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('$1'), expect.any(Array));
  });

  it('get returns first row', async () => {
    const mockQuery = vi
      .fn()
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 'f1', message: 'test' }] });
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
    const mockQuery = vi
      .fn()
      .mockResolvedValue({ rowCount: 2, rows: [{ id: 'f1' }, { id: 'f2' }] });
    const client = { query: mockQuery, end: vi.fn().mockResolvedValue(undefined) };
    const adapter = new PostgresAdapter(client);

    const rows = await adapter.all<{ id: string }>('SELECT id FROM findings');
    expect(rows).toHaveLength(2);
  });

  it('exec translates INSERT OR IGNORE INTO to ON CONFLICT DO NOTHING for Postgres', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const client = { query: mockQuery, end: vi.fn().mockResolvedValue(undefined) };
    const adapter = new PostgresAdapter(client);

    await adapter.exec('INSERT OR IGNORE INTO meta_review_counter (id, count) VALUES (1, 0)');
    expect(mockQuery).toHaveBeenCalledWith(
      'INSERT INTO meta_review_counter (id, count) VALUES (1, 0) ON CONFLICT DO NOTHING',
    );
  });
});

// ---------------------------------------------------------------------------
// MysqlAdapter tests (mocked)
// ---------------------------------------------------------------------------
describe('MysqlAdapter', () => {
  it('run returns affected rows', async () => {
    const mockExecute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, undefined]);
    const connection = {
      execute: mockExecute,
      end: vi.fn().mockResolvedValue(undefined),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new MysqlAdapter(connection);

    const result = await adapter.run('DELETE FROM feedback WHERE pr_number = ?', [1]);
    expect(result.changes).toBe(1);
  });

  it('all returns rows array', async () => {
    const mockExecute = vi.fn().mockResolvedValue([[{ id: 'f1' }, { id: 'f2' }], undefined]);
    const connection = {
      execute: mockExecute,
      end: vi.fn().mockResolvedValue(undefined),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new MysqlAdapter(connection);

    const rows = await adapter.all<{ id: string }>('SELECT id FROM findings');
    expect(rows).toHaveLength(2);
  });

  it('get returns first row', async () => {
    const mockExecute = vi.fn().mockResolvedValue([[{ id: 'f1', message: 'test' }], undefined]);
    const connection = {
      execute: mockExecute,
      end: vi.fn().mockResolvedValue(undefined),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new MysqlAdapter(connection);

    const row = await adapter.get<{ id: string }>('SELECT id FROM findings');
    expect(row!.id).toBe('f1');
  });

  it('transaction wraps with beginTransaction/commit', async () => {
    const mockExecute = vi.fn().mockResolvedValue([[[]], undefined]);
    const connection = {
      execute: mockExecute,
      end: vi.fn().mockResolvedValue(undefined),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new MysqlAdapter(connection);

    await adapter.transaction(async () => {
      await adapter.run('DELETE FROM feedback WHERE pr_number = ?', [1]);
    });

    expect(connection.beginTransaction).toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalled();
  });
});
