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
import type { PlatformTaskType, TaskJobData } from '../queue/types.js';

const logger = new Logger('Api');

/**
 * Task types the worker can actually dispatch.
 *
 * The request body is a network input, so `type` is validated against this set
 * at runtime rather than `as`-cast to {@link PlatformTaskType}. An unvalidated
 * value reached the worker as an unknown job name and only failed *after* the
 * workspace clone had already run.
 */
const DISPATCHABLE_TASK_TYPES: ReadonlySet<PlatformTaskType> = new Set<PlatformTaskType>([
  'review',
  'analyze',
]);

/**
 * Whether a request-supplied type is one the worker can dispatch.
 *
 * A type guard rather than a cast: the body is untrusted input, and the check
 * is what makes narrowing to {@link PlatformTaskType} sound.
 * @param value - The raw `type` from the request body.
 * @returns True when the worker supports this task type.
 */
function isDispatchableTaskType(value: string): value is PlatformTaskType {
  return DISPATCHABLE_TASK_TYPES.has(value as PlatformTaskType);
}

/** `owner/repo` — one owner segment, one repo segment, no path traversal. */
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Build the REST API router.
 * @param db - The platform database.
 * @param queue - The task queue (optional; task creation is disabled without it).
 * @returns An Express router mounted under /api.
 */
export function createApiRouter(db: PlatformDb, queue: TaskQueue | null): Router {
  const router = createRouter();

  // Cost-incurring and state-changing routes are role-gated. `requireRole`
  // existed but was never mounted, so a `viewer` could enqueue work for any
  // repository and spend LLM budget with the platform's own token — see #948.
  // The guard is applied per-route rather than with router.use() so the read
  // routes stay available to every authenticated role.
  const requireReviewer = requireRole('reviewer');

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
    if (!isDispatchableTaskType(type)) {
      res.status(400).json({ error: `Unsupported task type: ${type}` });
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
      const data: TaskJobData = {
        repo: row.repo,
        type: row.type as PlatformTaskType,
        taskId: row.id,
        prNumber: row.pr_number ?? undefined,
        headSha: row.head_sha ?? undefined,
        triggerSource: 'manual',
      };
      const job = await queue.enqueue(data);
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
