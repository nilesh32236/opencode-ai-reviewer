import type { ConversationConfig, ConversationContext, ConversationState } from '../types/index.js';

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
  return `${context.prContext.number}/${context.filePath || 'issue'}`;
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
 */
export class ConversationStateManager {
  private readonly states = new Map<string, ConversationState>();

  /**
   * Return the state for a thread, creating it with defaults if unknown.
   *
   * @param threadId - Unique conversation thread identifier.
   * @returns The existing or newly created conversation state.
   */
  getOrCreateState(threadId: string): ConversationState {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        threadId,
        turnCount: 0,
        lastActivityTimestamp: Date.now(),
        messageCount: 0,
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  /**
   * Get the current turn count for a thread.
   *
   * @param threadId - Unique conversation thread identifier.
   * @returns The tracked turn count (0 when unknown).
   */
  getTurnCount(threadId: string): number {
    return this.states.get(threadId)?.turnCount ?? 0;
  }

  /**
   * Update a conversation state after a successful turn: bumps the turn count,
   * refreshes the activity timestamp, and optionally stores a new summary.
   *
   * @param state - The conversation state to update.
   * @param latestSummary - Optional summary to persist as the snapshot.
   * @param summarizedCount - Number of older messages covered by `latestSummary`.
   * @param messageCount - Total messages seen this turn (defaults to keeping prior value).
   */
  updateState(
    state: ConversationState,
    latestSummary?: string,
    summarizedCount?: number,
    messageCount?: number,
  ): void {
    state.turnCount += 1;
    state.lastActivityTimestamp = Date.now();
    if (messageCount !== undefined) {
      state.messageCount = messageCount;
    }
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
    const olderCount = Math.max(0, threadLength - config.slidingWindowSize);
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
    const maxTurns = config.maxTurns;
    if (maxTurns > 0 && state.turnCount >= maxTurns) {
      return {
        shouldClose: true,
        reason: 'max_turns',
        message: formatAutoCloseMessage(maxTurns),
      };
    }
    return { shouldClose: false };
  }
}
