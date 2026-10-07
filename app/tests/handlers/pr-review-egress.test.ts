/**
 * Probot-path egress redaction, end to end.
 *
 * `app/src/handlers/pr-review.ts` never called `redactSecrets` at all — the
 * verdict called it out, and it was right. But the *handler* is not the
 * boundary. The handler hands its result to the platform adapter and to
 * `sendNotification`, and those are where bytes leave the process. Redaction
 * now lives there, so this file deliberately runs the REAL adapters (only the
 * LLM engine is mocked) over a mocked `fetch`, and asserts on the actual HTTP
 * request bodies.
 *
 * The sibling suite `app/tests/handlers/pr-review.test.ts` replaces the
 * adapters with mocks. That is the right scope for "did the handler post the
 * review", and it is also precisely why this defect survived a review: with
 * the egress mocked, no assertion in that file could ever observe a leak.
 */
import type { AgentConfig, ReviewResult } from '@opencode-pr-agent/lib';
import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReviewPR, mockCleanup } = vi.hoisted(() => ({
  mockReviewPR: vi.fn(),
  mockCleanup: vi.fn(),
}));

// Only the engine is replaced. GitHubHelper / createPlatformAdapter /
// sendNotification stay REAL so the test exercises the actual egress boundary.
vi.mock('@opencode-pr-agent/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencode-pr-agent/lib')>();
  return {
    ...actual,
    ReviewEngine: class {
      reviewPR = mockReviewPR;
      cleanup = mockCleanup;
      getLastTelemetry = () => undefined;
    },
  };
});

vi.mock('../../src/utils/config.js', () => ({
  mergeRepoConfig: (c: AgentConfig) => c,
}));

vi.mock('../../src/handlers/autofix.js', () => ({
  handleAutofixLoop: vi.fn(),
}));

import { handlePRReview } from '../../src/handlers/pr-review.js';

// Credential-shaped fixtures assembled from split literals at runtime, so a
// static secret scanner does not flag this file. All values are fake.
const OPENAI_KEY = `sk-${'kQ7'.repeat(16)}`;
const ANTHROPIC_KEY = `sk-ant-${'aP4'.repeat(15)}`;
const BEARER_VALUE = `${'zT9'.repeat(14)}eyJ`;
const CONNSTR_PASSWORD = `s3cr3t${'P4ss'}`;
const SECRETS = [OPENAI_KEY, ANTHROPIC_KEY, BEARER_VALUE, CONNSTR_PASSWORD] as const;

const LEAKY_FINDING =
  `Hardcoded credentials in config.ts: OPENAI_API_KEY="${OPENAI_KEY}", ` +
  `ANTHROPIC_API_KEY='${ANTHROPIC_KEY}', Authorization: Bearer ${BEARER_VALUE}, ` +
  `DATABASE_URL=postgres://appuser:${CONNSTR_PASSWORD}@db.internal:5432/prod.`;

const LEAKY_SUMMARY = `Committed credentials: ${OPENAI_KEY}, ${ANTHROPIC_KEY}.`;

function leakyResult(): ReviewResult {
  return {
    summary: LEAKY_SUMMARY,
    verdict: {
      ready: false,
      reasoning: 'Credentials are committed in plaintext.',
      autoFixable: false,
      confidence: 'high',
    },
    strengths: [],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/config.ts',
        line: 12,
        message: LEAKY_FINDING,
        suggestion: `Load it from the environment instead of ${OPENAI_KEY}`,
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

function config(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    platform: 'github',
    review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'critical' },
    notifications: { enabled: false },
  };
}

/**
 * URL-aware mock: the handler's very first call is `getMR`, which must return
 * a PR object or the handler bails out before posting anything (and the
 * assertions below would pass vacuously against an empty request log).
 * Everything else reads as an empty list and writes as `{ id: 1 }`.
 */
function mockResponse(url: string, method: string): Response {
  const upper = method.toUpperCase();
  let payload: unknown;
  if (upper !== 'GET') {
    payload = { id: 1 };
  } else if (/\/pulls\/42$/.test(url)) {
    // `getMR` reads `head.ref`, so a bare { number, headSha } is not enough:
    // the handler aborts before posting anything and the assertions below
    // would pass against a request log containing only reads.
    payload = {
      number: 42,
      headSha: 'abc123',
      head: { ref: 'feature/leaky', sha: 'abc123' },
      base: { ref: 'main', sha: 'base000' },
      labels: [],
      author: 'test-user',
      user: { login: 'test-user' },
      title: `Rotate ${OPENAI_KEY}`,
      body: '',
    };
  } else {
    payload = [];
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    url,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function outboundText(): string {
  return fetchMock.mock.calls
    .map((call) => {
      const init = (call[1] ?? {}) as RequestInit;
      return typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? '');
    })
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    mockResponse(url, init?.method ?? 'GET'),
  );
  vi.stubGlobal('fetch', fetchMock);
  mockReviewPR.mockResolvedValue(leakyResult());
  mockCleanup.mockResolvedValue(undefined);
});

describe('Probot review path never ships a credential', () => {
  it('redacts every outbound HTTP body the handler produces', async () => {
    await handlePRReview(42, 'owner/repo', 'test-token', config());

    const sent = outboundText();
    // Anti-vacuity: an empty string contains no secret. Prove the handler
    // actually reached the network before asserting anything about content.
    expect(
      sent.length,
      'handler issued no outbound request — test would pass vacuously',
    ).toBeGreaterThan(0);
    for (const secret of SECRETS) {
      expect(sent, 'Probot path leaked a credential to GitHub').not.toContain(secret);
    }
  });

  it('redacts the PR review body specifically', async () => {
    await handlePRReview(42, 'owner/repo', 'test-token', config());

    // The review body is the POST to /pulls/{n}/reviews.
    const reviewPost = fetchMock.mock.calls
      .map((call) => ({
        url: String(call[0]),
        init: (call[1] ?? {}) as RequestInit,
      }))
      .find((c) => c.url.includes('/pulls/42/reviews'));
    expect(reviewPost, 'review body was never posted').toBeDefined();
    for (const secret of SECRETS) {
      expect(String(reviewPost?.init.body)).not.toContain(secret);
    }
  });

  it('redacts the streamed inline comment specifically', async () => {
    await handlePRReview(
      42,
      'owner/repo',
      'test-token',
      config({
        review: { ...DEFAULT_CONFIG.review, failOnSeverity: 'critical', streamComments: true },
      }),
    );

    const sent = outboundText();
    expect(sent.length).toBeGreaterThan(0);
    for (const secret of SECRETS) {
      expect(sent, 'streamed inline comment leaked a credential').not.toContain(secret);
    }
  });

  it('redacts the check run output specifically', async () => {
    await handlePRReview(42, 'owner/repo', 'test-token', config());

    const checkRun = fetchMock.mock.calls
      .map((call) => ({
        url: String(call[0]),
        init: (call[1] ?? {}) as RequestInit,
      }))
      .find((c) => c.url.endsWith('/check-runs'));
    expect(checkRun, 'check run was never posted').toBeDefined();
    for (const secret of SECRETS) {
      expect(String(checkRun?.init.body)).not.toContain(secret);
    }
  });
});
