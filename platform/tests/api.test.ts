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
  users = new Map<string, { id: string; role: string }>();
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
    if (sql.includes('FROM users WHERE id =')) {
      return this.users.get(String(params[0])) as T | undefined;
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

  seedUser(id: string, role: string): void {
    this.users.set(id, { id, role });
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

describe('platform API authorization (issue #948)', () => {
  let db: FakeDb;
  let queue: FakeQueue;

  /** Build an app with a fixed session (as requireAuth would attach it). */
  function appWithSession(
    session: { sub: string; role: string } | undefined,
    repoFilter?: { allowed: Set<string>; denied: Set<string> },
  ): Express {
    return express()
      .use(express.json())
      .use((_req, _res, next) => {
        if (session) {
          (
            _req as unknown as {
              session: { sub: string; githubId: number; login: string; role: string };
            }
          ).session = { sub: session.sub, githubId: 1, login: 'tester', role: session.role };
        }
        next();
      })
      .use(
        '/api',
        createApiRouter(db as unknown as PlatformDb, queue as unknown as TaskQueue, {
          ...(repoFilter ? { repoFilter } : {}),
        }),
      );
  }

  beforeEach(() => {
    db = new FakeDb();
    queue = new FakeQueue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('403s POST /api/tasks for a viewer session and enqueues nothing', async () => {
    db.seedUser('u-viewer', 'viewer');
    const app = appWithSession({ sub: 'u-viewer', role: 'viewer' });
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'review' });
    expect(res.status).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('202s POST /api/tasks for a reviewer session', async () => {
    db.seedUser('u-rev', 'reviewer');
    const app = appWithSession({ sub: 'u-rev', role: 'reviewer' });
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'review' });
    expect(res.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
  });

  it('authorizes from the DB role, not the stale JWT role', async () => {
    // JWT claims reviewer, but the DB now says viewer — the DB must win.
    db.seedUser('u-demoted', 'viewer');
    const app = appWithSession({ sub: 'u-demoted', role: 'reviewer' });
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'review' });
    expect(res.status).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('401s POST /api/tasks when the session user no longer exists', async () => {
    const app = appWithSession({ sub: 'u-gone', role: 'reviewer' });
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'review' });
    expect(res.status).toBe(401);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('400s a malformed repo slug before enqueueing', async () => {
    db.seedUser('u-rev', 'reviewer');
    const app = appWithSession({ sub: 'u-rev', role: 'reviewer' });
    const res = await request(app).post('/api/tasks').send({ repo: 'not-a-slug', type: 'review' });
    expect(res.status).toBe(400);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('400s an unknown task type before enqueueing', async () => {
    db.seedUser('u-rev', 'reviewer');
    const app = appWithSession({ sub: 'u-rev', role: 'reviewer' });
    const res = await request(app).post('/api/tasks').send({ repo: 'a/b', type: 'bogus' });
    expect(res.status).toBe(400);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('403s a repo outside the allowlist and enqueues nothing', async () => {
    db.seedUser('u-rev', 'reviewer');
    const app = appWithSession(
      { sub: 'u-rev', role: 'reviewer' },
      { allowed: new Set(['acme/app']), denied: new Set() },
    );
    const res = await request(app).post('/api/tasks').send({ repo: 'evil/repo', type: 'review' });
    expect(res.status).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('202s a repo inside the allowlist', async () => {
    db.seedUser('u-rev', 'reviewer');
    const app = appWithSession(
      { sub: 'u-rev', role: 'reviewer' },
      { allowed: new Set(['acme/app']), denied: new Set() },
    );
    const res = await request(app).post('/api/tasks').send({ repo: 'acme/app', type: 'review' });
    expect(res.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
  });

  it('403s a retry whose repo is outside the allowlist', async () => {
    db.seedUser('u-rev', 'reviewer');
    db.seed(makeTask('t1', { status: 'failed', repo: 'evil/repo' }));
    const app = appWithSession(
      { sub: 'u-rev', role: 'reviewer' },
      { allowed: new Set(['acme/app']), denied: new Set() },
    );
    const res = await request(app).post('/api/tasks/t1/retry');
    expect(res.status).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('403s a retry for a viewer session', async () => {
    db.seedUser('u-viewer', 'viewer');
    db.seed(makeTask('t1', { status: 'failed' }));
    const app = appWithSession({ sub: 'u-viewer', role: 'viewer' });
    const res = await request(app).post('/api/tasks/t1/retry');
    expect(res.status).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('covers every mutating route under /api with a role guard', async () => {
    // Static guard against a new POST/PATCH/DELETE route silently joining the
    // ungated set: each mutating route layer stack must hold more than just
    // the final handler (i.e. a role middleware runs before it).
    const router = createApiRouter(db as unknown as PlatformDb, queue as unknown as TaskQueue);
    const unguarded: string[] = [];
    for (const layer of (router.stack ?? []) as Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: unknown[] };
    }>) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods ?? {}).filter((m) =>
        ['post', 'patch', 'put', 'delete'].includes(m),
      );
      if (methods.length === 0) continue;
      if (layer.route.stack.length < 2) unguarded.push(layer.route.path);
    }
    expect(unguarded).toEqual([]);
  });
});
