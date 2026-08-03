import {
  type ConversationConfig,
  type ConversationContext,
  type ConversationState,
  DEFAULT_CONVERSATION_CONFIG,
} from '../types/index.js';

/** Decision describing whether a conversation thread should be auto-closed. */
export interface AutoCloseDecision {
  /** Whether the conversation should be auto-closed. */
  shouldClose: boolean;
  /** Reason for the closure decision, when `shouldClose` is true. */
  reason?: 'max_turns';
  /** Pre-formatted message to post when the conversation is auto-closed. */
  message?: string;
}

/**
 * Build a unique thread identifier for a conversation context using the
 * repo/PR/file scheme so state survives across turns on the same thread.
 *
 * @param context - Conversation context (may carry an explicit `threadId`).
 * @returns The canonical thread identifier.
 */
export function conversationThreadId(context: ConversationContext): string {
  if (context.threadId) return context.threadId;
  const suffix = `${context.prContext.number}/${context.filePath || 'issue'}`;
  // Include the repo when available so the fallback key cannot collide across
  // repositories that share a PR number.
  return context.repo ? `${context.repo}/${suffix}` : suffix;
}

/**
 * Format the auto-close message shown to a user when a conversation reaches
 * its maximum turn count.
 *
 * @param maxTurns - The configured maximum turn count.
 * @returns The human-readable auto-close message.
 */
export function formatAutoCloseMessage(maxTurns: number): string {
  return `This conversation has reached its maximum of ${maxTurns} turns. Please start a new thread or create a new review comment to continue.`;
}

/**
 * Manages in-memory state for active conversation threads.
 *
 * Tracks turn count, activity timestamps, and summary snapshots so long-running
 * conversations can be summarized into a sliding window and auto-closed
 * gracefully instead of growing unbounded until the model's context window is
 * exceeded. State is kept in memory by design (Option A); the instance must be
 * long-lived (owned by the app subscriber) so it survives across webhook turns.
 *
 * Idle states are pruned after `STATE_TTL_MS` and the map is capped at
 * `MAX_STATES` entries so a long-lived instance never leaks memory. Per-thread
 * turns are serialized with {@link withThreadLock} so concurrent webhooks for
 * the same thread cannot drop a turn increment or clobber a summary snapshot.
 */
export class ConversationStateManager {
  /** Idle time after which a thread's state is evicted (24h). */
  static readonly STATE_TTL_MS = 24 * 60 * 60 * 1000;
  /** Maximum number of tracked thread states before eviction kicks in. */
  static readonly MAX_STATES = 1000;

  private readonly states = new Map<string, ConversationState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Return the state for a thread, creating it with defaults if unknown.
   * Prunes expired states and evicts the least-recently-active entry when the
   * map is at capacity so memory stays bounded.
   *
   * @param threadId - Unique conversation thread identifier.
   * @returns The existing or newly created conversation state.
   */
  getOrCreateState(threadId: string): ConversationState {
    this.pruneExpiredStates();
    let state = this.states.get(threadId);
    if (!state) {
      if (this.states.size >= ConversationStateManager.MAX_STATES) {
        this.evictLeastRecentlyActive();
      }
      state = {
        threadId,
        turnCount: 0,
        lastActivityTimestamp: Date.now(),
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  /**
   * Return the currently tracked state for a thread, without creating one.
   * @param threadId - Unique conversation thread identifier.
   * @returns The tracked state, or undefined when the thread is not tracked.
   */
  getState(threadId: string): ConversationState | undefined {
    return this.states.get(threadId);
  }

  /**
   * Restore a previously persisted conversation state so a thread's turn
   * count, summary snapshot, and auto-close flag survive an app restart. Only
   * applies when the thread is not already tracked in memory (fresh state wins
   * over stale persisted state).
   *
   * @param state - Persisted conversation state to seed the manager with.
   */
  restoreState(state: ConversationState): void {
    if (!state || !state.threadId) return;
    if (this.states.has(state.threadId)) return;
    this.states.set(state.threadId, {
      threadId: state.threadId,
      turnCount: state.turnCount ?? 0,
      lastActivityTimestamp: state.lastActivityTimestamp ?? Date.now(),
      summarySnapshot: state.summarySnapshot,
      summarizedCount: state.summarizedCount,
      alreadyClosed: state.alreadyClosed,
    });
  }

  /**
   * Serialize an async operation per thread so concurrent webhook turns for the
   * same thread cannot interleave state transitions (turn counting, summary
   * writes). Operations for different threads run concurrently.
   *
   * @param threadId - Unique conversation thread identifier.
   * @param fn - Async operation to run under the per-thread lock.
   * @returns The result of `fn`.
   */
  async withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(threadId, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Only remove the lock entry when no later waiter has replaced it.
      if (this.locks.get(threadId) === current) {
        this.locks.delete(threadId);
      }
    }
  }

  /**
   * Update a conversation state after a successful turn: bumps the turn count,
   * refreshes the activity timestamp, and optionally stores a new summary.
   *
   * @param state - The conversation state to update.
   * @param latestSummary - Optional summary to persist as the snapshot.
   * @param summarizedCount - Number of older messages covered by `latestSummary`.
   */
  updateState(state: ConversationState, latestSummary?: string, summarizedCount?: number): void {
    state.turnCount += 1;
    state.lastActivityTimestamp = Date.now();
    if (latestSummary !== undefined) {
      state.summarySnapshot = latestSummary;
      state.summarizedCount = summarizedCount;
    }
  }

  /**
   * Decide whether the older portion of a thread needs (re)summarization.
   * Returns true on the first turn the thread overflows the sliding window and
   * again each time the older chunk roughly doubles in size, so summarization
   * runs every N turns rather than on every single turn.
   *
   * @param state - The conversation state.
   * @param threadLength - Total messages currently in the thread.
   * @param config - Conversation configuration.
   * @returns True when a summarization pass should run.
   */
  shouldSummarize(
    state: ConversationState,
    threadLength: number,
    config: ConversationConfig,
  ): boolean {
    const windowSize = config?.slidingWindowSize ?? DEFAULT_CONVERSATION_CONFIG.slidingWindowSize;
    const olderCount = Math.max(0, threadLength - windowSize);
    if (olderCount <= 0) return false;
    if (!state.summarySnapshot) return true;
    const covered = state.summarizedCount ?? 0;
    return olderCount >= Math.max(1, covered * 2);
  }

  /**
   * Decide whether a conversation should be auto-closed based on its turn count.
   *
   * @param state - The conversation state.
   * @param config - Conversation configuration.
   * @returns The auto-close decision, including a pre-formatted message.
   */
  shouldAutoClose(state: ConversationState, config: ConversationConfig): AutoCloseDecision {
    const maxTurns = config?.maxTurns ?? DEFAULT_CONVERSATION_CONFIG.maxTurns;
    if (maxTurns > 0 && state.turnCount >= maxTurns) {
      return {
        shouldClose: true,
        reason: 'max_turns',
        message: formatAutoCloseMessage(maxTurns),
      };
    }
    return { shouldClose: false };
  }

  private pruneExpiredStates(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (now - state.lastActivityTimestamp > ConversationStateManager.STATE_TTL_MS) {
        this.states.delete(id);
      }
    }
  }

  private evictLeastRecentlyActive(): void {
    let oldestId: string | undefined;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [id, state] of this.states) {
      if (state.lastActivityTimestamp < oldestTs) {
        oldestTs = state.lastActivityTimestamp;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      this.states.delete(oldestId);
    }
  }
}
