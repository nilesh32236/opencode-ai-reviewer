/**
 * GitHub OAuth + session routes for the platform dashboard.
 *
 * GET  /auth/login    → redirect to GitHub authorization
 * GET  /auth/callback → exchange code for profile, upsert user, set session
 * GET  /auth/me       → return the current session user (or 401)
 * POST /auth/logout   → clear the session cookie
 *
 * When GITHUB_CLIENT_ID/SECRET are not configured, auth is disabled: /auth/me
 * returns 401 and the routes are no-ops (the dashboard is intended to sit
 * behind the reverse proxy until then).
 */

import crypto from 'node:crypto';
import { Logger } from '@opencode-pr-agent/lib';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import type { PlatformDb } from '../db/client.js';
import { getUserById, upsertUser } from '../db/users.js';
import type { SessionPayload } from './session.js';
import { clearSessionCookie, readSession, setSessionCookie, signSession } from './session.js';

const logger = new Logger('Auth');

/** OAuth configuration required for the login flow. */
export interface AuthOptions {
  /** GitHub OAuth client id (empty disables auth). */
  clientId: string | undefined;
  /** GitHub OAuth client secret. */
  clientSecret: string | undefined;
  /** Public base URL of the platform (used for the OAuth callback URL). */
  baseUrl: string;
  /** Session JWT secret. */
  sessionSecret: string | undefined;
  /** Whether the session cookie should be HTTPS-only. */
  secureCookie: boolean;
}

/**
 * Build the auth router.
 * @param db - The platform database (users).
 * @param opts - OAuth + session options.
 * @returns An Express router mounted at /auth.
 */
export function createAuthRouter(db: PlatformDb, opts: AuthOptions): Router {
  const router = createRouter();
  const authEnabled = Boolean(opts.clientId && opts.clientSecret && opts.sessionSecret);

  // GET /auth/login — start the GitHub OAuth flow.
  router.get('/login', (_req: Request, res: Response) => {
    if (!authEnabled) {
      res.status(501).json({ error: 'Authentication not configured' });
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('opencode_oauth_state', state, {
      httpOnly: true,
      secure: opts.secureCookie,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    const params = new URLSearchParams({
      client_id: opts.clientId as string,
      redirect_uri: `${opts.baseUrl}/auth/callback`,
      scope: 'read:user',
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  // GET /auth/callback — exchange the code, upsert the user, set the session.
  router.get('/callback', async (req: Request, res: Response) => {
    if (!authEnabled) {
      res.status(501).json({ error: 'Authentication not configured' });
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    if (!code) {
      res.status(400).json({ error: 'Missing code' });
      return;
    }
    const expectedState = req.cookies?.opencode_oauth_state as string | undefined;
    if (!expectedState || !state || expectedState !== state) {
      res.status(401).json({ error: 'Invalid state' });
      return;
    }
    res.clearCookie('opencode_oauth_state', { httpOnly: true, path: '/' });
    try {
      // Exchange the code for an access token.
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          code,
        }),
      });
      if (!tokenRes.ok) {
        res.status(502).json({ error: 'OAuth exchange failed' });
        return;
      }
      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (tokenData.error) {
        res.status(401).json({ error: `OAuth error: ${tokenData.error}` });
        return;
      }
      const accessToken = tokenData.access_token;
      if (!accessToken) {
        res.status(401).json({ error: 'Failed to exchange code' });
        return;
      }

      // Fetch the GitHub profile.
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
      });
      if (!userRes.ok) {
        res.status(502).json({ error: 'Failed to fetch GitHub profile' });
        return;
      }
      const profile = (await userRes.json()) as {
        id: number;
        login: string;
        avatar_url?: string;
      };
      if (typeof profile.id !== 'number' || typeof profile.login !== 'string') {
        res.status(502).json({ error: 'Invalid GitHub profile' });
        return;
      }

      const user = await upsertUser(db, {
        id: profile.id,
        login: profile.login,
        avatar: profile.avatar_url,
      });

      const session: SessionPayload = {
        sub: user.id,
        githubId: user.github_id,
        login: user.github_login,
        role: user.role,
      };
      const token = signSession(session, opts.sessionSecret as string);
      setSessionCookie(res, token, opts.secureCookie);
      res.redirect(`${opts.baseUrl}/dashboard/`);
    } catch (err) {
      logger.error(`OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Authentication failed' });
    }
  });

  // GET /auth/me — current session user.
  router.get('/me', async (req: Request, res: Response) => {
    if (!authEnabled) {
      res.status(501).json({ error: 'Authentication not configured' });
      return;
    }
    const session = readSession(req, opts.sessionSecret as string);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const user = await getUserById(db, session.sub);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }
      res.json({
        id: user.id,
        login: user.github_login,
        avatar: user.avatar_url,
        role: user.role,
      });
    } catch (err) {
      logger.error(`/auth/me failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to load user' });
    }
  });

  // POST /auth/logout — clear the session cookie.
  router.post('/logout', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    clearSessionCookie(res, opts.secureCookie);
    res.json({ ok: true });
  });

  return router;
}
