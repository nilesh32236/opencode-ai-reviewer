import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCPManager,
  buildRemoteHeaders,
  createRemoteTransportFactories,
  isAllowedTool,
  isMcpAbortError,
  isStreamableHandshakeMismatch,
  isTasksPollEnabled,
  resolveRemoteTransportMode,
  resolveTasksPollInterval,
  resolveTasksPollMaxAttempts,
  resolveTasksPollTimeoutMs,
  resolveToolsCacheTtl,
} from '../src/mcp/client.js';
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
  mockStreamableTransportCtor,
  mockStreamableTransportClose,
  MockClient,
  MockStdioClientTransport,
  MockSSEClientTransport,
  MockStreamableHTTPClientTransport,
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

  const _streamableCtor = vi.fn();
  const _streamableClose = vi.fn();

  class _MockStreamableHTTPClientTransport {
    close = _streamableClose;
    constructor(url: URL, opts?: Record<string, unknown>) {
      _streamableCtor(url, opts);
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
    mockStreamableTransportCtor: _streamableCtor,
    mockStreamableTransportClose: _streamableClose,
    MockClient: _MockClient,
    MockStdioClientTransport: _MockStdioTransport,
    MockSSEClientTransport: _MockSSEClientTransport,
    MockStreamableHTTPClientTransport: _MockStreamableHTTPClientTransport,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: MockSSEClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
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
    command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
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
    // biome-ignore lint/performance/noDelete: test isolation requires removing the env var, not emptying it
    delete process.env.OPENCODE_MCP_REMOTE_TRANSPORT;
  });

  it('getStatus() reports configured totals and initialization state', async () => {
    const manager = new MCPManager([
      makeConfig({ name: 'server-a' }),
      makeConfig({ name: 'server-b' }),
    ]);
    expect(manager.getStatus()).toEqual({
      initialized: false,
      connectedServers: 0,
      totalServers: 2,
    });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [{ name: 'search', description: 'test tool' }] });
    await manager.connect();

    const status = manager.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.connectedServers).toBe(2);
    expect(status.totalServers).toBe(2);
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
        expect.objectContaining({
          command: 'npx',
          args: ['-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
        }),
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

    it('connects to remote servers via SSE transport when pinned', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'https://mcp.example.com/sse',
          command: undefined,
          remoteTransport: 'sse',
        }),
      ]);
      await manager.connect();

      expect(mockSSEClientTransportCtor).toHaveBeenCalledWith(
        new URL('https://mcp.example.com/sse'),
        expect.objectContaining({ requestInit: expect.anything() }),
      );
      expect(mockStreamableTransportCtor).not.toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    it('uses Streamable HTTP by default in auto mode', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
      ]);
      await manager.connect();

      expect(mockStreamableTransportCtor).toHaveBeenCalledWith(
        new URL('https://mcp.example.com/mcp'),
        expect.objectContaining({ requestInit: expect.anything() }),
      );
      expect(mockSSEClientTransportCtor).not.toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().connectedServers).toBe(1);
    });

    it('falls back to SSE when Streamable HTTP handshake fails in auto mode', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Not Found: 404')).mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
      ]);
      await manager.connect();

      expect(mockStreamableTransportCtor).toHaveBeenCalledTimes(1);
      expect(mockSSEClientTransportCtor).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().connectedServers).toBe(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to SSE in streamable-http-only mode', async () => {
      mockConnect.mockRejectedValue(new Error('Not Found: 404'));
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'https://mcp.example.com/mcp',
          command: undefined,
          remoteTransport: 'streamable-http',
        }),
      ]);
      await manager.connect();

      expect(mockStreamableTransportCtor).toHaveBeenCalledTimes(1);
      expect(mockSSEClientTransportCtor).not.toHaveBeenCalled();
      expect(mockStreamableTransportClose).toHaveBeenCalled();
      expect(manager.getStatus().connectedServers).toBe(0);
    });

    it('passes environment vars as HTTP headers for remote servers', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'https://mcp.example.com/sse',
          command: undefined,
          remoteTransport: 'sse',
          environment: { Authorization: 'Bearer token123', 'X-API-Key': 'abc' },
        }),
      ]);
      await manager.connect();

      expect(mockSSEClientTransportCtor).toHaveBeenCalledWith(
        new URL('https://mcp.example.com/sse'),
        expect.objectContaining({
          requestInit: { headers: { Authorization: 'Bearer token123', 'X-API-Key': 'abc' } },
        }),
      );
    });

    it('passes environment vars as HTTP headers for Streamable HTTP transport', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'https://mcp.example.com/mcp',
          command: undefined,
          environment: { Authorization: 'Bearer token123', 'X-API-Key': 'abc' },
        }),
      ]);
      await manager.connect();

      expect(mockStreamableTransportCtor).toHaveBeenCalledWith(
        new URL('https://mcp.example.com/mcp'),
        expect.objectContaining({
          requestInit: {
            headers: {
              Authorization: 'Bearer token123',
              'X-API-Key': 'abc',
              'Mcp-Name': 'test-server',
              'Mcp-Method': 'initialize',
            },
          },
        }),
      );
    });

    it('handles remote connection failure gracefully', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));

      const manager = new MCPManager([
        makeConfig({
          type: 'remote',
          url: 'https://mcp.example.com/sse',
          command: undefined,
          remoteTransport: 'sse',
        }),
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
          url: 'https://mcp.example.com/sse',
          command: undefined,
          remoteTransport: 'sse',
          timeoutMs: 50,
        }),
      ]);
      await manager.connect();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockSSETransportClose).toHaveBeenCalled();
    }, 10000);

    it('does not fall back to SSE on auth failure in auto mode', async () => {
      mockConnect.mockRejectedValue(new Error('Unauthorized: 401'));
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
      ]);
      await manager.connect();

      expect(mockStreamableTransportCtor).toHaveBeenCalledTimes(1);
      expect(mockSSEClientTransportCtor).not.toHaveBeenCalled();
      expect(manager.getStatus().connectedServers).toBe(0);
    });

    it('does not fall back to SSE on timeout in auto mode', async () => {
      mockConnect.mockRejectedValue(new Error('Connection timed out after 5000ms'));
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
      ]);
      await manager.connect();

      expect(mockStreamableTransportCtor).toHaveBeenCalledTimes(1);
      expect(mockSSEClientTransportCtor).not.toHaveBeenCalled();
      expect(manager.getStatus().connectedServers).toBe(0);
    });

    it('scopes retries: first auto leg uses a single handshake attempt', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Not Found: 404')).mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
      ]);
      await manager.connect();

      const calls = vi.mocked(withRetry).mock.calls;
      // First handshake call (Streamable leg) must be single-attempt.
      expect(calls[0]?.[1]).toMatchObject({ maxRetries: 1 });
      // Fallback SSE leg keeps the standard retry budget.
      expect(calls[1]?.[1]).toMatchObject({ maxRetries: 3, baseDelayMs: 2000 });
      expect(manager.getStatus().connectedServers).toBe(1);
    });

    it('skips local server with undefined command', async () => {
      const manager = new MCPManager([
        makeConfig({ command: undefined as unknown as [string, ...string[]] }),
      ]);
      await manager.connect();

      expect(mockStdioTransportCtor).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it.each([
      'http://localhost:3000/sse',
      'http://169.254.169.254/latest',
      // https variants isolate the hostname/IP blocklist from the
      // https-only scheme check: these pass the scheme gate and must still
      // be rejected by isBlockedIpHost.
      'https://localhost:3000/sse',
      'https://169.254.169.254/latest',
    ])('skips remote server failing the SSRF policy: %s', async (url) => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([makeConfig({ type: 'remote', url, command: undefined })]);
      await manager.connect();

      expect(mockSSEClientTransportCtor).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockListTools).not.toHaveBeenCalled();
    });

    it('skips local servers failing the command allowlist', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });

      const manager = new MCPManager([makeConfig({ command: ['node', '-e', 'evil()'] })]);
      await manager.connect();

      expect(mockStdioTransportCtor).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  // ─── connect() env filtering ─────────────────────────────────────────────

  describe('connect() env filtering', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        originalEnv[key] = process.env[key];
      }
      process.env.PATH = '/usr/bin:/bin';
      process.env.HOME = '/home/user';
      process.env.GITHUB_TOKEN = 'super-secret-token';
      process.env.OPENAI_API_KEY = 'sk-secret';
      process.env.ACTIONS_RUNTIME_TOKEN = 'runtime-token-secret';
      process.env.npm_config_registry = 'https://registry.npmjs.org/';
      process.env.CUSTOM_APP_VAR = 'custom-value';
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    });

    function transportEnv(): Record<string, string> {
      // Pick the last StdioClientTransport construction so the helper stays
      // robust against retry paths where the transport is recreated.
      const calls = mockStdioTransportCtor.mock.calls;
      const opts = calls[calls.length - 1]?.[0] as { env?: Record<string, string> } | undefined;
      return opts?.env ?? {};
    }

    it('passes only the default allowlisted env vars by default', async () => {
      const manager = new MCPManager([makeConfig()]);
      await manager.connect();

      const env = transportEnv();
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.HOME).toBe('/home/user');
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CUSTOM_APP_VAR).toBeUndefined();
    });

    it('excludes secrets like GITHUB_TOKEN when not allowlisted', async () => {
      const manager = new MCPManager([makeConfig()]);
      await manager.connect();

      const env = transportEnv();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });

    it('always merges explicit server.environment vars on top', async () => {
      const manager = new MCPManager([makeConfig({ environment: { FOO: 'bar' } })]);
      await manager.connect();

      const env = transportEnv();
      expect(env.FOO).toBe('bar');
      expect(env.PATH).toBe('/usr/bin:/bin');
    });

    it('supports custom per-server allowedEnv', async () => {
      const manager = new MCPManager([makeConfig({ allowedEnv: ['PATH', 'CUSTOM_APP_VAR'] })]);
      await manager.connect();

      const env = transportEnv();
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.CUSTOM_APP_VAR).toBe('custom-value');
      expect(env.HOME).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    it('treats an explicit empty allowedEnv as forwarding no parent vars', async () => {
      const manager = new MCPManager([makeConfig({ allowedEnv: [], environment: {} })]);
      await manager.connect();

      const env = transportEnv();
      expect(env).toEqual({});
      expect(env.PATH).toBeUndefined();
      expect(env.HOME).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    it('still merges explicit server.environment when allowedEnv is empty', async () => {
      const manager = new MCPManager([makeConfig({ allowedEnv: [], environment: { FOO: 'bar' } })]);
      await manager.connect();

      const env = transportEnv();
      expect(env.FOO).toBe('bar');
      expect(env.PATH).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    it('excludes ambient CI secrets like ACTIONS_RUNTIME_TOKEN and npm_config tokens', async () => {
      const manager = new MCPManager([makeConfig()]);
      await manager.connect();

      const env = transportEnv();
      expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      expect(env.npm_config_registry).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });

    it('lets server.environment override an allowlisted key', async () => {
      const manager = new MCPManager([
        makeConfig({ environment: { PATH: '/custom/path', FOO: 'bar' } }),
      ]);
      await manager.connect();

      const env = transportEnv();
      expect(env.PATH).toBe('/custom/path');
      expect(env.FOO).toBe('bar');
    });

    it('forwards a secret when explicitly allowlisted via custom allowedEnv', async () => {
      const manager = new MCPManager([makeConfig({ allowedEnv: ['PATH', 'GITHUB_TOKEN'] })]);
      await manager.connect();

      const env = transportEnv();
      expect(env.GITHUB_TOKEN).toBe('super-secret-token');
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.HOME).toBeUndefined();
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
          // Anchored-prefix match: `context-get` matches pattern `context`;
          // a bare substring such as `get-context` must NOT match.
          mockListTools.mockResolvedValue({ tools: [{ name: 'context-get' }] });
        },
      );
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'context data' }] });

      const result = await manager.queryContext('context');

      expect(mockCallTool).toHaveBeenCalled();
      expect(result.entries).toHaveLength(1);
    });

    it('does not call a tool whose name merely contains the pattern', async () => {
      const manager = await createConnectedManager(
        [makeConfig({ allowedTools: ['resolve'] })],
        () => {
          mockListTools.mockResolvedValue({ tools: [{ name: 'my-resolve-tool' }] });
        },
      );

      const result = await manager.queryContext('test');

      expect(mockCallTool).not.toHaveBeenCalled();
      expect(result.entries).toHaveLength(0);
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
        [
          makeConfig({
            name: 'context7',
            command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
          }),
        ],
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
        [
          makeConfig({
            name: 'context7',
            command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
          }),
        ],
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
        [
          makeConfig({
            name: 'context7',
            command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
          }),
        ],
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
        [
          makeConfig({
            name: 'context7',
            command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
          }),
        ],
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
            command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
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
            command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
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

  // ─── isAllowedTool() ───────────────────────────────────────────────────────

  describe('isAllowedTool', () => {
    it.each([
      ['resolve', 'resolve'],
      ['resolve:lib', 'resolve'],
      ['resolve-library', 'resolve'],
      ['resolve_library', 'resolve'],
      ['resolve.docs', 'resolve'],
      ['resolve/docs', 'resolve'],
    ])('matches tool %s against pattern %s', (tool, pattern) => {
      expect(isAllowedTool(tool, pattern)).toBe(true);
    });

    it.each([
      ['my-resolve-tool', 'resolve'],
      ['resolveEvil', 'resolve'],
      ['resolves', 'resolve'],
      ['RESOLVE', 'resolve'],
      ['resolve', 'RESOLVE'],
      ['other', 'resolve'],
    ])('rejects tool %s against pattern %s', (tool, pattern) => {
      expect(isAllowedTool(tool, pattern)).toBe(false);
    });

    it('never matches empty patterns or tool names', () => {
      expect(isAllowedTool('resolve', '')).toBe(false);
      expect(isAllowedTool('', 'resolve')).toBe(false);
      expect(isAllowedTool('', '')).toBe(false);
    });
  });

  // ─── remote transport helpers ──────────────────────────────────────

  describe('resolveRemoteTransportMode', () => {
    const OLD_ENV = process.env.OPENCODE_MCP_REMOTE_TRANSPORT;
    afterEach(() => {
      if (OLD_ENV === undefined) {
        // biome-ignore lint/performance/noDelete: restore unset state so later tests see no leaked var
        delete process.env.OPENCODE_MCP_REMOTE_TRANSPORT;
      } else {
        process.env.OPENCODE_MCP_REMOTE_TRANSPORT = OLD_ENV;
      }
    });

    it('defaults to auto when neither per-server nor env is set', () => {
      process.env.OPENCODE_MCP_REMOTE_TRANSPORT = '';
      expect(resolveRemoteTransportMode(makeConfig({ type: 'remote' }))).toBe('auto');
    });

    it('prefers per-server value over env', () => {
      process.env.OPENCODE_MCP_REMOTE_TRANSPORT = 'sse';
      expect(
        resolveRemoteTransportMode(
          makeConfig({ type: 'remote', remoteTransport: 'streamable-http' }),
        ),
      ).toBe('streamable-http');
    });

    it('uses env global when per-server is unset', () => {
      process.env.OPENCODE_MCP_REMOTE_TRANSPORT = 'sse';
      expect(resolveRemoteTransportMode(makeConfig({ type: 'remote' }))).toBe('sse');
    });

    it('degrades unknown per-server and env values to auto', () => {
      process.env.OPENCODE_MCP_REMOTE_TRANSPORT = 'bogus';
      expect(
        resolveRemoteTransportMode(
          makeConfig({ type: 'remote', remoteTransport: 'bogus' as unknown as 'auto' }),
        ),
      ).toBe('auto');
      expect(resolveRemoteTransportMode(makeConfig({ type: 'remote' }))).toBe('auto');
    });
  });

  describe('buildRemoteHeaders', () => {
    it('maps environment entries to headers', () => {
      expect(
        buildRemoteHeaders(makeConfig({ environment: { Authorization: 'Bearer x' } })),
      ).toEqual({ Authorization: 'Bearer x' });
    });

    it('returns empty headers when environment is unset', () => {
      expect(buildRemoteHeaders(makeConfig({ environment: undefined }))).toEqual({});
    });
  });

  describe('isStreamableHandshakeMismatch', () => {
    it.each([
      'Not Found: 404',
      '405 Method Not Allowed',
      '406 Not Acceptable',
      '405 method not allowed',
      '406 not acceptable',
      'protocol version mismatch',
      'Streamable version mismatch',
      'server does not support Streamable',
      'unsupported Streamable transport',
      'expected text/event-stream response',
    ])('treats %s as a mismatch', (msg) => {
      expect(isStreamableHandshakeMismatch(new Error(msg))).toBe(true);
    });

    it.each([
      'Unauthorized: 401',
      'Forbidden: 403',
      'Connection timed out after 5000ms',
      'Streamable HTTP connection timed out',
      'Streamable HTTP 401 Unauthorized',
      'fetch failed: DNS ENOTFOUND',
    ])('does not treat %s as a mismatch', (msg) => {
      expect(isStreamableHandshakeMismatch(new Error(msg))).toBe(false);
    });
  });

  describe('createRemoteTransportFactories', () => {
    it('orders [streamable, sse] in auto mode', () => {
      const factories = createRemoteTransportFactories(
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
        {},
      );
      expect(factories).toHaveLength(2);
      factories[0]!();
      expect(mockStreamableTransportCtor).toHaveBeenCalledTimes(1);
      factories[1]!();
      expect(mockSSEClientTransportCtor).toHaveBeenCalledTimes(1);
    });

    it('returns only [sse] when pinned', () => {
      const factories = createRemoteTransportFactories(
        makeConfig({
          type: 'remote',
          url: 'https://mcp.example.com/mcp',
          command: undefined,
          remoteTransport: 'sse',
        }),
        {},
      );
      expect(factories).toHaveLength(1);
      factories[0]!();
      expect(mockSSEClientTransportCtor).toHaveBeenCalledTimes(1);
      expect(mockStreamableTransportCtor).not.toHaveBeenCalled();
    });

    it('throws on invalid URL', () => {
      expect(() =>
        createRemoteTransportFactories(
          makeConfig({ type: 'remote', url: 'not-a-url', command: undefined }),
          {},
        ),
      ).toThrow();
    });

    it('builds fresh URL/headers per factory invocation', () => {
      const headers = { Authorization: 'Bearer x' };
      const factories = createRemoteTransportFactories(
        makeConfig({ type: 'remote', url: 'https://mcp.example.com/mcp', command: undefined }),
        headers,
      );
      factories[0]!();
      factories[0]!();
      const [url1, opts1] = mockStreamableTransportCtor.mock.calls[0] as [URL, unknown];
      const [url2, opts2] = mockStreamableTransportCtor.mock.calls[1] as [URL, unknown];
      expect(url1).not.toBe(url2);
      expect(url1.href).toBe(url2.href);
      expect((opts1 as { requestInit: { headers: object } }).requestInit.headers).not.toBe(
        (opts2 as { requestInit: { headers: object } }).requestInit.headers,
      );
    });
  });

  // ─── tools-list TTL caching ──────────────────────────────────────────

  describe('resolveToolsCacheTtl', () => {
    const OLD_ENV = process.env.MCP_TOOLS_CACHE_TTL_MS;
    afterEach(() => {
      if (OLD_ENV === undefined) {
        // biome-ignore lint/performance/noDelete: restore unset state
        delete process.env.MCP_TOOLS_CACHE_TTL_MS;
      } else {
        process.env.MCP_TOOLS_CACHE_TTL_MS = OLD_ENV;
      }
    });

    it('returns Infinity when neither per-server nor env is set', () => {
      // biome-ignore lint/performance/noDelete: test isolation
      delete process.env.MCP_TOOLS_CACHE_TTL_MS;
      expect(resolveToolsCacheTtl(makeConfig())).toBe(Number.POSITIVE_INFINITY);
    });

    it('prefers per-server value over env', () => {
      process.env.MCP_TOOLS_CACHE_TTL_MS = '5000';
      expect(resolveToolsCacheTtl(makeConfig({ toolsCacheTtlMs: 123 }))).toBe(123);
    });

    it('uses env when per-server is unset', () => {
      process.env.MCP_TOOLS_CACHE_TTL_MS = '5000';
      expect(resolveToolsCacheTtl(makeConfig())).toBe(5000);
    });

    it('falls back to Infinity on invalid per-server and env values', () => {
      process.env.MCP_TOOLS_CACHE_TTL_MS = 'bogus';
      expect(resolveToolsCacheTtl(makeConfig({ toolsCacheTtlMs: -5 }))).toBe(
        Number.POSITIVE_INFINITY,
      );
    });
  });

  describe('getToolsList caching', () => {
    const OLD_TTL = process.env.MCP_TOOLS_CACHE_TTL_MS;
    afterEach(() => {
      if (OLD_TTL === undefined) {
        // biome-ignore lint/performance/noDelete: restore unset state
        delete process.env.MCP_TOOLS_CACHE_TTL_MS;
      } else {
        process.env.MCP_TOOLS_CACHE_TTL_MS = OLD_TTL;
      }
    });

    function ageCache(manager: MCPManager, name: string, ageMs: number): void {
      const inner = manager as unknown as { toolsCacheAt: Map<string, number> };
      inner.toolsCacheAt.set(name, Date.now() - ageMs);
    }

    it('cache hit performs zero listTools calls', async () => {
      const manager = await createConnectedManager([makeConfig({ toolsCacheTtlMs: 60_000 })]);
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'hit' }] });

      await manager.queryContext('q');
      expect(mockListTools).toHaveBeenCalledTimes(0);
      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    it('TTL expiry triggers a single refresh', async () => {
      const manager = await createConnectedManager([makeConfig({ toolsCacheTtlMs: 10 })]);
      ageCache(manager, 'test-server', 1000);
      mockListTools.mockResolvedValue({ tools: [{ name: 'search' }] });
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'fresh' }] });

      const result = await manager.queryContext('q');
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(result.entries).toHaveLength(1);
    });

    it('refresh failure falls back to stale cache', async () => {
      const manager = await createConnectedManager([makeConfig({ toolsCacheTtlMs: 10 })]);
      ageCache(manager, 'test-server', 1000);
      mockListTools.mockRejectedValue(new Error('list boom'));
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'stale-ok' }] });

      const result = await manager.queryContext('q');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('stale-ok');
    });

    it('propagates cancellation instead of returning stale cache', async () => {
      const manager = await createConnectedManager([makeConfig({ toolsCacheTtlMs: 10 })]);
      ageCache(manager, 'test-server', 1000);
      mockListTools.mockRejectedValue(new DOMException('aborted', 'AbortError'));
      const controller = new AbortController();
      controller.abort(new DOMException('aborted', 'AbortError'));

      await expect(manager.queryContext('q', 4000, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('coalesces concurrent refreshes onto one listTools call (single-flight)', async () => {
      const manager = await createConnectedManager([
        makeConfig({
          name: 'context7',
          command: ['npx', '-y', '--quiet', '@upstash/context7-mcp@3.2.5'],
          toolsCacheTtlMs: 10,
        }),
      ]);
      ageCache(manager, 'context7', 1000);
      let resolveList!: (v: { tools: Array<{ name: string }> }) => void;
      const gate = new Promise<{ tools: Array<{ name: string }> }>((r) => {
        resolveList = r;
      });
      mockListTools.mockReturnValue(gate);
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'docs' }] });

      const pending = manager.getLibraryDocs(['react', 'vue', 'svelte']);
      await Promise.resolve();
      await Promise.resolve();
      resolveList({ tools: [{ name: 'resolve' }] });
      const docs = await pending;
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(docs).toContain('### react');
    });
  });

  // ─── Tasks polling ───────────────────────────────────────────────────

  describe('Tasks polling', () => {
    const OLD_ENABLED = process.env.MCP_TASKS_POLL_ENABLED;
    const OLD_INTERVAL = process.env.MCP_TASKS_POLL_INTERVAL_MS;
    const OLD_ATTEMPTS = process.env.MCP_TASKS_POLL_MAX_ATTEMPTS;
    const OLD_TIMEOUT = process.env.MCP_TASKS_POLL_TIMEOUT_MS;
    afterEach(() => {
      for (const [key, val] of [
        ['MCP_TASKS_POLL_ENABLED', OLD_ENABLED],
        ['MCP_TASKS_POLL_INTERVAL_MS', OLD_INTERVAL],
        ['MCP_TASKS_POLL_MAX_ATTEMPTS', OLD_ATTEMPTS],
        ['MCP_TASKS_POLL_TIMEOUT_MS', OLD_TIMEOUT],
      ] as const) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    });

    function clientOf(manager: MCPManager, name: string): Record<string, unknown> {
      const inner = manager as unknown as { clients: Map<string, { client: unknown }> };
      return inner.clients.get(name)?.client as Record<string, unknown>;
    }

    it('isTasksPollEnabled parses opt-in values', () => {
      // biome-ignore lint/performance/noDelete: test isolation
      delete process.env.MCP_TASKS_POLL_ENABLED;
      expect(isTasksPollEnabled()).toBe(false);
      process.env.MCP_TASKS_POLL_ENABLED = 'true';
      expect(isTasksPollEnabled()).toBe(true);
      process.env.MCP_TASKS_POLL_ENABLED = '1';
      expect(isTasksPollEnabled()).toBe(true);
      process.env.MCP_TASKS_POLL_ENABLED = '0';
      expect(isTasksPollEnabled()).toBe(false);
    });

    it('resolveTasksPollInterval/MaxAttempts/TimeoutMs read live env', () => {
      process.env.MCP_TASKS_POLL_INTERVAL_MS = '25';
      process.env.MCP_TASKS_POLL_MAX_ATTEMPTS = '7';
      process.env.MCP_TASKS_POLL_TIMEOUT_MS = '9000';
      expect(resolveTasksPollInterval()).toBe(25);
      expect(resolveTasksPollMaxAttempts()).toBe(7);
      expect(resolveTasksPollTimeoutMs(5000)).toBe(9000);
      // biome-ignore lint/performance/noDelete: test isolation
      delete process.env.MCP_TASKS_POLL_TIMEOUT_MS;
      expect(resolveTasksPollTimeoutMs(5000)).toBe(5000);
      process.env.MCP_TASKS_POLL_INTERVAL_MS = 'bogus';
      process.env.MCP_TASKS_POLL_MAX_ATTEMPTS = '-3';
      expect(resolveTasksPollInterval()).toBe(1000);
      expect(resolveTasksPollMaxAttempts()).toBe(30);
    });

    it('isMcpAbortError detects aborts and AbortErrors', () => {
      const controller = new AbortController();
      expect(isMcpAbortError(new Error('x'), controller.signal)).toBe(false);
      controller.abort();
      expect(isMcpAbortError(new Error('x'), controller.signal)).toBe(true);
      expect(isMcpAbortError(new DOMException('a', 'AbortError'))).toBe(true);
      expect(isMcpAbortError(new Error('plain'))).toBe(false);
    });

    it('disabled polling returns the first result with zero extra requests', async () => {
      // biome-ignore lint/performance/noDelete: test isolation
      delete process.env.MCP_TASKS_POLL_ENABLED;
      const manager = await createConnectedManager();
      const client = clientOf(manager, 'test-server');
      const getTask = vi.fn(async () => ({ status: 'completed' }));
      client.getTask = getTask;
      mockCallTool.mockResolvedValue({
        taskId: 't1',
        content: [{ type: 'text', text: 'first' }],
      });

      const result = await manager.queryContext('q');
      expect(result.entries[0].content).toBe('first');
      expect(getTask).not.toHaveBeenCalled();
    });

    it('enabled polling follows a task handle to the terminal result', async () => {
      process.env.MCP_TASKS_POLL_ENABLED = '1';
      process.env.MCP_TASKS_POLL_INTERVAL_MS = '1';
      const manager = await createConnectedManager();
      const client = clientOf(manager, 'test-server');
      client.getTask = vi.fn(async () => ({
        status: 'completed',
        content: [{ type: 'text', text: 'terminal-docs' }],
      }));
      mockCallTool.mockResolvedValue({
        taskId: 't1',
        content: [{ type: 'text', text: 'first' }],
      });

      const result = await manager.queryContext('q');
      expect(result.entries[0].content).toBe('terminal-docs');
    });

    it('accepts success synonyms and task_id envelope, keeps polling on partial content', async () => {
      process.env.MCP_TASKS_POLL_ENABLED = 'true';
      process.env.MCP_TASKS_POLL_INTERVAL_MS = '1';
      process.env.MCP_TASKS_POLL_MAX_ATTEMPTS = '5';
      const manager = await createConnectedManager();
      const client = clientOf(manager, 'test-server');
      const getTask = vi
        .fn()
        // Progress update carrying partial content must NOT stop polling.
        .mockResolvedValueOnce({ status: 'running', content: [{ type: 'text', text: 'part' }] })
        .mockResolvedValueOnce({
          status: 'succeeded',
          content: [{ type: 'text', text: 'done-synonym' }],
        });
      client.getTask = getTask;
      mockCallTool.mockResolvedValue({
        task_id: 't2',
        content: [{ type: 'text', text: 'first' }],
      });

      const result = await manager.queryContext('q');
      expect(getTask).toHaveBeenCalledTimes(2);
      expect(result.entries[0].content).toBe('done-synonym');
    });

    it('structuredContent task envelope is detected', async () => {
      process.env.MCP_TASKS_POLL_ENABLED = '1';
      process.env.MCP_TASKS_POLL_INTERVAL_MS = '1';
      const manager = await createConnectedManager();
      const client = clientOf(manager, 'test-server');
      const getTask = vi.fn(async () => ({
        status: 'complete',
        content: [{ type: 'text', text: 'via-structured' }],
      }));
      client.getTask = getTask;
      mockCallTool.mockResolvedValue({
        structuredContent: { taskId: 't9' },
        content: [{ type: 'text', text: 'first' }],
      });

      const result = await manager.queryContext('q');
      expect(getTask).toHaveBeenCalled();
      expect(result.entries[0].content).toBe('via-structured');
    });

    it('object-envelope accessors ({ taskId }) are retried after a shape mismatch', async () => {
      process.env.MCP_TASKS_POLL_ENABLED = '1';
      process.env.MCP_TASKS_POLL_INTERVAL_MS = '1';
      const manager = await createConnectedManager();
      const client = clientOf(manager, 'test-server');
      client.getTask = vi.fn(async (arg: unknown) => {
        if (typeof arg === 'string') throw new TypeError('Expected object argument with taskId');
        return { status: 'completed', content: [{ type: 'text', text: 'object-shape' }] };
      });
      mockCallTool.mockResolvedValue({
        taskId: 't1',
        content: [{ type: 'text', text: 'first' }],
      });

      const result = await manager.queryContext('q');
      expect(result.entries[0].content).toBe('object-shape');
    });

    it('no task handle or no accessor returns the first result', async () => {
      process.env.MCP_TASKS_POLL_ENABLED = '1';
      const manager = await createConnectedManager();
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'plain' }] });

      const result = await manager.queryContext('q');
      expect(result.entries[0].content).toBe('plain');
    });

    it('poll errors fail open to the first result', async () => {
      process.env.MCP_TASKS_POLL_ENABLED = '1';
      process.env.MCP_TASKS_POLL_INTERVAL_MS = '1';
      const manager = await createConnectedManager();
      const client = clientOf(manager, 'test-server');
      client.getTask = vi.fn(async () => {
        throw new Error('status 500');
      });
      mockCallTool.mockResolvedValue({
        taskId: 't1',
        content: [{ type: 'text', text: 'first-fallback' }],
      });

      const result = await manager.queryContext('q');
      expect(result.entries[0].content).toBe('first-fallback');
    });
  });
});
