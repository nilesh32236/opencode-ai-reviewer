import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStateManager } from '../src/conversation/state.js';
import type {
  AgentConfig,
  ConversationContext,
  ConversationState,
  PRContext,
} from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

const { mockMCPConnect, mockMCPDisconnect, mockRunOpenCode, MockMCPManager } = vi.hoisted(() => {
  const _mockMCPConnect = vi.fn();
  const _mockMCPDisconnect = vi.fn();
  const _mockRunOpenCode = vi.fn();
  class _MockMCPManager {
    connect = _mockMCPConnect;
    disconnect = _mockMCPDisconnect;
    getLibraryDocs = vi.fn();
  }
  return {
    mockMCPConnect: _mockMCPConnect,
    mockMCPDisconnect: _mockMCPDisconnect,
    mockRunOpenCode: _mockRunOpenCode,
    MockMCPManager: _MockMCPManager,
  };
});

vi.mock('../src/mcp/client.js', () => ({
  MCPManager: MockMCPManager,
}));

vi.mock('../src/opencode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/opencode.js')>();
  return {
    ...actual,
    runOpenCode: mockRunOpenCode,
    ensureOutputDir: vi.fn(),
    getGitStatus: vi.fn(),
  };
});

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      unlink: vi.fn(),
      appendFile: vi.fn(),
      // The async codebase-index walk uses the real async directory listing.
      readdir: actual.promises.readdir,
      stat: actual.promises.stat,
      mkdir: actual.promises.mkdir,
    },
  };
});

import * as fs from 'fs';
import { ReviewEngine } from '../src/engine.js';

const mockReadFile = fs.promises.readFile as unknown as ReturnType<typeof vi.fn>;
const mockUnlink = fs.promises.unlink as unknown as ReturnType<typeof vi.fn>;

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'test-user',
    labels: [],
    changedFiles: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    ...overrides,
  };
}

function makeContext(
  threadCount: number,
  overrides: Partial<ConversationContext> = {},
): ConversationContext {
  const thread = Array.from({ length: threadCount }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    body: `message ${i + 1}`,
    author: i % 2 === 0 ? 'alice' : 'bot',
  }));
  return {
    threadId: 'org/repo/42/src/a.ts',
    repo: 'org/repo',
    filePath: 'src/a.ts',
    thread,
    prContext: makePRContext(),
    intent: 'general',
    ...overrides,
  };
}

function mockMainRun(): void {
  mockReadFile.mockImplementation(async (p: string) => {
    if (p.includes('conversation-output.txt')) return 'conversation reply';
    if (p.includes('conversation-summary.txt')) return 'summary text';
    throw new Error('not found');
  });
}

