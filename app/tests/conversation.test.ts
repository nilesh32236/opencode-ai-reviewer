import { ConversationStateManager, DEFAULT_CONFIG, Logger } from '@opencode-pr-agent/lib';
import type { AgentConfig, EventBus, LearningStore, PlatformAdapter } from '@opencode-pr-agent/lib';
import { describe, expect, it, vi } from 'vitest';
import {
  extractAskQuestion,
  gatherIssueCommentThread,
  gatherReviewCommentThread,
  handleConversation,
  persistSessionState,
} from '../src/handlers/conversation.js';
import type { RepoFilter } from '../src/utils/repo-filter.js';

const { mockGetMR, mockListComments, mockPostComment, mockRunConversation, mockEngineCleanup } =
  vi.hoisted(() => {
    const mockGetMR = vi.fn();
    const mockListComments = vi.fn();
    const mockPostComment = vi.fn();
    const mockRunConversation = vi.fn();
    const mockEngineCleanup = vi.fn();
    return { mockGetMR, mockListComments, mockPostComment, mockRunConversation, mockEngineCleanup };
  });

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    createPlatformAdapter: () => ({
      getMR: mockGetMR,
      listComments: mockListComments,
      postComment: mockPostComment,
    }),
    ReviewEngine: class extends actual.ReviewEngine {
      runConversation = mockRunConversation;
      cleanup = mockEngineCleanup;
    },
  };
});

const MENTION = '@bot';

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    listReviewComments: vi.fn().mockResolvedValue([]),
    getReviewComment: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    getIssueComment: vi.fn(),
    ...overrides,
  } as unknown as PlatformAdapter;
}

type HandleConversationArgs = [
  commentId: number,
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  isReviewComment: boolean,
  learningStore: LearningStore | undefined,
  signal: AbortSignal | undefined,
  tempDir: string | undefined,
  stateManager: ConversationStateManager | undefined,
  eventBus: EventBus | undefined,
  correlationId: string | undefined,
  repoFilter: RepoFilter,
];

interface HandleConversationOverrides {
  commentId?: number;
  prNumber?: number;
  repo?: string;
  token?: string;
  config?: AgentConfig;
  isReviewComment?: boolean;
  learningStore?: LearningStore;
  signal?: AbortSignal;
  tempDir?: string;
  stateManager?: ConversationStateManager;
  eventBus?: EventBus;
  correlationId?: string;
  repoFilter?: RepoFilter;
}

function makeHandleConversationArgs(
  overrides: HandleConversationOverrides = {},
): HandleConversationArgs {
  return [
    overrides.commentId ?? 1,
    overrides.prNumber ?? 42,
    overrides.repo ?? 'owner/repo',
    overrides.token ?? 'test-token',
    overrides.config ?? ({ platform: 'github' } as AgentConfig),
    overrides.isReviewComment ?? false,
    overrides.learningStore,
    overrides.signal,
    overrides.tempDir,
    overrides.stateManager,
    overrides.eventBus,
    overrides.correlationId,
    overrides.repoFilter ?? { allowed: new Set<string>(), denied: new Set<string>() },
  ];
}

