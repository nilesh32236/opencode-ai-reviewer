import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlatformConfig } from '../src/config.js';
import type { PlatformDb, TaskRow } from '../src/db/client.js';
import type { TaskQueue } from '../src/queue/manager.js';
import { createApiRouter } from '../src/routes/api.js';

/** In-memory fake of PlatformDb for the task routes. */
class FakeDb {
  tasks = new Map<string, TaskRow>();
  private nextId = 1;

  async query<T = TaskRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.startsWith('UPDATE tasks SET')) {
      const id = String(params[params.length - 1]);
      const row = this.tasks.get(id);
      if (!row) return [];
      row.status = String(params[0]);
      row.error_message = (params[1] as string | null) ?? null;
      row.updated_at = new Date();
      return [row] as T[];
    }
    if (sql.startsWith('SELECT * FROM tasks')) {
      let rows = [...this.tasks.values()];
      // Apply WHERE status = $n filter if present.
      const statusIdx = sql.indexOf('status = $');
      if (statusIdx >= 0) {
        const place = sql.slice(statusIdx).match(/\$(\d+)/);
        if (place) {
          const value = params[Number(place[1]) - 1];
          if (typeof value === 'string') rows = rows.filter((r) => r.status === value);
        }
      }
      rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const limit = params[params.length - 1] as number;
      return rows.slice(0, limit) as T[];
    }
    return [];
  }

  async queryOne<T = TaskRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    if (sql.includes('FROM tasks WHERE id =')) {
      return this.tasks.get(String(params[0])) as T | undefined;
    }
    return undefined;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith('UPDATE tasks SET')) {
      // updateTask builds SET status=$1, error_message=$2, ... WHERE id=$last
      const id = String(params[params.length - 1]);
      const row = this.tasks.get(id);
      if (row) {
        row.status = String(params[0]);
        row.error_message = (params[1] as string | null) ?? null;
        row.updated_at = new Date();
      }
      return;
    }
    throw new Error(`Unexpected execute: ${sql}`);
  }

  seed(row: TaskRow): void {
    this.tasks.set(row.id, row);
  }
}

/** Fake queue capturing enqueues. */
class FakeQueue {
  enqueued: Array<{ repo: string; type: string; prNumber?: number }> = [];
  async enqueue(data: { repo: string; type: string; prNumber?: number }): Promise<{ id: string }> {
    this.enqueued.push(data);
    return { id: `job-${this.enqueued.length}` };
  }
  async close(): Promise<void> {
    /* noop */
  }
}

function makeTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    repo_id: 'repo-1',
    repo: 'acme/app',
    type: 'review',
    status: 'queued',
    priority: 0,
    pr_number: 42,
    head_sha: 'abc123',
    workspace_path: null,
    result_data: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as TaskRow;
}

describe('platform API', () => {
  let db: FakeDb;
  let queue: FakeQueue;
  let app: Express;

  beforeEach(() => {
    db = new FakeDb();
    queue = new FakeQueue();
    app = express()
      .use(express.json())
      .use('/api', createApiRouter(db as unknown as PlatformDb, queue as unknown as TaskQueue));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists tasks', async () => {
    db.seed(makeTask('t1', { status: 'running' }));
    db.seed(makeTask('t2', { status: 'queued' }));
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('filters tasks by status', async () => {
    db.seed(makeTask('t1', { status: 'running' }));
    db.seed(makeTask('t2', { status: 'queued' }));
    const res = await request(app).get('/api/tasks?status=running');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('running');
  });

  it('gets a single task', async () => {
    db.seed(makeTask('t1'));
    const res = await request(app).get('/api/tasks/t1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('t1');
  });

  it('returns 404 for a missing task', async () => {
    const res = await request(app).get('/api/tasks/nope');
    expect(res.status).toBe(404);
  });

  it('enqueues a task on POST /api/tasks', async () => {
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'review' });
    expect(res.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].repo).toBe('a/b');
  });

  it('requires repo and type on task creation', async () => {
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b' });
    expect(res.status).toBe(400);
  });

  it('retries a failed task', async () => {
    db.seed(makeTask('t1', { status: 'failed' }));
    const res = await request(app).post('/api/tasks/t1/retry');
    expect(res.status).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    expect(db.tasks.get('t1')?.status).toBe('queued');
  });
});
