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
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPContextEntry, MCPQueryResult, MCPServerConfig } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { estimateTokens } from '../utils/token-estimate.js';

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
 * Filter the parent process environment down to an allowlisted subset before
 * handing it to a local MCP subprocess.
 * Uses the server's `allowedEnv` when set — an explicit empty array forwards no
 * parent variables (the least-privilege option) — and otherwise falls back to
 * the built-in safe default. Keys must exactly match the environment variable
 * names and are case-sensitive on POSIX, so a warning is logged when a custom
 * `allowedEnv` key is not present in the parent environment (likely a typo).
 * The server's explicit `environment` vars are always merged on top afterward.
 * @param server - MCP server configuration
 * @returns A sanitized env object safe to pass to a subprocess
 */
function filterEnv(server: MCPServerConfig): Record<string, string> {
  const custom = server.allowedEnv !== undefined;
  const allowlist: readonly string[] = server.allowedEnv ?? DEFAULT_MCP_ALLOWED_ENV;
  const filtered: Record<string, string> = {};
  const logger = new Logger('MCPManager');
  for (const key of allowlist) {
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

/**
 * Manages connections to MCP (Model Context Protocol) servers.
 * Supports local (stdio) and remote (SSE) transports and provides
 * unified methods for querying context and library documentation.
 */
export class MCPManager {
  private clients: Map<string, { client: Client; transport: Transport }> = new Map();
  private initialized = false;
  private toolsCache: Map<string, Tool[]> = new Map();
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
   */
  async connect(): Promise<void> {
    if (this.initialized) return;
    if (this.servers.length === 0) {
      core.startGroup('MCP: No servers configured, skipping');
      core.endGroup();
      return;
    }

    core.startGroup(`MCP: Connecting to ${this.servers.length} server(s)`);

    const results = await Promise.allSettled(
      this.servers.map((server) => {
        if (server.type === 'local' && server.command) {
          const cmd = server.command;
          return this.connectServer(
            server,
            () =>
              new StdioClientTransport({
                command: cmd[0],
                args: cmd.slice(1),
                env: { ...filterEnv(server), ...server.environment } as Record<string, string>,
              }),
          );
        }
        if (server.type === 'remote' && server.url) {
          const headers: Record<string, string> = {};
          if (server.environment) {
            for (const [key, value] of Object.entries(server.environment)) {
              if (value !== undefined) headers[key] = value;
            }
          }
          return this.connectServer(
            server,
            () => new SSEClientTransport(new URL(server.url!), { requestInit: { headers } }),
          );
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
   * Connect to a single MCP server with retry and timeout support.
   * Creates the transport, initializes the client, and caches available tools.
   * @param server - Configuration for the MCP server to connect to
   * @param createTransport - Factory function that creates the transport for this server
   */
  private async connectServer(
    server: MCPServerConfig,
    createTransport: () => Transport,
  ): Promise<void> {
    const result: { client?: Client; transport?: Transport } = {};
    try {
      await withRetry(
        async () => {
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
          await Promise.race([
            connectPromise,
            new Promise<never>((_, reject) => {
              connectTimer = setTimeout(() => {
                timedOut = true;
                connectPromise.catch(() => {});
                reject(new Error(`Connection timed out after ${connectionTimeout}ms`));
              }, connectionTimeout);
            }),
          ]).finally(() => {
            if (connectTimer !== null) clearTimeout(connectTimer);
            if (timedOut) {
              Promise.resolve(newTransport.close()).catch(() => {});
            }
          });

          result.client = clientInstance;
          this.clients.set(server.name, { client: clientInstance, transport: newTransport });
        },
        {
          maxRetries: 3,
          baseDelayMs: 2000,
        },
      );

      const rc = result.client;
      if (rc) {
        const tools = await withRetry(() => rc.listTools(), {
          maxRetries: 3,
          baseDelayMs: 2000,
        });
        this.logger.info(`${server.name}: ${tools.tools.length} tools available`);
        this.toolsCache.set(server.name, tools.tools);
      }
    } catch (err) {
      this.logger.warn(`Failed to connect to ${server.name}`, err);
      this.clients.delete(server.name);
      if (result.client) {
        try {
          await result.client.close();
        } catch {}
      }
      if (result.transport) {
        try {
          await result.transport.close();
        } catch {}
      }
    }
  }

  /**
   * Query all MCP servers for context relevant to the given query.
   * @param query - The search query to retrieve context for
   * @param maxTokens - Maximum token budget for the returned context
   * @returns Aggregated context entries from all MCP servers within the token budget
   */
  async queryContext(query: string, maxTokens = 4000): Promise<MCPQueryResult> {
    const entries: MCPContextEntry[] = [];

    if (!this.initialized) {
      return { entries: [], totalTokens: 0 };
    }

    const results = await Promise.allSettled(
      [...this.clients].map(async ([name, { client }]) => {
        let toolsList = this.toolsCache.get(name);
        if (!toolsList) {
          const tools = await client.listTools();
          toolsList = tools.tools;
          this.toolsCache.set(name, toolsList);
        }
        const serverConfig = this.servers.find((s) => s.name === name);
        const allowedPatterns = serverConfig?.allowedTools ?? ['resolve', 'search'];
        const searchTool = toolsList.find((t) => allowedPatterns.some((p) => t.name.includes(p)));

        if (searchTool) {
          const result = await withRetry(
            () =>
              client.callTool({
                name: searchTool.name,
                arguments: { query, maxTokens: String(maxTokens / this.clients.size) },
              }),
            { maxRetries: 3, baseDelayMs: 2000 },
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

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('MCP query failed', result.reason);
      }
    }

    // Sort by relevance and trim to token budget
    entries.sort((a, b) => b.relevance - a.relevance);
    return trimToTokenBudget(entries, maxTokens);
  }

  /**
   * Get context specifically for library documentation.
   * Useful for resolving false positives caused by API changes.
   * @param libraries - List of library names to fetch documentation for
   * @returns Concatenated markdown documentation for all requested libraries
   */
  async getLibraryDocs(libraries: string[]): Promise<string> {
    const context7Client = this.clients.get('context7');
    if (!context7Client) return '';

    const results = await Promise.allSettled(
      libraries.map(async (lib) => {
        let toolsList = this.toolsCache.get('context7');
        if (!toolsList) {
          const tools = await context7Client.client.listTools();
          toolsList = tools.tools;
          this.toolsCache.set('context7', toolsList);
        }
        const serverConfig = this.servers.find((s) => s.name === 'context7');
        const allowedPatterns = serverConfig?.allowedTools ?? ['resolve', 'search'];
        const resolveTool = toolsList.find((t) => allowedPatterns.some((p) => t.name.includes(p)));

        if (resolveTool) {
          const result = await withRetry(
            () =>
              context7Client.client.callTool({
                name: resolveTool.name,
                arguments: { libraryName: lib },
              }),
            { maxRetries: 3, baseDelayMs: 2000 },
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
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        sections.push(result.value);
      }
    }

    return sections.join('\n\n');
  }

  /**
   * Clean up all MCP connections.
   */
  async disconnect(): Promise<void> {
    const disconnectTimeoutMs = 5_000;
    for (const [name, { client, transport }] of this.clients) {
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
        } catch {}
        this.logger.warn(`MCP disconnect error for ${name}`, err);
      }
    }
    this.clients.clear();
    this.toolsCache.clear();
    this.initialized = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────

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
  if (Array.isArray(r.content)) {
    return r.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text ?? '')
      .join('\n');
  }
  return '';
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
