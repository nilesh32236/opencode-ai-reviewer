/**
 * Origin-based CSRF protection for the platform dashboard.
 *
 * The session is a cookie (`opencode_platform_session`), so a cross-site
 * request would otherwise carry credentials automatically. The cookie is
 * `SameSite=Lax`, which stops a browser sending it on a cross-site POST, and
 * that remains the primary control. This is the second one: it does not depend
 * on browser SameSite behaviour, which is exactly what a future change to
 * `sameSite` — or a client that does not enforce it — would otherwise remove
 * silently.
 *
 * A token is deliberately not used. The dashboard is served same-origin from
 * this same process, so the browser always sends `Origin` on state-changing
 * requests and the check needs no cooperation from the frontend. A double
 * submit token would require the web bundle to carry and refresh a secret that
 * adds no protection here.
 *
 * A missing `Origin` is allowed rather than rejected. Browsers omit it for
 * same-origin form posts in some cases, and non-browser API clients (curl, the
 * workflow scripts) never send one; rejecting them would break legitimate
 * callers without stopping an attack, because an attacker cannot suppress a
 * header on a browser request. The protection comes from the mismatch case.
 */

import type { NextFunction, Request, Response } from 'express';

/** Methods that cannot change state, so a cross-site issue is not exploitable. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** How a request's origin is classified. */
export type CsrfDecision = 'safe-method' | 'allowed' | 'missing-origin' | 'rejected';

/**
 * Classify a request against the expected origin.
 *
 * @param method - The HTTP method.
 * @param origin - The `Origin` header, if present.
 * @param referer - The `Referer` header, used only when `Origin` is absent.
 * @param expectedOrigin - The origin the platform is served from.
 * @returns The decision, so callers can log or test the distinction.
 */
export function evaluateCsrf(
  method: string,
  origin: string | undefined,
  referer: string | undefined,
  expectedOrigin: string | undefined,
): CsrfDecision {
  if (SAFE_METHODS.has(method.toUpperCase())) return 'safe-method';
  if (!expectedOrigin) return 'allowed';
  if (origin) return origin === expectedOrigin ? 'allowed' : 'rejected';
  // No Origin: fall back to Referer's origin, else allow. See the note above.
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin ? 'allowed' : 'rejected';
    } catch {
      return 'missing-origin';
    }
  }
  return 'missing-origin';
}

/**
 * Build the CSRF middleware.
 *
 * @param expectedOrigin - The origin the dashboard is served from, e.g.
 * `https://platform.example.com`. When undefined the check is disabled, which
 * is the correct behaviour for a deployment whose public origin is unknown at
 * boot rather than guessing one and locking every real user out.
 * @returns Express middleware that 403s a cross-origin state change.
 */
export function requireSameOrigin(expectedOrigin: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = evaluateCsrf(
      req.method,
      req.headers.origin,
      req.headers.referer,
      expectedOrigin,
    );
    if (decision === 'rejected') {
      res.status(403).json({ error: 'Cross-origin request refused' });
      return;
    }
    next();
  };
}
