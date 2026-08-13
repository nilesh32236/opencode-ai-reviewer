import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlatformConfig } from '../src/config.js';
import { createPlatformServer } from '../src/server.js';

describe('platform server', () => {
  let app: Express;

  beforeEach(() => {
    app = createPlatformServer(buildPlatformConfig({ PORT: '8080' }), {
      databaseOk: () => Promise.resolve(true),
      queueOk: () => Promise.resolve(true),
    });
  });

  afterEach(() => {
    app.removeAllListeners();
  });

  it('returns ok on GET /health when all subsystems healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'server', ok: true }),
    );
  });

  it('returns 503 with database error when the DB is unreachable', async () => {
    const failingApp = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x:y@localhost:5432/z' }),
      {
        databaseOk: () => Promise.resolve(false),
        queueOk: () => Promise.resolve(true),
      },
    );
    const res = await request(failingApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'database', ok: false }),
    );
  });

  it('reports ok with only server component when no subsystems configured', async () => {
    const minimalApp = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: '', REDIS_URL: '' }),
    );
    const res = await request(minimalApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.components).toHaveLength(1);
    expect(res.body.components[0].name).toBe('server');
  });

  it('exposes /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