describe('ReviewEngine.runConversation', () => {
  let engine: ReviewEngine;
  let stateManager: ConversationStateManager;

  beforeEach(() => {
    vi.resetAllMocks();
    mockUnlink.mockResolvedValue(undefined);
    mockMCPConnect.mockResolvedValue(undefined);
    mockMCPDisconnect.mockResolvedValue(undefined);
    engine = new ReviewEngine(makeConfig(), {} as never);
    stateManager = new ConversationStateManager();
  });

  it('auto-closes at the turn limit without invoking the model', async () => {
    const ctx = makeContext(3);
    const state = stateManager.getOrCreateState(ctx.threadId!);
    state.turnCount = 50;

    const response = await engine.runConversation(ctx, undefined, undefined, stateManager);

    expect(response).toContain('maximum of 50 turns');
    expect(mockRunOpenCode).not.toHaveBeenCalled();
    // The close message is only posted once — a follow-up mention is a no-op.
    const again = await engine.runConversation(ctx, undefined, undefined, stateManager);
    expect(again).toBe('');
  });

  it('returns an empty no-op when the thread is already closed', async () => {
    const ctx = makeContext(3);
    const state = stateManager.getOrCreateState(ctx.threadId!);
    state.alreadyClosed = true;

    const response = await engine.runConversation(ctx, undefined, undefined, stateManager);

    expect(response).toBe('');
    expect(mockRunOpenCode).not.toHaveBeenCalled();
  });

  it('does not consume a turn or trigger summarization on an empty reply', async () => {
    const ctx = makeContext(25);
    mockRunOpenCode.mockResolvedValue({ success: true, output: '', durationMs: 10, tokensUsed: 1 });
    mockReadFile.mockResolvedValue('');

    const response = await engine.runConversation(ctx, undefined, undefined, stateManager);

    expect(response).toContain('output was empty');
    const state = stateManager.getOrCreateState(ctx.threadId!);
    // No turn consumed: an empty generation must not advance auto-close.
    expect(state.turnCount).toBe(0);
    // Only the main model call happened — no summary pass.
    expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
  });

  it('runs the main turn, reads the reply before summarizing, and stores a fresh summary', async () => {
    const ctx = makeContext(25);
    mockMainRun();
    mockRunOpenCode
      .mockResolvedValueOnce({ success: true, output: 'main', durationMs: 5, tokensUsed: 2 })
      .mockResolvedValueOnce({ success: true, output: 'summary', durationMs: 5, tokensUsed: 1 });

    const response = await engine.runConversation(ctx, undefined, undefined, stateManager);

    expect(response).toBe('conversation reply');
    // Main run + one summarization pass.
    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
    const state = stateManager.getOrCreateState(ctx.threadId!);
    expect(state.turnCount).toBe(1);
    expect(state.summarySnapshot).toBe('summary text');
    // Older chunk = 25 - 20 = 5 messages covered by the fresh snapshot.
    expect(state.summarizedCount).toBe(5);
  });

  it('does not advance summarizedCount when the summary run fails', async () => {
    const ctx = makeContext(25);
    mockMainRun();
    mockRunOpenCode
      .mockResolvedValueOnce({ success: true, output: 'main', durationMs: 5, tokensUsed: 2 })
      .mockResolvedValueOnce({ success: false, output: '', durationMs: 5, tokensUsed: 0 });

    const state = stateManager.getOrCreateState(ctx.threadId!);
    state.summarySnapshot = 'previous snapshot';
    state.summarizedCount = 2;

    const response = await engine.runConversation(ctx, undefined, undefined, stateManager);

    expect(response).toBe('conversation reply');
    // Failed summary keeps the previous snapshot and coverage.
    expect(state.summarySnapshot).toBe('previous snapshot');
    expect(state.summarizedCount).toBe(2);
    // The turn still advanced.
    expect(state.turnCount).toBe(1);
  });

  it('does not run a summary pass when the thread fits in the window', async () => {
    const ctx = makeContext(3);
    mockMainRun();
    mockRunOpenCode.mockResolvedValue({
      success: true,
      output: 'main',
      durationMs: 5,
      tokensUsed: 2,
    });

    await engine.runConversation(ctx, undefined, undefined, stateManager);

    expect(mockRunOpenCode).toHaveBeenCalledTimes(1);
    const state = stateManager.getOrCreateState(ctx.threadId!);
    expect(state.turnCount).toBe(1);
  });

  it('isolates state per thread id', async () => {
    mockMainRun();
    mockRunOpenCode.mockResolvedValue({
      success: true,
      output: 'main',
      durationMs: 5,
      tokensUsed: 2,
    });

    const ctxA = makeContext(3);
    const ctxB = makeContext(3, { threadId: 'org/repo/42/src/b.ts' });

    await engine.runConversation(ctxA, undefined, undefined, stateManager);
    await engine.runConversation(ctxB, undefined, undefined, stateManager);

    const stateA = stateManager.getOrCreateState(ctxA.threadId!);
    const stateB = stateManager.getOrCreateState(ctxB.threadId!);
    expect(stateA.turnCount).toBe(1);
    expect(stateB.turnCount).toBe(1);
    expect(stateA).not.toBe(stateB);
  });

  it('normalizes a partial conversation config through the shared defaults', async () => {
    // A partial conversation section (as merged from yml/env) must not yield
    // NaN coverage or crash the state manager.
    mockMainRun();
    mockRunOpenCode.mockResolvedValue({
      success: true,
      output: 'main',
      durationMs: 5,
      tokensUsed: 2,
    });
    const partialEngine = new ReviewEngine(
      makeConfig({
        conversation: {
          mentionHandle: 'opencode-reviewer',
          enabled: true,
          maxTurns: 5,
          slidingWindowSize: 20,
          contextTokenBudget: 32000,
        } as AgentConfig['conversation'],
      }),
      {} as never,
    );

    const ctx = makeContext(25);
    const response = await partialEngine.runConversation(ctx, undefined, undefined, stateManager);

    expect(response).toBe('conversation reply');
    expect(mockRunOpenCode).toHaveBeenCalledTimes(2);
    const state = stateManager.getOrCreateState(ctx.threadId!);
    expect(state.summarizedCount).toBe(5);
  });
});
