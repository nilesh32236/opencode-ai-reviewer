/**
 * CSRF protection for the cookie-backed session, exercised through the real
 * server (`createPlatformServer`) rather than the middleware in isolation.
 *
 * A unit test on `evaluateCsrf` cannot see whether the middleware is mounted,
 * where it sits relative to the cookie parser, or whether a request actually
 * carries a session cookie — which is precisely the class of regression the
 * CodeQL alert "Missing CSRF middleware" (platform/src/server.ts:163) reports.
 * These cases go through the wiring so the answers are about the shipped
 * application, not about an exported function.
 *
 * The control here is an ORIGIN check, not a token: the dashboard is served
 * same-origin from this process, so a browser always attaches `Origin` to a
 * state-changing request and no cooperation from the web bundle is needed. The
 * "valid token" below is therefore a same-origin `Origin` header, and the
 * cross-site analogue is a foreign one.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { requireSameOrigin } from '../src/auth/csrf.js';
import { SESSION_COOKIE, signSession } from '../src/auth/session.js';
import { buildPlatformConfig } from '../src/config.js';
import { createPlatformServer } from '../src/server.js';

const SECRET = 's'.repeat(32);
const PUBLIC_BASE = 'https://platform.example.com';
const EVIL = 'https://evil.test';

/** A real, valid, admin-role session cookie — the credential CSRF abuses. */
const ADMIN_COOKIE = signSession(
  { sub: 'user-1', githubId: 4242, login: 'victim', role: 'admin' },
  SECRET,
);

const cookieHeader = `${SESSION_COOKIE}=${ADMIN_COOKIE}`;

const build = (baseUrl: string) =>
  createPlatformServer(buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x' }), {
    databaseOk: () => Promise.resolve(true),
    db: {} as never,
    auth: {
      sessionSecret: SECRET,
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl,
      secureCookie: true,
    },
  });

describe('CSRF on a cookie-authenticated handler (POST /api/tasks)', () => {
  let app: ReturnType<typeof createPlatformServer>;

  afterEach(() => {
    app?.removeAllListeners();
  });

  // The negative case. This is the request an attacker induces: the victim's
  // browser attaches the session cookie automatically, so only the origin can
  // refuse it. It must be rejected BEFORE the handler runs — hence 403, not the
  // handler's own 503/400.
  it('refuses a cross-origin state change carrying a valid session cookie', async () => {
    app = build(PUBLIC_BASE);
    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookieHeader)
      .set('Origin', EVIL)
      .send({ repo: 'owner/repo', type: 'review' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  // The positive case, so the refusal above is not achieved by simply having
  // broken the endpoint. 503 is the handler's own "no queue" answer: the point
  // is that the request got past both the origin check and the RBAC gate.
  it('lets the same request through with a valid same-origin Origin', async () => {
    app = build(PUBLIC_BASE);
    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookieHeader)
      .set('Origin', PUBLIC_BASE)
      .send({ repo: 'owner/repo', type: 'review' });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(503);
  });

  // Reads are never a CSRF target, so the check must not touch them even from a
  // hostile origin — a blanket check here would break the dashboard for no gain.
  it('leaves reads alone from any origin', async () => {
    app = build(PUBLIC_BASE);
    const res = await request(app)
      .get('/api/health')
      .set('Cookie', cookieHeader)
      .set('Origin', EVIL);
    expect(res.status).toBe(200);
  });
});

describe('CSRF when the public base URL is not configured', () => {
  let app: ReturnType<typeof createPlatformServer>;

  afterEach(() => {
    app?.removeAllListeners();
  });

  // This is the case that was open. With no expected origin there is nothing to
  // compare against, and the middleware used to allow EVERY state change — so a
  // deployment with a session secret but no PUBLIC_BASE_URL ran a
  // cookie-authenticated, RBAC-gated API with no CSRF control at all, while the
  // startup log said the check was merely "disabled". It has to fail closed on
  // the one request that matters: the one holding the session cookie.
  it('still refuses a cross-origin state change carrying a session cookie', async () => {
    app = build('');
    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookieHeader)
      .set('Origin', EVIL)
      .send({ repo: 'owner/repo', type: 'review' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  // Failing closed must not mean failing everything: a request with no session
  // cookie has no authority to borrow, so health probes and curl keep working.
  it('still serves cookie-less callers', async () => {
    app = build('');
    const res = await request(app).post('/api/tasks').set('Origin', EVIL).send({ repo: 'a/b' });
    expect(res.status).not.toBe(403);
  });

  // An unparseable PUBLIC_BASE_URL must not become a crash at boot — and must
  // not become "no check" either; it lands on the same fail-closed path.
  it('treats a malformed base URL as unknown, not as a crash', async () => {
    app = build('not-a-url');
    const res = await request(app)
      .post('/api/tasks')
      .set('Cookie', cookieHeader)
      .set('Origin', EVIL)
      .send({ repo: 'owner/repo', type: 'review' });
    expect(res.status).toBe(403);
  });
});

describe('the one route that is deliberately exempt', () => {
  let app: ReturnType<typeof createPlatformServer>;

  afterEach(() => {
    app?.removeAllListeners();
  });

  // /webhooks/github is mounted before cookieParser and before the origin check,
  // so it has no parsed session cookie to ride, and it authenticates by GitHub's
  // X-Hub-Signature-256 HMAC over the raw body instead. GitHub is not a browser
  // and sends no Origin, so requiring one would break every legitimate delivery
  // while stopping no attack. This test exists so the exemption stays a stated,
  // verified decision instead of drifting into an unexplained hole.
  it('serves a cross-origin webhook delivery', async () => {
    let reached = false;
    app = createPlatformServer(
      buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x' }),
      {
        webhookHandler: async (_req, res) => {
          reached = true;
          res.status(202).json({ ok: true });
        },
      },
    );
    const res = await request(app)
      .post('/webhooks/github')
      .set('Origin', EVIL)
      .set('X-Hub-Signature-256', 'sha256=whatever');
    expect(reached).toBe(true);
    expect(res.status).toBe(202);
  });
});

describe('requireSameOrigin is actually mounted, not merely correct', () => {
  it('refuses a cross-origin POST when registered ahead of a handler', async () => {
    const app = (await import('express')).default();
    app.use(requireSameOrigin(PUBLIC_BASE));
    app.post('/x', (_req, res) => {
      res.status(202).json({ ok: true });
    });
    const res = await request(app).post('/x').set('Origin', EVIL);
    expect(res.status).toBe(403);
  });
});
