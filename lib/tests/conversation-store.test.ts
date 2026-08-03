import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';

const TEST_DB = path.join(os.tmpdir(), `.test-conv-store-${Date.now()}.db`);

describe('LearningStore conversation sessions', () => {
  let store: LearningStore;

  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
    store = new LearningStore(TEST_DB);
  });

  afterEach(async () => {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(TEST_DB + suffix);
      } catch {
        /* ok */
      }
    }
    try {
      fs.unlinkSync(TEST_DB.replace(/\.db$/, '.json'));
    } catch {
      /* ok */
    }
  });

  it('creates a session on first getOrCreate and returns it unchanged on repeat', async () => {
    const sessionId = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
      turnCount: 3,
    });
    expect(sessionId).toBe('org/repo/42/issue');

    // Second call with different initial state must NOT overwrite the row.
    await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
      turnCount: 99,
    });
    const session = await store.getConversationSession('org/repo/42/issue');
    expect(session?.turn_count).toBe(3);
    expect(session?.pr_number).toBe(42);
    expect(session?.is_review_comment).toBe(0);
  });

  it('returns null for a missing session', async () => {
    expect(await store.getConversationSession('missing')).toBeNull();
  });

  it('persists review-comment anchor fields', async () => {
    const id = await store.getOrCreateConversationSession({
      id: 'org/repo/42/src/a.ts#7',
      prNumber: 42,
      repo: 'org/repo',
      threadRootCommentId: 7,
      isReviewComment: true,
    });
    const session = await store.getConversationSession(id);
    expect(session?.thread_root_comment_id).toBe(7);
    expect(session?.is_review_comment).toBe(1);
  });

  it('addConversationTurn and getConversationTurns round-trip in turn order', async () => {
    const sessionId = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
    });
    await store.addConversationTurn({
      sessionId,
      turnNumber: 1,
      role: 'user',
      body: 'Why is this null?',
      fileRef: 'src/foo.ts',
      lineRef: 42,
    });
    await store.addConversationTurn({
      sessionId,
      turnNumber: 1,
      role: 'assistant',
      body: 'Because it is not initialized.',
    });
    await store.addConversationTurn({
      sessionId,
      turnNumber: 2,
      role: 'user',
      body: 'How do I fix it?',
    });

    const turns = await store.getConversationTurns(sessionId);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.turn_number)).toEqual([1, 1, 2]);
    expect(turns[0].role).toBe('user');
    expect(turns[0].file_ref).toBe('src/foo.ts');
    expect(turns[0].line_ref).toBe(42);
    expect(turns[1].role).toBe('assistant');
  });

  it('getConversationTurns only returns turns for the requested session', async () => {
    const a = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
    });
    const b = await store.getOrCreateConversationSession({
      id: 'org/repo/43/issue',
      prNumber: 43,
      repo: 'org/repo',
      isReviewComment: false,
    });
    await store.addConversationTurn({ sessionId: a, turnNumber: 1, role: 'user', body: 'qa' });
    await store.addConversationTurn({ sessionId: b, turnNumber: 1, role: 'user', body: 'qb' });

    expect(await store.getConversationTurns(a)).toHaveLength(1);
    expect((await store.getConversationTurns(a))[0].body).toBe('qa');
    expect(await store.getConversationTurns(b)).toHaveLength(1);
  });

  it('updateConversationSession applies a state patch', async () => {
    const sessionId = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
    });
    await store.updateConversationSession(sessionId, {
      turnCount: 5,
      tokenBudgetUsed: 1234,
      summarySnapshot: 'agreed on approach',
      summarizedCount: 8,
      alreadyClosed: false,
      lastFileRef: 'src/foo.ts',
      lastLineRef: 42,
      lastActivityTimestamp: 1_700_000_000_000,
    });

    const session = await store.getConversationSession(sessionId);
    expect(session?.turn_count).toBe(5);
    expect(session?.token_budget_used).toBe(1234);
    expect(session?.summary_snapshot).toBe('agreed on approach');
    expect(session?.summarized_count).toBe(8);
    expect(session?.already_closed).toBe(0);
    expect(session?.last_file_ref).toBe('src/foo.ts');
    expect(session?.last_line_ref).toBe(42);
    expect(session?.last_activity_timestamp).toBe(1_700_000_000_000);
  });

  it('updateConversationSession leaves unpatched fields intact', async () => {
    const sessionId = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
      turnCount: 1,
    });
    await store.updateConversationSession(sessionId, { alreadyClosed: true });
    const session = await store.getConversationSession(sessionId);
    expect(session?.already_closed).toBe(1);
    expect(session?.turn_count).toBe(1);
  });

  it('updateConversationSession clears nullable columns when null is passed', async () => {
    const sessionId = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
      lastFileRef: 'src/foo.ts',
      lastLineRef: 42,
      summarySnapshot: 'old snapshot',
      summarizedCount: 3,
    });
    await store.updateConversationSession(sessionId, {
      lastFileRef: null,
      lastLineRef: null,
      summarySnapshot: null,
      summarizedCount: null,
    });
    const session = await store.getConversationSession(sessionId);
    expect(session?.last_file_ref).toBeNull();
    expect(session?.last_line_ref).toBeNull();
    expect(session?.summary_snapshot).toBeNull();
    expect(session?.summarized_count).toBeNull();
  });

  it('getConversationTurns returns user before assistant for distinct turn numbers', async () => {
    const sessionId = await store.getOrCreateConversationSession({
      id: 'org/repo/42/issue',
      prNumber: 42,
      repo: 'org/repo',
      isReviewComment: false,
    });
    // Mirrors persistSessionState: user rows get 2n-1, assistant rows 2n, so a
    // user question always precedes its assistant answer regardless of the
    // insertion order.
    await store.addConversationTurn({
      sessionId,
      turnNumber: 4,
      role: 'assistant',
      body: 'answer',
    });
    await store.addConversationTurn({
      sessionId,
      turnNumber: 3,
      role: 'user',
      body: 'question',
    });
    await store.addConversationTurn({
      sessionId,
      turnNumber: 5,
      role: 'user',
      body: 'next question',
    });

    const turns = await store.getConversationTurns(sessionId);
    expect(turns.map((t) => t.turn_number)).toEqual([3, 4, 5]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('cleanupConversations removes idle sessions and their turns', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const staleId = await store.getOrCreateConversationSession({
      id: 'org/repo/1/issue',
      prNumber: 1,
      repo: 'org/repo',
      isReviewComment: false,
      lastActivityTimestamp: now - 40 * DAY_MS,
    });
    const freshId = await store.getOrCreateConversationSession({
      id: 'org/repo/2/issue',
      prNumber: 2,
      repo: 'org/repo',
      isReviewComment: false,
    });
    await store.addConversationTurn({
      sessionId: staleId,
      turnNumber: 1,
      role: 'user',
      body: 'stale question',
    });
    await store.addConversationTurn({
      sessionId: freshId,
      turnNumber: 1,
      role: 'user',
      body: 'fresh question',
    });

    const deleted = await store.cleanupConversations(now - 30 * DAY_MS);

    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await store.getConversationSession(staleId)).toBeNull();
    expect(await store.getConversationTurns(staleId)).toHaveLength(0);
    expect(await store.getConversationSession(freshId)).not.toBeNull();
    expect(await store.getConversationTurns(freshId)).toHaveLength(1);
  });
});
