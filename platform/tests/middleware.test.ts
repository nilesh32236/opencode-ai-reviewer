/**
 * Role gating: fail closed by default, pass through only when explicitly trusted.
 *
 * `.env.platform.example` documents a supported mode: with GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET and SESSION_SECRET all empty, "the dashboard/API are
 * served without authentication (intended to sit behind the Caddy reverse proxy
 * until auth is configured)". In that mode `requireAuth` passes through without
 * ever setting a session, so there is nothing for the role gate to read.
 *
 * That exception is opt-in, not assumed: `server.ts` passes `trustProxy: true`
 * only when the session secret is absent. With a secret configured the gate
 * fails closed (401), because an absent session is then an unauthenticated
 * caller and must never be treated as authorized. The default being fail-closed
 * is what keeps the router safe for any caller that forgets `requireAuth`.
 */

import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { requireRole } from '../src/auth/middleware.js';

function run(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  session: unknown,
): { status: number | undefined; next: boolean } {
  let status: number | undefined;
  let next = false;
  const req = { session } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  middleware(req, res, () => {
    next = true;
  });
  return { status, next };
}

describe('requireRole', () => {
  it('401s a session-less request by default — fail closed', () => {
    // A request with no session is an unauthenticated caller, not a trusted one.
    // The old behaviour passed it through, which let the lowest-privilege route
    // be reached with no identity at all.
    const result = run(requireRole('reviewer'), undefined);
    expect(result.status).toBe(401);
    expect(result.next).toBe(false);
  });

  it('passes through a session-less request only when trustProxy is set', () => {
    // The documented auth-disabled deployment (no SESSION_SECRET) has no session
    // to read; server.ts opts in explicitly rather than relying on the default.
    const result = run(requireRole('reviewer', { trustProxy: true }), undefined);
    expect(result.next).toBe(true);
    expect(result.status).toBeUndefined();
  });

  it('still 403s a role that is too low, when a session IS present', () => {
    const result = run(requireRole('reviewer'), { role: 'viewer' });
    expect(result.status).toBe(403);
    expect(result.next).toBe(false);
  });

  it('allows a role that meets the minimum', () => {
    expect(run(requireRole('reviewer'), { role: 'reviewer' }).next).toBe(true);
    expect(run(requireRole('reviewer'), { role: 'admin' }).next).toBe(true);
  });

  it('allows every authenticated role for the viewer minimum', () => {
    expect(run(requireRole('viewer'), { role: 'viewer' }).next).toBe(true);
  });
});
