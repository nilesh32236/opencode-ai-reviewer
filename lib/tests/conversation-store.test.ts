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
});
