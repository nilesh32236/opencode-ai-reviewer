import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateCsrf, requireSameOrigin } from '../src/auth/csrf.js';
import { buildPlatformConfig } from '../src/config.js';
import { createPlatformServer } from '../src/server.js';

const EXPECTED = 'https://platform.example.com';

describe('evaluateCsrf', () => {
  it('never rejects a safe method, whatever the origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(evaluateCsrf(method, 'https://evil.test', 'https://evil.test', EXPECTED)).toBe(
        'safe-method',
      );
    }
  });

  it('allows a same-origin state change', () => {
    expect(evaluateCsrf('POST', EXPECTED, undefined, EXPECTED)).toBe('allowed');
    expect(evaluateCsrf('PUT', EXPECTED, undefined, EXPECTED)).toBe('allowed');
    expect(evaluateCsrf('DELETE', EXPECTED, undefined, EXPECTED)).toBe('allowed');
  });

  it('rejects a cross-origin state change', () => {
    expect(evaluateCsrf('POST', 'https://evil.test', undefined, EXPECTED)).toBe('rejected');
    // A lookalike host must not pass a substring check.
    expect(
      evaluateCsrf('POST', 'https://platform.example.com.evil.test', undefined, EXPECTED),
    ).toBe('rejected');
    expect(evaluateCsrf('POST', 'http://platform.example.com', undefined, EXPECTED)).toBe(
      'rejected',
    );
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    expect(evaluateCsrf('POST', undefined, `${EXPECTED}/dashboard/`, EXPECTED)).toBe('allowed');
    expect(evaluateCsrf('POST', undefined, 'https://evil.test/x', EXPECTED)).toBe('rejected');
  });

  it('allows a missing origin rather than breaking non-browser clients', () => {
    // curl and the workflow scripts never send Origin. Rejecting them would
    // break legitimate callers without stopping an attacker, who cannot
    // suppress the header on a browser request.
    expect(evaluateCsrf('POST', undefined, undefined, EXPECTED)).toBe('missing-origin');
    expect(evaluateCsrf('POST', undefined, 'not a url', EXPECTED)).toBe('missing-origin');
  });

  it('is disabled when no expected origin is configured', () => {
    expect(evaluateCsrf('POST', 'https://evil.test', undefined, undefined)).toBe('allowed');
  });
});

describe('requireSameOrigin middleware', () => {
  const build = (expected: string | undefined) => {
    const app = express();
    app.use(requireSameOrigin(expected));
    app.post('/api/tasks', (_req, res) => {
      res.status(202).json({ ok: true });
    });
    app.get('/api/tasks', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    return app;
  };

  it('403s a cross-origin POST', async () => {
    const res = await request(build(EXPECTED))
      .post('/api/tasks')
      .set('Origin', 'https://evil.test');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it('allows a same-origin POST', async () => {
    const res = await request(build(EXPECTED)).post('/api/tasks').set('Origin', EXPECTED);
    expect(res.status).toBe(202);
  });

  it('leaves reads alone', async () => {
    const res = await request(build(EXPECTED)).get('/api/tasks').set('Origin', 'https://evil.test');
    expect(res.status).toBe(200);
  });

  it('passes everything when no expected origin is configured', async () => {
    const res = await request(build(undefined))
      .post('/api/tasks')
      .set('Origin', 'https://evil.test');
    expect(res.status).toBe(202);
  });
});

// The tests above exercise the middleware in isolation. These mount it the way
// production does, through `createPlatformServer`, so a regression that leaves
// the middleware unmounted — or mounted in the wrong place — is caught. A unit
// test on an exported function cannot see that.
describe('csrf wiring in the real server', () => {
  let app: ReturnType<typeof createPlatformServer>;
  const PUBLIC_BASE = 'https://platform.example.com';

  afterEach(() => {
    app.removeAllListeners();
  });

  const build = (publicBaseUrl: string | undefined) =>
    createPlatformServer(buildPlatformConfig({ PORT: '8080', DATABASE_URL: 'postgres://x' }), {
      databaseOk: () => Promise.resolve(true),
      db: {} as never,
      auth: {
        sessionSecret: 's'.repeat(32),
        clientId: 'id',
        clientSecret: 'secret',
        baseUrl: publicBaseUrl ?? '',
        secureCookie: true,
      },
    });

  it('refuses a cross-origin POST to a real route', async () => {
    app = build(PUBLIC_BASE);
    const res = await request(app).post('/auth/logout').set('Origin', 'https://evil.test');
    expect(res.status).toBe(403);
  });

  it('allows a same-origin POST to a real route', async () => {
    app = build(PUBLIC_BASE);
    const res = await request(app).post('/auth/logout').set('Origin', PUBLIC_BASE);
    // No session cookie, so this fails auth rather than CSRF — which is the
    // point: the request got PAST the origin check.
    expect(res.status).not.toBe(403);
  });

  it('leaves GET /health reachable cross-origin', async () => {
    app = build(PUBLIC_BASE);
    const res = await request(app).get('/health').set('Origin', 'https://evil.test');
    expect(res.status).toBe(200);
  });
});
