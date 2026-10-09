/**
 * Role gating and the auth-disabled deployment.
 *
 * `.env.platform.example` documents a supported mode: with GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET and SESSION_SECRET all empty, "the dashboard/API are
 * served without authentication (intended to sit behind the Caddy reverse proxy
 * until auth is configured)". In that mode `requireAuth` passes through without
 * ever setting a session, so `requireRole` must pass through with it — otherwise
 * every role-gated route 401s and the platform is unusable.
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
  it('passes through when there is no session — the auth-disabled deployment', () => {
    // The regression: this returned 401, which made every role-gated route
    // unusable in the documented no-auth mode.
    const result = run(requireRole('reviewer'), undefined);
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
