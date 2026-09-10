/**
 * Pre-configured MCP server definitions.
 * Users can import these and merge with their own configs.
 *
 * SECURITY: Local MCP server subprocesses (npx commands) receive only an
 * allowlisted subset of the parent environment (see filterEnv in client.ts)
 * plus the explicit `environment` overrides below, which include CONTEXT7_API_KEY
 * and GITHUB_TOKEN. These credentials are visible to any npm package executed by
 * the MCP server. Only use trusted MCP server packages and consider running MCP
 * servers in a sandboxed environment.
 */

import type { MCPServerConfig } from '../types/index.js';
import { Logger } from '../utils/logger.js';

/**
 * Exact pinned versions of MCP server npm packages.
 * Pinning prevents `npx` from auto-installing the latest release, mitigating
 * supply-chain attacks via compromised or typosquatted packages (audit 4.2).
 */
export const MCP_PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  '@upstash/context7-mcp': '3.2.5',
  '@modelcontextprotocol/server-github': '2025.4.8',
};

/**
 * Context7 MCP server — resolves latest library documentation.
 * Reduces false positives in reviews by providing current API info.
 * Package version is pinned to mitigate supply-chain attacks (audit 4.2).
 *
 * Setup: npm install -g @upstash/context7-mcp
 *
 * @returns MCPServerConfig for the Context7 documentation server
 */
export function context7Server(): MCPServerConfig {
  const apiKey = process.env.CONTEXT7_API_KEY || '';
  if (!apiKey) {
    new Logger('MCPManager').warn('CONTEXT7_API_KEY is empty — MCP server may fail');
  }
  return {
    name: 'context7',
    type: 'local',
    command: [
      'npx',
      '-y',
      '--quiet',
      `@upstash/context7-mcp@${MCP_PACKAGE_VERSIONS['@upstash/context7-mcp']}`,
    ],
    environment: {
      CONTEXT7_API_KEY: apiKey,
    },
  };
}

/**
 * GitHub MCP server — provides repository-aware context.
 * Reads files, searches code, understands PR structure.
 * Package version is pinned to mitigate supply-chain attacks (audit 4.2).
 *
 * SECURITY: `token` is passed verbatim into the environment of a third-party
 * npx-executed npm package. Prefer a repo-scoped, minimally-privileged
 * (fine-grained PAT) token; a full-scope PAT exposed to compromised/
 * typosquatted package code would grant broad account access. MCP servers are
 * disabled by default in CI — enable them only with trusted packages, and
 * consider sandboxing the npx subprocess (containers/namespaces).
 * @param token - GitHub personal access token for authentication
 * @returns MCPServerConfig for the GitHub MCP server
 */
export const githubMCPServer = (token: string): MCPServerConfig => {
  new Logger('MCPManager').warn(
    'Passing full GITHUB_TOKEN to third-party npx MCP server package — ' +
      'prefer a repo-scoped, minimally-privileged token and keep MCP servers ' +
      'disabled by default in CI.',
  );
  return {
    name: 'github',
    type: 'local',
    command: [
      'npx',
      '-y',
      '--quiet',
      `@modelcontextprotocol/server-github@${MCP_PACKAGE_VERSIONS['@modelcontextprotocol/server-github']}`,
    ],
    environment: {
      GITHUB_TOKEN: token,
    },
  };
};

/**
 * Example remote MCP server configuration.
 * Connects to a remote MCP service via HTTP SSE transport.
 * Use `environment` to pass authentication headers.
 * @param url - URL of the remote MCP server SSE endpoint
 * @returns MCPServerConfig for a remote MCP server
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
 * @param githubToken - GitHub personal access token (may be empty if not available)
 * @returns Array of default MCP server configurations
 */
export function getDefaultMCPServers(githubToken: string): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [context7Server()];
  if (githubToken) {
    servers.push(githubMCPServer(githubToken));
  }
  return servers;
}
