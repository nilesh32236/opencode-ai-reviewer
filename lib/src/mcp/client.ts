/**
 * MCP (Model Context Protocol) client for enriching prompts with
 * up-to-date documentation from external sources.
 *
 * Supports:
 * - Context7: Latest library/framework docs to reduce false positives
 * - GitHub MCP: Repository-aware context
 * - Custom local/remote MCP servers
 */

import * as core from '@actions/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  MCPContextEntry,
  MCPQueryResult,
  MCPServerConfig,
  RemoteTransportMode,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import {
  dnsResolvesBlockedHost,
  isAllowedMcpLocalCommand,
  isSafeRemoteMcpUrl,
} from '../utils/safe-exec.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { rankContextEntries } from './context-ranker.js';

/**
 * Default safe allowlist of environment variables forwarded to local MCP
 * subprocesses. Excludes credentials (GITHUB_TOKEN, API keys, etc.) and other
 * secrets by default. Includes common network/proxy, CI, and cross-platform
 * (Unix + Windows) runtime variables so locally spawned servers keep working
 * without leaking secrets. Per-server overrides are possible via `allowedEnv`.
 */
const DEFAULT_MCP_ALLOWED_ENV = [
  // Runtime path & shell
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_PATH',
  'NODE_OPTIONS',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TERM',
  // Network / proxy (needed for servers behind corporate proxies)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // CI context (non-secret)
  'CI',
  'GITHUB_WORKSPACE',
  'GITHUB_REPOSITORY',
  // Windows-essential vars (user home / system dirs for spawned subprocesses)
  'USERPROFILE',
  'USERNAME',
  'SystemRoot',
  'SYSTEMROOT',
  'PATHEXT',
  'ComSpec',
  'APPDATA',
];

/**
 * Environment variable names that must never be forwarded to a local MCP
 * subprocess via `allowedEnv`. Local MCP servers execute third-party packages
 * that would receive these credentials verbatim.
 */
const BLOCKED_MCP_ENV_KEYS = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'CONTEXT7_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_API_KEY',
  'AZURE_OPENAI_KEY',
  'OPENCODE_API_KEY',
  'LLM_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/**
 * Filter the parent process environment down to an allowlisted subset before
 * handing it to a local MCP subprocess.
 * Uses the server's `allowedEnv` when set — an explicit empty array forwards no
 * parent variables (the least-privilege option) — and otherwise falls back to
 * the built-in safe default. Keys must exactly match the environment variable
 * names and are case-sensitive on POSIX, so a warning is logged when a custom
 * `allowedEnv` key is not present in the parent environment (likely a typo).
 * The server's explicit `environment` vars are always merged on top afterward.
 *
 * SECURITY: `allowedEnv` entries naming credentials (e.g. `GITHUB_TOKEN`) are
 * forwarded only on explicit per-server opt-in and always log a warning —
 * forwarding runner secrets to third-party MCP packages via PR-editable config
 * hands tokens to attacker-influenced code. Prefer the pinned built-in
 * servers' explicit `environment` after operator review, and keep MCP disabled
 * by default in CI.
 * @param server - MCP server configuration
 * @returns A sanitized env object safe to pass to a subprocess
 */
function filterEnv(server: MCPServerConfig): Record<string, string> {
  const custom = server.allowedEnv !== undefined;
  const allowlist: readonly string[] = server.allowedEnv ?? DEFAULT_MCP_ALLOWED_ENV;
  const filtered: Record<string, string> = {};
  const logger = new Logger('MCPManager');
  for (const key of allowlist) {
    if (custom && BLOCKED_MCP_ENV_KEYS.has(key)) {
      logger.warn(
        `MCP server "${server.name}": allowedEnv key "${key}" looks like a credential — ` +
          'it will be visible to the third-party MCP subprocess. Prefer a minimally-privileged token.',
      );
    }
    const value = process.env[key];
    if (value !== undefined) {
      filtered[key] = value;
    } else if (custom) {
      logger.warn(
        `MCP server "${server.name}": allowedEnv key "${key}" is not set in the parent ` +
          'environment — check for typos or case mismatches (env var names are case-sensitive).',
      );
    }
  }
  return filtered;
}

// Re-exported so existing `import { RemoteTransportMode } from '../mcp/client.js'`
// call sites keep working; the canonical definition lives in `types/index.ts`.
export type { RemoteTransportMode } from '../types/index.js';

/**
 * Whether a Streamable HTTP handshake error looks like a protocol mismatch
 * (server speaks SSE-only) rather than an auth/outage failure. Only mismatch
 * signals may trigger the SSE fallback in `auto` mode; auth errors (401/403),
 * timeouts, and DNS failures fail fast so the real error is not masked and no
 * second full connect cycle is wasted.
 * @param err - Error thrown by the Streamable HTTP handshake attempt
 * @returns True when the error signals SSE-only (404/405/406, method-not-allowed, version mismatch)
 * @since NEXT
 */
export function isStreamableHandshakeMismatch(err: unknown): boolean {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return (
    /\b(404|405|406)\b/i.test(raw) ||
    /method not allowed/i.test(raw) ||
    /not acceptable/i.test(raw) ||
    /version mismatch/i.test(raw) ||
    /protocol version/i.test(raw) ||
    /unsupported.*streamable/i.test(raw) ||
    /streamable.*(version|unsupported|not support)/i.test(raw) ||
    /not support.*streamable/i.test(raw) ||
    /text\/event-stream/i.test(raw)
  );
}

/**
 * Resolve the effective remote transport mode for a server.
 * Per-server `remoteTransport` wins; otherwise the
 * `OPENCODE_MCP_REMOTE_TRANSPORT` env var acts as a global default;
 * otherwise `auto`. Unknown values degrade to `auto` (fail-open).
 * @param server - MCP server configuration
 * @returns Effective remote transport mode
 * @since NEXT
 */
export function resolveRemoteTransportMode(server: MCPServerConfig): RemoteTransportMode {
  if (
    server.remoteTransport === 'auto' ||
    server.remoteTransport === 'sse' ||
    server.remoteTransport === 'streamable-http'
  ) {
    return server.remoteTransport;
  }
  const env = process.env.OPENCODE_MCP_REMOTE_TRANSPORT?.toLowerCase().trim();
  if (env === 'auto' || env === 'sse' || env === 'streamable-http') {
    return env;
  }
  return 'auto';
}

/**
 * Client identity sent on the Streamable HTTP leg so Streamable-preferred
 * servers/gateways can route on explicit MCP identity headers.
 * Matches the `name` passed to `new Client({ name })` in `connectServer`.
 * @since NEXT
 */
