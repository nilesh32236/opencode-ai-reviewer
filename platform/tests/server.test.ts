import { Logger } from '@opencode-pr-agent/lib';
import type { Express, Request } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlatformConfig } from '../src/config.js';
import { createPlatformServer, runProbe } from '../src/server.js';
import { PLATFORM_VERSION } from '../src/version.js';

describe('runProbe', () => {
  const logger = new Logger('TestProbe');

  it('returns true for a healthy probe and clears its timeout', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const ok = await runProbe('db', () => Promise.resolve(true), logger);
    expect(ok).toBe(true);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('returns false and clears its timeout when the probe hangs', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const ok = await runProbe('db', () => new Promise<boolean>(() => {}), logger);
    expect(ok).toBe(false);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('returns false and clears its timeout when the probe throws', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const ok = await runProbe(
      'db',
      () => {
        throw new Error('boom');
      },
      logger,
    );
    expect(ok).toBe(false);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('returns true without scheduling a timer when no probe is provided', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const ok = await runProbe('db', undefined, logger);
    expect(ok).toBe(true);
    expect(clearSpy).not.toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe('platform server', () => {
  let app: Express;

  beforeEach(() => {
    app = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' }),
      {
        databaseOk: () => Promise.resolve(true),
        queueOk: () => Promise.resolve(true),
      },
    );
  });

  afterEach(() => {
    app.removeAllListeners();
  });

  it('returns ok on GET /health when all subsystems healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'database', ok: true, detail: 'ok' }),
    );
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'queue', ok: true, detail: 'ok' }),
    );
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'server', ok: true }),
    );
  });

  it('returns degraded when one configured subsystem is down', async () => {
    const partialApp = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' }),
      {
        databaseOk: () => Promise.resolve(true),
        queueOk: () => Promise.resolve(false),
      },
    );
    const res = await request(partialApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'queue', ok: false }),
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
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'database', ok: false, detail: 'unreachable' }),
    );
  });

  it('reports not-wired (non-failing) when a configured subsystem lacks a probe', async () => {
    const notWiredApp = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x' }),
    );
    const res = await request(notWiredApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'database', ok: true, detail: 'not-wired' }),
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

  it('fails the probe when it hangs past the timeout', async () => {
    const slowApp = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x' }),
      {
        databaseOk: () => new Promise<boolean>(() => {}),
      },
    );
    const res = await request(slowApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.components).toContainEqual(
      expect.objectContaining({ name: 'database', ok: false }),
    );
  });

  it('exposes /api/health with the package version', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe(PLATFORM_VERSION);
  });

  it('mounts the webhook route with raw body parsing before JSON middleware', async () => {
    // The webhook handler must receive the raw Buffer body so HMAC verification
    // sees the exact bytes GitHub signed — express.json() must not consume it.
    let receivedBody: unknown;
    let receivedHeaders: Record<string, string | undefined> = {};
    const webhookApp = createPlatformServer(buildPlatformConfig({ PORT: '8080' }), {
      webhookHandler: async (req, res) => {
        receivedBody = (req as Request & { body: unknown }).body;
        receivedHeaders = {
          event: req.header('x-github-event'),
          delivery: req.header('x-github-delivery'),
        };
        res.status(200).json({ ok: true });
      },
    });
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'a/b' } });
    const res = await request(webhookApp)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'del-xyz')
      .send(payload);

    expect(res.status).toBe(200);
    // express.raw() produces a Buffer; if express.json() ran first it would be
    // a plain object and this assertion would fail.
    expect(Buffer.isBuffer(receivedBody)).toBe(true);
    expect((receivedBody as Buffer).toString('utf-8')).toBe(payload);
    expect(receivedHeaders.event).toBe('pull_request');
    expect(receivedHeaders.delivery).toBe('del-xyz');
  });
});
