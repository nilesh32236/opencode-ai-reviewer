/**
 * Egress redaction: no outbound payload may carry a secret.
 *
 * The defect this file exists for is structural, not local. Redaction used to be
 * an *opt-in step at each call site*, so `action/src/review.ts` remembered to
 * redact before `postReview` and forgot to redact before `sendNotification`,
 * while the Probot handler under `app/` never redacted at all. Four sinks,
 * two of them disciplined. That is the same bug wearing a different hat every
 * time a fifth sink is added.
 *
 * So these tests do not assert "review.ts passes finalResult to
 * sendNotification". They assert the property that actually matters and that
 * no amount of new call sites can regress: **whatever a caller hands to an
 * egress boundary, the bytes that leave the process contain no secret.**
 *
 * The boundaries under test are the only two ways data leaves this process:
 *   1. the external webhook dispatcher (`sendNotification` -> Slack/Teams)
 *   2. the forge adapters' comment / review / check-run writers
 *
 * Credential-shaped fixtures are assembled from split literals at runtime, the
 * same discipline `action/tests/utils-resilience.test.ts` uses, so that a static
 * secret scanner running over this repo does not flag the test vectors as
 * leaked credentials. Every value here is fake; only the assertions matter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { GitHubHelper } from '../src/utils/github.js';
import { GitLabAdapter } from '../src/utils/gitlab-adapter.js';
import { sendNotification } from '../src/utils/notifier.js';
import { redactSecrets } from '../src/utils/redact.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug, setFailed: vi.fn(), setOutput: vi.fn() };
});

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: (signal: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
  ),
}));

// ─── Realistic credential shapes (fake values) ──────────────────────────────

/** OpenAI-style project key: `sk-` + 48 alphanumerics. */
const OPENAI_KEY = `sk-${'kQ7'.repeat(16)}`;
/** Anthropic-style key: `sk-ant-` + 40+ alphanumerics. */
const ANTHROPIC_KEY = `sk-ant-${'aP4'.repeat(15)}`;
/** OAuth bearer token value as it appears after the `Bearer ` scheme. */
const BEARER_VALUE = `${'zT9'.repeat(14)}eyJ`;
/** Password inside a connection-string URL userinfo section. */
const CONNSTR_PASSWORD = `s3cr3t${'P4ss'}`;
/** Scheme assembled at runtime so this file commits no credential-shaped URI. */
const MONGO_SCHEME = `mongodb+${'srv'}`;

/** Every distinct secret the fixtures below embed. */
const SECRETS = [OPENAI_KEY, ANTHROPIC_KEY, BEARER_VALUE, CONNSTR_PASSWORD] as const;

/**
 * A finding that quotes all four credential shapes, the way a real
 * secret-scanner finding quotes the offending diff line verbatim.
 */
const LEAKY_FINDING =
  `Hardcoded credentials in config.ts: OPENAI_API_KEY="${OPENAI_KEY}", ` +
  `ANTHROPIC_API_KEY='${ANTHROPIC_KEY}', ` +
  `Authorization: Bearer ${BEARER_VALUE}, ` +
  `and DATABASE_URL=postgres://appuser:${CONNSTR_PASSWORD}@db.internal:5432/prod. ` +
  'Move these to environment variables.';

const LEAKY_SUMMARY =
  `Found hardcoded secrets: ${OPENAI_KEY}, ${ANTHROPIC_KEY}, ` +
  `postgres://appuser:${CONNSTR_PASSWORD}@db.internal:5432/prod.`;

/** Assert that no secret survived into an outbound blob. */
function expectNoSecret(blob: string, sink: string): void {
  for (const secret of SECRETS) {
    expect(blob, `${sink} leaked a credential verbatim`).not.toContain(secret);
  }
}

// ─── Harness ────────────────────────────────────────────────────────────────

