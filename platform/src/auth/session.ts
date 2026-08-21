/**
 * Session JWT helpers for the platform dashboard.
 *
 * After GitHub OAuth, the user's id + role are signed into a JWT stored in a
 * secure HTTP-only cookie. Requests to the dashboard/API read the cookie and
 * verify the token against the session secret.
 */

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

/** Session cookie name. */
export const SESSION_COOKIE = 'opencode_platform_session';

/** Payload embedded in the session JWT. */
export interface SessionPayload {
  /** Internal user UUID. */
  sub: string;
  /** GitHub user id. */
  githubId: number;
  /** GitHub login. */
  login: string;
  /** Role (admin | reviewer | viewer). */
  role: string;
}

/**
 * Sign a session JWT for a user.
 * @param payload - The session payload.
 * @param secret - The session secret.
 * @param ttlSeconds - Token lifetime (default 12h).
 * @returns The signed JWT string.
 */
export function signSession(
  payload: SessionPayload,
  secret: string,
  ttlSeconds = 12 * 3600,
): string {
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

/**
 * Verify a session JWT, returning the payload or null when invalid/expired.
 * @param token - The JWT string.
 * @param secret - The session secret.
 * @returns The decoded payload, or null.
 */
export function verifySession(token: string, secret: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as SessionPayload;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Set the session cookie on a response.
 * @param res - The Express response.
 * @param token - The signed JWT.
 * @param secure - Whether the cookie should be HTTPS-only.
 */
export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 12 * 3600 * 1000,
    path: '/',
  });
}

/**
 * Clear the session cookie.
 * @param res - The Express response.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, path: '/' });
}

/**
 * Read and verify the session cookie from a request.
 * @param req - The Express request.
 * @param secret - The session secret.
 * @returns The session payload, or null.
 */
export function readSession(req: Request, secret: string): SessionPayload | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  return verifySession(String(token), secret);
}
