/**
 * Pre-configured MCP server definitions.
 * Users can import these and merge with their own configs.
 */

import type { MCPServerConfig } from '../types/index.js';

/**
 * Context7 MCP server — resolves latest library documentation.
 * Reduces false positives in reviews by providing current API info.
 *
 * Setup: npm install -g @context7/mcp-server
 */
export const context7Server: MCPServerConfig = {
  name: 'context7',
  type: 'local',
  command: ['npx', '-y', '@context7/mcp-server'],
};

/**
 * GitHub MCP server — provides repository-aware context.
 * Reads files, searches code, understands PR structure.
 */
export const githubMCPServer = (token: string): MCPServerConfig => ({
  name: 'github',
  type: 'local',
  command: ['npx', '-y', '@github/github-mcp-server'],
  environment: {
    GITHUB_TOKEN: token,
  },
});

/**
 * Default MCP configuration for typical use.
 * Includes Context7 for docs and GitHub for repo context.
 */
export function getDefaultMCPServers(githubToken: string): MCPServerConfig[] {
  return [
    context7Server,
    githubMCPServer(githubToken),
  ];
}
