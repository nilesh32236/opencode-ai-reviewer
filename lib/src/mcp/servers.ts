/**
 * Pre-configured MCP server definitions.
 * Users can import these and merge with their own configs.
 *
 * SECURITY: MCP server subprocesses (npx commands) receive environment variables
 * including CONTEXT7_API_KEY and GITHUB_TOKEN. These are visible to any npm
 * package executed by the MCP server. Only use trusted MCP server packages
 * and consider running MCP servers in a sandboxed environment.
 */

import type { MCPServerConfig } from '../types/index.js';
import { Logger } from '../utils/logger.js';

/**
 * Context7 MCP server — resolves latest library documentation.
 * Reduces false positives in reviews by providing current API info.
 *
 * Setup: npm install -g @upstash/context7-mcp
 */
export function context7Server(): MCPServerConfig {
  const apiKey = process.env.CONTEXT7_API_KEY || '';
  if (!apiKey) {
    new Logger('MCPManager').warn('CONTEXT7_API_KEY is empty — MCP server may fail');
  }
  return {
    name: 'context7',
    type: 'local',
    command: ['npx', '-y', '--quiet', '@upstash/context7-mcp'],
    environment: {
      CONTEXT7_API_KEY: apiKey,
    },
  };
}

/**
 * GitHub MCP server — provides repository-aware context.
 * Reads files, searches code, understands PR structure.
 */
export const githubMCPServer = (token: string): MCPServerConfig => ({
  name: 'github',
  type: 'local',
  command: ['npx', '-y', '--quiet', '@github/github-mcp-server'],
  environment: {
    GITHUB_TOKEN: token,
  },
});

/**
 * Example remote MCP server configuration.
 * Connects to a remote MCP service via HTTP SSE transport.
 * Use `environment` to pass authentication headers.
 */
export function exampleRemoteServer(url = 'https://mcp.example.com/sse'): MCPServerConfig {
  return {
    name: 'example-remote',
    type: 'remote',
    url,
    timeoutMs: 10000,
  };
}

/**
 * Default MCP configuration for typical use.
 * Includes Context7 for docs.
 */
export function getDefaultMCPServers(githubToken: string): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [context7Server()];
  if (githubToken) {
    servers.push(githubMCPServer(githubToken));
  }
  return servers;
}
