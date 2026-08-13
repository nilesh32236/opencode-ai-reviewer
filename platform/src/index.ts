/**
 * Platform server entry point. Boots the Express server, then (in later
 * chunks) the task queue, worker, and webhook receiver. For the vertical
 * slice this only wires configuration and the HTTP server.
 */

import type { Server } from 'node:http';
import { Logger } from '@opencode-pr-agent/lib';
import { buildPlatformConfig } from './config.js';
import { createPlatformServer } from './server.js';

const logger = new Logger('Platform');

/**
 * Start the platform server. Resolves once the HTTP server is listening, and
 * rejects when port binding fails (e.g. EADDRINUSE), so callers can surface
 * the startup error instead of silently exiting.
 * @returns A handle exposing `server` (the Node http.Server) for tests and
 * graceful shutdown.
 */
export async function startPlatform(): Promise<{ server: Server }> {
  const config = buildPlatformConfig();
  const app = createPlatformServer(config);

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

  return { server };
}

// Only auto-start when run directly (not when imported by tests).
if (require.main === module) {
  startPlatform().catch((err) => {
    logger.error(`Platform failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
