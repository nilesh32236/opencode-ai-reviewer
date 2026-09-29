/**
 * The CSRF control must be mounted where the cookies are read.
 *
 * CodeQL's `js/missing-token-validation` flags `app.use(cookieParser())` in
 * `server.ts` as "serving a request handler without CSRF protection" because it
 * cannot model a custom origin check — only recognised libraries. The check IS
 * mounted, at the app level, ahead of every cookie-bearing route.
 *
 * These tests assemble the REAL `createPlatformServer` and assert it, so the
 * mount order is pinned end to end rather than assumed from reading the file:
 *
 *   1. A cross-origin POST to `/api/tasks` is refused with 403 — the CSRF
 *      middleware answers before the request ever reaches the handler.
 *   2. The same-origin POST is NOT refused by CSRF — it gets to the handler and
 *      is turned back by `requireAuth` with 401. That distinguishable status is
 *      the proof: had CSRF been missing or misordered, the cross-origin request
 *      would have reached the handler too and answered 401 instead.
 *
 * The two statuses differ, so a future re-order of `app.use(cookieParser())`,
 * `app.use(requireSameOrigin(...))` and the `/api` router breaks these tests.
 */

import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlatformConfig } from '../src/config.js';
import type { PlatformDb } from '../src/db/client.js';
import type { TaskQueue } from '../src/queue/manager.js';
import { createPlatformServer } from '../src/server.js';

const ORIGIN = 'https://platform.example.com';

describe('Platform assembly: CSRF precedes the cookie-reading routes', () => {
  let app: Express;

  beforeEach(() => {
    // A configured publicBaseUrl makes `expectedCsrfOrigin` a real origin, so
    // the origin check is armed rather than in its "unknown origin" branch.
    const config = buildPlatformConfig({
      PORT: '8080',
      PUBLIC_BASE_URL: `${ORIGIN}/`,
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
    });

    app = createPlatformServer(config, {
      db: {} as unknown as PlatformDb,
      queue: {} as unknown as TaskQueue,
      // Auth configured: a session is expected, so `requireAuth` answers 401 for
      // a request that arrives without one.
      auth: {
        clientId: 'id',
        clientSecret: 'secret',
        baseUrl: ORIGIN,
        sessionSecret: 'test-session-secret',
        secureCookie: false,
      },
    });
  });

  afterEach(() => {
    app.removeAllListeners();
  });

  it('refuses a cross-origin state change on /api with 403, before the handler runs', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Origin', 'https://evil.example.com')
      .send({ repo: 'a/b', type: 'review', prNumber: 7 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it('lets the same-origin request past CSRF and into the auth gate', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Origin', ORIGIN)
      .send({ repo: 'a/b', type: 'review', prNumber: 7 });

    // 401 comes from `requireAuth`, which sits AFTER the CSRF middleware. If the
    // CSRF check were missing, this same request would also be 401 — so pair it
    // with the cross-origin case above, which must be 403.
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not authenticated/i);
  });
});
