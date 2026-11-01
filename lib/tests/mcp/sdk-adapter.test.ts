import { describe, expect, it } from 'vitest';
import * as sdk from '../../src/mcp/sdk-adapter.js';

describe('MCP SDK adapter', () => {
  it('re-exports every runtime symbol the MCP client uses', () => {
    expect(typeof sdk.Client).toBe('function');
    expect(typeof sdk.SSEClientTransport).toBe('function');
    expect(typeof sdk.StdioClientTransport).toBe('function');
    expect(typeof sdk.StreamableHTTPClientTransport).toBe('function');
  });
});
