import { describe, expect, it } from 'vitest';
import {
  ConversationStateManager,
  conversationThreadId,
  formatAutoCloseMessage,
} from '../src/conversation/state.js';
import {
  buildConversationPrompt,
  buildConversationSummaryPrompt,
} from '../src/prompts/conversation.js';
import type {
  ConversationConfig,
  ConversationContext,
  ConversationState,
  PRContext,
} from '../src/types/index.js';
import { estimateTokens } from '../src/utils/token-estimate.js';

const BASE_PR: PRContext = {
  number: 42,
  title: 'Fix the bug',
  body: '',
  headRef: 'feature',
  headSha: 'abc123',
  baseRef: 'main',
  author: 'alice',
  labels: [],
  changedFiles: [],
};

const BASE_CONFIG: ConversationConfig = {
  mentionHandle: 'opencode-reviewer',
  enabled: true,
  maxTurns: 50,
  slidingWindowSize: 20,
  contextTokenBudget: 32000,
};

function makeContext(
  thread: Array<{ role: 'user' | 'assistant'; body: string; author?: string }>,
): ConversationContext {
  return {
    filePath: 'src/a.ts',
    diffHunk: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@',
    thread,
    prContext: BASE_PR,
    intent: 'general',
  };
}

function makeMessages(
  count: number,
): Array<{ role: 'user' | 'assistant'; body: string; author?: string }> {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    body: `message ${i + 1}`,
    author: i % 2 === 0 ? 'alice' : 'bot',
  }));
}

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    threadId: 'org/repo/42/src/a.ts',
    turnCount: 0,
    lastActivityTimestamp: Date.now(),
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('returns ~4 chars per token, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('scales linearly with length', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('a'.repeat(401))).toBe(101);
  });
});

