import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPManager } from '../src/mcp/client.js';
import type { MCPServerConfig } from '../src/types/index.js';

// ─── Hoisted mock classes & functions (accessible inside vi.mock factories) ──
const {
  mockConnect,
  mockClose,
  mockListTools,
  mockCallTool,
  mockTransportClose,
  mockStdioTransportCtor,
  mockSSEClientTransportCtor,
  mockSSETransportClose,
  MockClient,
  MockStdioClientTransport,
  MockSSEClientTransport,
} = vi.hoisted(() => {
  const _connect = vi.fn();
  const _close = vi.fn();
  const _listTools = vi.fn();
  const _callTool = vi.fn();
  const _transportClose = vi.fn();
  const _stdioCtor = vi.fn();

  class _MockClient {
    connect = _connect;
    close = _close;
    listTools = _listTools;
    callTool = _callTool;
  }

  class _MockStdioTransport {
    close = _transportClose;
    constructor(opts: Record<string, unknown>) {
      _stdioCtor(opts);
    }
  }

  const _sseCtor = vi.fn();
  const _sseClose = vi.fn();

  class _MockSSEClientTransport {
    close = _sseClose;
    constructor(url: URL, opts?: Record<string, unknown>) {
      _sseCtor(url, opts);
    }
  }

  return {
    mockConnect: _connect,
    mockClose: _close,
    mockListTools: _listTools,
    mockCallTool: _callTool,
    mockTransportClose: _transportClose,
    mockStdioTransportCtor: _stdioCtor,
    mockSSEClientTransportCtor: _sseCtor,
    mockSSETransportClose: _sseClose,
    MockClient: _MockClient,
    MockStdioClientTransport: _MockStdioTransport,
    MockSSEClientTransport: _MockSSEClientTransport,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: MockSSEClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: MockStdioClientTransport,
}));

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { withRetry } from '../src/utils/retry.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: 'test-server',
    type: 'local',
    command: ['node', 'server.js'],
    environment: { FOO: 'bar' },
    timeoutMs: 5000,
    ...overrides,
  };
}

async function createConnectedManager(
  configs: MCPServerConfig[] = [makeConfig()],
  setupTools?: () => void,
): Promise<MCPManager> {
  mockConnect.mockResolvedValue(undefined);
  mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });
  setupTools?.();
  const manager = new MCPManager(configs);
  await manager.connect();
  vi.clearAllMocks();
  return manager;
}

// ─── connect() ─────────────────────────────────────────────────────────────

