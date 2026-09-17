import type { LearningStore } from '@opencode-pr-agent/lib';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createHealthRouter } from '../src/health.js';

function makeApp(
  store: LearningStore,
  mcpStatus?: () => { initialized: boolean; connectedServers: number; totalServers: number },
) {
  const app = express();
  app.use(createHealthRouter(store, mcpStatus));
  return app;
}

describe('createHealthRouter', () => {
  it('GET /health returns ok when database and mcp are healthy', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: true,
      connectedServers: 1,
      totalServers: 1,
    }));

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.components.find((c: { name: string }) => c.name === 'database')?.ok).toBe(true);
    expect(res.body.components.find((c: { name: string }) => c.name === 'mcp')?.ok).toBe(true);
  });

  it('GET /health returns 503 when the database is unreachable', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: false, responseMs: 0 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: true,
      connectedServers: 1,
      totalServers: 1,
    }));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });

  it('GET /health reports degraded (200) when only MCP is unhealthy', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: false,
      connectedServers: 0,
      totalServers: 2,
    }));

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  it('GET /ready requires MCP initialization', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: false,
      connectedServers: 0,
      totalServers: 2,
    }));

    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('GET /ready returns 200 when DB ping succeeds and MCP is initialized', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: true,
      connectedServers: 1,
      totalServers: 1,
    }));

    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /ready returns 200 when no MCP servers are configured', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: false,
      connectedServers: 0,
      totalServers: 0,
    }));

    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/v1/health mirrors /health', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: true,
      connectedServers: 1,
      totalServers: 1,
    }));

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/v1/ready mirrors /ready', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: false,
      connectedServers: 0,
      totalServers: 2,
    }));

    const res = await request(app).get('/api/v1/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('sends Cache-Control: no-store on probes', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store);

    const res = await request(app).get('/health');

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 429 with Retry-After and the error shape when throttled', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const app = makeApp(store, () => ({
      initialized: true,
      connectedServers: 1,
      totalServers: 1,
    }));

    let res = await request(app).get('/health');
    expect(res.status).toBe(200);
    // PROBE_RATE_MAX is 300 per IP per window; exceed it from the same client.
    for (let i = 0; i < 300; i++) {
      res = await request(app).get('/health');
    }

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toEqual({ status: 'error', components: [] });
  });

  it('error middleware returns the 503 error shape with no-store', async () => {
    const store = {
      ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
    } as unknown as LearningStore;
    const router = createHealthRouter(store);
    // Reach the centralized error-handling layer (4-arg middleware) and mount
    // it behind a route that forwards a failure, exercising the 503 path.
    const stack = router.stack as unknown as Array<{
      handle: (...args: unknown[]) => void;
    }>;
    const errorLayer = stack.find((l) => l.handle.length === 4);
    expect(errorLayer).toBeDefined();
    const probeApp = express();
    probeApp.get('/boom', (_req, _res, next) => {
      next(new Error('boom'));
    });
    probeApp.use(errorLayer?.handle as unknown as express.ErrorRequestHandler);

    const res = await request(probeApp).get('/boom');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', components: [] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 401 without a bearer token when HEALTH_AUTH_TOKEN is set', async () => {
    process.env.HEALTH_AUTH_TOKEN = 'secret-token';
    try {
      const store = {
        ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
      } as unknown as LearningStore;
      const app = makeApp(store);

      const res = await request(app).get('/health');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ status: 'error', components: [] });
    } finally {
      // Deleting via a computed key fully unsets the variable; assigning
      // `undefined` would store the literal string "undefined".
      const tokenKey = 'HEALTH_AUTH_TOKEN';
      delete process.env[tokenKey];
    }
  });

  it('allows probes with the correct bearer token when HEALTH_AUTH_TOKEN is set', async () => {
    process.env.HEALTH_AUTH_TOKEN = 'secret-token';
    try {
      const store = {
        ping: vi.fn(async () => ({ ok: true, responseMs: 5 })),
      } as unknown as LearningStore;
      const app = makeApp(store);

      const res = await request(app).get('/health').set('Authorization', 'Bearer secret-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    } finally {
      const tokenKey = 'HEALTH_AUTH_TOKEN';
      delete process.env[tokenKey];
    }
  });
});
