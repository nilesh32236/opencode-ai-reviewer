import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthedRequest } from '../src/auth/middleware.js';
import type { SessionRole } from '../src/auth/session.js';
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

  /**
   * Stand in for `requireAuth`, which `server.ts` mounts ahead of the router.
   * A role is attached here so the route-level `requireRole` guard is exercised
   * the same way it is in production; without it every mutating route would
   * 401 and the happy-path tests below would prove nothing.
   */
  const withSession =
    (role: SessionRole | null): express.RequestHandler =>
    (req, _res, next) => {
      if (role) {
        (req as AuthedRequest).session = {
          sub: 'user-1',
          githubId: 1,
          login: 'tester',
          role,
        };
      }
      next();
    };

  const buildApp = (role: SessionRole | null = 'reviewer'): Express =>
    express()
      .use(express.json())
      .use('/api', withSession(role))
      .use('/api', createApiRouter(db as unknown as PlatformDb, queue as unknown as TaskQueue));

  beforeEach(() => {
    db = new FakeDb();
    queue = new FakeQueue();
    app = buildApp();
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
    // prNumber is required for a review: the worker throws on it *after* the
    // workspace clone has already run, so it is now rejected before enqueue.
    const res = await request(app)
      .post('/api/tasks')
      .send({ repo: 'a/b', type: 'review', prNumber: 7 });
    expect(res.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].repo).toBe('a/b');
  });

  it('rejects a review with no prNumber BEFORE enqueueing', async () => {
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'review' });
    expect(res.status).toBe(400);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('requires repo and type on task creation', async () => {
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b' });
    expect(res.status).toBe(400);
  });

  // --- role enforcement (issue #948) -------------------------------------
  // `requireRole` was exported and never mounted, so every authenticated user
  // — including the lowest role — could enqueue work for any repository and
  // spend LLM budget with the platform's own GitHub token. These pin the gate.

  describe('role enforcement', () => {
    const enqueueReview = (as: Express, repo = 'a/b') =>
      request(as).post('/api/tasks').send({ repo, type: 'review', prNumber: 7 });

    it('refuses a viewer', async () => {
      const res = await enqueueReview(buildApp('viewer'));
      expect(res.status).toBe(403);
      expect(queue.enqueued).toHaveLength(0);
    });

    it('refuses a reviewer-less session entirely (no session at all)', async () => {
      const res = await enqueueReview(buildApp(null));
      expect(res.status).toBe(401);
      expect(queue.enqueued).toHaveLength(0);
    });

    it('allows an admin', async () => {
      const res = await enqueueReview(buildApp('admin'));
      expect(res.status).toBe(202);
      expect(queue.enqueued).toHaveLength(1);
    });

    it('refuses a viewer on the retry route too', async () => {
      db.seed(makeTask('t1', { status: 'failed', repo: 'a/b' }));
      const res = await request(buildApp('viewer')).post('/api/tasks/t1/retry');
      expect(res.status).toBe(403);
      expect(queue.enqueued).toHaveLength(0);
    });

    it('leaves read routes open to a viewer', async () => {
      db.seed(makeTask('t1', { status: 'running' }));
      const res = await request(buildApp('viewer')).get('/api/tasks');
      expect(res.status).toBe(200);
    });
  });

  // --- input validation on the enqueue body -----------------------------
  describe('task input validation', () => {
    it('rejects a repo that is not owner/repo', async () => {
      for (const repo of ['../../etc', 'a/b/c', 'justowner', 'a/b; rm -rf /', 'a//b', '-']) {
        const res = await request(app)
          .post('/api/tasks')
          .send({ repo, type: 'review', prNumber: 7 });
        expect(res.status, `repo ${JSON.stringify(repo)} was accepted`).toBe(400);
      }
      expect(queue.enqueued).toHaveLength(0);
    });

    it('rejects a task type the worker cannot dispatch', async () => {
      for (const type of ['fix', 'audit', 'docs', 'conversation', 'bogus', '']) {
        const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type, prNumber: 7 });
        expect(res.status, `type ${JSON.stringify(type)} was accepted`).toBe(400);
      }
      expect(queue.enqueued).toHaveLength(0);
    });

    it('rejects an unsupported type BEFORE the worker would have cloned', async () => {
      // `fix` is a valid PlatformTaskType but the worker throws
      // "not yet supported" — after cloning. It must never reach the queue.
      const res = await request(app)
        .post('/api/tasks')
        .send({ repo: 'a/b', type: 'fix', prNumber: 7 });
      expect(res.status).toBe(400);
      expect(queue.enqueued).toHaveLength(0);
    });
  });

  it('retries a failed task', async () => {
    db.seed(makeTask('t1', { status: 'failed' }));
    const res = await request(app).post('/api/tasks/t1/retry');
    expect(res.status).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    expect(db.tasks.get('t1')?.status).toBe('queued');
  });
});
