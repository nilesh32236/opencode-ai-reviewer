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

export class MCPManager {
  private clients: Map<string, { client: Client; transport: Transport }> = new Map();
  private initialized = false;
  private toolsCache: Map<string, Tool[]> = new Map();

  constructor(private servers: MCPServerConfig[]) {}

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

    for (const server of this.servers) {
      if (server.type === 'local' && server.command) {
        const cmd = server.command;
        await this.connectServer(
          server,
          () =>
            new StdioClientTransport({
              command: cmd[0],
              args: cmd.slice(1),
              env: { ...process.env, ...server.environment } as Record<string, string>,
            }),
        );
      } else if (server.type === 'remote' && server.url) {
        const headers: Record<string, string> = {};
        if (server.environment) {
          for (const [key, value] of Object.entries(server.environment)) {
            if (value !== undefined) headers[key] = value;
          }
        }
        await this.connectServer(
          server,
          () => new SSEClientTransport(new URL(server.url!), { requestInit: { headers } }),
        );
      }
    }

    this.initialized = true;
    core.endGroup();
  }

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

          const clientInstance = new Client({ name: 'opencode-pr-agent', version: '1.0.0' });

          const connectionTimeout = server.timeoutMs ?? 5000;
          let timedOut = false;
          let connectTimer: ReturnType<typeof setTimeout>;
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
            clearTimeout(connectTimer);
            if (timedOut) {
              newTransport.close().catch(() => {});
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
        core.info(`  ${server.name}: ${tools.tools.length} tools available`);
        this.toolsCache.set(server.name, tools.tools);
      }
    } catch (err) {
      const logger = new Logger('MCPManager');
      logger.warn(`Failed to connect to ${server.name}`, err);
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
          const logger = new Logger('MCPManager');
          logger.warn(
            `No allowed tool found for server ${name}. Allowed patterns: ${allowedPatterns.join(', ')}`,
          );
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        const logger = new Logger('MCPManager');
        logger.warn('MCP query failed', result.reason);
      }
    }

    // Sort by relevance and trim to token budget
    entries.sort((a, b) => b.relevance - a.relevance);
    return trimToTokenBudget(entries, maxTokens);
  }

  /**
   * Get context specifically for library documentation.
   * Useful for resolving false positives caused by API changes.
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
          const logger = new Logger('MCPManager');
          logger.warn(
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
        let disconnectTimer: ReturnType<typeof setTimeout>;
        await Promise.race([
          closePromise,
          new Promise<void>((_, reject) => {
            disconnectTimer = setTimeout(
              () => reject(new Error(`MCP client close timed out for ${name}`)),
              disconnectTimeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(disconnectTimer!));
        core.info(`MCP: Disconnected from ${name}`);
      } catch (err) {
        try {
          await transport.close();
        } catch {}
        const logger = new Logger('MCPManager');
        logger.warn(`MCP disconnect error for ${name}`, err);
      }
    }
    this.clients.clear();
    this.toolsCache.clear();
    this.initialized = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────

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

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

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
