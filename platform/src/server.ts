/**
 * Express HTTP server for the platform. For the vertical slice this exposes
 * liveness/readiness probes and a placeholder API health route; the task
 * queue, webhook receiver, and dashboard are added in later chunks.
 */

import { Logger } from '@opencode-pr-agent/lib';
import type { Request, Response } from 'express';
import express from 'express';
import type { PlatformConfig } from './config.js';

/** Per-component health probe results. */
export interface HealthComponent {
  /** Component name (e.g. 'database', 'queue', 'server'). */
  name: string;
  /** True when the component check passed. */
  ok: boolean;
  /** Optional detail (response time, error message). */
  detail?: string;
}

/** Health response payload. */
export interface HealthResponse {
  /** Overall status: 'ok' | 'degraded' | 'error'. */
  status: 'ok' | 'degraded' | 'error';
  /** Per-component results. */
  components: HealthComponent[];
}

/**
 * Build and return the platform Express app.
 * @param config - Platform configuration.
 * @param deps - Runtime dependencies injected for testability. When omitted,
 * the health probe reports unconfigured subsystems as non-critical.
 * @param deps.databaseOk - Optional async check that returns whether the
 * PostgreSQL database is reachable.
 * @param deps.queueOk - Optional async check that returns whether the task
 * queue (Redis) is reachable.
 * @returns The configured Express application.
 */
export function createPlatformServer(
  config: PlatformConfig,
  deps: {
    databaseOk?: () => Promise<boolean> | boolean;
    queueOk?: () => Promise<boolean> | boolean;
  } = {},
): express.Express {
  const app = express();
  const logger = new Logger('PlatformServer');

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req: Request, res: Response) => {
    const components: HealthComponent[] = [];

    // Database — critical when configured; skipped (non-critical) when no
    // DATABASE_URL is set so the server can boot for health checks alone.
    if (config.databaseUrl) {
      try {
        const ok = await deps.databaseOk?.();
        components.push({
          name: 'database',
          ok: ok === true,
          detail: ok === true ? 'ok' : 'unreachable',
        });
      } catch (err) {
        components.push({ name: 'database', ok: false, detail: 'unreachable' });
        logger.error(
          `Health check database failure: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Queue — critical when a Redis URL is configured.
    if (config.redisUrl) {
      try {
        const ok = await deps.queueOk?.();
        components.push({
          name: 'queue',
          ok: ok === true,
          detail: ok === true ? 'ok' : 'unreachable',
        });
      } catch (err) {
        components.push({ name: 'queue', ok: false, detail: 'unreachable' });
        logger.error(
          `Health check queue failure: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    components.push({ name: 'server', ok: true, detail: 'listening' });

    const anyCriticalDown = components.some((c) => !c.ok);
    const status: HealthResponse['status'] = anyCriticalDown ? 'error' : 'ok';
    res.status(anyCriticalDown ? 503 : 200).json({ status, components });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'opencode-platform', version: '0.1.0' });
  });

  return app;
}