export const MCP_CLIENT_NAME = 'opencode-ai-reviewer';

/**
 * Default method advertised via the `Mcp-Method` header on the Streamable
 * HTTP handshake leg. Static handshake-safe default (`initialize`).
 * @since NEXT
 */
export const MCP_HANDSHAKE_METHOD = 'initialize';

/**
 * Build Streamable HTTP headers by merging MCP identity headers
 * (`Mcp-Name` / `Mcp-Method`) over a base header map.
 * User-supplied keys always win on (case-insensitive) collision, and a fresh
 * object is returned per call so no mutable state leaks between the
 * Streamable/SSE retry legs.
 * @param server - MCP server configuration (provides the default `Mcp-Name`)
 * @param baseHeaders - Base headers (e.g. from `buildRemoteHeaders`)
 * @returns Fresh header map for the Streamable HTTP `requestInit`
 * @since NEXT
 */
export function buildStreamableHeaders(
  server: MCPServerConfig,
  baseHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...baseHeaders };
  const lowerKeys = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  if (!lowerKeys.has('mcp-name')) {
    headers['Mcp-Name'] = server.name || MCP_CLIENT_NAME;
  }
  if (!lowerKeys.has('mcp-method')) {
    headers['Mcp-Method'] = MCP_HANDSHAKE_METHOD;
  }
  return headers;
}

/**
 * Build HTTP headers forwarded to a remote MCP server from its explicit
 * `environment` map. No keys are forwarded beyond this allowlist-shaped
 * explicit map (privacy-safe; AI features stay optional).
 * @param server - MCP server configuration
 * @returns Header map for `requestInit`
 * @since NEXT
 */
export function buildRemoteHeaders(server: MCPServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (server.environment) {
    for (const [key, value] of Object.entries(server.environment)) {
      if (value !== undefined) headers[key] = value;
    }
  }
  return headers;
}

/**
 * Ordered transport factories for a remote MCP server per its effective mode.
 * `auto` → `[streamable, sse]`; `streamable-http` → `[streamable]`;
 * `sse` → `[sse]`. Each factory builds a fresh `URL` and a fresh headers
 * object so no mutable state leaks between Streamable/SSE attempts or across
 * `withRetry` re-creations. Throws on invalid `url` (callers treat this as
 * fail-open and skip the server).
 * @param server - MCP server configuration (must have `url` for remote servers)
 * @param headers - HTTP headers applied to both transports via `requestInit`
 * @returns Ordered factories tried in sequence by `connectRemoteWithFallback`
 * @since NEXT
 */
export function createRemoteTransportFactories(
  server: MCPServerConfig,
  headers: Record<string, string>,
): Array<() => Transport> {
  // Validate eagerly so a malformed URL fails fast (fail-open at the caller).
  const rawUrl = server.url;
  if (!rawUrl) throw new Error(`Missing url for remote MCP server ${server.name}`);
  new URL(rawUrl);
  // NOTE: `StreamableHTTPClientTransport` is a static import from
  // `@modelcontextprotocol/sdk/client/streamableHttp.js` (SDK ^1.30.0 always
  // ships it), so no runtime `typeof` guard is needed — a missing export would
  // fail at module load, not per-connection.
  const sseFactory = (): Transport =>
    new SSEClientTransport(new URL(rawUrl), { requestInit: { headers: { ...headers } } });
  const streamableFactory = (): Transport =>
    new StreamableHTTPClientTransport(new URL(rawUrl), {
      // Streamable leg only: merge Mcp-Name/Mcp-Method identity headers so
      // Streamable-preferred gateways can route. The legacy SSE leg keeps
      // byte-identical headers. Fresh object per invocation (no shared state).
      requestInit: { headers: buildStreamableHeaders(server, headers) },
    });
  const mode = resolveRemoteTransportMode(server);
  if (mode === 'sse') return [sseFactory];
  if (mode === 'streamable-http') return [streamableFactory];
  return [streamableFactory, sseFactory];
}

/**
 * Per-call timeout (ms) bounding MCP listTools/callTool legs, which otherwise
 * hang unbounded (only the connect handshake had a timeout). Overridable per
 * server via `timeoutMs`.
 */