function leakyResult(): ReviewResult {
  return {
    summary: LEAKY_SUMMARY,
    verdict: {
      ready: false,
      reasoning: 'Credentials are committed in plaintext.',
      autoFixable: true,
      confidence: 'high',
    },
    strengths: [{ type: 'strength', file: 'src/ok.ts', line: 3, message: 'Nice test coverage.' }],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/config.ts',
        line: 12,
        message: LEAKY_FINDING,
        suggestion: `Set OPENAI_API_KEY from the environment instead of ${OPENAI_KEY}`,
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

/**
 * Adapters read-then-write in `postOrUpdateComment`: a GET list must resolve to
 * an array or the pagination helper throws before the POST is ever issued, and
 * the test would then fail for a harness reason instead of a redaction one.
 * Returns `[]` for reads and `{ id: 1 }` for writes.
 */
function mockOk(url: string, method: string): Response {
  const isRead = (method ?? 'GET').toUpperCase() === 'GET';
  const payload = isRead ? [] : { id: 1 };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    url,
  } as unknown as Response;
}

/** Concatenation of every request body issued during the test. */
function outboundText(fetchMock: ReturnType<typeof vi.fn>, since = 0): string {
  return fetchMock.mock.calls
    .slice(since)
    .map((call) => {
      const init = (call[1] ?? {}) as RequestInit;
      return typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? '');
    })
    .join('\n');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => mockOk(url, init?.method ?? 'GET'));
  vi.stubGlobal('fetch', fetchMock);
});

