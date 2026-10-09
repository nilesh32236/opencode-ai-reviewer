import type { Express, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthedRequest, ROLE_GATE } from '../src/auth/middleware.js';
import type { SessionRole } from '../src/auth/session.js';
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
    // The role gate fails CLOSED on a session-less request and re-reads the
    // role from the DB, so the basic CRUD tests below need a reviewer session
    // backed by a seeded row. Without both, every mutating route 401s.
    db.seedUser('user-1', 'reviewer');
    app = express()
      .use(express.json())
      .use('/api', (_req: Request, _res: Response, next: () => void) => {
        (_req as unknown as AuthedRequest).session = {
          sub: 'user-1',
          githubId: 1,
          login: 'tester',
          role: 'reviewer',
        };
        next();
      })
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

  it('400s a repo that TRAVERSES, not just one that is the wrong shape', async () => {
    // The shape pattern's character class includes '.', so '../..' and 'a/..'
    // MATCH it. A boundary that only tests the pattern accepts a repo that
    // escapes the workspace root — which is exactly what shipped before
    // isValidRepoSlug gained the explicit '..' check. WorkspaceManager
    // re-validates before path.join as defence in depth; this is the boundary
    // that keeps such a repo out of the queue at all.
    db.seedUser('u-rev', 'reviewer');
    const app = appWithSession({ sub: 'u-rev', role: 'reviewer' });
    for (const repo of ['../..', 'a/..', '../../etc', 'a/.', './x']) {
      const res = await request(app).post('/api/tasks').send({ repo, type: 'review', prNumber: 7 });
      expect(res.status, `repo ${JSON.stringify(repo)} was accepted`).toBe(400);
    }
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
    // ungated set.
    //
    // It asserts what it claims. The first version only checked that the route
    // layer held MORE than one handler, which ANY dummy middleware satisfies —
    // a route with a logging stub and no role gate passed green. A guard that
    // cannot detect the thing it names is the same defect as the bug it guards.
    //
    // requireRole/requireRoleDb now tag the middleware they return with
    // `ROLE_GATE`, so this can look for the gate itself rather than inferring
    // it from the handler count.
    const router = createApiRouter(db as unknown as PlatformDb, queue as unknown as TaskQueue);
    const unguarded: string[] = [];
    const withGate: string[] = [];
    // Express 5 stores Layer objects, not raw handlers, so the marker is read
    // off `layer.handle`.
    for (const layer of (router.stack ?? []) as Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle?: (...args: never[]) => unknown }>;
      };
    }>) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods ?? {}).filter((m) =>
        ['post', 'patch', 'put', 'delete'].includes(m),
      );
      if (methods.length === 0) continue;
      const hasGate = layer.route.stack.some(
        (entry) =>
          typeof entry.handle === 'function' &&
          (entry.handle as unknown as { [key: symbol]: boolean })[ROLE_GATE] === true,
      );
      if (hasGate) withGate.push(layer.route.path);
      else unguarded.push(layer.route.path);
    }
    // Part 1 — nothing is ungated. This is the half that can fail.
    expect(unguarded).toEqual([]);
    // Part 2 — and the gate is really being found, not trivially satisfied.
    // If the marker were never set, part 1 would fail with EVERY mutating route
    // listed, so this assertion is what distinguishes "checked" from "vacuous".
    expect(withGate.length).toBeGreaterThan(0);
  });
});

/**
 * Guards carried forward from the earlier RBAC work: dispatchability, the
 * repo-shape check on the retry route, and the session-less behaviour under a
 * configured secret. These live in their own describe because the
 * authorization block above builds its app through `appWithSession`, while
 * these need the shared `app` that `requireAuth` would have already run.
 */
describe('platform API guards carried forward', () => {
  let db: FakeDb;
  let queue: FakeQueue;
  let app: Express;

  /**
   * Stand in for `requireAuth`, which `server.ts` mounts ahead of the router.
   * Defaults to a reviewer session so the route-level role guard passes and
   * the input-validation assertions below test validation rather than auth.
   */
  const withRole =
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

  /** Enqueue a review task against an already-built app. */
  const enqueueReview = (as: Express, repo = 'a/b') =>
    request(as).post('/api/tasks').send({ repo, type: 'review', prNumber: 7 });

  const buildApp = (role: SessionRole | null = 'reviewer'): Express => {
    // Seed the DB role to MATCH the session role: the gate reads the DB, so a
    // session claiming 'reviewer' against a DB row saying 'viewer' is refused
    // as the stale-JWT case this PR exists to close.
    if (role) {
      db.seedUser('user-1', role);
    }
    return express()
      .use(express.json())
      .use('/api', withRole(role))
      .use('/api', createApiRouter(db as unknown as PlatformDb, queue as unknown as TaskQueue));
  };

  beforeEach(() => {
    db = new FakeDb();
    queue = new FakeQueue();
    // The role gate re-reads the role from the DB rather than trusting the
    // JWT (so a demoted user cannot ride a stale token), so the session's user
    // must exist with a role. Without this every mutating route 401s.
    db.seedUser('user-1', 'reviewer');
    app = buildApp();
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

  it('refuses to retry a task whose repo is malformed', async () => {
    // The webhook path takes `repo` from payload.repository.full_name with no
    // shape check, so a task row can hold a value that would reach
    // path.join(baseDir, owner, name, id) in the worker. Rejecting here gives
    // the caller a 400 instead of a job that dies after a wasted clone.
    db.seed(makeTask('t1', { status: 'failed', repo: '../../etc' }));
    const res = await request(app).post('/api/tasks/t1/retry');
    expect(res.status).toBe(400);
    expect(queue.enqueued).toHaveLength(0);
  });
});
