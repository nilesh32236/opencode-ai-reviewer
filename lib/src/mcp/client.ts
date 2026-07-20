/**
 * MCP (Model Context Protocol) client for enriching prompts with
 * up-to-date documentation from external sources.
 *
 * Supports:
 * - Context7: Latest library/framework docs to reduce false positives
 * - GitHub MCP: Repository-aware context
 * - Custom local/remote MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPContextEntry, MCPQueryResult, MCPServerConfig } from '../types/index.js';
import { withRetry } from '../utils/retry.js';

export class MCPManager {
  private clients: Map<string, { client: Client; transport: StdioClientTransport }> = new Map();
  private initialized = false;

  constructor(private servers: MCPServerConfig[]) {}

  /**
   * Initialize all configured MCP servers.
   */
  async connect(): Promise<void> {
    if (this.servers.length === 0) {
      console.log('::group::MCP: No servers configured, skipping');
      console.log('::endgroup::');
      return;
    }

    console.log(`::group::MCP: Connecting to ${this.servers.length} server(s)`);

    for (const server of this.servers) {
      try {
        const cmd = server.command;
        if (server.type === 'local' && cmd) {
          let mcpClient: Client | undefined;
          let mcpTransport: StdioClientTransport | undefined;
          try {
            await withRetry(
              async () => {
                if (mcpTransport) {
                  try {
                    mcpTransport.close();
                  } catch {
                    /* ignore */
                  }
                }
                mcpTransport = new StdioClientTransport({
                  command: cmd[0],
                  args: cmd.slice(1),
                  env: { ...process.env, ...server.environment } as Record<string, string>,
                });

                const clientInstance = new Client({ name: 'opencode-pr-agent', version: '1.0.0' });

                const connectionTimeout = server.timeoutMs ?? 5000;
                let connectTimer: ReturnType<typeof setTimeout>;
                await Promise.race([
                  clientInstance.connect(mcpTransport),
                  new Promise<never>((_, reject) => {
                    connectTimer = setTimeout(
                      () => reject(new Error(`Connection timed out after ${connectionTimeout}ms`)),
                      connectionTimeout,
                    );
                  }),
                ]).finally(() => clearTimeout(connectTimer));

                mcpClient = clientInstance;
                this.clients.set(server.name, { client: mcpClient, transport: mcpTransport });
              },
              {
                maxRetries: 3,
                baseDelayMs: 2000,
              },
            );

            if (mcpClient) {
              const tools = await withRetry(() => mcpClient!.listTools(), {
                maxRetries: 3,
                baseDelayMs: 2000,
              });
              console.log(`  ${server.name}: ${tools.tools.length} tools available`);
            }
          } catch (err) {
            console.log(
              `  ${server.name}: Failed to connect — ${err instanceof Error ? err.message : err}`,
            );
            this.clients.delete(server.name);
            if (mcpClient) {
              try {
                await mcpClient.close();
              } catch {}
            }
            if (mcpTransport) {
              try {
                mcpTransport.close();
              } catch {}
            }
          }
        } else if (server.type === 'remote' && server.url) {
          // For remote MCP servers, we'd use a different transport
          // For now, log a warning
          console.log(`  ${server.name}: Remote MCP not yet supported, skipping`);
        }
      } catch (err) {
        console.log(
          `  ${server.name}: Failed to connect — ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    this.initialized = true;
    console.log('::endgroup::');
  }

  /**
   * Query all MCP servers for context relevant to the given query.
   */
  async queryContext(query: string, maxTokens = 4000): Promise<MCPQueryResult> {
    const entries: MCPContextEntry[] = [];
    let _totalTokens = 0;

    if (!this.initialized) {
      return { entries: [], totalTokens: 0 };
    }

    const results = await Promise.allSettled(
      [...this.clients].map(async ([name, { client }]) => {
        const tools = await client.listTools();
        const searchTool = tools.tools.find(
          (t) =>
            t.name.includes('search') || t.name.includes('resolve') || t.name.includes('context'),
        );

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
            _totalTokens += estimateTokens(text);
          }
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.log(
          `::warning::MCP query failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
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
        const tools = await context7Client.client.listTools();
        const resolveTool = tools.tools.find((t) => t.name.includes('resolve'));

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
    for (const [name, { client, transport }] of this.clients) {
      try {
        await client.close();
        transport.close();
        console.log(`MCP: Disconnected from ${name}`);
      } catch (err) {
        console.log(
          `MCP disconnect error for ${name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.clients.clear();
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
      .map((c) => c.text!)
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
