/**
 * Platform-specific configuration loaded from environment variables.
 * Kept deliberately small for the vertical slice — the heavy lifting
 * (models, providers, review tuning) stays in `lib` config via `loadConfig`,
 * which the worker reuses unchanged.
 */

import { Logger } from '@opencode-pr-agent/lib';

const logger = new Logger('PlatformConfig');

/** Runtime configuration for the platform server and worker. */
export interface PlatformConfig {
  /** HTTP port the platform server listens on (default: 8080). */
  port: number;
  /** GitHub webhook secret (X-Hub-Signature-256 verification). */
  webhookSecret: string | undefined;
  /** Base directory for cloned workspaces (default: ./data/workspaces). */
  workspaceDir: string;
  /** PostgreSQL connection URL (required for tasks/repos persistence). */
  databaseUrl: string | undefined;
  /** Redis connection URL (required for the BullMQ queue; undefined = no queue). */
  redisUrl: string | undefined;
  /** GitHub App ID (installation token auth) or GITHUB_TOKEN fallback. */
  appId: string | undefined;
  /** Path to the GitHub App private key PEM. */
  privateKeyPath: string | undefined;
  /** Plain GITHUB_TOKEN (used when APP_ID/private key are absent). */
  githubToken: string | undefined;
  /** GitHub OAuth client id for the dashboard login (empty = auth disabled). */
  githubClientId: string | undefined;
  /** GitHub OAuth client secret for the dashboard login. */
  githubClientSecret: string | undefined;
  /** Secret used to sign dashboard session JWTs. */
  sessionSecret: string | undefined;
  /** Public base URL of the platform (for OAuth callback, behind Caddy). */
  publicBaseUrl: string;
  /** Log level for the platform's own loggers (default: info). */
  logLevel: string;
}

/**
 * Parse an integer env var with a fallback, logging a warning on bad input.
 * @param name - Env var name (used in the warning message).
 * @param raw - Raw environment variable value (may be undefined).
 * @param fallback - Default value returned when raw is unset or invalid.
 * @returns The parsed positive integer or the fallback.
 */
function parseIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(`Invalid ${name} "${raw}" — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Build the platform configuration from environment variables. Every value
 * degrades gracefully to a default so the server can boot for health checks
 * before required credentials (DB, Redis, GitHub) are configured.
 * @param env - Environment variables to read (defaults to `process.env`).
 * @returns The resolved platform configuration.
 */
export function buildPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  return {
    port: parseIntEnv('PORT', env.PORT, 8080),
    webhookSecret: env.WEBHOOK_SECRET,
    workspaceDir: env.WORKSPACE_DIR ?? 'data/workspaces',
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    appId: env.APP_ID,
    privateKeyPath: env.PRIVATE_KEY_PATH,
    githubToken: env.GITHUB_TOKEN,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