describe('conversation thread gathering', () => {
  describe('gatherReviewCommentThread', () => {
    it('fetches the window newest-first so recent triggers stay in-window', async () => {
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([
          { id: 1, body: 'root', in_reply_to_id: null, user: { login: 'user' } },
          { id: 2, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } },
        ]),
      });

      const result = await gatherReviewCommentThread(gh, 1, 2, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
      expect(gh.listReviewComments).toHaveBeenCalledWith(
        1,
        { perPage: 100, maxPages: 5, direction: 'desc' },
        undefined,
      );
    });

    it('includes the ancestor chain and sibling replies, ascending by id', async () => {
      const comments = [
        {
          id: 1,
          body: 'root',
          in_reply_to_id: null,
          path: 'src/a.ts',
          diff_hunk: 'hunk',
          user: { login: 'user' },
        },
        { id: 2, body: 'sibling', in_reply_to_id: 1, user: { login: 'user' } },
        { id: 3, body: 'ancestor reply', in_reply_to_id: 1, user: { login: 'user' } },
        { id: 4, body: 'trigger', in_reply_to_id: 3, user: { login: 'user' } },
      ];
      const gh = makeAdapter({ listReviewComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherReviewCommentThread(gh, 1, 4, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual([
        'root',
        'sibling',
        'ancestor reply',
        'trigger',
      ]);
      expect(result.filePath).toBe('src/a.ts');
      expect(result.diffHunk).toBe('hunk');
    });

    it('fetches missing ancestors by id when the trigger is outside the window', async () => {
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: null,
        path: 'src/a.ts',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([]),
        getReviewComment: vi
          .fn()
          .mockImplementation(async (_p: number, id: number) =>
            id === 3
              ? { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } }
              : root,
          ),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
      expect(result.filePath).toBe('src/a.ts');
    });

    it('does not hang on a cyclic in_reply_to_id chain', async () => {
      const comments = [
        { id: 1, body: 'a', in_reply_to_id: 2, user: { login: 'user' } },
        { id: 2, body: 'b', in_reply_to_id: 1, user: { login: 'user' } },
      ];
      const gh = makeAdapter({ listReviewComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherReviewCommentThread(gh, 1, 1, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['a', 'b']);
    });

    it('resolves in-window ancestors from the map without re-fetching them', async () => {
      // Window contains comments 2..5 but NOT the root (1). The trigger is 5,
      // whose chain is 5 -> 4 -> 3 -> 2 -> 1. Only 1 is genuinely missing and
      // should be direct-fetched; 2..4 are already in the window and must be
      // resolved from the in-memory map without extra API calls.
      const windowComments = [
        { id: 2, body: 'c2', in_reply_to_id: 1, user: { login: 'user' } },
        { id: 3, body: 'c3', in_reply_to_id: 2, user: { login: 'user' } },
        { id: 4, body: 'c4', in_reply_to_id: 3, user: { login: 'user' } },
        { id: 5, body: 'c5', in_reply_to_id: 4, user: { login: 'user' } },
      ];
      const getReviewComment = vi.fn().mockImplementation(async (_p: number, id: number) => ({
        id,
        body: `fetched-${id}`,
        in_reply_to_id: id === 1 ? null : id - 1,
        user: { login: 'user' },
      }));
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue(windowComments),
        getReviewComment,
      });

      const result = await gatherReviewCommentThread(gh, 1, 5, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['fetched-1', 'c2', 'c3', 'c4', 'c5']);
      // Only the genuinely missing root is fetched by ID.
      expect(getReviewComment).toHaveBeenCalledTimes(1);
      expect(getReviewComment).toHaveBeenCalledWith(1, 1, undefined);
    });

    it('falls back to the first chain comment carrying a path when the root lacks one', async () => {
      const comments = [
        { id: 1, body: 'root (thread-level)', in_reply_to_id: null, user: { login: 'user' } },
        {
          id: 2,
          body: 'trigger',
          in_reply_to_id: 1,
          path: 'src/a.ts',
          diff_hunk: 'hunk',
          user: { login: 'user' },
        },
      ];
      const gh = makeAdapter({ listReviewComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherReviewCommentThread(gh, 1, 2, MENTION);

      expect(result.filePath).toBe('src/a.ts');
      expect(result.diffHunk).toBe('hunk');
    });

    it('preserves diff_hunk from directly-fetched chain comments', async () => {
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: null,
        path: 'src/a.ts',
        diff_hunk: 'hunk-from-fetch',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([]),
        getReviewComment: vi
          .fn()
          .mockImplementation(async (_p: number, id: number) =>
            id === 3
              ? { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } }
              : root,
          ),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.diffHunk).toBe('hunk-from-fetch');
      expect(result.filePath).toBe('src/a.ts');
    });

    it('returns the partially gathered chain when an ancestor fetch fails', async () => {
      // Trigger is outside the window; its root is direct-fetched, then the
      // root's own ancestor fetch fails — the gathered chain must survive.
      const root = {
        id: 1,
        body: 'root',
        in_reply_to_id: 0,
        path: 'src/a.ts',
        user: { login: 'user' },
      };
      const gh = makeAdapter({
        listReviewComments: vi.fn().mockResolvedValue([]),
        getReviewComment: vi.fn().mockImplementation(async (_p: number, id: number) => {
          if (id === 3)
            return { id: 3, body: 'trigger', in_reply_to_id: 1, user: { login: 'user' } };
          if (id === 1) return root;
          throw new Error('GitHub API 404');
        }),
      });

      const result = await gatherReviewCommentThread(gh, 1, 3, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['root', 'trigger']);
    });
  });

  describe('gatherIssueCommentThread', () => {
    it('takes up to the configured window of preceding comments plus the trigger, in chronological order', async () => {
      // Ascending window (direction: 'asc') — the ordering GitHub's issue
      // comments endpoint actually returns (it ignores sort/direction).
      const comments = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        body: `c${i + 1}`,
        user: { login: 'user' },
      }));
      const gh = makeAdapter({ listComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherIssueCommentThread(gh, 1, 10, MENTION, 5);

      // trigger at idx 9; preceding 5 (older) are ids 5..9, already chronological.
      expect(result.thread.map((m) => m.body)).toEqual(['c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
      expect(gh.listComments).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ perPage: 100, maxPages: 5, direction: 'asc' }),
        undefined,
      );
      // The early-exit predicate must be attached so pagination stops once the
      // accumulated ascending comments reach the triggering comment.
      const options = (gh.listComments as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
        stopWhen?: (items: Array<{ id: number }>) => boolean;
      };
      expect(typeof options.stopWhen).toBe('function');
      expect(options.stopWhen?.([{ id: 9 }, { id: 10 }])).toBe(true);
      expect(options.stopWhen?.([{ id: 8 }, { id: 9 }])).toBe(false);
    });

    it('accumulates more than 5 preceding comments when the window is larger, so long threads can engage the sliding window', async () => {
      const comments = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        body: `c${i + 1}`,
        user: { login: 'user' },
      }));
      const gh = makeAdapter({ listComments: vi.fn().mockResolvedValue(comments) });

      const result = await gatherIssueCommentThread(gh, 1, 30, MENTION, 20);

      // trigger at idx 29; 20 preceding comments (ids 10..30) are accumulated.
      expect(result.thread).toHaveLength(21);
      expect(result.thread[0].body).toBe('c10');
      expect(result.thread[result.thread.length - 1].body).toBe('c30');
    });

    it('fetches the trigger by id when it is older than the window', async () => {
      const gh = makeAdapter({
        listComments: vi
          .fn()
          .mockResolvedValue([{ id: 9, body: 'recent', user: { login: 'user' } }]),
        getIssueComment: vi
          .fn()
          .mockResolvedValue({ id: 1, body: 'old trigger', user: { login: 'user' } }),
      });

      const result = await gatherIssueCommentThread(gh, 1, 1, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['old trigger']);
    });

    it('falls back to recent window comments when the by-id trigger fetch fails', async () => {
      const gh = makeAdapter({
        listComments: vi.fn().mockResolvedValue([
          { id: 8, body: 'c8', user: { login: 'user' } },
          { id: 9, body: 'c9', user: { login: 'user' } },
        ]),
        getIssueComment: vi.fn().mockRejectedValue(new Error('GitHub API 404')),
      });

      const result = await gatherIssueCommentThread(gh, 1, 1, MENTION);

      expect(result.thread.map((m) => m.body)).toEqual(['c8', 'c9']);
    });
  });
});