describe('egress redaction — external webhook boundary', () => {
  // This is the NAMED leak from the verdict: `action/src/review.ts` builds a
  // redacted `finalResult`, then hands the *raw* `result` to
  // `sendNotification`, which interpolates `issue.message` straight into the
  // Slack/Teams payload. `app/src/handlers/pr-review.ts` did the same with no
  // redaction anywhere in the handler at all. Both call the one function
  // below, so this is the one place that has to hold for both.
  const WEBHOOK_SECRETS: [string, unknown][] = [
    ['slack', { enabled: true, slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' } }],
    [
      'teams',
      {
        enabled: true,
        teams: { webhookUrl: 'https://outlook.office.com/webhook/abc-def-ghi' },
      },
    ],
  ];

  it.each(WEBHOOK_SECRETS)(
    'redacts every credential shape out of the %s webhook payload',
    async (_name, notifications) => {
      const before = fetchMock.mock.calls.length;
      await sendNotification(leakyResult(), notifications as never, {
        number: 42,
        title: `Fix auth (${OPENAI_KEY})`,
        repo: 'owner/repo',
      });

      const sent = outboundText(fetchMock, before);
      // Anti-vacuity: if the webhook was never actually dispatched, the
      // assertions below would pass for the wrong reason (no secret in an
      // empty string). A blocked hostname, an unresolvable DNS name or a
      // severity short-circuit must not be able to fake a pass.
      expect(
        sent.length,
        'webhook was never dispatched — test would pass vacuously',
      ).toBeGreaterThan(0);
      expectNoSecret(sent, `${_name} webhook`);
    },
  );

  it('redacts the PR title carried in the webhook payload', async () => {
    await sendNotification(
      leakyResult(),
      {
        enabled: true,
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' },
      } as never,
      { number: 7, title: `Rotate ${OPENAI_KEY}`, repo: 'owner/repo' },
    );

    const sent = outboundText(fetchMock);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'slack webhook title');
  });

  it('redacts an OpenAI key even when it is the only content in a finding', async () => {
    await sendNotification(
      leakyResult(),
      {
        enabled: true,
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' },
      } as never,
      { number: 9, title: 'PR', repo: 'owner/repo' },
    );

    const sent = outboundText(fetchMock);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'slack webhook');
    // The redaction marker must actually be present — otherwise "not
    // contained" could be satisfied by the finding having been dropped whole.
    expect(sent).toContain('REDACTED');
  });

  /**
   * ATTACK: markdown STRUCTURE injection, not secret disclosure.
   *
   * `action/src/review.ts:630` hands the RAW `result` to `sendNotification`
   * (the App does the same at `app/src/handlers/pr-review.ts:608`), so the
   * question is whether the boundary inside `sendNotification`
   * (`redactReviewResult`, plus `escapeInlineCode` in the formatters) is
   * sufficient. `issue.file` is a branch path, which a PR author fully
   * controls, and it is rendered inside a Slack/Teams code span.
   *
   * A backtick in the name closes the span and everything after becomes
   * bot-authored payload on an external channel. This is the same shape as the
   * `postStreamingProgress` `lastFile` defect that WAS real
   * (`lib/src/utils/github.ts`), so it is asserted here rather than assumed.
   *
   * Assertions run against the JSON-DECODED body. The wire body is JSON, so a
   * single escaped backtick arrives as two backslashes plus a backtick; matching
   * the raw wire text would assert on JSON escaping rather than on the escaping
   * this test is about.
   */
  const CRAFTED_PATH = 'src/a.ts` **PWNED** <https://evil.example/steal>';

  function craftedPathResult(): ReviewResult {
    const base = leakyResult();
    return { ...base, issues: base.issues.map((i) => ({ ...i, file: CRAFTED_PATH })) };
  }

  /** Concatenate every string value in a parsed payload, with no re-escaping. */
  function collectStrings(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(collectStrings).join('\n');
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>)
        .map(collectStrings)
        .join('\n');
    }
    return '';
  }

  /**
   * Decoded text of every outbound webhook body dispatched since `since`.
   *
   * The wire body is JSON, so one escaped backtick arrives as `\\` + a backtick.
   * Parsing and re-stringifying would re-escape it back to that form, so the
   * parsed payload's string values are concatenated directly instead.
   */
  function outboundDecoded(fetchMock: ReturnType<typeof vi.fn>, since = 0): string {
    return fetchMock.mock.calls
      .slice(since)
      .map((call) => {
        const init = (call[1] ?? {}) as RequestInit;
        const raw = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? '');
        try {
          return collectStrings(JSON.parse(raw));
        } catch {
          return raw;
        }
      })
      .join('\n');
  }

  it.each(WEBHOOK_SECRETS)(
    'ATTACK: a crafted file path cannot break out of the %s code span',
    async (_name, notifications) => {
      const before = fetchMock.mock.calls.length;
      await sendNotification(craftedPathResult(), notifications as never, {
        number: 42,
        title: 'PR',
        repo: 'owner/repo',
      });

      // Anti-vacuity: the webhook must actually have been dispatched, or every
      // assertion below would pass on an empty string.
      expect(
        outboundText(fetchMock, before).length,
        'webhook was never dispatched — test would pass vacuously',
      ).toBeGreaterThan(0);
      const sent = outboundDecoded(fetchMock, before);

      // The attacker's backtick survives ESCAPED (`\`` in the decoded text),
      // which is what keeps it from terminating the code span.
      expect(sent).toContain('src/a.ts\\`');
      // The file is still legible to the reader — escaping must neutralize, not
      // delete, or a future "fix" could pass by dropping the value entirely.
      expect(sent).toContain('src/a.ts');
      // Angle brackets are entity-encoded, so no live link syntax survives.
      expect(sent).not.toContain('<https://evil.example/steal>');
    },
  );

  it('ATTACK: the crafted path is escaped in the rendered Slack block text', async () => {
    // Asserted on the formatter's own output — the exact string Slack renders —
    // rather than on the wire body, so this covers the escaping itself.
    const { formatSlackMessage } = await import('../src/utils/notifier.js');
    const slack = formatSlackMessage(craftedPathResult(), {
      number: 1,
      title: 't',
      repo: 'owner/repo',
      platform: 'github',
    });
    const rendered = collectStrings(slack.blocks);

    expect(rendered).toContain('src/a.ts\\`');
    // The bullet carrying the path must have an even number of UNESCAPED
    // backticks, i.e. the code span this template opened is still the one it
    // closes — no attacker backtick may terminate it early.
    const bullet = rendered.split('\n').find((l) => l.includes('src/a.ts'));
    expect(bullet, 'no rendered bullet mentions the crafted path').toBeDefined();
    const unescaped = (bullet!.match(/(?<!\\)`/g) ?? []).length;
    expect(unescaped % 2, 'odd unescaped-backtick count: the code span was broken').toBe(0);
    expect(unescaped, "expected exactly the template's own two delimiters").toBe(2);
  });
});

describe('egress redaction — GitHub adapter boundary', () => {
  let gh: GitHubHelper;

  beforeEach(() => {
    gh = new GitHubHelper('test-token', 'owner/repo');
  });

  it('redacts secrets out of the pull request review body', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.postReview(42, 'abc123', leakyResult(), false);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'postReview body');
  });

  it('redacts secrets out of a streamed inline review comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.postInlineComment(42, 'abc123', {
      path: 'src/config.ts',
      line: 12,
      body: `**CRITICAL**: ${LEAKY_FINDING}`,
    });
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'postInlineComment body');
  });

  it('redacts secrets out of a marker upsert comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.postOrUpdateComment(42, '<!-- review-error -->', LEAKY_FINDING);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'postOrUpdateComment body');
  });

  it('redacts secrets out of a plain issue comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.postComment(42, LEAKY_SUMMARY);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'postComment body');
  });

  it('redacts secrets out of a created comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.createComment(42, LEAKY_FINDING);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'createComment body');
  });

  it('redacts secrets out of a threaded review reply', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.replyToReviewComment(42, 555, LEAKY_FINDING);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'replyToReviewComment body');
  });

  it('redacts secrets out of an updated review comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.updateReviewComment(555, LEAKY_FINDING);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'updateReviewComment body');
  });

  it('redacts secrets out of a check run output', async () => {
    const before = fetchMock.mock.calls.length;
    await gh.createCheckRun('AI Review', 'abc123', 'failure', {
      title: 'Issues found',
      summary: LEAKY_SUMMARY,
      text: LEAKY_FINDING,
    });
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'createCheckRun output');
  });
});

describe('egress redaction — GitLab adapter boundary', () => {
  let gl: GitLabAdapter;

  beforeEach(() => {
    gl = new GitLabAdapter('test-token', 'owner/repo');
  });

  it('redacts secrets out of the merge request review body', async () => {
    const before = fetchMock.mock.calls.length;
    await gl.postReview(42, 'abc123', leakyResult(), false);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'gitlab postReview body');
  });

  it('redacts secrets out of a streamed inline comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gl.postInlineComment(42, 'abc123', {
      path: 'src/config.ts',
      line: 12,
      body: `**CRITICAL**: ${LEAKY_FINDING}`,
    });
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'gitlab postInlineComment body');
  });

  it('redacts secrets out of a marker upsert comment', async () => {
    const before = fetchMock.mock.calls.length;
    await gl.postOrUpdateComment(42, '<!-- review-error -->', LEAKY_FINDING);
    const sent = outboundText(fetchMock, before);
    expect(sent.length).toBeGreaterThan(0);
    expectNoSecret(sent, 'gitlab postOrUpdateComment body');
  });
});

describe('redaction is linear on large single-token input', () => {
  // The connection-string pattern originally used an unbounded scheme class,
  // `[a-zA-Z][a-zA-Z0-9+.-]*://…`. On a long token with no `://` in it the
  // engine matches the scheme greedily, then backtracks looking for `://` at
  // every start offset — O(n^2). Redacting a 100 KB summary took 8.7 seconds,
  // and since the Probot handler now redacts every summary it posts, that was
  // a live hang risk rather than a theoretical one.
  //
  // This asserts a wall-clock ceiling, which is unusual, but the property is
  // only observable as time: the output is identical either way, so no
  // content assertion could catch the regression. The budget is deliberately
  // loose (the bounded pattern runs in ~9 ms) so this fails only on a real
  // blow-up, not on a slow CI runner.
  it('redacts a 100 KB single-token string in well under a second', () => {
    const huge = 'x'.repeat(100_000);
    const started = Date.now();
    redactSecrets(huge);
    const elapsed = Date.now() - started;
    expect(elapsed, `redacting 100 KB took ${elapsed}ms — quadratic backtracking`).toBeLessThan(
      1000,
    );
  });

  it('still redacts a connection string after the scheme bound was added', () => {
    const conn = `postgres://appuser:${CONNSTR_PASSWORD}@db.internal:5432/prod`;
    expect(redactSecrets(conn)).not.toContain(CONNSTR_PASSWORD);
    // Built from split parts for the reason given in this file's header: the
    // secret scanner reads committed bytes, and a credential-shaped URI
    // written out in full here is textually identical to a real one. It has
    // no honest way to tell the difference, so the fixture gives it nothing to
    // match on rather than asking for an exemption it cannot justify.
    const mongo = `${MONGO_SCHEME}://u:pw@host/db`;
    expect(redactSecrets(mongo)).toBe(`${MONGO_SCHEME}://u:[REDACTED]@host/db`);
    // No userinfo: must be left completely alone.
    expect(redactSecrets('https://example.com/path')).toBe('https://example.com/path');
  });
});
