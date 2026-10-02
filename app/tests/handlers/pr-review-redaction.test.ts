/**
 * Probot handler-layer redaction.
 *
 * `lib/tests/egress-redaction.test.ts` and `pr-review-egress.test.ts` drive the
 * REAL adapters and assert that no credential reaches the wire. Those tests go
 * green when `lib/src/utils/{github,gitlab-adapter,notifier}.ts` redact at the
 * boundary — which means they cannot distinguish "the handler redacts" from
 * "the adapter caught it". That distinction is the whole question here, so this
 * suite mocks the adapter and asserts on what the HANDLER hands to each sink.
 *
 * Every test in this file therefore fails if `app/src/handlers/pr-review.ts`
 * regresses, regardless of what lib does. That is what makes it coverage
 * rather than a restatement of the boundary tests.
 *
 * Credential-shaped fixtures are assembled from split literals at runtime, the
 * discipline used across this repo's redaction tests, so a static secret
 * scanner does not flag this file. All values are fake.
 */
import type { AgentConfig, LearningStore, ReviewResult } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetMR,
  mockGetBotReviewThreads,
  mockPostOrUpdateComment,
  mockPostReview,
  mockPostInlineComment,
  mockPostStreamingProgress,
  mockCreateCheckRun,
  mockReviewPR,
  mockCleanup,
  mockMergeRepoConfig,
  mockSendNotification,
  mockRecordFindings,
} = vi.hoisted(() => ({
  mockGetMR: vi.fn(),
  mockGetBotReviewThreads: vi.fn(),
  mockPostOrUpdateComment: vi.fn(),
  mockPostReview: vi.fn(),
  mockPostInlineComment: vi.fn(),
  mockPostStreamingProgress: vi.fn(),
  mockCreateCheckRun: vi.fn(),
  mockReviewPR: vi.fn(),
  mockCleanup: vi.fn(),
  mockMergeRepoConfig: vi.fn(),
  mockSendNotification: vi.fn(),
  mockRecordFindings: vi.fn(),
}));

vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  // Only the EGRESS FUNCTIONS are replaced. `redactReviewResult` and
  // `redactSecrets` are deliberately left REAL — they are the unit under test.
  return {
    ...actual,
    sendNotification: mockSendNotification,
    GitHubHelper: class {
      getMR = mockGetMR;
      getBotReviewThreads = mockGetBotReviewThreads;
      postOrUpdateComment = mockPostOrUpdateComment;
      postReview = mockPostReview;
      postInlineComment = mockPostInlineComment;
      postStreamingProgress = mockPostStreamingProgress;
      createCheckRun = mockCreateCheckRun;
    },
    GitLabAdapter: class {},
    ReviewEngine: class {
      reviewPR = mockReviewPR;
      cleanup = mockCleanup;
      getLastTelemetry = () => undefined;
    },
    createPlatformAdapter: () => ({
      getMR: mockGetMR,
      getBotReviewThreads: mockGetBotReviewThreads,
      postOrUpdateComment: mockPostOrUpdateComment,
      postReview: mockPostReview,
      postInlineComment: mockPostInlineComment,
      postStreamingProgress: mockPostStreamingProgress,
      createCheckRun: mockCreateCheckRun,
    }),
  };
});

vi.mock('../../src/utils/config.js', () => ({ mergeRepoConfig: mockMergeRepoConfig }));
vi.mock('../../src/handlers/autofix.js', () => ({ handleAutofixLoop: vi.fn() }));

import { handlePRReview } from '../../src/handlers/pr-review.js';

const OPENAI_KEY = `sk-${'kQ7'.repeat(16)}`;
const ANTHROPIC_KEY = `sk-ant-${'aP4'.repeat(15)}`;
const BEARER_VALUE = `${'zT9'.repeat(14)}eyJ`;
const CONNSTR_PASSWORD = `s3cr3t${'P4ss'}`;
const SECRETS = [OPENAI_KEY, ANTHROPIC_KEY, BEARER_VALUE, CONNSTR_PASSWORD] as const;

const LEAKY_FINDING =
  `Hardcoded credentials: OPENAI_API_KEY="${OPENAI_KEY}", ` +
  `ANTHROPIC_API_KEY='${ANTHROPIC_KEY}', Authorization: Bearer ${BEARER_VALUE}, ` +
  `DATABASE_URL=postgres://appuser:${CONNSTR_PASSWORD}@db.internal:5432/prod.`;

const LEAKY_SUMMARY = `Committed credentials: ${OPENAI_KEY}, ${ANTHROPIC_KEY}.`;

function expectNoSecret(blob: unknown, sink: string): void {
  const text = typeof blob === 'string' ? blob : JSON.stringify(blob ?? '');
  for (const secret of SECRETS) {
    expect(text, `${sink} received a credential verbatim`).not.toContain(secret);
  }
}

function leakyResult(): ReviewResult {
  return {
    summary: LEAKY_SUMMARY,
    verdict: {
      ready: false,
      reasoning: `Credentials committed: ${OPENAI_KEY}`,
      autoFixable: false,
      confidence: 'high',
    },
    strengths: [{ type: 'strength', file: 'src/ok.ts', line: 1, message: 'Fine.' }],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/config.ts',
        line: 12,
        message: LEAKY_FINDING,
        suggestion: `Load from env instead of ${OPENAI_KEY}`,
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'critical' },
    notifications: { enabled: true, minSeverity: 'critical' },
    ...overrides,
  };
}

