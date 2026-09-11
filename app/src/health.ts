/**
 * Health and readiness probes for the Probot app. Exposes `GET /health`
 * (liveness: process alive + critical components reachable) and `GET /ready`
 * (readiness: stricter — DB ping succeeds and MCP initialization has completed)
 * via a Probot Express router mounted at `app.route('/')`.
 *
 * Versioned aliases `GET /api/v1/health` and `GET /api/v1/ready` share the
 * same handlers; the root paths are kept for container orchestrators
 * (Kubernetes, Docker Compose) that already scrape them.
 *
 * Status-code contract (intentional liveness-vs-readiness divergence):
 * - `/health` (liveness): `ok` → 200, `degraded` → 200 (process is alive,
 *   only a non-critical component is down), `error` → 503.
 * - `/ready` (readiness): `ok` → 200, anything else (`degraded` or `error`)
 *   → 503 (the instance must not receive traffic).
 */

import { type LearningStore, Logger } from '@opencode-pr-agent/lib';
import type { NextFunction, Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';

/** Status of a single health-checked component. */
export interface HealthComponent {
  /** Component name (e.g. 'database', 'mcp', 'webhook'). */
  name: string;
  /** True when the component check passed. */
  ok: boolean;
  /** Optional detail (e.g. connected server count, response time). */
  detail?: string;
}

/** Health response payload returned by the probes. */
export interface HealthResponse {
  /** Overall status: 'ok' | 'degraded' | 'error'. */
  status: 'ok' | 'degraded' | 'error';
  /** Per-component results. */
  components: HealthComponent[];
}

/** Window for the lightweight in-memory probe rate limit. */
const PROBE_RATE_WINDOW_MS = 60_000;
/** Max probe requests per IP per window (generous — only stops tight loops). */
const PROBE_RATE_MAX = 300;

/**
 * Create the health/readiness router.
 *
 * @param learningStore - LearningStore used to ping the database (critical).
 * @param mcpStatus - Optional getter for MCP connection status; when omitted,
 * the MCP component reports ok with 0/0 servers (no MCP configured).
 * @returns An Express Router with `GET /health`, `GET /ready`,
 * `GET /api/v1/health`, and `GET /api/v1/ready` routes plus a centralized
 * error middleware returning the consistent `{ status, components }` shape.
 */
export function createHealthRouter(
  learningStore: LearningStore,
  mcpStatus?: () => { initialized: boolean; connectedServers: number; totalServers: number },
): Router {
  const router = createRouter();
  const logger = new Logger('Health');
  // Last-seen timestamps per client IP for probe rate limiting.
  const probeHits = new Map<string, number[]>();

  /**
   * Lightweight in-memory rate limit + cache-header hardening for probes.
   * Health scraping on a short interval must not pile DB-ping load, and
   * probes must never be cached by intermediaries.
   */
  function probeGuard(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const hits = (probeHits.get(ip) ?? []).filter((t) => now - t < PROBE_RATE_WINDOW_MS);
    hits.push(now);
    probeHits.set(ip, hits);
    if (hits.length > PROBE_RATE_MAX) {
      res.status(429).json({ status: 'error', components: [] } satisfies HealthResponse);
      return;
    }
    next();
  }

  /**
   * Build a health response by checking all components.
   * @param requireReady - When true, treat un-initialized MCP as failing
   * (readiness semantics); when false, MCP failures are non-critical.
   * @returns The computed health response.
   */
  async function check(requireReady: boolean): Promise<HealthResponse> {
    const components: HealthComponent[] = [];

    // Database — critical. If the store cannot ping, report error.
    let dbOk = false;
    try {
      const ping = await learningStore.ping();
      dbOk = ping.ok;
      components.push({
        name: 'database',
        ok: ping.ok,
        detail: ping.ok ? `${ping.responseMs}ms` : 'unreachable',
      });
    } catch (err) {
      components.push({ name: 'database', ok: false, detail: 'unreachable' });
      logger.error(
        `Health check database failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // MCP — non-critical on /health (reports degraded), gating on /ready.
    let mcp = { initialized: false, connectedServers: 0, totalServers: 0 };
    if (mcpStatus) {
      try {
        mcp = mcpStatus();
      } catch {
        mcp = { initialized: false, connectedServers: 0, totalServers: 0 };
      }
    }
    // Healthy when there is nothing to connect, or all configured servers are
    // connected. On /ready, also require the initialization pass to have run
    // when servers are configured (zero configured servers is always ready).
    const mcpConnected = mcp.totalServers === 0 || mcp.connectedServers === mcp.totalServers;
    const mcpOk =
      mcp.totalServers === 0 ? true : requireReady ? mcpConnected && mcp.initialized : mcpConnected;
    components.push({
      name: 'mcp',
      ok: mcpOk,
      detail: `${mcp.connectedServers}/${mcp.totalServers} connected${mcp.initialized ? ', initialized' : ''}`,
    });

    // Webhook listener — always considered ready once the app mounted routes.
    components.push({ name: 'webhook', ok: true, detail: 'listening' });

    if (!dbOk) {
      return { status: 'error', components };
    }
    const allOk = components.every((c) => c.ok);
    return { status: allOk ? 'ok' : 'degraded', components };
  }

  async function handleHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await check(false);
      // Liveness: degraded MCP still reports 200 — the process is alive.
      res.status(result.status === 'error' ? 503 : 200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async function handleReady(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await check(true);
      // Readiness: anything but ok reports 503 so the instance leaves rotation.
      res.status(result.status === 'ok' ? 200 : 503).json(result);
    } catch (err) {
      next(err);
    }
  }

  router.get('/health', probeGuard, handleHealth);
  router.get('/ready', probeGuard, handleReady);
  // Versioned RESTful aliases sharing the same handlers; root paths above are
  // kept for orchestrators that already scrape them.
  router.get('/api/v1/health', probeGuard, handleHealth);
  router.get('/api/v1/ready', probeGuard, handleReady);

  // Centralized error middleware so an unexpected throw in check() becomes a
  // consistent error-shape 503 instead of an unhandled rejection / hung probe.
  // biome-ignore lint/suspicious/noExplicitAny: Express error-middleware signature requires 4 args.
  router.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
    logger.error(`Health probe failed: ${err instanceof Error ? err.message : String(err)}`);
    res.setHeader('Cache-Control', 'no-store');
    if (!res.headersSent) {
      res.status(503).json({ status: 'error', components: [] } satisfies HealthResponse);
    }
  });

  return router;
}
