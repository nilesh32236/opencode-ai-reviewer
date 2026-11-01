/**
 * Thin re-export boundary for the MCP SDK.
 *
 * Every MCP SDK symbol used by the reviewer is re-exported here so an upstream
 * export move/rename is a one-file change instead of a repo-wide edit. Callers
 * must load this module dynamically (see `MCPManager.connect`) so a broken SDK
 * import degrades to "MCP disabled" instead of taking down the review.
 */

export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
export type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
export type { Tool } from '@modelcontextprotocol/sdk/types.js';
