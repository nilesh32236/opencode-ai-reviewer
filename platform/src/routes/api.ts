/**
 * REST API for the platform dashboard.
 *
 * Exposes task/repo/workspace reads and task creation, plus a system summary.
 * SSE event streaming is added by events.ts (Chunk 7). These routes are
 * read-mostly for the dashboard; mutating operations (create task, retry)
 * enqueue to BullMQ rather than running inline.
 */

import { Logger } from '@opencode-pr-agent/lib';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { requireRole, requireRoleDb } from '../auth/middleware.js';
import type { PlatformDb } from '../db/client.js';
import { getTask, listTasks, updateTask } from '../db/repositories.js';
import type { TaskQueue } from '../queue/manager.js';
import { type TaskJobData, isDispatchableTaskType } from '../queue/types.js';
import { type RepoFilter, isRepoAllowed, isValidRepoSlug } from '../utils/repo-filter.js';

const logger = new Logger('Api');

/** Options for {@link createApiRouter}. */
export interface ApiRouterOptions {
  /**
   * Repo allowlist/denylist enforced before any job is enqueued. Defaults to
   * allow-all (empty sets) so existing callers without a filter keep working.
   */
  repoFilter?: RepoFilter;
}

/** Default-open filter used when the caller supplies none. */
const ALLOW_ALL_FILTER: RepoFilter = { allowed: new Set(), denied: new Set() };

/**
 * Build the REST API router.
 * @param db - The platform database.
 * @param queue - The task queue (optional; task creation is disabled without it).
 * @param opts - Optional repo allowlist/denylist enforced on enqueue paths.
 * @returns An Express router mounted under /api.
 */
export function createApiRouter(
  db: PlatformDb,
  queue: TaskQueue | null,
  opts: ApiRouterOptions = {},
): Router {
  const router = createRouter();
  const repoFilter = opts.repoFilter ?? ALLOW_ALL_FILTER;

  // GET /api/tasks — list tasks (filter by status/type).
  router.get('/tasks', requireRole('viewer'), async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
    try {
      const rows = await listTasks(db, {
        status,
        type,
        limit: Number.isNaN(limit) ? 100 : Math.min(limit, 500),
      });
      res.json(rows);
    } catch (err) {
      logger.error(`GET /api/tasks failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  // GET /api/tasks/:id — task detail.
  router.get('/tasks/:id', requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const row = await getTask(db, String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json(row);
    } catch (err) {
      logger.error(
        `GET /api/tasks/:id failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: 'Failed to get task' });
    }
  });

  // POST /api/tasks — create a task (requires the queue). Cost-incurring:
  // clones with the platform token and spends LLM budget, so it requires at
  // least the reviewer role (DB-backed — the JWT role lags DB changes by up
  // to the 12 h token lifetime) plus repo shape + allowlist validation.
  router.post('/tasks', requireRoleDb(db, 'reviewer'), async (req: Request, res: Response) => {
    if (!queue) {
      res.status(503).json({ error: 'Task queue not configured' });
      return;
    }
    const body = (req.body ?? {}) as {
      repo?: string;
      type?: string;
      prNumber?: number;
      headSha?: string;
    };
    const repo = body.repo;
    const type = body.type;
    if (!repo || !type) {
      res.status(400).json({ error: 'repo and type are required' });
      return;
    }
    // Same boundary check as the retry route: a type the worker cannot dispatch
    // would be accepted, cloned, and only then rejected inside the worker.
    if (!isDispatchableTaskType(type)) {
      res.status(400).json({
        error: `Task type '${type}' cannot be queued — the worker does not dispatch it yet`,
      });
      return;
    }
    // Validate shape BEFORE the allowlist so malformed input is a 400, and
    // check the allowlist BEFORE enqueueing so rejected repos never clone.
    if (!isValidRepoSlug(repo)) {
      res.status(400).json({ error: 'repo must be in "owner/repo" form' });
      return;
    }
    if (!isRepoAllowed(repo, repoFilter)) {
      res.status(403).json({ error: 'Repository is not allowed' });
      return;
    }
    const data: TaskJobData = {
      repo,
      type,
      prNumber: body.prNumber,
      headSha: body.headSha,
      triggerSource: 'manual',
    };
    try {
      const job = await queue.enqueue(data);
      res.status(202).json({ id: job.id, status: 'queued' });
    } catch (err) {
      logger.error(`POST /api/tasks failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to enqueue task' });
    }
  });

  // POST /api/tasks/:id/retry — re-enqueue a failed task. Same cost profile
  // as task creation, so the same reviewer role + repo allowlist applies.
  router.post(
    '/tasks/:id/retry',
    requireRoleDb(db, 'reviewer'),
    async (req: Request, res: Response) => {
      if (!queue) {
        res.status(503).json({ error: 'Task queue not configured' });
        return;
      }
      try {
        const row = await getTask(db, String(req.params.id));
        if (!row) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        if (!row.repo) {
          res.status(400).json({ error: 'Task has no repo — cannot retry' });
          return;
        }
        // Reject an undispatchable type HERE, before enqueueing. The worker
        // clones the repo and only then calls dispatchTask, which throws for a
        // type it does not handle — so without this check the caller is told
        // "queued" for work that cannot run, and the clone is wasted.
        if (!isDispatchableTaskType(row.type)) {
          res.status(400).json({
            error: `Task type '${row.type}' cannot be retried — the worker does not dispatch it yet`,
          });
          return;
        }
        // The stored repo predates the allowlist, so re-check it here — before
        // enqueueing — or a denied repo could be retried forever.
        if (!isValidRepoSlug(row.repo)) {
          res.status(400).json({ error: 'Task repo must be in "owner/repo" form' });
          return;
        }
        if (!isRepoAllowed(row.repo, repoFilter)) {
          res.status(403).json({ error: 'Repository is not allowed' });
          return;
        }
        const data: TaskJobData = {
          repo: row.repo,
          type: row.type,
          taskId: row.id,
          prNumber: row.pr_number ?? undefined,
          headSha: row.head_sha ?? undefined,
          triggerSource: 'manual',
        };
        // A retry must be a NEW job. The queue derives its id from
        // (repo, type, pr/issue, headSha), and the retry passes the same values as
        // the original, so without a suffix the id collides and BullMQ's add()
        // resolves without adding anything — the route would report "queued" for
        // work that was never enqueued. The task id plus a timestamp makes each
        // retry distinct while staying traceable.
        const job = await queue.enqueue(data, `retry-${row.id}-${Date.now()}`);
        await updateTask(db, row.id, { status: 'queued', errorMessage: null });
        res.json({ id: job.id, status: 'queued' });
      } catch (err) {
        logger.error(
          `POST /api/tasks/:id/retry failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({ error: 'Failed to retry task' });
      }
    },
  );

  // GET /api/health — system summary.
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'opencode-platform' });
  });

  return router;
}
