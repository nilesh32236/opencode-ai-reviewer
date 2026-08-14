/**
 * Server-Sent Events (SSE) streaming for the platform dashboard.
 *
 * GET /api/events streams a live feed of task lifecycle events. Events are
 * read from the `task_events` table via a lightweight poll loop, so the
 * dashboard updates without WebSockets or an extra pub-sub dependency.
 */

import { Logger } from '@opencode-pr-agent/lib';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import type { DbRow, PlatformDb } from '../db/client.js';

const logger = new Logger('Sse');

/** Milliseconds between event polls. */
const POLL_INTERVAL_MS = 2_000;

/**
 * Build the SSE router.
 * @param db - The platform database (reads task_events).
 * @returns An Express router mounted under /api.
 */
export function createEventsRouter(db: PlatformDb): Router {
  const router = createRouter();

  router.get('/events', async (req: Request, res: Response) => {
    // SSE headers + flush so the client sees the connection open immediately.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    let lastSeen: string | null = null;
    const poll = async (): Promise<void> => {
      try {
        // Fetch events created after the last one we sent, newest first.
        const rows = await db.query<DbRow>(
          `SELECT id::text AS id, task_id::text AS task_id, event_type, payload,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
           FROM task_events
           WHERE ($1::text IS NULL OR id::text > $1::text)
           ORDER BY created_at ASC
           LIMIT 50`,
          lastSeen ? [lastSeen] : [null],
        );
        for (const row of rows) {
          const data = JSON.stringify({
            id: row.id,
            taskId: row.task_id,
            eventType: row.event_type,
            payload: row.payload ?? null,
            createdAt: row.created_at,
          });
          res.write(`data: ${data}\n\n`);
          if (typeof row.id === 'string') lastSeen = row.id;
        }
      } catch (err) {
        // A transient DB error should not kill the stream; log and continue.
        logger.warn(`SSE poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Send an initial heartbeat so the client gets data even with no events.
    void poll();
    res.write('event: connected\ndata: {}\n\n');

    req.on('close', () => {
      clearInterval(timer);
    });
  });

  return router;
}