const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * Default TTL (ms) for the cached Streamable HTTP tools-list.
 * Parsed from `MCP_TOOLS_CACHE_TTL_MS`; `0`/unset means never-expire
 * (forever-in-session, today's behavior). Per-server `toolsCacheTtlMs`
 * overrides this global default.
 * @since NEXT
 */
export const MCP_TOOLS_CACHE_TTL_MS = (() => {
  const raw = process.env.MCP_TOOLS_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();

/**
 * Opt-in Tasks polling for long-running tool calls. Disabled by default;
 * when disabled the tool-call path is byte-identical to today (zero extra
 * requests). Enable with `MCP_TASKS_POLL_ENABLED=1|true|yes`.
 * @since NEXT
 */
export const MCP_TASKS_POLL_ENABLED = (() => {
  const raw = process.env.MCP_TASKS_POLL_ENABLED?.toLowerCase().trim();
  return raw === '1' || raw === 'true' || raw === 'yes';
})();

/**
 * Interval (ms) between opt-in Tasks status polls. Overridable via
 * `MCP_TASKS_POLL_INTERVAL_MS`; defaults to 1000ms.
 * @since NEXT
 */
export const MCP_TASKS_POLL_INTERVAL_MS = (() => {
  const raw = process.env.MCP_TASKS_POLL_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
})();

/**
 * Max Tasks status poll attempts before failing open to the first result.
 * Overridable via `MCP_TASKS_POLL_MAX_ATTEMPTS`; defaults to 30.
 * @since NEXT
 */
export const MCP_TASKS_POLL_MAX_ATTEMPTS = (() => {
  const raw = process.env.MCP_TASKS_POLL_MAX_ATTEMPTS;
  if (raw === undefined || raw.trim() === '') return 30;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
})();

/**
 * Overall deadline (ms) bounding the opt-in Tasks poll loop. Overridable via
 * `MCP_TASKS_POLL_TIMEOUT_MS`; when unset/non-positive the caller's
 * `timeoutMs` (or the 30s `MCP_CALL_TIMEOUT_MS` default) bounds the loop so a
 * slow server cannot block review for many minutes. Worst case ≈
 * `min(deadline, MAX_ATTEMPTS × (INTERVAL + per-poll timeout))`.
 * @since NEXT
 */
export const MCP_TASKS_POLL_TIMEOUT_MS = (() => {
  const raw = process.env.MCP_TASKS_POLL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();

/**
 * Resolve the effective tools-list cache TTL for a server.
 * Precedence: per-server `toolsCacheTtlMs` > `MCP_TOOLS_CACHE_TTL_MS` env >
 * never-expire. Returns `Number.POSITIVE_INFINITY` when caching never expires.
 * Fail-open: non-positive/invalid per-server values fall back to the env default.
 * @param server - MCP server configuration
 * @returns Effective TTL in milliseconds, or Infinity for never-expire
 * @since NEXT
 */
export function resolveToolsCacheTtl(server: MCPServerConfig): number {
  if (
    typeof server.toolsCacheTtlMs === 'number' &&
    Number.isFinite(server.toolsCacheTtlMs) &&
    server.toolsCacheTtlMs > 0
  ) {
    return server.toolsCacheTtlMs;
  }
  // Read the live env on every call (module constant is only the startup
  // default) so runtime/test toggles take effect without re-import.
  const raw = process.env.MCP_TOOLS_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MCP_TOOLS_CACHE_TTL_MS > 0 ? MCP_TOOLS_CACHE_TTL_MS : Number.POSITIVE_INFINITY;
}

/**
 * Whether opt-in Tasks polling is enabled for long-running tool calls.
 * Reads the live `MCP_TASKS_POLL_ENABLED` env var on every call so tests
 * and runtime toggles take effect without re-import; falls back to the
 * module constant when the env var is unset.
 * @returns True when Tasks polling is opted in
 * @since NEXT
 */
export function isTasksPollEnabled(): boolean {
  const raw = process.env.MCP_TASKS_POLL_ENABLED?.toLowerCase().trim();
  if (raw === undefined || raw === '') return MCP_TASKS_POLL_ENABLED;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Resolve the effective Tasks poll interval (ms), reading the live
 * `MCP_TASKS_POLL_INTERVAL_MS` env var on every call so runtime/test toggles
 * take effect without re-import. Falls back to the module constant.
 * @returns Poll interval in milliseconds
 * @since NEXT
 */
export function resolveTasksPollInterval(): number {
  const raw = process.env.MCP_TASKS_POLL_INTERVAL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MCP_TASKS_POLL_INTERVAL_MS;
}

/**
 * Resolve the effective Tasks max poll attempts, reading the live
 * `MCP_TASKS_POLL_MAX_ATTEMPTS` env var on every call so runtime/test toggles
 * take effect without re-import. Falls back to the module constant.
 * @returns Max poll attempts
 * @since NEXT
 */
export function resolveTasksPollMaxAttempts(): number {
  const raw = process.env.MCP_TASKS_POLL_MAX_ATTEMPTS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MCP_TASKS_POLL_MAX_ATTEMPTS;
}

/**
 * Resolve the overall deadline (ms) bounding the opt-in Tasks poll loop.
 * Precedence: `MCP_TASKS_POLL_TIMEOUT_MS` env (when positive) >
 * caller `timeoutMs` > 30s default. Guarantees the loop never blocks review
 * longer than the caller's own per-call budget unless explicitly overridden.
 * @param callerTimeoutMs - Per-call timeout passed to the tool-call legs
 * @returns Overall poll deadline in milliseconds
 * @since NEXT
 */
export function resolveTasksPollTimeoutMs(callerTimeoutMs?: number): number {
  const raw = process.env.MCP_TASKS_POLL_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof callerTimeoutMs === 'number' && Number.isFinite(callerTimeoutMs)) {
    if (callerTimeoutMs > 0) return callerTimeoutMs;
  }
  return MCP_CALL_TIMEOUT_MS;
}

/**
 * Whether an error signals cancellation (AbortError or an aborted signal).
 * Used to propagate cancellation instead of masking it behind stale-cache or
 * first-result fallbacks.
 * @param err - Error thrown by an MCP leg
 * @param signal - Optional caller AbortSignal
 * @returns True when cancellation should propagate
 * @since NEXT
 */
export function isMcpAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

/**
 * Race an MCP SDK promise against a per-call timeout and an optional caller
 * AbortSignal so hangs are bounded and cancellation propagates.
 *
 * NOTE: timeout/abort only rejects the returned promise — the underlying MCP
 * SDK promise (`listTools`/`callTool` take no signal) is NOT cancelled and
 * keeps the transport busy until it settles. Callers should treat a timeout
 * as fail-open for that server rather than immediately starting a second
 * in-flight call on the same transport.
 * @param fn - Factory producing the SDK promise (invoked immediately).
 * @param timeoutMs - Per-call timeout in milliseconds.
 * @param signal - Optional caller AbortSignal.
 * @returns The SDK result.
 * @throws TimeoutError when the timeout fires, AbortError on cancellation.
 */
async function withMcpCallTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('MCP call aborted by signal', 'AbortError');
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DOMException(`MCP call timed out after ${timeoutMs}ms`, 'TimeoutError'));
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException('MCP call aborted by signal', 'AbortError'),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      fn().then(resolve, reject);
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run an MCP SDK leg under per-call timeout + withRetry. `callTool` legs are
 * non-idempotent: callers must pass 429-only retryables with
 * `retryUnknownStatus:false` so mutations are never replayed on 5xx or
 * status-less SDK errors. `listTools` legs (idempotent reads) keep the
 * default retry policy.
 * @param fn - SDK call factory.
 * @param options - Timeout, signal, and retry tuning.
 * @param options.timeoutMs - Per-call timeout in milliseconds.
 * @param options.signal - Optional AbortSignal: aborts the SDK leg.
 * @param options.maxRetries - Handshake/call attempts before giving up.
 * @param options.baseDelayMs - Base delay between attempts in milliseconds.
 * @param options.retryableStatuses - HTTP statuses worth retrying.
 * @param options.retryUnknownStatus - Whether to retry status-less errors.
 * @returns The SDK result.
 */
async function withMcpRetry<T>(
  fn: () => Promise<T>,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxRetries?: number;
    baseDelayMs?: number;
    retryableStatuses?: number[];
    retryUnknownStatus?: boolean;
  } = {},
): Promise<T> {
  const { timeoutMs = MCP_CALL_TIMEOUT_MS, signal, ...retryOpts } = options;
  return withRetry(() => withMcpCallTimeout(fn, timeoutMs, signal), {
    maxRetries: 3,
    baseDelayMs: 2000,
    ...retryOpts,
    signal,
  });
}

/**
 * Manages connections to MCP (Model Context Protocol) servers.
 * Supports local (stdio) and remote (Streamable HTTP with SSE fallback)
 * transports and provides unified methods for querying context and
 * library documentation.
 */
export class MCPManager {
  private clients: Map<string, { client: Client; transport: Transport }> = new Map();
  private initialized = false;
  private toolsCache: Map<string, Tool[]> = new Map();
  private toolsCacheAt: Map<string, number> = new Map();
  /** In-flight tools-list refreshes keyed by server name (single-flight). */
  private toolsRefreshInFlight: Map<string, Promise<Tool[]>> = new Map();
  private logger = new Logger('MCPManager');

  /**
   * @param servers - Array of MCP server configurations to manage
   */
  constructor(private servers: MCPServerConfig[]) {}

  /**
   * Report the MCP connection status for health/readiness probes.
   * @returns Whether initialization has been attempted, how many servers are
   * connected, and the total number of configured servers.
   */
  getStatus(): { initialized: boolean; connectedServers: number; totalServers: number } {
    return {
      initialized: this.initialized,
      connectedServers: this.clients.size,
      totalServers: this.servers.length,
    };
  }

  /**
   * Initialize all configured MCP servers.
   * @param signal - Optional AbortSignal to cancel connection attempts.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (this.servers.length === 0) {
      core.startGroup('MCP: No servers configured, skipping');
      core.endGroup();
      return;
    }

    core.startGroup(`MCP: Connecting to ${this.servers.length} server(s)`);

    const results = await Promise.allSettled(
      this.servers.map(async (server) => {
        // SECURITY: `mcpServers` entries may come from PR-editable repo-file
        // config (untrusted). Local commands are constrained to a launcher
        // allowlist (no shells/paths) and remote URLs must pass the SSRF
        // policy; anything else is skipped without connecting.
        if (server.type === 'local' && server.command) {
          if (!isAllowedMcpLocalCommand(server.command)) {
            this.logger.warn(
              `Skipping MCP server "${server.name}": local command launcher is not on the allowed list`,
            );
            return Promise.resolve();
          }
          const cmd = server.command;
          return this.connectServer(
            server,
            () =>
              new StdioClientTransport({
                command: cmd[0],
                args: cmd.slice(1),
                env: { ...filterEnv(server), ...server.environment } as Record<string, string>,
                // @since NEXT: pin the subprocess working directory when configured
                // (fail-open: omit when absent/blank so the process default applies).
                ...(typeof server.cwd === 'string' && server.cwd.trim() !== ''
                  ? { cwd: server.cwd }
                  : {}),
              }),
            undefined,
            signal,
          );
        }
        if (server.type === 'remote' && server.url) {
          if (!isSafeRemoteMcpUrl(server.url)) {
            this.logger.warn(
              `Skipping MCP server "${server.name}": remote URL failed the SSRF policy (https-only, no internal hosts)`,
            );
            return Promise.resolve();
          }
          // DNS-rebinding guard (issue #546): refuse hostnames that resolve
          // to internal addresses even though the literal hostname is clean.
          try {
            const remoteHost = new URL(server.url).hostname;
            if (await dnsResolvesBlockedHost(remoteHost)) {
              this.logger.warn(
                `Skipping MCP server "${server.name}": hostname resolves to a blocked internal address`,
              );
              return Promise.resolve();
            }
          } catch {
            this.logger.warn(`Skipping MCP server "${server.name}": unparsable remote URL`);
            return Promise.resolve();
          }
          const headers = buildRemoteHeaders(server);
          return this.connectRemoteWithFallback(server, headers, signal);
        }
        return Promise.resolve();
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('MCP connection failed', result.reason);
      }
    }

    this.initialized = true;
    core.endGroup();
  }

  /**
   * Connect to a remote MCP server trying Streamable HTTP first with SSE
   * fallback (in `auto` mode). Fallback fires only on protocol-mismatch
   * signals (404/405/406, method-not-allowed, version mismatch); auth
   * failures, timeouts, and DNS errors fail fast so the real error is not
   * masked. The first handshake runs with no retries (single attempt) so
   * `auto` fallback costs ~one handshake; the fallback leg keeps the normal
   * retry budget. Any transport error is fail-open: it is logged and review
   * continues without MCP enrichment from that server.
   * @param server - Configuration for the remote MCP server to connect to
   * @param headers - HTTP headers applied to both transports via `requestInit`
   * @param signal - Optional AbortSignal: aborts the handshake and cancels retries mid-flight.
   * @since NEXT
   */
  private async connectRemoteWithFallback(
    server: MCPServerConfig,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    let factories: Array<() => Transport>;
    try {
      factories = createRemoteTransportFactories(server, headers);
    } catch (err) {
      this.logger.warn(`Failed to create remote transport for ${server.name}`, err);
      return;
    }
    for (let i = 0; i < factories.length; i++) {
      const factory = factories[i]!;
      // Scope retries across the fallback: the first leg is a single
      // handshake attempt (no retry amplification); later legs keep the
      // standard budget. Single-factory modes always use the default budget.
      // NOTE: withRetry treats maxRetries as total attempts, so a single
      // attempt is { maxRetries: 1 } — { maxRetries: 0 } would run zero
      // attempts and throw undefined.
      const retryOpts = factories.length > 1 && i === 0 ? { maxRetries: 1 } : undefined;
      const err = await this.connectServer(server, factory, retryOpts, signal);
      if (err === null) return;
      if (i < factories.length - 1) {
        if (!isStreamableHandshakeMismatch(err)) {
          // Fail fast: auth/outage/timeout — connectServer already logged the
          // underlying error at warn level; do not mask it with an SSE retry.
          return;
        }
        this.logger.warn(
          `MCP server "${server.name}": Streamable HTTP handshake failed (${err instanceof Error ? err.message : String(err)}), falling back to SSE`,
        );
      }
    }
  }

  /**
   * Refresh the cached tools-list for a server via a single bounded
   * `listTools` call. Concurrent callers coalesce onto one in-flight refresh
   * (single-flight) so a TTL expiry under `getLibraryDocs`'s concurrent fan-out
   * fires exactly one `listTools` instead of N parallel calls.
   * @param name - Server name (cache key)
   * @param client - Connected MCP SDK client
   * @param server - Server config (timeout source)
   * @param signal - Optional AbortSignal
   * @returns Freshly listed tools (also stamped into the cache)
   * @since NEXT
   */
  private async refreshToolsList(
    name: string,
    client: Client,
    server: MCPServerConfig,
    signal?: AbortSignal,
  ): Promise<Tool[]> {
    const existing = this.toolsRefreshInFlight.get(name);
    if (existing) return existing;
    const pending = (async (): Promise<Tool[]> => {
      const tools = await withMcpRetry(() => client.listTools(), {
        timeoutMs: server.timeoutMs ?? MCP_CALL_TIMEOUT_MS,
        signal,
      });
      this.toolsCache.set(name, tools.tools);
      this.toolsCacheAt.set(name, Date.now());
      return tools.tools;
    })();
    this.toolsRefreshInFlight.set(name, pending);
    try {
      return await pending;
    } finally {
      if (this.toolsRefreshInFlight.get(name) === pending) {
        this.toolsRefreshInFlight.delete(name);
      }
    }
  }

  /**
   * Return the cached tools-list for a server, refreshing once when the TTL
   * has expired. Stale-while-revalidate: on refresh failure the last good
   * list is returned (warn logged) so review continues without MCP
   * enrichment loss. A cache hit performs zero `listTools` round trips
   * (under 5 request-ms lookup). All legs stay bounded by `withMcpRetry`.
   * Cancellation (AbortError/aborted signal) always propagates instead of
   * returning stale cache.
   * @param name - Server name (cache key)
   * @param client - Connected MCP SDK client
   * @param server - Server config (TTL + timeout source)
   * @param signal - Optional AbortSignal
   * @returns Cached or freshly listed tools
   * @since NEXT
   */
  private async getToolsList(
    name: string,
    client: Client,
    server: MCPServerConfig,
    signal?: AbortSignal,
  ): Promise<Tool[]> {
    const cached = this.toolsCache.get(name);
    const cachedAt = this.toolsCacheAt.get(name);
    const ttl = resolveToolsCacheTtl(server);
    if (cached && cachedAt !== undefined && Date.now() - cachedAt < ttl) {
      return cached;
    }
    if (!cached) {
      // Cold miss (or post-disconnect): no stale list exists, so failures —
      // including cancellation — propagate to the caller (fail-open upstream).
      return this.refreshToolsList(name, client, server, signal);
    }
    // TTL expired: single refresh, stale fallback on failure (fail-open).
    try {
      return await this.refreshToolsList(name, client, server, signal);
    } catch (err) {
      if (isMcpAbortError(err, signal)) throw err;
      this.logger.warn(`MCP tools-list refresh failed for ${name}, using stale cache`, err);
      return cached;
    }
  }

  /**
   * Call a tool, with opt-in Tasks polling for long operations. When polling
   * is disabled (default) this is a byte-identical direct `callTool` under
   * `withMcpRetry` (zero extra requests). When enabled, the same bounded
   * call runs first; if the result carries a task handle and the SDK client
   * exposes a task-status accessor, it is polled at the live
   * `MCP_TASKS_POLL_INTERVAL_MS` up to the live `MCP_TASKS_POLL_MAX_ATTEMPTS`
   * times, bounded overall by `MCP_TASKS_POLL_TIMEOUT_MS` (or the caller's
   * `timeoutMs` when the env is unset) so review can never block longer than
   * the per-call budget. Each poll is a single SDK attempt (the poll loop
   * itself is the retry mechanism). Any poll/transport error fails open to the first
   * result; cancellation propagates the latest result.
   * @param client - Connected MCP SDK client
   * @param args - Tool name + arguments
   * @param options - Timeout/signal/retry tuning (callTool legs use 429-only retries)
   * @returns The tool result (or the polled terminal task result)
   * @since NEXT
   */
  private async callToolWithTasksOptIn(
    client: Client,
    args: { name: string; arguments?: Record<string, string> },
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      maxRetries?: number;
      baseDelayMs?: number;
      retryableStatuses?: number[];
      retryUnknownStatus?: boolean;
    } = {},
  ): Promise<unknown> {
    const first = await withMcpRetry(() => client.callTool(args), options);
    if (!isTasksPollEnabled()) {
      return first;
    }
    try {
      const taskId = extractTaskId(first);
      if (!taskId) return first;
      const accessor = extractTaskAccessor(client);
      if (!accessor) return first;
      const intervalMs = resolveTasksPollInterval();
      const maxAttempts = resolveTasksPollMaxAttempts();
      const deadlineMs = resolveTasksPollTimeoutMs(options.timeoutMs);
      const deadlineAt = Date.now() + deadlineMs;
      let latest: unknown = first;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (options.signal?.aborted) return latest;
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return latest;
        await sleepMcp(Math.min(intervalMs, remaining), options.signal);
        if (options.signal?.aborted) return latest;
        const remainingAfterSleep = deadlineAt - Date.now();
        if (remainingAfterSleep <= 0) return latest;
        try {
          // Single attempt per poll (maxRetries: 1): the poll loop itself is
          // the retry mechanism, so SDK-level retries here would only amplify
          // worst-case latency beyond the overall deadline. Any failure fails
          // open to the first tool result below.
          const status = await withMcpRetry(() => accessor(taskId), {
            timeoutMs: Math.min(options.timeoutMs ?? MCP_CALL_TIMEOUT_MS, remainingAfterSleep),
            signal: options.signal,
            maxRetries: 1,
          });
          latest = status ?? latest;
          if (isTerminalTaskStatus(status)) return latest;
        } catch (pollErr) {
          if (isMcpAbortError(pollErr, options.signal)) return latest;
          this.logger.warn('MCP Tasks poll failed, using first tool result', pollErr);
          return first;
        }
      }
      return latest;
    } catch (err) {
      if (isMcpAbortError(err, options.signal)) throw err;
      this.logger.warn('MCP Tasks polling failed, using first tool result', err);
      return first;
    }
  }

  /**
   * Connect to a single MCP server with retry and timeout support.
   * Creates the transport, initializes the client, and caches available tools.
   * @param server - Configuration for the MCP server to connect to
   * @param createTransport - Factory function that creates the transport for this server
   * @param retryOpts - Optional retry-budget override for the handshake
   * (used to scope retries across Streamable→SSE fallback). Defaults to
   * `{ maxRetries: 3, baseDelayMs: 2000 }`.
   * @param retryOpts.maxRetries - Handshake attempts before giving up.
   * @param retryOpts.baseDelayMs - Base delay between attempts in milliseconds.
   * @param signal - Optional AbortSignal: aborts the handshake and the
   * post-handshake listTools leg, and cancels retries mid-flight.
   * @returns Null on success, otherwise the connection error (fail-open; already logged)
   */
  private async connectServer(
    server: MCPServerConfig,
    createTransport: () => Transport,
    retryOpts?: { maxRetries?: number; baseDelayMs?: number },
    signal?: AbortSignal,
  ): Promise<Error | null> {
    const result: { client?: Client; transport?: Transport } = {};
    let lastError: Error | null = null;
    try {
      await withRetry(
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new DOMException('MCP connect aborted by signal', 'AbortError');
          }
          if (result.transport) {
            try {
              await result.transport.close();
            } catch {
              /* ignore */
            }
          }

          const newTransport = createTransport();
          result.transport = newTransport;

          const clientInstance = new Client({ name: 'opencode-ai-reviewer', version: '1.0.0' });

          const connectionTimeout = server.timeoutMs ?? 5000;
          let timedOut = false;
          let connectTimer: ReturnType<typeof setTimeout> | null = null;
          const connectPromise = clientInstance.connect(newTransport);
          const onOuterAbort = () => {
            timedOut = true;
            connectPromise.catch(() => {});
            Promise.resolve(newTransport.close()).catch(() => {});
          };
          if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
          try {
            await Promise.race([
              connectPromise,
              new Promise<never>((_, reject) => {
                connectTimer = setTimeout(() => {
                  timedOut = true;
                  connectPromise.catch(() => {});
                  reject(new Error(`Connection timed out after ${connectionTimeout}ms`));
                }, connectionTimeout);
              }),
              ...(signal
                ? [
                    new Promise<never>((_, reject) => {
                      if (signal.aborted) {
                        reject(
                          signal.reason instanceof Error
                            ? signal.reason
                            : new DOMException('MCP connect aborted by signal', 'AbortError'),
                        );
                      } else {
                        signal.addEventListener(
                          'abort',
                          () =>
                            reject(
                              signal.reason instanceof Error
                                ? signal.reason
                                : new DOMException('MCP connect aborted by signal', 'AbortError'),
                            ),
                          { once: true },
                        );
                      }
                    }),
                  ]
                : []),
            ]).finally(() => {
              if (connectTimer !== null) clearTimeout(connectTimer);
              if (timedOut) {
                Promise.resolve(newTransport.close()).catch(() => {});
              }
            });
          } finally {
            if (signal) signal.removeEventListener('abort', onOuterAbort);
          }

          result.client = clientInstance;
          this.clients.set(server.name, { client: clientInstance, transport: newTransport });
        },
        {
          maxRetries: retryOpts?.maxRetries ?? 3,
          baseDelayMs: retryOpts?.baseDelayMs ?? 2000,
          signal,
        },
      );

      const rc = result.client;
      if (rc) {
        // Single source of truth for listTools + cache-stamp (single-flight):
        // connect, cold-miss, and TTL-refresh legs all share refreshToolsList
        // so timeout/retry changes apply in one place.
        const tools = await this.refreshToolsList(server.name, rc, server, signal);
        this.logger.info(`${server.name}: ${tools.length} tools available`);
      }
      if (this.clients.has(server.name)) return null;
      return lastError ?? new Error(`Failed to connect to ${server.name}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err ?? 'Unknown error'));
      this.logger.warn(`Failed to connect to ${server.name}`, err);
      this.clients.delete(server.name);
      if (result.client) {
        try {
          await result.client.close();
        } catch (err) {
          this.logger.debug(`MCP client close failed for ${server.name}`, err);
        }
      }
      if (result.transport) {
        try {
          await result.transport.close();
        } catch (err) {
          this.logger.debug(`MCP transport close failed for ${server.name}`, err);
        }
      }
      return lastError;
    }
  }

  /**
   * Query all MCP servers for context relevant to the given query.
   * Partial failures are surfaced via `errors` on the result so callers can
   * log/metric the degradation instead of silently receiving fewer entries.
   * @param query - The search query to retrieve context for
   * @param maxTokens - Maximum token budget for the returned context
   * @param signal - Optional AbortSignal to cancel the query mid-flight
   * @returns Aggregated context entries from all MCP servers within the token budget
   */
  async queryContext(
    query: string,
    maxTokens = 4000,
    signal?: AbortSignal,
  ): Promise<MCPQueryResult> {
    const entries: MCPContextEntry[] = [];

    if (!this.initialized) {
      return { entries: [], totalTokens: 0 };
    }

    const serverNames = [...this.clients].map(([name]) => name);
    const errors: string[] = [];
    const results = await Promise.allSettled(
      [...this.clients].map(async ([name, { client }]) => {
        const serverConfig = this.servers.find((s) => s.name === name);
        const fallbackServer: MCPServerConfig = serverConfig ?? { name, type: 'remote' };
        const toolsList = await this.getToolsList(name, client, fallbackServer, signal);
        const allowedPatterns = serverConfig?.allowedTools ?? ['resolve', 'search'];
        const searchTool = toolsList.find((t) =>
          allowedPatterns.some((p) => isAllowedTool(t.name, p)),
        );

        if (searchTool) {
          const result = await this.callToolWithTasksOptIn(
            client,
            {
              name: searchTool.name,
              arguments: { query, maxTokens: String(maxTokens / this.clients.size) },
            },
            {
              maxRetries: 3,
              baseDelayMs: 2000,
              // callTool is non-idempotent: never replay on 5xx or
              // status-less SDK errors, only on 429.
              retryableStatuses: [429],
              retryUnknownStatus: false,
              timeoutMs: serverConfig?.timeoutMs ?? MCP_CALL_TIMEOUT_MS,
              signal,
            },
          );

          const text = extractTextFromResult(result);
          if (text) {
            entries.push({
              source: name,
              content: text,
              relevance: 0.8,
            });
          }
        } else {
          this.logger.warn(
            `No allowed tool found for server ${name}. Allowed patterns: ${allowedPatterns.join(', ')}`,
          );
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const server = serverNames[i] ?? 'unknown';
        const detail =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.warn(
          `MCP query failed on server ${server} (${i + 1}/${results.length})`,
          result.reason,
        );
        errors.push(`${server}: ${detail}`);
      }
    }

    // Cancellation must propagate: without this, an abort becomes per-server
    // warnings in errors[] and the caller sees partial results instead of
    // observing cancellation.
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('MCP query aborted by signal', 'AbortError');
    }

    // Module 2 — Jev semantic re-rank (opt-in via JEV_ENABLED): score
    // entries for relevance to the query so the same token budget keeps the
    // most relevant context. Fail-open — disabled or unavailable Jev returns
    // entries unchanged, preserving existing order and behavior exactly.
    // rankContextEntries already returns relevance-desc order (and the
    // fail-open path returns the input, which carries uniform heuristic
    // relevance here), so trim directly against the same budget.
    const rankedEntries = await rankContextEntries(entries, query, {
      logger: this.logger,
      signal,
    });

    // Trim to token budget (entries arrive highest-relevance-first)
    const trimmed = trimToTokenBudget(rankedEntries, maxTokens);
    return errors.length > 0 ? { ...trimmed, errors } : trimmed;
  }

  /**
   * Get context specifically for library documentation.
   * Useful for resolving false positives caused by API changes.
   * @param libraries - List of library names to fetch documentation for
   * @param signal - Optional AbortSignal to cancel the fetch mid-flight
   * @returns Concatenated markdown documentation for all requested libraries
   */
  async getLibraryDocs(libraries: string[], signal?: AbortSignal): Promise<string> {
    const context7Client = this.clients.get('context7');
    if (!context7Client) return '';

    const results = await Promise.allSettled(
      libraries.map(async (lib) => {
        const serverConfig = this.servers.find((s) => s.name === 'context7');
        const fallbackServer: MCPServerConfig = serverConfig ?? {
          name: 'context7',
          type: 'remote',
        };
        const toolsList = await this.getToolsList(
          'context7',
          context7Client.client,
          fallbackServer,
          signal,
        );
        const allowedPatterns = serverConfig?.allowedTools ?? ['resolve', 'search'];
        const resolveTool = toolsList.find((t) =>
          allowedPatterns.some((p) => isAllowedTool(t.name, p)),
        );

        if (resolveTool) {
          const result = await this.callToolWithTasksOptIn(
            context7Client.client,
            {
              name: resolveTool.name,
              arguments: { libraryName: lib },
            },
            {
              maxRetries: 3,
              baseDelayMs: 2000,
              // callTool is non-idempotent: never replay on 5xx or
              // status-less SDK errors, only on 429.
              retryableStatuses: [429],
              retryUnknownStatus: false,
              timeoutMs: serverConfig?.timeoutMs ?? MCP_CALL_TIMEOUT_MS,
              signal,
            },
          );

          const text = extractTextFromResult(result);
          if (text) {
            return `### ${lib}\n${text}`;
          }
        } else {
          this.logger.warn(
            `No allowed tool found for server context7. Allowed patterns: ${allowedPatterns.join(', ')}`,
          );
        }
        return '';
      }),
    );

    const sections: string[] = [];
    const errors: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        sections.push(result.value);
      } else if (result.status === 'rejected') {
        const lib = libraries[i] ?? 'unknown';
        const detail =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`${lib}: ${detail}`);
      }
    }
    if (errors.length > 0) {
      this.logger.warn(
        `MCP getLibraryDocs partial failure: ${errors.length}/${results.length} libraries failed`,
        errors.join('; '),
      );
    }

    // Propagate cancellation instead of returning partial docs on abort.
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('MCP query aborted by signal', 'AbortError');
    }

    return sections.join('\n\n');
  }

  /**
   * Clean up all MCP connections.
   * @param signal - Optional AbortSignal: when aborted, closes are attempted
   * fire-and-forget (no 5s wait) so no transport is orphaned.
   */
  async disconnect(signal?: AbortSignal): Promise<void> {
    const disconnectTimeoutMs = 5_000;
    for (const [name, { client, transport }] of this.clients) {
      // On abort, do NOT break out of the loop (that would orphan the
      // remaining transports and leak stdio child processes / sockets).
      // Instead fire-and-forget the close without waiting and continue.
      if (signal?.aborted) {
        Promise.resolve(client.close()).catch(() => {});
        Promise.resolve(transport.close()).catch(() => {});
        continue;
      }
      try {
        const closePromise = (async () => {
          await client.close();
          await transport.close();
        })();
        closePromise.catch(() => {});
        let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          closePromise,
          new Promise<void>((_, reject) => {
            disconnectTimer = setTimeout(
              () => reject(new Error(`MCP client close timed out for ${name}`)),
              disconnectTimeoutMs,
            );
          }),
        ]).finally(() => {
          if (disconnectTimer !== null) clearTimeout(disconnectTimer);
        });
        this.logger.info(`Disconnected from ${name}`);
      } catch (err) {
        try {
          await transport.close();
        } catch (closeErr) {
          this.logger.debug(`MCP transport close failed during disconnect for ${name}`, closeErr);
        }
        this.logger.warn(`MCP disconnect error for ${name}`, err);
      }
    }
    this.clients.clear();
    this.toolsCache.clear();
    this.toolsCacheAt.clear();
    this.toolsRefreshInFlight.clear();
    this.initialized = false;
  }
}

