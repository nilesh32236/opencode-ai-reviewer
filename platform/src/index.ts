/**
 * Platform server entry point. Boots the HTTP server and, when DATABASE_URL is
 * configured, connects to PostgreSQL and applies pending migrations so the
 * queue/worker (later chunks) can persist tasks. The webhook receiver and
 * worker are added in later chunks.
 */

import type { Server } from 'node:http';
import { Logger } from '@opencode-pr-agent/lib';
import { buildPlatformConfig } from './config.js';
import { connectPlatformDb } from './db/client.js';
import type { PlatformDb } from './db/client.js';
import { createPlatformServer } from './server.js';

const logger = new Logger('Platform');

/**
 * Start the platform server. Connects to PostgreSQL (and applies migrations)
 * when DATABASE_URL is set, then boots the HTTP server with live database and
 * queue probes. Resolves once the HTTP server is listening, and rejects when
 * port binding fails (e.g. EADDRINUSE) or the database cannot be reached.
 * @returns A handle exposing `server` (the Node http.Server) and the DB handle
 * (for graceful shutdown).
 */
export async function startPlatform(): Promise<{ server: Server; db: PlatformDb | null }> {
  const config = buildPlatformConfig();

  // Connect to Postgres and apply migrations when configured. The DB is
  // optional so the server can boot for health checks before DATABASE_URL is
  // set; when configured, a failure to reach/migrate it is fatal.
  let db: PlatformDb | null = null;
  if (config.databaseUrl) {
    db = await connectPlatformDb(
      config.databaseUrl,
      // The migrations dir defaults to the bundled dist/db/migrations, but the
      // callers may override via env (e.g. a volume-mounted copy in prod).
      process.env.PLATFORM_MIGRATIONS_DIR,
    );
    logger.info('PostgreSQL connected and migrations applied');
  } else {
    logger.warn('DATABASE_URL not set — running without task persistence');
  }

  const app = createPlatformServer(config, {
    databaseOk: () => (db ? db.ping() : true),
    // Queue probe comes with the BullMQ worker (Chunk 4); until then report ok.
    queueOk: () => Promise.resolve(true),
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

  return { server, db };
}

// Only auto-start when run directly (not when imported by tests).
if (require.main === module) {
  let started: { server: Server; db: PlatformDb | null } | undefined;
  startPlatform()
    .then((handle) => {
      started = handle;
    })
    .catch((err) => {
      logger.error(`Platform failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });

  // Graceful shutdown: close the DB pool and exit on SIGTERM/SIGINT.
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal} — shutting down`);
    started?.server.close(() => {
      started?.db
        ?.close()
        .catch((err) => {
          logger.warn(
            `DB close failed during shutdown: ${err instanceof Error ? err.message : String(err)}`,
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
