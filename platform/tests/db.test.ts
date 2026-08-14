import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformDb, TaskRow } from '../src/db/client.js';
import {
  addTaskEvent,
  createTask,
  getTask,
  listTasks,
  updateTask,
} from '../src/db/repositories.js';

/**
 * A minimal in-memory fake of PlatformDb so task-repo logic can be tested
 * without a real Postgres server. Intercepts query/execute and routes the
 * task-table operations to an in-memory map.
 */
class FakeDb {
  tasks = new Map<string, TaskRow>();
  private nextId = 1;

  async query<T = TaskRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes('INSERT INTO tasks')) {
      const row = {
        id: `task-${this.nextId++}`,
        repo_id: (params[0] as string | null) ?? null,
        type: params[1] as string,
        priority: params[2] as number,
        pr_number: (params[3] as number | null) ?? null,
        pr_title: (params[4] as string | null) ?? null,
        head_sha: (params[5] as string | null) ?? null,
        base_branch: (params[6] as string | null) ?? null,
        head_branch: (params[7] as string | null) ?? null,
        trigger_source: (params[8] as string | null) ?? 'webhook',
        triggered_by: (params[9] as string | null) ?? null,
        status: 'queued',
        result_data: null,
        error_message: null,
        workspace_path: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.tasks.set(row.id, row);
      return [row as unknown as T];
    }
    if (sql.includes('FROM tasks WHERE id =')) {
      const row = this.tasks.get(params[0] as string);
      return (row ? [row] : []) as T[];
    }
    if (sql.startsWith('UPDATE tasks SET')) {
      const id = params[params.length - 1] as string;
      const row = this.tasks.get(id);
      if (!row) return [];
      // Map positional SET columns to the task row (only status + result used here).
      const status = params[0];
      if (typeof status === 'string') row.status = status;
      const resultData = params[1];
      if (resultData !== undefined && resultData !== null) row.result_data = resultData;
      row.updated_at = new Date();
      return [row as unknown as T];
    }
    if (sql.startsWith('SELECT * FROM tasks WHERE')) {
      const rows = [...this.tasks.values()].sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime(),
      );
      const limit = params[params.length - 1] as number;
      return rows.slice(0, limit) as T[];
    }
    return [];
  }

  async queryOne<T = TaskRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async execute(sql: string, _params: unknown[] = []): Promise<void> {
    if (!sql.includes('INSERT INTO task_events')) {
      throw new Error(`Unexpected execute: ${sql}`);
    }
  }
}

describe('task repository', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = new FakeDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a task with defaults', async () => {
    const task = await createTask(db as unknown as PlatformDb, {
      repoId: 'repo-1',
      type: 'review',
      prNumber: 5,
    });
    expect(task.id).toMatch(/^task-/);
    expect(task.type).toBe('review');
    expect(task.priority).toBe(0);
    expect(task.trigger_source).toBe('webhook');
    expect(task.pr_number).toBe(5);
  });

  it('gets a task by id', async () => {
    const created = await createTask(db as unknown as PlatformDb, {
      repoId: 'repo-1',
      type: 'audit',
    });
    const fetched = await getTask(db as unknown as PlatformDb, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.type).toBe('audit');
  });

  it('updates a task status and result', async () => {
    const created = await createTask(db as unknown as PlatformDb, {
      repoId: 'repo-1',
      type: 'fix',
    });
    const updated = await updateTask(db as unknown as PlatformDb, created.id, {
      status: 'completed',
      resultData: { verdict: 'clean' },
    });
    expect(updated?.status).toBe('completed');
    expect((updated?.result_data as { verdict: string }).verdict).toBe('clean');
  });

  it('lists tasks filtered by status, most recent first', async () => {
    await createTask(db as unknown as PlatformDb, { repoId: 'r', type: 'review' });
    await createTask(db as unknown as PlatformDb, { repoId: 'r', type: 'review' });
    const rows = await listTasks(db as unknown as PlatformDb, { status: 'queued', limit: 10 });
    expect(rows.length).toBe(2);
  });

  it('records task events', async () => {
    const dbSpy = vi.spyOn(db, 'execute');
    await addTaskEvent(db as unknown as PlatformDb, 'task-1', 'status_change', { from: 'queued' });
    expect(dbSpy).toHaveBeenCalledWith(
      'INSERT INTO task_events (task_id, event_type, payload) VALUES ($1, $2, $3)',
      ['task-1', 'status_change', '{"from":"queued"}'],
    );
  });
});
