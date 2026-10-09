import { Logger } from '@opencode-pr-agent/lib';
import type { Express, Request } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlatformConfig } from '../src/config.js';
import type { PlatformDb } from '../src/db/client.js';
import type { TaskQueue } from '../src/queue/manager.js';
import { createPlatformServer, runProbe } from '../src/server.js';
import { PLATFORM_VERSION } from '../src/version.js';
import { createWebhookHandler } from '../src/webhooks.js';

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
  }, 10000);

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

  it('handles an empty webhook body without crashing', async () => {
    // A probe or malformed request with no body must not throw in the handler.
    const handler = createWebhookHandler(
      {
        queryOne: vi.fn(async () => undefined),
        execute: vi.fn(async () => {}),
        query: vi.fn(async () => []),
        ping: vi.fn(async () => true),
      } as unknown as PlatformDb,
      { enqueue: vi.fn(async () => ({})) } as unknown as TaskQueue,
      'secret',
    );
    const webhookApp = createPlatformServer(buildPlatformConfig({ PORT: '8080' }), {
      webhookHandler: handler,
    });
    const res = await request(webhookApp)
      .post('/webhooks/github')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'empty-del');
    // Either 401 (missing signature) or 400 (invalid JSON) — never a crash.
    expect([401, 400]).toContain(res.status);
  });
});

// The auth-disabled deployment is documented in .env.platform.example: with
// GITHUB_CLIENT_ID/SECRET and SESSION_SECRET all empty, "the dashboard/API are
// served without authentication (intended to sit behind the Caddy reverse proxy
// until auth is configured)".
//
// `requireRole` now fails CLOSED on a session-less request by default and passes
// through only when handed `trustProxy`. That exception is opt-in, so the wiring
// in server.ts — `{ trustProxy: !sessionSecret }` — is the single line that keeps
// the documented deployment working. Nothing tested it: if that option were
// dropped, every role-gated route would 401 and no unit test on the middleware
// would notice, because the middleware's own two branches are covered in
// isolation. These two tests pin the WIRING, which is the part that can silently
// break.
describe('role-gate wiring for the auth-disabled deployment', () => {
  const queue = {
    enqueued: [] as Array<Record<string, unknown>>,
    async enqueue(data: Record<string, unknown>): Promise<{ id: string }> {
      this.enqueued.push(data);
      return { id: `job-${this.enqueued.length}` };
    },
    async close(): Promise<void> {
      /* noop */
    },
  };

  /** A db handle is required: server.ts only mounts /api when one is present. */
  const db = {} as unknown as PlatformDb;

  const build = (sessionSecret: string | undefined) =>
    createPlatformServer(buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x' }), {
      databaseOk: () => Promise.resolve(true),
      db,
      queue: queue as unknown as TaskQueue,
      // Every field `createPlatformServer` declares, so the auth-configured
      // case exercises a real config rather than a partial one. `sessionSecret`
      // is the only one that changes behaviour between the two cases.
      auth: {
        clientId: undefined,
        clientSecret: undefined,
        baseUrl: 'https://x.test',
        sessionSecret,
        secureCookie: false,
      },
    });

  const validTask = { repo: 'acme/widgets', type: 'review', prNumber: 42 };

  it('a session-less state change is NOT refused when auth is disabled', async () => {
    // No SESSION_SECRET: the documented reverse-proxy deployment. If server.ts
    // stopped passing trustProxy, this would be 401 and the platform would be
    // unusable — which is the exact regression this test exists to catch.
    const app = build(undefined);

    const res = await request(app).post('/api/tasks').send(validTask);

    expect(res.status).not.toBe(401);
  });

  it('a session-less state change IS refused when auth is configured', async () => {
    // The contrast case, so the test above cannot pass for the wrong reason
    // (e.g. the route not being mounted at all, which would 404).
    const app = build('s'.repeat(32));

    const res = await request(app).post('/api/tasks').send(validTask);

    expect(res.status).toBe(401);
  });
});