describe('buildConversationPrompt', () => {
  it('includes the full thread when within the sliding window', () => {
    const messages = makeMessages(5);
    const prompt = buildConversationPrompt(makeContext(messages), BASE_CONFIG);
    expect(prompt).toContain('message 1');
    expect(prompt).toContain('message 5');
    expect(prompt).not.toContain('Conversation Summary');
  });

  it('applies the sliding window when the thread exceeds slidingWindowSize', () => {
    const messages = makeMessages(25);
    const prompt = buildConversationPrompt(makeContext(messages), BASE_CONFIG);
    // Older messages are omitted from the thread section.
    expect(prompt).not.toContain('\nmessage 1\n');
    expect(prompt).not.toContain('\nmessage 5\n');
    // Recent window (last 20) is kept in full.
    expect(prompt).toContain('\nmessage 6\n');
    expect(prompt).toContain('\nmessage 25\n');
    // An omission note is present since no summary snapshot exists yet.
    expect(prompt).toContain('5 earlier message(s) have been omitted');
  });

  it('includes the summary snapshot as a condensed preamble when present', () => {
    const messages = makeMessages(30);
    const state = makeState({
      summarySnapshot: 'We agreed to extract the helper.',
      summarizedCount: 10,
    });
    const prompt = buildConversationPrompt(makeContext(messages), BASE_CONFIG, state);
    expect(prompt).toContain('## Conversation Summary');
    expect(prompt).toContain('We agreed to extract the helper.');
    // Older messages are not re-listed in the thread.
    expect(prompt).not.toContain('\nmessage 1\n');
    expect(prompt).toContain('\nmessage 30\n');
  });

  it('re-renders older messages not yet covered by the summary snapshot', () => {
    // 23 messages with a summary covering only the first 2: msg3 rolled out of
    // the window but is not in the snapshot — it must still reach the model.
    const messages = makeMessages(23);
    const state = makeState({ summarySnapshot: 'summary of msg1-2', summarizedCount: 2 });
    const prompt = buildConversationPrompt(makeContext(messages), BASE_CONFIG, state);
    expect(prompt).toContain('recently rolled out');
    expect(prompt).toContain('\nmessage 3\n');
    // Fully covered older messages are not re-sent.
    expect(prompt).not.toContain('\nmessage 1\n');
    expect(prompt).not.toContain('\nmessage 2\n');
  });

  it('enforces the token budget by reducing the recent-window size', () => {
    // Each message is huge (~500 chars), so 20 recent messages blow far past a
    // tiny budget; the prompt must shrink the window rather than overflow.
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      body: `very long message ${i + 1} ` + 'x'.repeat(500),
      author: i % 2 === 0 ? 'alice' : 'bot',
    }));
    const prompt = buildConversationPrompt(makeContext(messages), {
      ...BASE_CONFIG,
      slidingWindowSize: 20,
      contextTokenBudget: 2500,
    });
    // The most recent message is always kept.
    expect(prompt).toContain('very long message 30');
    // A window larger than what fits must have been dropped (older message gone).
    const estimate = estimateTokens(prompt);
    expect(estimate).toBeLessThanOrEqual(3000);
  });

  it('appends context usage info with turn and token estimate', () => {
    const messages = makeMessages(3);
    const prompt = buildConversationPrompt(
      makeContext(messages),
      BASE_CONFIG,
      makeState({ turnCount: 2 }),
    );
    expect(prompt).toContain('## Context Usage');
    expect(prompt).toContain('Turn: 3/50');
    expect(prompt).toContain('tokens');
    expect(prompt).toContain('32,000');
  });

  it('uses the fallback token budget when no config is provided', () => {
    const messages = makeMessages(2);
    const prompt = buildConversationPrompt(makeContext(messages));
    expect(prompt).toContain('## Context Usage');
    expect(prompt).toContain('32,000');
  });

  it('warns when approaching the turn limit', () => {
    const messages = makeMessages(3);
    const state = makeState({ turnCount: 41 });
    const prompt = buildConversationPrompt(makeContext(messages), BASE_CONFIG, state);
    expect(prompt).toContain('⚠️');
    expect(prompt).toContain('approaching its 50-turn limit');
  });

  it('does not warn when far from the turn limit', () => {
    const messages = makeMessages(3);
    const prompt = buildConversationPrompt(
      makeContext(messages),
      BASE_CONFIG,
      makeState({ turnCount: 5 }),
    );
    expect(prompt).not.toContain('approaching its 50-turn limit');
  });

  it('renders unlimited turns as ∞', () => {
    const messages = makeMessages(2);
    const prompt = buildConversationPrompt(
      makeContext(messages),
      { ...BASE_CONFIG, maxTurns: 0 },
      makeState({ turnCount: 10 }),
    );
    expect(prompt).toContain('Turn: 11/∞');
  });
});

describe('buildConversationSummaryPrompt', () => {
  it('lists the messages and instructs the summary output file', () => {
    const messages = makeMessages(5);
    const prompt = buildConversationSummaryPrompt(messages, BASE_CONFIG, 12);
    expect(prompt).toContain('message 1');
    expect(prompt).toContain('message 5');
    expect(prompt).toContain('conversation-summary.txt');
    expect(prompt).toContain('turn 12');
  });

  it('merges new messages into an existing summary instead of rewriting', () => {
    const messages = makeMessages(3);
    const prompt = buildConversationSummaryPrompt(
      messages,
      BASE_CONFIG,
      12,
      'Existing summary text.',
    );
    expect(prompt).toContain('Existing Summary');
    expect(prompt).toContain('Existing summary text.');
    expect(prompt).toContain('Newer Messages to Merge In');
    expect(prompt).toContain('message 1');
  });
});