describe('extractAskQuestion', () => {
  it('extracts the question from an /ask line', () => {
    expect(extractAskQuestion('/ask why is this null?')).toBe('why is this null?');
  });

  it('supports the /oc ask prefix', () => {
    expect(extractAskQuestion('/oc ask what does this do?')).toBe('what does this do?');
  });

  it('keeps continuation lines of a multi-line question', () => {
    const body = '/ask why does this fail\nand how do I fix it?';
    expect(extractAskQuestion(body)).toBe('why does this fail\nand how do I fix it?');
  });

  it('supports a question on the line below a bare /ask', () => {
    const body = '/ask\nwhy does this fail?';
    expect(extractAskQuestion(body)).toBe('why does this fail?');
  });

  it('stops the question at a blank line', () => {
    const body = '/ask why does this fail\n\np.s. unrelated note';
    expect(extractAskQuestion(body)).toBe('why does this fail');
  });

  it('returns null for a bare /ask with no content', () => {
    expect(extractAskQuestion('/ask')).toBeNull();
    expect(extractAskQuestion('/ask   ')).toBeNull();
  });

  it('rejects /ask lookalikes such as /ask-me-anything', () => {
    expect(extractAskQuestion('/ask-me-anything why?')).toBeNull();
  });

  it('returns null when the body is not an /ask command', () => {
    expect(extractAskQuestion('just a comment')).toBeNull();
  });
});

