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
import type { PlatformDb } from '../db/client.js';
import { getTask, listTasks, updateTask } from '../db/repositories.js';
import type { TaskQueue } from '../queue/manager.js';
import type { PlatformTaskType, TaskJobData } from '../queue/types.js';

const logger = new Logger('Api');

/**
 * Build the REST API router.
 * @param db - The platform database.
 * @param queue - The task queue (optional; task creation is disabled without it).
 * @returns An Express router mounted under /api.
 */
export function createApiRouter(db: PlatformDb, queue: TaskQueue | null): Router {
  const router = createRouter();

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
  router.post('/tasks', async (req: Request, res: Response) => {
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
    const type = body.type as PlatformTaskType | undefined;
    if (!repo || !type) {
      res.status(400).json({ error: 'repo and type are required' });
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
  router.post('/tasks/:id/retry', async (req: Request, res: Response) => {
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
