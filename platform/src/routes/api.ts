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
import type { AuthedRequest } from '../auth/middleware.js';
import { requireRole } from '../auth/middleware.js';
import type { PlatformDb } from '../db/client.js';
import { getTask, listTasks, updateTask } from '../db/repositories.js';
import type { TaskQueue } from '../queue/manager.js';
import { type TaskJobData, isDispatchableTaskType } from '../queue/types.js';

const logger = new Logger('Api');

/** `owner/repo` — one owner segment, one repo segment, no path traversal. */
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Options for {@link createApiRouter}.
 */
export interface ApiRouterOptions {
  /**
   * Trust an authenticating reverse proxy and let unauthenticated requests
   * through the role gate.
   *
   * Set this ONLY when no session secret is configured (`SESSION_SECRET` empty)
   * — the documented auth-disabled deployment, where `requireAuth` passes through
   * because there is no session to verify. With a secret present this must stay
   * false, so that an absent session is an unauthenticated caller and is refused.
   */
  trustProxy?: boolean;
}

/**
 * Build the REST API router.
 * @param db - The platform database.
 * @param queue - The task queue (optional; task creation is disabled without it).
 * @param options - See {@link ApiRouterOptions}.
 * @returns An Express router mounted under /api.
 */
export function createApiRouter(
  db: PlatformDb,
  queue: TaskQueue | null,
  options: ApiRouterOptions = {},
): Router {
  const router = createRouter();

  // Cost-incurring and state-changing routes are role-gated. `requireRole`
  // existed but was never mounted, so a `viewer` could enqueue work for any
  // repository and spend LLM budget with the platform's own token — see #948.
  // The guard is applied per-route rather than with router.use() so the read
  // routes stay available to every authenticated role. It fails closed: with
  // auth configured, a caller with no session is refused with a 401 rather than
  // waved through. The only pass-through is the auth-disabled deployment, which
  // asks for it explicitly via `trustProxy`.
  const requireReviewer = requireRole('reviewer', { trustProxy: options.trustProxy });

  // GET /api/tasks — list tasks (filter by status/type).
  router.get('/tasks', async (req: Request, res: Response) => {
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
  router.get('/tasks/:id', async (req: Request, res: Response) => {
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

  // POST /api/tasks — create a task (requires the queue).
  router.post('/tasks', requireReviewer, async (req: AuthedRequest, res: Response) => {
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
    const repo = body.repo?.trim();
    const type = body.type?.trim();
    if (!repo || !type) {
      res.status(400).json({ error: 'repo and type are required' });
      return;
    }
    // `repo` becomes a clone URL and a GitHub adapter repo in the worker, so
    // reject anything that is not a plain `owner/repo` before it is enqueued.
    if (!REPO_SHAPE.test(repo)) {
      res.status(400).json({ error: 'repo must be in owner/repo form' });
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
    if (type === 'review' && !body.prNumber) {
      res.status(400).json({ error: 'prNumber is required for a review task' });
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

  // POST /api/tasks/:id/retry — re-enqueue a failed task.
  router.post('/tasks/:id/retry', requireReviewer, async (req: Request, res: Response) => {
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
  });

  // GET /api/health — system summary.
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'opencode-platform' });
  });

  return router;
}
