import { promises as fs } from 'fs';
import * as path from 'path';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { sanitizeString } from '../utils/sanitize.js';

/** Maximum log file size in bytes before it is rotated to `*.ndjson.1`. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** Maximum serialized string length kept in the log (prevents unbounded growth). */
const MAX_STRING_LENGTH = 2000;

/** Keys whose values are redacted from the event log to avoid leaking raw payloads. */
const SENSITIVE_KEYS = new Set([
  'body',
  'comment',
  'login',
  'email',
  'token',
  'password',
  'secret',
  'authorization',
  'avatar_url',
  'client_secret',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'private_key',
  'cookie',
  'set-cookie',
  'diff',
  'patch',
]);

/**
 * Check whether a payload key is sensitive. Matches exact known keys plus
 * `*_token`, `*_secret`, `*_key`, `*password*`, and `*auth*` variants,
 * case-insensitively, so `GITHUB_TOKEN`, `clientSecret`, `deploy-key`, and
 * `Authorization` are all redacted.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, '_');
  if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(normalized)) return true;
  return (
    normalized.endsWith('_token') ||
    normalized.endsWith('_secret') ||
    normalized.endsWith('_key') ||
    normalized.includes('password') ||
    normalized.includes('auth') ||
    normalized.includes('secret') ||
    normalized === 'token' ||
    normalized === 'cookie'
  );
}

/**
 * Deep-sanitize an event payload for the log: redact sensitive keys, scrub
 * credential patterns from every string via `sanitizeString` (webhook payloads
 * routinely embed diffs/patches containing leaked secrets), and truncate long
 * strings so the log cannot grow unbounded or leak raw user content.
 * @param value - The value to sanitize.
 * @param depth - Current recursion depth (guards against cyclic/abusive structures).
 * @returns A sanitized copy safe to serialize.
 */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'undefined') return value;
  if (typeof value === 'string') {
    const scrubbed = sanitizeString(value);
    if (scrubbed.length > MAX_STRING_LENGTH)
      return `${scrubbed.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
    return scrubbed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 4) return typeof value === 'object' ? '[truncated]' : value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[redacted]' : sanitizePayload(val, depth + 1);
  }
  return out;
}

/**
 * Subscriber that writes every published event to a JSONL file for auditability.
 * Listens on the wildcard `*` event type so it captures all internal pipeline
 * events as well as external webhook events. Sensitive payload fields are
 * redacted and the file is rotated past a size threshold.
 *
 * Opt-in: only registered when `eventLogging.enabled` is true.
 */
export class LoggingSubscriber implements Subscriber {
  name = 'LoggingSubscriber';
  subscribedEvents = ['*'];

  private logger = new Logger('LoggingSubscriber');
  private dirReady: Promise<unknown> | undefined;

  /**
   * @param logPath - Absolute or relative path to the JSONL event log file.
   */
  constructor(private readonly logPath: string) {}

  /**
   * Ensure the log directory exists exactly once (lazily on first event).
   * @returns A promise that resolves once the directory is ready.
   */
  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = fs.mkdir(path.dirname(this.logPath), { recursive: true });
    }
    return this.dirReady?.then(() => undefined) ?? Promise.resolve();
  }

  /**
   * Rotate the log file once it exceeds {@link MAX_LOG_BYTES}: the current file
   * is moved to `${logPath}.1` (overwriting any previous rotation) so the log
   * never grows unbounded on the runner.
   */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.logPath);
      if (stat.size < MAX_LOG_BYTES) return;
      const backup = `${this.logPath}.1`;
      await fs.rm(backup, { force: true });
      await fs.rename(this.logPath, backup);
    } catch {
      // File does not exist yet — nothing to rotate.
    }
  }

  /**
   * Append a single sanitized event as a JSON line to the event log.
   * @param event - The event to write.
   */
  async handle(event: GitHubEvent): Promise<void> {
    try {
      await this.ensureDir();
      await this.rotateIfNeeded();
      const sanitized: GitHubEvent = { ...event, payload: sanitizePayload(event.payload) };
      await fs.appendFile(this.logPath, `${JSON.stringify(sanitized)}\n`, 'utf-8');
    } catch (err) {
      this.logger.warn(
        `Failed to write event to ${this.logPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