/**
 * Check whether an MCP tool name matches an allowlist pattern using exact
 * match or anchored-prefix semantics. A pattern matches when the tool name
 * equals it exactly or starts with the pattern followed by a namespace
 * separator (`:`, `-`, `_`, `.`, `/`), e.g. pattern `resolve` matches
 * `resolve`, `resolve:lib`, `resolve-library`, `resolve_library`,
 * `resolve.docs`, and `resolve/docs` — but NOT `my-resolve-tool`.
 * Substring matching (`includes`) is intentionally avoided to prevent
 * authorization over-grant. Matching is case-sensitive; empty patterns or
 * tool names never match.
 * @param toolName - Full MCP tool name (e.g. `resolve-library-documents`).
 * @param pattern - Allowlist pattern (e.g. `resolve`).
 * @returns True when the tool name matches the pattern.
 */
export function isAllowedTool(toolName: string, pattern: string): boolean {
  // Empty patterns or tool names never match (fail closed on misconfiguration).
  if (!pattern || !toolName) return false;
  if (toolName === pattern) return true;
  return (
    toolName.startsWith(`${pattern}:`) ||
    toolName.startsWith(`${pattern}-`) ||
    toolName.startsWith(`${pattern}_`) ||
    toolName.startsWith(`${pattern}.`) ||
    toolName.startsWith(`${pattern}/`)
  );
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Sleep for `ms` unless the signal aborts first (fail-open: resolve early).
 * @param ms - Delay in milliseconds
 * @param signal - Optional AbortSignal
 * @since NEXT
 */
function sleepMcp(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Extract a task handle id from a tool-call result, if present. Checks the
 * top-level `taskId` / `task_id` / `task.{id,taskId}` shapes from the MCP
 * Tasks primitive, then the same shapes nested inside `structuredContent`
 * and `meta` envelopes (both object and single-element array forms).
 * Returns null when the result is a plain (non-task) result.
 * @param result - Raw tool-call result
 * @returns Task id string, or null
 * @since NEXT
 */
function extractTaskId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const direct = extractTaskIdFromObject(result as Record<string, unknown>);
  if (direct) return direct;
  const r = result as Record<string, unknown>;
  for (const key of ['structuredContent', 'meta']) {
    const envelope = r[key];
    if (!envelope || typeof envelope !== 'object') continue;
    if (Array.isArray(envelope)) {
      for (const entry of envelope) {
        if (entry && typeof entry === 'object') {
          const found = extractTaskIdFromObject(entry as Record<string, unknown>);
          if (found) return found;
        }
      }
    } else {
      const found = extractTaskIdFromObject(envelope as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract a task id from a single object envelope. Shared by the top-level
 * result and the `structuredContent`/`meta` envelopes.
 * @param obj - Candidate envelope object
 * @returns Task id string, or null
 * @since NEXT
 */
function extractTaskIdFromObject(obj: Record<string, unknown>): string | null {
  if (typeof obj.taskId === 'string' && obj.taskId !== '') return obj.taskId;
  const snake = obj.task_id;
  if (typeof snake === 'string' && snake !== '') return snake;
  const nested = obj.task;
  if (nested && typeof nested === 'object') {
    const t = nested as Record<string, unknown>;
    if (typeof t.id === 'string' && t.id !== '') return t.id;
    if (typeof t.taskId === 'string' && t.taskId !== '') return t.taskId;
    if (typeof t.task_id === 'string' && t.task_id !== '') return t.task_id;
  }
  return null;
}

/**
 * Extract an optional task-status accessor from the SDK client, if the
 * connected SDK version exposes one. Probes `getTask` / `getTaskResult` /
 * `tasksGet` / `tasksResult` in order and returns null when unavailable so
 * callers fail open to the first tool result with zero extra requests.
 *
 * Expected SDK signatures (first match wins): `(taskId: string) =>
 * Promise<status>` is tried first; SDK variants that expect an object
 * envelope (`{ taskId }` or `{ id }`) are retried automatically on a
 * shape-mismatch failure, and the working shape is pinned for subsequent
 * polls so the fallback costs at most one extra request per poll loop.
 * @param client - Connected MCP SDK client
 * @returns Accessor mapping task id → status promise, or null
 * @since NEXT
 */
function extractTaskAccessor(client: Client): ((taskId: string) => Promise<unknown>) | null {
  const c = client as unknown as Record<string, unknown>;
  for (const key of ['getTask', 'getTaskResult', 'tasksGet', 'tasksResult']) {
    const fn = c[key];
    if (typeof fn === 'function') {
      const raw = fn as (this: unknown, ...args: unknown[]) => Promise<unknown>;
      let shape: 'string' | 'taskId' | 'id' | null = null;
      return async (taskId: string): Promise<unknown> => {
        const attempts: Array<'string' | 'taskId' | 'id'> =
          shape !== null
            ? [shape]
            : (['string', 'taskId', 'id'] as const as Array<'string' | 'taskId' | 'id'>);
        let lastErr: unknown = null;
        for (const candidate of attempts) {
          try {
            const arg: unknown =
              candidate === 'string'
                ? taskId
                : candidate === 'taskId'
                  ? { taskId }
                  : { id: taskId };
            const out = await raw.call(client, arg);
            shape = candidate;
            return out;
          } catch (err) {
            lastErr = err;
            // Only fall through to the next envelope shape on a likely
            // signature mismatch; transport/timeout errors propagate so the
            // caller's fail-open path sees the real failure.
            if (!isTaskAccessorShapeMismatch(err) || shape !== null) throw err;
          }
        }
        throw lastErr instanceof Error
          ? lastErr
          : new Error(String(lastErr ?? 'Task accessor failed'));
      };
    }
  }
  return null;
}

/**
 * Whether a task-accessor error looks like a signature/shape mismatch
 * (object-vs-string envelope) rather than a transport failure. Only mismatch
 * signals trigger the `{ taskId }` / `{ id }` envelope retry; timeouts, aborts,
 * and auth errors propagate.
 * @param err - Error thrown by a task-status accessor attempt
 * @returns True when retrying with an alternate envelope shape is safe
 * @since NEXT
 */
function isTaskAccessorShapeMismatch(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return false;
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return false;
  }
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  if (/\b(401|403|404|429|5\d\d)\b/.test(raw) || /timed out/i.test(raw)) return false;
  return (
    /taskid/i.test(raw) ||
    /expected.*(string|object)/i.test(raw) ||
    /invalid.*(argument|param)/i.test(raw) ||
    /missing.*task/i.test(raw) ||
    /typeerror/i.test(raw)
  );
}

/**
 * Whether a polled task status looks terminal. A documented terminal status
 * string (completed/failed/cancelled + common success synonyms) or an
 * explicit `isFinal: true` flag ends polling. Progress-style payloads that
 * merely carry partial `content` without a terminal status keep polling, and
 * unknown shapes are non-terminal (fail-open: poll until max attempts or the
 * overall deadline).
 * @param status - Raw task status payload
 * @returns True when polling should stop
 * @since NEXT
 */
function isTerminalTaskStatus(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const s = status as Record<string, unknown>;
  if (typeof s.isFinal === 'boolean') return s.isFinal;
  const rawStatus = s.status;
  if (typeof rawStatus === 'string') {
    const norm = rawStatus.toLowerCase().trim();
    if (
      norm === 'completed' ||
      norm === 'failed' ||
      norm === 'cancelled' ||
      norm === 'canceled' ||
      norm === 'succeeded' ||
      norm === 'success' ||
      norm === 'complete' ||
      norm === 'done' ||
      norm === 'finished' ||
      norm === 'error'
    ) {
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Extract text content from an MCP tool call result.
 * Filters for content items with type 'text'.
 * @param result - The raw result object from an MCP tool call
 * @returns Concatenated text content filtered from result items with type 'text'
 */
function extractTextFromResult(result: unknown): string {
  if (!result) return '';
  // MCP tool results have a `content` array
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(r.content)) return '';

  let out = '';
  let first = true;
  for (const c of r.content) {
    if (c.type === 'text' && c.text) {
      if (!first) out += '\n';
      out += c.text;
      first = false;
    }
  }
  return out;
}

/**
 * Trim context entries to fit within a token budget.
 * Entries are processed in order (highest relevance first)
 * and truncated if needed to stay within budget.
 * @param entries - Context entries sorted by relevance to be trimmed
 * @param maxTokens - Maximum token budget for the returned result
 * @returns Trimmed context entries and total tokens used, within the token budget
 */
function trimToTokenBudget(entries: MCPContextEntry[], maxTokens: number): MCPQueryResult {
  let total = 0;
  const trimmed: MCPContextEntry[] = [];

  for (const entry of entries) {
    const tokens = estimateTokens(entry.content);
    if (total + tokens > maxTokens) {
      // Truncate this entry to fit
      const remaining = maxTokens - total;
      if (remaining > 100) {
        trimmed.push({
          ...entry,
          content: entry.content.slice(0, remaining * 4),
        });
        total = maxTokens;
      }
      break;
    }
    trimmed.push(entry);
    total += tokens;
  }

  return { entries: trimmed, totalTokens: total };
}
