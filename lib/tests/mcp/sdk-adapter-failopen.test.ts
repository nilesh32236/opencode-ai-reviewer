import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../../src/types/index.js';

const ADAPTER = '../../src/mcp/sdk-adapter.js';

const localServer: MCPServerConfig = {
  name: 'adapter-test',
  type: 'local',
  command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
};

async function loadClientWithWarnSpy() {
  // Import the logger and client from the same module-registry generation so
  // the spy lands on the exact Logger class the client uses.
  const { Logger } = await import('../../src/utils/logger.js');
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { MCPManager } = await import('../../src/mcp/client.js');
  return { MCPManager, warn };
}

describe('MCPManager SDK adapter fail-open', () => {
  afterEach(() => {
    vi.doUnmock(ADAPTER);
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('disables MCP with a warning when the adapter fails to load', async () => {
    vi.doMock(ADAPTER, () => {
      throw new Error('adapter import boom');
    });
    const { MCPManager, warn } = await loadClientWithWarnSpy();

    const manager = new MCPManager([localServer]);
    await expect(manager.connect()).resolves.toBeUndefined();

    expect(manager.getStatus()).toEqual({
      initialized: true,
      connectedServers: 0,
      totalServers: 1,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to load'), expect.anything());
  });

  it('disables MCP when a required export is missing', async () => {
    vi.doMock(ADAPTER, () => ({
      Client: class {},
      SSEClientTransport: class {},
      StdioClientTransport: class {},
    }));
    const { MCPManager, warn } = await loadClientWithWarnSpy();

    const manager = new MCPManager([localServer]);
    await expect(manager.connect()).resolves.toBeUndefined();

    expect(manager.getStatus().connectedServers).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('StreamableHTTPClientTransport'));
  });

  it('does not load the adapter when no servers are configured', async () => {
    vi.doMock(ADAPTER, () => {
      throw new Error('adapter import boom');
    });
    const { MCPManager, warn } = await loadClientWithWarnSpy();

    const manager = new MCPManager([]);
    await expect(manager.connect()).resolves.toBeUndefined();

    expect(manager.getStatus().initialized).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