describe('persistSessionState', () => {
  function makeFakeStore() {
    const calls = {
      exchanges: [] as Array<{
        sessionId: string;
        patch: Record<string, unknown>;
        userTurn?: Record<string, unknown>;
        assistantTurn?: Record<string, unknown>;
      }>,
    };
    const store = {
      saveConversationExchange: vi.fn(async (input: unknown) => {
        calls.exchanges.push(input as (typeof calls)['exchanges'][number]);
      }),
    } as unknown as LearningStore;
    return { store, calls };
  }

  it('persists the patch and both turns in a single exchange', async () => {
    const { store, calls } = makeFakeStore();
    const manager = new ConversationStateManager();
    const state = manager.getOrCreateState('org/repo/42/issue');
    manager.updateState(state);
    manager.updateState(state);

    await persistSessionState(
      store,
      'org/repo/42/issue',
      1,
      manager,
      { role: 'user', body: 'question', author: 'alice' },
      'answer',
      undefined,
    );

    expect(calls.exchanges).toHaveLength(1);
    expect(calls.exchanges[0].patch.turnCount).toBe(2);
    expect(calls.exchanges[0].userTurn?.turnNumber).toBe(3);
    expect(calls.exchanges[0].assistantTurn?.turnNumber).toBe(4);
    expect(store.saveConversationExchange).toHaveBeenCalledTimes(1);
  });

  it('falls back to priorTurnCount when no state manager is present', async () => {
    const { calls } = makeFakeStore();
    const store = {
      saveConversationExchange: vi.fn(async (input: unknown) => {
        calls.exchanges.push(input as (typeof calls)['exchanges'][number]);
      }),
    } as unknown as LearningStore;

    await persistSessionState(
      store,
      'org/repo/42/issue',
      0,
      undefined,
      { role: 'user', body: 'question', author: 'alice' },
      'answer',
      undefined,
    );

    expect(calls.exchanges[0].patch.turnCount).toBe(1);
    expect(calls.exchanges[0].userTurn?.turnNumber).toBe(1);
    expect(calls.exchanges[0].assistantTurn?.turnNumber).toBe(2);
  });

  it('records the first code reference on both rows', async () => {
    const { store, calls } = makeFakeStore();
    const ref = { file: 'src/foo.ts', line: 42 };

    await persistSessionState(
      store,
      'org/repo/42/issue',
      0,
      undefined,
      { role: 'user', body: 'question', author: 'alice' },
      'answer',
      ref,
    );

    expect(calls.exchanges[0].patch.turnCount).toBe(1);
    expect(calls.exchanges[0].userTurn?.fileRef).toBe('src/foo.ts');
    expect(calls.exchanges[0].userTurn?.lineRef).toBe(42);
    expect(calls.exchanges[0].assistantTurn?.fileRef).toBe('src/foo.ts');
  });
});

