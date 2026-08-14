/**
 * Express HTTP server for the platform. For the vertical slice this exposes
 * liveness/readiness probes and a placeholder API health route; the task
 * queue, webhook receiver, and dashboard are added in later chunks.
 */

import path from 'node:path';
import { Logger } from '@opencode-pr-agent/lib';
import type { Request, Response } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { PlatformConfig } from './config.js';
import type { PlatformDb } from './db/client.js';
import type { TaskQueue } from './queue/manager.js';
import { createApiRouter } from './routes/api.js';
import { createEventsRouter } from './routes/events.js';
import { PLATFORM_VERSION } from './version.js';

/** Per-component health probe results. */
export interface HealthComponent {
  /** Component name (e.g. 'database', 'queue', 'server'). */
  name: string;
  /** True when the component check passed. */
  ok: boolean;
  /** Optional detail (response time, error message). */
  detail?: string;
}

/** Rate limiter for the public dashboard static/fallback routes. */
const DASHBOARD_RATE_LIMIT = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

/** Health response payload. */
export interface HealthResponse {
  /** Overall status: 'ok' | 'degraded' | 'error'. */
  status: 'ok' | 'degraded' | 'error';
  /** Per-component results. */
  components: HealthComponent[];
}

/** Number of seconds a subsystem probe may run before timing out. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Run a health probe with a hard timeout, so a hung or flaky dependency
 * cannot stall the liveness endpoint. Uses `Promise.race` against a timer so
 * the bound holds even when the probe ignores cancellation signals.
 * The timer is always cleared (success, timeout, or thrown probe) so a single
 * poll never leaks a timeout handle. Exported for unit testing.
 * @param name - Component name (for error logging).
 * @param probe - The probe to run; returns true when the subsystem is healthy.
 * @param logger - Logger for probe failures.
 * @returns True when the probe reported healthy within the timeout.
 */
export async function runProbe(
  name: string,
  probe: (() => Promise<boolean> | boolean) | undefined,
  logger: Logger,
): Promise<boolean> {
  if (!probe) return true;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    const ok = await Promise.race([Promise.resolve(probe()), timeout]);
    return ok;
  } catch (err) {
    logger.error(
      `Health check ${name} failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    // Always clear the timer — whether the probe won, hung, rejected, or threw
    // synchronously — so a single /health poll never leaks a timeout handle.
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Build and return the platform Express app.
 * @param config - Platform configuration.
 * @param deps - Runtime dependencies injected for testability. When a subsystem
 * URL is configured but its probe is omitted, the component reports `ok: true`
 * with detail "not-wired" — the probe will be supplied by a later chunk, and a
 * missing probe must not fail-close the liveness endpoint.
 * @param deps.databaseOk - Optional async check that returns whether the
 * PostgreSQL database is reachable.
 * @param deps.queueOk - Optional async check that returns whether the task
 * queue (Redis) is reachable.
 * @param deps.webhookHandler - Optional webhook route handler mounted at
 * POST /webhooks/github with raw-body parsing (HMAC needs the exact bytes).
 * @param deps.db - Optional platform database handle; when present the
 * dashboard REST API + SSE event routes are mounted under /api.
 * @param deps.queue - Optional task queue used by the /api/tasks routes.
 * @param deps.dashboardDir - Optional directory of the built dashboard
 * (platform/web/dist); served under /dashboard with an SPA fallback.
 * @returns The configured Express application.
 */
export function createPlatformServer(
  config: PlatformConfig,
  deps: {
    databaseOk?: () => Promise<boolean> | boolean;
    queueOk?: () => Promise<boolean> | boolean;
    webhookHandler?: (req: Request, res: Response) => Promise<void>;
    db?: PlatformDb;
    queue?: TaskQueue | null;
    dashboardDir?: string;
  } = {},
): express.Express {
  const app = express();
  const logger = new Logger('PlatformServer');

  app.disable('x-powered-by');
  // Behind the Caddy reverse proxy, which sets X-Forwarded-For. Required for
  // express-rate-limit to correctly key clients by their real IP instead of
  // the proxy's, and for correct client IPs in logs. Caddy is the only ingress.
  app.set('trust proxy', true);

  // Mount the webhook route BEFORE the global express.json() middleware:
  // HMAC verification needs the exact raw bytes GitHub signed, and once
  // express.json() consumes the body it is no longer available as a Buffer.
  if (deps.webhookHandler) {
    app.post('/webhooks/github', express.raw({ type: '*/*', limit: '10mb' }), deps.webhookHandler);
  }

  // JSON for the API/health routes.
  app.use(express.json({ limit: '1mb' }));

  // Dashboard REST API + SSE events (mounted when a DB is available).
  if (deps.db) {
    app.use('/api', createApiRouter(deps.db, deps.queue ?? null));
    app.use('/api', createEventsRouter(deps.db));
  }

  // Serve the built dashboard (platform/web/dist) when present. Assets are
  // served under /dashboard with an SPA fallback to index.html. Express 5 /
  // path-to-regexp requires a named wildcard (not bare `*`). The static +
  // fallback handlers are rate-limited (file system access on public routes)
  // to bound abuse; express.static already guards against path traversal.
  if (deps.dashboardDir) {
    const dashboard = express.static(deps.dashboardDir, { maxAge: '1h' });
    app.use('/dashboard', DASHBOARD_RATE_LIMIT, dashboard);
    app.get('/dashboard/*path', DASHBOARD_RATE_LIMIT, (_req, res) => {
      res.sendFile(path.join(deps.dashboardDir as string, 'index.html'));
    });
    app.get('/dashboard', DASHBOARD_RATE_LIMIT, (_req, res) => {
      res.sendFile(path.join(deps.dashboardDir as string, 'index.html'));
    });
  }

  app.get('/health', async (_req: Request, res: Response) => {
    const components: HealthComponent[] = [];

    // Database — checked only when configured; a configured-but-unwired
    // subsystem reports ok ("not-wired") rather than failing the endpoint.
    if (config.databaseUrl) {
      const probe = deps.databaseOk;
      const ok = await runProbe('database', probe, logger);
      components.push({
        name: 'database',
        ok,
        detail: ok ? (probe ? 'ok' : 'not-wired') : 'unreachable',
      });
    }

    // Queue — checked only when a Redis URL is configured.
    if (config.redisUrl) {
      const probe = deps.queueOk;
      const ok = await runProbe('queue', probe, logger);
      components.push({
        name: 'queue',
        ok,
        detail: ok ? (probe ? 'ok' : 'not-wired') : 'unreachable',
      });
    }

    components.push({ name: 'server', ok: true, detail: 'listening' });

    // Degraded when at least one configured subsystem is down but the server
    // itself is alive; error only when every critical component is down.
    const down = components.filter((c) => !c.ok);
    let status: HealthResponse['status'] = 'ok';
    if (down.length > 0) status = down.length === components.length ? 'error' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({ status, components });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'opencode-platform', version: PLATFORM_VERSION });
  });

  return app;
}
