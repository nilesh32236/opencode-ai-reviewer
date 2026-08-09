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
});