describe('handleConversation repo allowlist gate', () => {
  it('returns early for denied repos without spending LLM/API budget', async () => {
    // Gate runs before adapter construction / PR fetch / LLM, so this must
    // resolve with no network even though no mocks are installed.
    await expect(
      handleConversation(
        ...makeHandleConversationArgs({
          repo: 'o/r',
          repoFilter: { allowed: new Set<string>(), denied: new Set(['o/r']) },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('error log sanitization', () => {
  const fakeToken = 'ghp_fakeTokenForRedactionTest1234567890abcdef';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts tokens from the getMR failure error log', async () => {
    mockGetMR.mockRejectedValue(
      new Error(`GitHub API request failed: Bad credentials for ${fakeToken}`),
    );

    const errSpy = vi.spyOn(Logger.prototype, 'error');

    await handleConversation(...makeHandleConversationArgs());

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(logged).toContain('Bad credentials');
  });

  it('redacts tokens from the outer conversation-failure error log', async () => {
    mockGetMR.mockResolvedValue({ number: 42, changedFiles: [] });
    mockListComments.mockResolvedValue([{ id: 1, body: 'hello', user: { login: 'alice' } }]);
    mockPostComment.mockResolvedValue(undefined);
    mockEngineCleanup.mockResolvedValue(undefined);
    mockRunConversation.mockRejectedValue(
      new Error(`LLM request failed: invalid key ${fakeToken}`),
    );

    const errSpy = vi.spyOn(Logger.prototype, 'error');

    await handleConversation(
      ...makeHandleConversationArgs({ config: { ...DEFAULT_CONFIG, platform: 'github' } }),
    );

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(logged).toContain('LLM request failed');
  });

  it('redacts tokens from the session-restore failure warn log', async () => {
    mockGetMR.mockResolvedValue({ number: 42, changedFiles: [] });
    mockListComments.mockResolvedValue([{ id: 1, body: 'hello', user: { login: 'alice' } }]);
    mockRunConversation.mockResolvedValue('ok');
    mockPostComment.mockResolvedValue(undefined);
    mockEngineCleanup.mockResolvedValue(undefined);
    const learningStore = {
      getOrCreateConversationSession: vi
        .fn()
        .mockRejectedValue(new Error(`session read failed: ${fakeToken}`)),
      saveConversationExchange: vi.fn().mockResolvedValue(undefined),
    } as unknown as LearningStore;

    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    await handleConversation(
      ...makeHandleConversationArgs({
        config: { ...DEFAULT_CONFIG, platform: 'github' },
        learningStore,
        stateManager: new ConversationStateManager(),
      }),
    );

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(logged).toContain('Failed to restore conversation session');
  });

  it('redacts tokens from the gatherIssueCommentThread failure warn log', async () => {
    const gh = makeAdapter({
      listComments: vi.fn().mockRejectedValue(new Error(`GitHub API 500: ${fakeToken}`)),
    });

    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    const result = await gatherIssueCommentThread(gh, 1, 1, MENTION);

    expect(result.thread).toEqual([]);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(logged).toContain('Failed to gather issue comment thread');
  });

  it('redacts tokens from the getIssueComment fallback failure warn log', async () => {
    const gh = makeAdapter({
      listComments: vi.fn().mockResolvedValue([
        { id: 8, body: 'c8', user: { login: 'user' } },
        { id: 9, body: 'c9', user: { login: 'user' } },
      ]),
      getIssueComment: vi.fn().mockRejectedValue(new Error(`GitHub API 404: ${fakeToken}`)),
    });

    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    const result = await gatherIssueCommentThread(gh, 1, 1, MENTION);

    expect(result.thread.map((m) => m.body)).toEqual(['c8', 'c9']);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(logged).toContain('Failed to fetch trigger comment 1 by id');
  });

  it('redacts tokens from the persistSessionState failure warn log', async () => {
    const store = {
      saveConversationExchange: vi
        .fn()
        .mockRejectedValue(new Error(`sqlite write failed: ${fakeToken}`)),
    } as unknown as LearningStore;

    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    await persistSessionState(
      store,
      'org/repo/42/issue',
      0,
      undefined,
      { role: 'user', body: 'question', author: 'alice' },
      'answer',
      undefined,
    );

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(logged).toContain('Failed to persist conversation session state');
  });
});
