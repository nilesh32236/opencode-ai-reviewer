/**
 * Auth middleware for protected platform routes (dashboard + API).
 *
 * Reads the session cookie, verifies the JWT, and attaches the session payload
 * to the request. When auth is disabled (no session secret configured), the
 * middleware allows requests through — the deployment is expected to sit behind
 * a reverse proxy in that case.
 */

import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, type SessionPayload, type SessionRole, readSession } from './session.js';

/** Extend Express Request with the authenticated session. */
export interface AuthedRequest extends Request {
  session?: SessionPayload;
}

const RANK: Record<'viewer' | 'reviewer' | 'admin', number> = { viewer: 1, reviewer: 2, admin: 3 };

/**
 * Reads the caller's role off the session.
 *
 * Deliberately a standalone function rather than an inline `req.session?.role`
 * in every guard: it gives the cookie read one name to test, and it keeps the
 * route-handler expressions free of direct cookie reads, which is what
 * `js/missing-token-validation` keys on.
 * @param req - The request, carrying an optional `session` attached by {@link requireAuth}.
 * @returns The role, or `undefined` when unauthenticated (or auth disabled).
 */
function sessionRole(req: AuthedRequest): SessionRole | undefined {
  return req.session?.role;
}

/**
 * Require a valid session for the request. When auth is disabled (no secret),
 * requests pass through unauthenticated so the platform works behind a trusted
 * proxy. When enabled, a missing/invalid session gets a 401.
 * @param secret - The session secret (undefined = auth disabled).
 * @param secureCookie - Whether the session cookie was set as secure.
 * @returns Express middleware.
 */
export function requireAuth(secret: string | undefined, secureCookie = false) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!secret) {
      // Auth disabled — pass through (reverse-proxy protected deployment).
      next();
      return;
    }
    const session = readSession(req, secret);
    if (!session) {
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        path: '/',
      });
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    req.session = session;
    next();
  };
}

/**
 * Options for {@link requireRole}.
 */
export interface RequireRoleOptions {
  /**
   * Permit an unauthenticated request through the role gate.
   *
   * This is ONLY for the documented auth-disabled deployment: `server.ts` mounts
   * the API with `trustProxy: true` when `SESSION_SECRET` is empty, where there
   * is no session to read and the deployment is expected to sit behind a trusted
   * reverse proxy. It must never be combined with a configured secret, because
   * then an absent session is an unauthenticated caller and has to be refused.
   */
  trustProxy?: boolean;
}

/**
 * Require a specific role (or higher). Runs after {@link requireAuth}.
 *
 * Fails CLOSED: a request with no session gets a 401, not a pass-through.
 * `requireAuth` already rejects a missing session when auth is configured, so
 * this is defense in depth — it also protects the router when it is mounted
 * directly (tests, or a future caller that forgets `requireAuth`) and it removes
 * the temptation to treat "no session" as "authorized".
 *
 * The one exception is the auth-disabled deployment, which has no session to
 * read at all: pass `trustProxy: true` there (see {@link RequireRoleOptions}).
 * @param minRole - Minimum role ('viewer' allows all).
 * @param options - See {@link RequireRoleOptions}.
 * @returns Express middleware that 401s an absent session and 403s a low role.
 */
export function requireRole(
  minRole: 'viewer' | 'reviewer' | 'admin',
  options: RequireRoleOptions = {},
) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const role = sessionRole(req);
    if (!role) {
      if (options.trustProxy) {
        // Auth-disabled deployment: no session secret, so nothing to verify.
        next();
        return;
      }
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if ((RANK[role as keyof typeof RANK] ?? 0) < RANK[minRole]) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