describe('ConversationStateManager', () => {
  it('creates and retrieves states by thread id', () => {
    const manager = new ConversationStateManager();
    const state = manager.getOrCreateState('a');
    expect(state.turnCount).toBe(0);
    expect(manager.getOrCreateState('a')).toBe(state);
  });

  it('returns distinct states for distinct thread ids', () => {
    const manager = new ConversationStateManager();
    expect(manager.getOrCreateState('a')).not.toBe(manager.getOrCreateState('b'));
  });

  it('updateState bumps the turn count and refreshes activity', () => {
    const manager = new ConversationStateManager();
    const state = manager.getOrCreateState('a');
    manager.updateState(state);
    expect(state.turnCount).toBe(1);
    manager.updateState(state);
    expect(state.turnCount).toBe(2);
  });

  it('updateState stores a summary snapshot with its coverage count', () => {
    const manager = new ConversationStateManager();
    const state = manager.getOrCreateState('a');
    manager.updateState(state, 'summary text', 5);
    expect(state.summarySnapshot).toBe('summary text');
    expect(state.summarizedCount).toBe(5);
    expect(state.turnCount).toBe(1);
  });

  it('shouldSummarize is false when the thread fits in the window', () => {
    const manager = new ConversationStateManager();
    const state = makeState();
    expect(manager.shouldSummarize(state, 20, BASE_CONFIG)).toBe(false);
  });

  it('shouldSummarize is true when no summary exists yet and the thread overflows', () => {
    const manager = new ConversationStateManager();
    const state = makeState();
    expect(manager.shouldSummarize(state, 21, BASE_CONFIG)).toBe(true);
  });

  it('shouldSummarize re-triggers when the older chunk doubles', () => {
    const manager = new ConversationStateManager();
    // Summary covers 2 older messages; chunk now holds 5 (> 2*2) → summarize.
    const state = makeState({ summarySnapshot: 's', summarizedCount: 2 });
    expect(manager.shouldSummarize(state, 25, BASE_CONFIG)).toBe(true);
    // Chunk still only slightly larger than covered → no re-summarization.
    const small = makeState({ summarySnapshot: 's', summarizedCount: 4 });
    expect(manager.shouldSummarize(small, 25, BASE_CONFIG)).toBe(false);
  });

  it('shouldAutoClose returns a close decision at the turn limit', () => {
    const manager = new ConversationStateManager();
    const state = makeState({ turnCount: 50 });
    const decision = manager.shouldAutoClose(state, BASE_CONFIG);
    expect(decision.shouldClose).toBe(true);
    expect(decision.reason).toBe('max_turns');
    expect(decision.message).toContain('maximum of 50 turns');
  });

  it('shouldAutoClose does not close before the limit', () => {
    const manager = new ConversationStateManager();
    const state = makeState({ turnCount: 49 });
    expect(manager.shouldAutoClose(state, BASE_CONFIG).shouldClose).toBe(false);
  });

  it('shouldAutoClose never closes when maxTurns is 0 (unlimited)', () => {
    const manager = new ConversationStateManager();
    const state = makeState({ turnCount: 10_000 });
    expect(manager.shouldAutoClose(state, { ...BASE_CONFIG, maxTurns: 0 }).shouldClose).toBe(false);
  });

  it('shouldAutoClose guards against a missing maxTurns instead of throwing', () => {
    const manager = new ConversationStateManager();
    const state = makeState({ turnCount: 10 });
    expect(
      manager.shouldAutoClose(state, { ...BASE_CONFIG, maxTurns: undefined as unknown as number })
        .shouldClose,
    ).toBe(false);
  });

  it('shouldSummarize guards against a missing slidingWindowSize', () => {
    const manager = new ConversationStateManager();
    const state = makeState();
    expect(
      manager.shouldSummarize(state, 10, {
        ...BASE_CONFIG,
        slidingWindowSize: undefined as unknown as number,
      }),
    ).toBe(false);
  });

  it('evicts idle states older than the TTL on next access', () => {
    const manager = new ConversationStateManager();
    const state = manager.getOrCreateState('stale');
    state.lastActivityTimestamp = Date.now() - ConversationStateManager.STATE_TTL_MS - 1000;
    const fresh = manager.getOrCreateState('fresh');
    expect(fresh.turnCount).toBe(0);
    // The stale entry was pruned when a new one was created.
    const recreated = manager.getOrCreateState('stale');
    expect(recreated).not.toBe(state);
  });

  it('evicts the least-recently-active state when at capacity', () => {
    const manager = new ConversationStateManager();
    const first = manager.getOrCreateState('first');
    first.lastActivityTimestamp = 1;
    for (let i = 0; i < ConversationStateManager.MAX_STATES; i++) {
      manager.getOrCreateState(`thread-${i}`);
    }
    // 'first' is the least recently active and must have been evicted.
    expect(manager.getOrCreateState('first')).not.toBe(first);
  });

  it('serializes turns on the same thread with withThreadLock', async () => {
    const manager = new ConversationStateManager();
    const order: string[] = [];
    await Promise.all([
      manager.withThreadLock('a', async () => {
        order.push('start-1');
        await new Promise((r) => setTimeout(r, 20));
        order.push('end-1');
      }),
      manager.withThreadLock('a', async () => {
        order.push('start-2');
        order.push('end-2');
      }),
      manager.withThreadLock('b', async () => {
        order.push('b');
      }),
    ]);
    // Same-thread turns are serialized; different threads run independently.
    expect(order.indexOf('start-1')).toBeLessThan(order.indexOf('end-1'));
    expect(order.indexOf('start-2')).toBeLessThan(order.indexOf('end-2'));
    expect(order.indexOf('end-1')).toBeLessThan(order.indexOf('start-2'));
  });

  it('updateState preserves alreadyClosed flag across turns', () => {
    const manager = new ConversationStateManager();
    const state = manager.getOrCreateState('a');
    state.alreadyClosed = true;
    manager.updateState(state, undefined, undefined, 3);
    expect(state.alreadyClosed).toBe(true);
    expect(state.turnCount).toBe(1);
  });

  it('getState returns undefined for untracked threads', () => {
    const manager = new ConversationStateManager();
    expect(manager.getState('untracked')).toBeUndefined();
  });

  it('restoreState seeds a persisted state that getOrCreateState returns', () => {
    const manager = new ConversationStateManager();
    const now = Date.now();
    manager.restoreState({
      threadId: 'org/repo/42/issue',
      turnCount: 7,
      lastActivityTimestamp: now,
      summarySnapshot: 'agreed on approach',
      summarizedCount: 4,
      alreadyClosed: false,
    });
    const state = manager.getOrCreateState('org/repo/42/issue');
    expect(state.turnCount).toBe(7);
    expect(state.summarySnapshot).toBe('agreed on approach');
    expect(state.summarizedCount).toBe(4);
    expect(state.lastActivityTimestamp).toBe(now);
    expect(manager.getState('org/repo/42/issue')).toBe(state);
  });

  it('restoreState preserves the alreadyClosed flag', () => {
    const manager = new ConversationStateManager();
    manager.restoreState({
      threadId: 'closed-thread',
      turnCount: 50,
      lastActivityTimestamp: Date.now(),
      alreadyClosed: true,
    });
    expect(manager.getOrCreateState('closed-thread').alreadyClosed).toBe(true);
  });

  it('restoreState does not clobber an existing in-memory state', () => {
    const manager = new ConversationStateManager();
    const live = manager.getOrCreateState('live');
    live.turnCount = 3;
    manager.restoreState({ threadId: 'live', turnCount: 99, lastActivityTimestamp: Date.now() });
    expect(manager.getState('live')?.turnCount).toBe(3);
  });

  it('restoreState ignores states without a thread id', () => {
    const manager = new ConversationStateManager();
    manager.restoreState({
      threadId: '',
      turnCount: 1,
      lastActivityTimestamp: Date.now(),
    });
    expect(manager.getState('')).toBeUndefined();
  });
});

describe('conversationThreadId', () => {
  it('uses the explicit threadId when present', () => {
    expect(conversationThreadId({ ...makeContext([]), threadId: 'custom/id' })).toBe('custom/id');
  });

  it('falls back to pr number and file path', () => {
    expect(conversationThreadId(makeContext([]))).toBe('42/src/a.ts');
  });

  it('falls back to "issue" when no file path exists', () => {
    const ctx = makeContext([]);
    ctx.filePath = undefined;
    expect(conversationThreadId(ctx)).toBe('42/issue');
  });

  it('includes the repo in the fallback key when available', () => {
    expect(conversationThreadId({ ...makeContext([]), repo: 'org/repo' })).toBe(
      'org/repo/42/src/a.ts',
    );
  });
});

describe('formatAutoCloseMessage', () => {
  it('mentions the configured turn limit', () => {
    expect(formatAutoCloseMessage(50)).toContain('maximum of 50 turns');
  });
});