const fakeStore = { recordFindings: mockRecordFindings } as unknown as LearningStore;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMR.mockResolvedValue({
    number: 42,
    headSha: 'abc123',
    head: { ref: 'feature/leaky', sha: 'abc123' },
    base: { ref: 'main', sha: 'base000' },
    labels: [],
    author: 'test-user',
    user: { login: 'test-user' },
    title: 'Rotate credentials',
    body: '',
  });
  mockGetBotReviewThreads.mockResolvedValue([]);
  mockPostOrUpdateComment.mockResolvedValue({ action: 'created', commentId: 1 });
  mockPostReview.mockResolvedValue({ success: true, method: 'full', reviewId: 1 });
  mockPostInlineComment.mockResolvedValue({ commentId: 101 });
  mockPostStreamingProgress.mockResolvedValue(undefined);
  mockCreateCheckRun.mockResolvedValue({ id: 77 });
  mockSendNotification.mockResolvedValue(undefined);
  mockRecordFindings.mockResolvedValue([]);
  mockReviewPR.mockResolvedValue(leakyResult());
  mockCleanup.mockResolvedValue(undefined);
  mockMergeRepoConfig.mockImplementation((c: AgentConfig) => c);
});

describe('Probot handler redacts before every egress', () => {
  it('hands a redacted review body to postReview', async () => {
    await handlePRReview(42, 'owner/repo', 'tok', config());
    expect(mockPostReview).toHaveBeenCalled();
    expectNoSecret(mockPostReview.mock.calls.at(-1)?.[2], 'postReview');
  });

  it('hands a redacted result to sendNotification', async () => {
    await handlePRReview(42, 'owner/repo', 'tok', config());
    expect(mockSendNotification).toHaveBeenCalled();
    expectNoSecret(mockSendNotification.mock.calls.at(-1)?.[0], 'sendNotification');
  });

  it('hands a redacted output to createCheckRun', async () => {
    await handlePRReview(42, 'owner/repo', 'tok', config());
    expect(mockCreateCheckRun).toHaveBeenCalled();
    expectNoSecret(mockCreateCheckRun.mock.calls.at(-1)?.[3], 'createCheckRun');
  });

  it('hands a redacted body to the streamed inline comment', async () => {
    // The streamed path fires from inside `engine.reviewPR()` via the
    // onBatchComplete callback, so the mock has to invoke it — a plain
    // `mockResolvedValue` never streams and this assertion would be vacuous.
    mockReviewPR.mockImplementation(
      async (
        _pr: unknown,
        _it?: unknown,
        _pf?: unknown,
        _pe?: unknown,
        _tm?: unknown,
        _pf2?: unknown,
        _wd?: unknown,
        _phs?: unknown,
        _pbc?: unknown,
        onBatchComplete?: (
          batchIndex: number,
          totalBatches: number,
          batchResult: ReviewResult,
        ) => Promise<void>,
      ) => {
        if (onBatchComplete) await onBatchComplete(0, 1, leakyResult());
        return leakyResult();
      },
    );
    await handlePRReview(
      42,
      'owner/repo',
      'tok',
      config({
        review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'critical', streamComments: true },
      }),
    );
    expect(mockPostInlineComment).toHaveBeenCalled();
    expectNoSecret(mockPostInlineComment.mock.calls.at(-1)?.[2]?.body, 'postInlineComment');
  });

  it('persists only redacted findings to the learning store', async () => {
    // This sink never touches the platform adapter, so no egress guard can
    // cover it. It is the one the boundary-only fix genuinely left open.
    await handlePRReview(42, 'owner/repo', 'tok', config(), fakeStore);
    expect(mockRecordFindings).toHaveBeenCalled();
    expectNoSecret(mockRecordFindings.mock.calls.at(-1)?.[0], 'learningStore.recordFindings');
  });

  it('redacts the verdict reasoning too', async () => {
    await handlePRReview(42, 'owner/repo', 'tok', config());
    const posted = mockPostReview.mock.calls.at(-1)?.[2] as ReviewResult;
    expect(posted.verdict.reasoning).not.toContain(OPENAI_KEY);
  });

  it('preserves the fingerprint anchor, so dedup still matches across runs', async () => {
    // Redaction must not break the dedup key: file/line are what
    // partitionInlineCommentsForUpdate and the streamed filter match on.
    await handlePRReview(42, 'owner/repo', 'tok', config());
    const posted = mockPostReview.mock.calls.at(-1)?.[2] as ReviewResult;
    expect(posted.issues[0].file).toBe('src/config.ts');
    expect(posted.issues[0].line).toBe(12);
  });

  it('still delivers a redacted review, i.e. redaction is not a no-op that drops content', async () => {
    await handlePRReview(42, 'owner/repo', 'tok', config());
    const posted = mockPostReview.mock.calls.at(-1)?.[2] as ReviewResult;
    expect(posted.summary).toContain('Committed credentials');
    expect(posted.summary).toContain('REDACTED');
    expect(posted.issues).toHaveLength(1);
  });
});
