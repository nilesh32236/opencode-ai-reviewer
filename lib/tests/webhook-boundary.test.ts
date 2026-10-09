/**
 * Webhook egress boundary: redirect following and Slack markup injection.
 *
 * NOTE ON SCOPE. The verdict's executive summary claimed the Slack/Teams
 * webhook still ships an unredacted payload. That claim does NOT reproduce on
 * this head: `sendNotification` redacts the result and the PR title on entry
 * and formats every outbound payload from the redacted copy. A direct probe of
 * the bytes handed to `fetch` shows `[REDACTED_OPENAI_KEY]` and
 * `postgres://u:[REDACTED]@db/x`. The call site at `action/src/review.ts:630`
 * does pass the raw `result`, but that is now harmless — redaction happens at
 * the boundary, which is the whole point of the earlier fix.
 *
 * These tests cover the two webhook-boundary defects the verdict's own findings
 * list cites at this boundary, both of which a PR author can influence through
 * `.opencode-reviewer.yml`:
 *
 *  1. `postToWebhook` omits `redirect`, so `fetch` follows a 3xx. Both guards
 *     immediately above the call — https-only and DNS-rebinding — validate the
 *     ORIGINAL url only. A configured webhook host that 302s to
 *     `http://169.254.169.254/` walks straight past both, and the redirected
 *     request may be cleartext, defeating the rationale in the guard's comment.
 *  2. `findingBullet` interpolates `issue.file` into a Slack backtick span
 *     unescaped, while `findingBulletTeams` escapes the identical value. A
 *     crafted path closes the code span and injects a clickable `<url|label>`
 *     into the one channel the operator trusts for review verdicts.
 *
 * Every test is written as an attack a hostile PR author could submit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/types/index.js';
import { formatSlackMessage, postToWebhook, sendNotification } from '../src/utils/notifier.js';

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: (s: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
  ),
}));

function okResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

describe('webhook egress refuses to follow redirects', () => {
  it('never follows a redirect to an internal address', async () => {
    // The attack: an operator- or PR-configured webhook host that answers 302
    // with a Location pointing at the cloud metadata service.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue(''),
    } as unknown as Response);

    await postToWebhook('https://hooks.slack.com/services/T/B/S', { blocks: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    // `redirect: 'manual'` is the control: without it fetch follows Location
    // and both guards above are bypassed for the redirected hop.
    expect(init.redirect, 'fetch may follow a redirect past the egress guards').toBe('manual');
  });

  it('does not silently succeed on a redirect response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://internal.corp/steal' }),
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue(''),
    } as unknown as Response);

    const ok = await postToWebhook('https://hooks.slack.com/services/T/B/S', { blocks: [] });
    expect(ok, 'a 3xx was reported as a delivered webhook').toBe(false);
  });
});

describe('Slack payload escapes the finding path', () => {
  const craftedPath = 'src/a` <http://evil.example|click me> `b.ts';

  function resultWithPath(): ReviewResult {
    return {
      summary: 'Summary.',
      verdict: { ready: true, reasoning: 'ok', autoFixable: false, confidence: 'high' },
      strengths: [],
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: craftedPath,
          line: 12,
          message: 'Something is wrong here.',
        },
      ],
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    };
  }

  it('neutralises a backtick that would close the code span', () => {
    const payload = formatSlackMessage(resultWithPath(), {
      number: 42,
      title: 'PR',
      repo: 'o/r',
    });
    const text = JSON.stringify(payload);
    // A raw, unescaped backtick in the path lets the author close the span and
    // start live mrkdwn — including a clickable link — inside the channel the
    // operator uses to judge "Ready to merge".
    expect(text).not.toContain('`src/a` ');
    expect(text).not.toMatch(/<http:\/\/evil\.example\|click me>/);
  });

  it('keeps the finding readable rather than dropping it', () => {
    // Anti-vacuity: a fix that deleted findings would pass the escaping test.
    const payload = formatSlackMessage(resultWithPath(), {
      number: 42,
      title: 'PR',
      repo: 'o/r',
    });
    expect(JSON.stringify(payload)).toContain('Something is wrong here');
    expect(JSON.stringify(payload)).toContain('src/a');
  });
});

describe('sendNotification egress remains redacted', () => {
  it('sends no credential on the wire', async () => {
    const OPENAI_KEY = `sk-${'kQ7'.repeat(16)}`;
    const CONN_PW = `s3cr3t${'P4ss'}`;
    const result: ReviewResult = {
      summary: `Leak ${OPENAI_KEY} postgres://u:${CONN_PW}@db/x`,
      verdict: { ready: false, reasoning: OPENAI_KEY, autoFixable: false, confidence: 'low' },
      strengths: [],
      issues: [
        {
          type: 'issue',
          severity: 'critical',
          file: 'src/c.ts',
          line: 3,
          message: `hardcoded ${OPENAI_KEY}`,
        },
      ],
      stats: { total: 1, critical: 1, important: 0, minor: 0 },
    };
    await sendNotification(
      result,
      { enabled: true, slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' } } as never,
      { number: 5, title: `Rotate ${OPENAI_KEY}`, repo: 'o/r' },
      { env: { OPENCODE_ALLOW_CONFIG_WEBHOOK: '1' } as NodeJS.ProcessEnv },
    );
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body ?? '');
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain(OPENAI_KEY);
    expect(body).not.toContain(CONN_PW);
  });
});
