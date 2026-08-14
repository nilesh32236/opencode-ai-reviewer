/**
 * Platform server entry point. Boots the HTTP server and, when DATABASE_URL is
 * configured, connects to PostgreSQL and applies pending migrations so the
 * queue/worker (later chunks) can persist tasks. When REDIS_URL is configured,
 * creates the BullMQ queue and mounts the GitHub webhook receiver.
 */

import type { Server } from 'node:http';
import { Logger } from '@opencode-pr-agent/lib';
import { Redis } from 'ioredis';
import { buildPlatformConfig } from './config.js';
import { connectPlatformDb } from './db/client.js';
import type { PlatformDb } from './db/client.js';
import { TaskQueue } from './queue/manager.js';
import { createPlatformServer } from './server.js';
import { createWebhookHandler } from './webhooks.js';

const logger = new Logger('Platform');

/**
 * Start the platform server. Connects to PostgreSQL (and applies migrations)
 * when DATABASE_URL is set, creates the BullMQ queue when REDIS_URL is set,
 * and mounts the webhook receiver. Resolves once the HTTP server is listening,
 * and rejects when port binding fails or the database cannot be reached.
 * @returns A handle exposing `server`, the DB handle, and the queue (for
 * graceful shutdown).
 */
export async function startPlatform(): Promise<{
  server: Server;
  db: PlatformDb | null;
  queue: TaskQueue | null;
}> {
  const config = buildPlatformConfig();

  // Connect to Postgres and apply migrations when configured. The DB is
  // optional so the server can boot for health checks before DATABASE_URL is
  // set; when configured, a failure to reach/migrate it is fatal.
  let db: PlatformDb | null = null;
  if (config.databaseUrl) {
    db = await connectPlatformDb(config.databaseUrl, process.env.PLATFORM_MIGRATIONS_DIR);
    logger.info('PostgreSQL connected and migrations applied');
  } else {
    logger.warn('DATABASE_URL not set — running without task persistence');
  }

  // BullMQ queue + Redis connection when configured.
  let queue: TaskQueue | null = null;
  let redis: Redis | null = null;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    queue = new TaskQueue(redis);
    logger.info('Task queue connected');
  } else {
    logger.warn('REDIS_URL not set — running without a task queue');
  }

  const app = createPlatformServer(config, {
    databaseOk: () => (db ? db.ping() : true),
    queueOk: () => (queue ? redis?.status === 'ready' : true),
    webhookHandler: db && queue ? createWebhookHandler(db, queue, config.webhookSecret) : undefined,
  });

  const server = app.listen(config.port);

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      logger.info(`OpenCode platform listening on http://0.0.0.0:${config.port}`);
      resolve();
    });
    server.once('error', (err: Error) => {
      reject(err);
    });
  });

  return { server, db, queue };
}

// Only auto-start when run directly (not when imported by tests).
if (require.main === module) {
  let started: { server: Server; db: PlatformDb | null; queue: TaskQueue | null } | undefined;
  startPlatform()
    .then((handle) => {
      started = handle;
    })
    .catch((err) => {
      logger.error(`Platform failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });

  // Graceful shutdown: close the queue and DB pool, then exit on SIGTERM/SIGINT.
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal} — shutting down`);
    started?.server.close(() => {
      Promise.allSettled([
        started?.queue?.close() ?? Promise.resolve(),
        started?.db?.close() ?? Promise.resolve(),
      ])
        .catch((err) => {
          logger.warn(
            `Shutdown cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => process.exit(0));
    });
    // Hard fallback so a hung close never blocks the container stop.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
