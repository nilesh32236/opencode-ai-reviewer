/**
 * Health and readiness probes for the Probot app. Exposes `GET /health`
 * (liveness: process alive + critical components reachable) and `GET /ready`
 * (readiness: stricter — DB ping succeeds and MCP initialization has completed)
 * via a Probot Express router mounted at `app.route('/')`.
 */

import { type LearningStore, Logger } from '@opencode-pr-agent/lib';
import type { Request, Response, Router } from 'express';
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

/**
 * Create the health/readiness router.
 *
 * @param learningStore - LearningStore used to ping the database (critical).
 * @param mcpStatus - Optional getter for MCP connection status; when omitted,
 * the MCP component reports ok with 0/0 servers (no MCP configured).
 * @returns An Express Router with `GET /health` and `GET /ready` routes.
 */
export function createHealthRouter(
  learningStore: LearningStore,
  mcpStatus?: () => { initialized: boolean; connectedServers: number; totalServers: number },
): Router {
  const router = createRouter();
  const logger = new Logger('Health');

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

  router.get('/health', async (_req: Request, res: Response) => {
    const result = await check(false);
    res.status(result.status === 'error' ? 503 : 200).json(result);
  });

  router.get('/ready', async (_req: Request, res: Response) => {
    const result = await check(true);
    res.status(result.status === 'ok' ? 200 : 503).json(result);
  });

  return router;
}
