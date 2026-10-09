/**
 * Auth middleware for protected platform routes (dashboard + API).
 *
 * Reads the session cookie, verifies the JWT, and attaches the session payload
 * to the request. When auth is disabled (no session secret configured), the
 * middleware allows requests through — the deployment is expected to sit behind
 * a reverse proxy in that case.
 */

import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, type SessionPayload, readSession } from './session.js';

/** Extend Express Request with the authenticated session. */
export interface AuthedRequest extends Request {
  session?: SessionPayload;
}

const RANK: Record<'viewer' | 'reviewer' | 'admin', number> = { viewer: 1, reviewer: 2, admin: 3 };

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
 * Require a specific role (or higher). Runs after {@link requireAuth}.
 *
 * When auth is disabled (`SESSION_SECRET` empty) `requireAuth` passes through
 * without ever setting a session, so there is no role to check. That mode is a
 * documented deployment — `.env.platform.example` says the dashboard/API are
 * "served without authentication (intended to sit behind the Caddy reverse proxy
 * until auth is configured)" — so the role guard must pass through with it
 * rather than 401 every role-gated route and make the platform unusable.
 *
 * The protection is not lost: with no session there is no authenticated identity
 * to grant a role, and the deployment is expected to be network-restricted. When
 * auth IS configured, `requireAuth` rejects an absent session before this runs,
 * so a real caller always has a role here.
 *
 * @param minRole - Minimum role ('viewer' allows all).
 * @returns Express middleware that 403s when the user's role is below minRole.
 */
export function requireRole(minRole: 'viewer' | 'reviewer' | 'admin') {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const role = req.session?.role;
    if (!role) {
      // No session means auth is disabled (or requireAuth already rejected).
      // Pass through so the documented auth-disabled deployment stays usable.
      next();
      return;
    }
    if ((RANK[role as keyof typeof RANK] ?? 0) < RANK[minRole]) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
