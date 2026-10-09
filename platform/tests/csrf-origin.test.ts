/**
 * The CSRF middleware's "disabled when the origin is unknown" branch must be
 * REACHABLE. It was not: `buildPlatformConfig` defaulted `PUBLIC_BASE_URL` to
 * `http://localhost:8080`, so `expectedOrigin` was always a value, and that
 * placeholder matches no real deployment — every browser's `Origin` failed the
 * equality check and every state change 403'd.
 *
 * These tests pin the three cases: a real origin is honoured, the placeholder is
 * treated as unknown (so the check disables rather than locks everyone out), and
 * the other two `publicBaseUrl` consumers are unaffected.
 */

import { describe, expect, it } from 'vitest';
import { buildPlatformConfig, expectedCsrfOrigin } from '../src/config.js';

function configWith(publicBaseUrl: string | undefined): ReturnType<typeof buildPlatformConfig> {
  const env: Record<string, string | undefined> = {
    GITHUB_TOKEN: 'x',
    REDIS_URL: undefined,
  };
  if (publicBaseUrl !== undefined) env.PUBLIC_BASE_URL = publicBaseUrl;
  return buildPlatformConfig(env as never);
}

describe('expectedCsrfOrigin', () => {
  it('returns a configured public origin unchanged', () => {
    expect(expectedCsrfOrigin(configWith('https://platform.example.com'))).toBe(
      'https://platform.example.com',
    );
  });

  it('strips a trailing slash, matching the CSRF comparison', () => {
    expect(expectedCsrfOrigin(configWith('https://platform.example.com/'))).toBe(
      'https://platform.example.com',
    );
  });

  it('treats the localhost placeholder as UNKNOWN, not as an origin', () => {
    // This is the bug. With PUBLIC_BASE_URL unset the config supplies
    // 'http://localhost:8080'; passing that to the CSRF middleware made every
    // real deployment 403 every state change.
    expect(expectedCsrfOrigin(configWith(undefined))).toBeUndefined();
  });

  it('treats a trailing-slash placeholder as unknown too', () => {
    expect(expectedCsrfOrigin(configWith('http://localhost:8080/'))).toBeUndefined();
  });

  it('treats an empty PUBLIC_BASE_URL as unknown', () => {
    expect(expectedCsrfOrigin(configWith(''))).toBeUndefined();
  });

  it('still leaves publicBaseUrl a string for the OAuth and cookie consumers', () => {
    // expectedCsrfOrigin must not change the config itself: index.ts calls
    // config.publicBaseUrl.replace(...) and .startsWith(...), which throw on
    // undefined.
    const config = configWith(undefined);
    expect(typeof config.publicBaseUrl).toBe('string');
    expect(config.publicBaseUrl.replace(/\/+$/, '')).toBe('http://localhost:8080');
    expect(config.publicBaseUrl.startsWith('https://')).toBe(false);
  });
});