describe('MCPManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('connect()', () => {
    it('skips connection when no servers configured', async () => {
      const manager = new MCPManager([]);
      await manager.connect();

      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockStdioTransportCtor).not.toHaveBeenCalled();
    });

    it('connects successfully and lists tools', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search', description: 'test tool' }] });

      const manager = new MCPManager([makeConfig()]);
      await manager.connect();

      expect(mockStdioTransportCtor).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'node', args: ['server.js'] }),
      );
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    it('cleans up transport on connection failure', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));

      const manager = new MCPManager([makeConfig()]);
      await manager.connect();

      // mcpClient is never assigned (connect fails before assignment)
      expect(mockClose).not.toHaveBeenCalled();
      // mcpTransport IS assigned inside the retry callback, so it gets closed
      expect(mockTransportClose).toHaveBeenCalled();
    });

    it('handles timeout during connection', async () => {
      mockConnect.mockImplementation(() => new Promise(() => {}));

      const manager = new MCPManager([makeConfig({ timeoutMs: 50 })]);
      await manager.connect();

      // mcpClient is never assigned (timeout before assignment)
      expect(mockClose).not.toHaveBeenCalled();
      // mcpTransport IS assigned inside the retry callback, so it gets closed
      expect(mockTransportClose).toHaveBeenCalled();
    }, 10000);

    it('handles tool listing failure', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockRejectedValue(new Error('List failed'));

      const manager = new MCPManager([makeConfig()]);
      await expect(manager.connect()).resolves.not.toThrow();
    });

    it('uses withRetry for connection', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [] });

      const manager = new MCPManager([makeConfig()]);
      await manager.connect();

      expect(vi.mocked(withRetry)).toHaveBeenCalled();
      const opts = vi.mocked(withRetry).mock.calls[0][1];
      expect(opts).toMatchObject({ maxRetries: 3, baseDelayMs: 2000 });
    });

    it('connects to remote servers via SSE transport', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'http://localhost:3000', command: undefined }),
      ]);
      await manager.connect();

      expect(mockSSEClientTransportCtor).toHaveBeenCalledWith(
        new URL('http://localhost:3000'),
        expect.objectContaining({ requestInit: expect.anything() }),
      );
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    it('passes environment vars as HTTP headers for remote servers', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'http://localhost:3000',
          command: undefined,
          environment: { Authorization: 'Bearer token123', 'X-API-Key': 'abc' },
        }),
      ]);
      await manager.connect();

      expect(mockSSEClientTransportCtor).toHaveBeenCalledWith(
        new URL('http://localhost:3000'),
        expect.objectContaining({
          requestInit: { headers: { Authorization: 'Bearer token123', 'X-API-Key': 'abc' } },
        }),
      );
    });

    it('handles remote connection failure gracefully', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'http://localhost:3000', command: undefined }),
      ]);
      await manager.connect();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockSSETransportClose).toHaveBeenCalled();
    });

    it('handles remote connection timeout', async () => {
      mockConnect.mockImplementation(() => new Promise(() => {}));

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'http://localhost:3000',
          command: undefined,
          timeoutMs: 50,
        }),
      ]);
      await manager.connect();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockSSETransportClose).toHaveBeenCalled();
    }, 10000);

    it('skips local server with undefined command', async () => {
      const manager = new MCPManager([
        makeConfig({ command: undefined as unknown as [string, ...string[]] }),
      ]);
      await manager.connect();

      expect(mockStdioTransportCtor).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  // ─── disconnect() ────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('disconnects normally and clears state', async () => {
      const manager = await createConnectedManager();
      mockClose.mockResolvedValue(undefined);
      mockTransportClose.mockResolvedValue(undefined);

      await manager.disconnect();

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockTransportClose).toHaveBeenCalledTimes(1);

      const result = await manager.queryContext('anything');
      expect(result).toEqual({ entries: [], totalTokens: 0 });
    });

    it('handles transport close failure', async () => {
      const manager = await createConnectedManager();
      mockClose.mockResolvedValue(undefined);
      mockTransportClose.mockRejectedValueOnce(new Error('Close failed'));

      await expect(manager.disconnect()).resolves.not.toThrow();
    });

    it('disconnects multiple clients', async () => {
      const manager = await createConnectedManager([
        makeConfig({ name: 'server-a' }),
        makeConfig({ name: 'server-b' }),
      ]);
      mockClose.mockResolvedValue(undefined);
      mockTransportClose.mockResolvedValue(undefined);

      await manager.disconnect();

      expect(mockClose).toHaveBeenCalledTimes(2);
      expect(mockTransportClose).toHaveBeenCalledTimes(2);
    });

    it('handles timeout during disconnect', async () => {
      vi.useFakeTimers();
      try {
        const manager = await createConnectedManager();
        mockClose.mockImplementation(() => new Promise(() => {}));

        const disconnectPromise = manager.disconnect();
        await vi.advanceTimersByTimeAsync(5000);
        await expect(disconnectPromise).resolves.not.toThrow();

        expect(mockTransportClose).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    }, 10000);
  });

  // ─── queryContext() ──────────────────────────────────────────────────────

  describe('queryContext()', () => {
    it('returns empty result when not initialized', async () => {
      const manager = new MCPManager([]);
      const result = await manager.queryContext('test');

      expect(result).toEqual({ entries: [], totalTokens: 0 });
    });

    it('discovers and calls a search tool', async () => {
      const manager = await createConnectedManager();
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'result content' }] });

      const result = await manager.queryContext('find something');

      expect(mockListTools).toHaveBeenCalledTimes(0);
      expect(mockCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'search',
          arguments: expect.objectContaining({ query: 'find something' }),
        }),
      );
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('result content');
      expect(result.entries[0].source).toBe('test-server');
    });

    it('calls a resolve tool', async () => {
      const manager = await createConnectedManager([makeConfig()], () => {
        mockListTools.mockResolvedValue({ tools: [{ name: 'resolve-issue' }] });
      });
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'resolved' }] });

      const result = await manager.queryContext('resolve');

      expect(mockCallTool).toHaveBeenCalled();
      expect(result.entries).toHaveLength(1);
    });

    it('calls a context tool when allowedTools includes context', async () => {
      const manager = await createConnectedManager(
        [makeConfig({ allowedTools: ['resolve', 'search', 'context'] })],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'get-context' }] });
        },
      );
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'context data' }] });

      const result = await manager.queryContext('context');

      expect(mockCallTool).toHaveBeenCalled();
      expect(result.entries).toHaveLength(1);
    });

    it('returns empty entries when no matching tool found', async () => {
      const manager = await createConnectedManager([makeConfig()], () => {
        mockListTools.mockResolvedValue({ tools: [{ name: 'other-tool' }] });
      });

      const result = await manager.queryContext('test');

      expect(mockCallTool).not.toHaveBeenCalled();
      expect(result.entries).toHaveLength(0);
    });

    it('trims entries to token budget', async () => {
      const manager = await createConnectedManager();
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'a'.repeat(10_000) }] });

      // 10,000 chars ≈ 2500 tokens, with maxTokens=500 the remaining=500 > 100, so entry is added (trimmed)
      const result = await manager.queryContext('test', 500);

      expect(result.totalTokens).toBeLessThanOrEqual(500);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content.length).toBeLessThan(10_000);
    });

    it('handles callTool rejection gracefully', async () => {
      const manager = await createConnectedManager();
      mockCallTool.mockRejectedValue(new Error('Query failed'));

      const result = await manager.queryContext('test');

      expect(result.entries).toHaveLength(0);
    });

    // ─── Tool Whitelisting ──────────────────────────────────

    it('respects allowedTools config allowing the tool', async () => {
      const manager = await createConnectedManager([
        makeConfig({ allowedTools: ['search', 'resolve'] }),
      ]);
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'allowed' }] });

      const result = await manager.queryContext('find');

      expect(mockCallTool).toHaveBeenCalled();
      expect(result.entries).toHaveLength(1);
    });

    it('blocks tool not in allowedTools config', async () => {
      const manager = await createConnectedManager([
        makeConfig({ allowedTools: ['resolve-only'] }),
      ]);
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'should not run' }] });

      const result = await manager.queryContext('find');

      expect(mockCallTool).not.toHaveBeenCalled();
      expect(result.entries).toHaveLength(0);
    });

    it('defaults to safe set (resolve, search) when allowedTools is unset', async () => {
      const manager = await createConnectedManager([makeConfig()], () => {
        mockListTools.mockResolvedValue({ tools: [{ name: 'resolve' }] });
      });
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'default allowed' }] });

      const result = await manager.queryContext('find');

      expect(mockCallTool).toHaveBeenCalled();
      expect(result.entries).toHaveLength(1);
    });

    it('blocks "context" tool by default when allowedTools is unset', async () => {
      const manager = await createConnectedManager([makeConfig()], () => {
        mockListTools.mockResolvedValue({ tools: [{ name: 'get-context' }] });
      });

      const result = await manager.queryContext('find');

      expect(mockCallTool).not.toHaveBeenCalled();
      expect(result.entries).toHaveLength(0);
    });
  });

  // ─── getLibraryDocs() ────────────────────────────────────────────────────

  describe('getLibraryDocs()', () => {
    it('returns empty string without context7 client', async () => {
      const manager = await createConnectedManager([makeConfig({ name: 'other' })]);

      const result = await manager.getLibraryDocs(['react']);

      expect(result).toBe('');
    });

    it('resolves a single library', async () => {
      const manager = await createConnectedManager(
        [makeConfig({ name: 'context7', command: ['node', 'c7.mjs'] })],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'resolve' }] });
        },
      );
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'React 19 docs' }] });

      const result = await manager.getLibraryDocs(['react']);

      expect(result).toContain('### react');
      expect(result).toContain('React 19 docs');
    });

    it('resolves multiple libraries', async () => {
      const manager = await createConnectedManager(
        [makeConfig({ name: 'context7', command: ['node', 'c7.mjs'] })],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'resolve' }] });
        },
      );
      mockCallTool
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'React docs' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Vue docs' }] });

      const result = await manager.getLibraryDocs(['react', 'vue']);

      expect(result).toContain('### react');
      expect(result).toContain('React docs');
      expect(result).toContain('### vue');
      expect(result).toContain('Vue docs');
    });

    it('returns empty when resolve tool not found', async () => {
      const manager = await createConnectedManager(
        [makeConfig({ name: 'context7', command: ['node', 'c7.mjs'] })],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'other-tool' }] });
        },
      );

      const result = await manager.getLibraryDocs(['react']);

      expect(result).toBe('');
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('handles resolution failure gracefully', async () => {
      const manager = await createConnectedManager(
        [makeConfig({ name: 'context7', command: ['node', 'c7.mjs'] })],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'resolve' }] });
        },
      );
      mockCallTool.mockRejectedValue(new Error('Resolution failed'));

      const result = await manager.getLibraryDocs(['react']);

      expect(result).toBe('');
    });

    it('respects allowedTools in getLibraryDocs allowing the tool', async () => {
      const manager = await createConnectedManager(
        [
          makeConfig({
            name: 'context7',
            command: ['node', 'c7.mjs'],
            allowedTools: ['resolve'],
          }),
        ],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'resolve' }] });
        },
      );
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'React docs' }] });

      const result = await manager.getLibraryDocs(['react']);

      expect(result).toContain('React docs');
    });

    it('blocks tool not in allowedTools in getLibraryDocs', async () => {
      const manager = await createConnectedManager(
        [
          makeConfig({
            name: 'context7',
            command: ['node', 'c7.mjs'],
            allowedTools: ['search-only'],
          }),
        ],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'resolve' }] });
        },
      );

      const result = await manager.getLibraryDocs(['react']);

      expect(result).toBe('');
      expect(mockCallTool).not.toHaveBeenCalled();
    });
  });
});
