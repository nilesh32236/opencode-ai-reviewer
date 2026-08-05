import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewIssue, ReviewResult } from '../src/types/index.js';
import {
  defaultPrUrl,
  formatSlackMessage,
  formatTeamsMessage,
  getTopFindings,
  meetsSeverityThreshold,
  postToWebhook,
  resolveWebhookUrl,
  sendNotification,
} from '../src/utils/notifier.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug };
});

vi.mock('../src/utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRetryAndTimeout: vi.fn(async (fn: (signal: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
  ),
}));

function makeIssue(severity: ReviewIssue['severity'], message: string): ReviewIssue {
  return {
    type: 'issue',
    severity,
    file: 'src/a.ts',
    line: 12,
    message,
  };
}

function makeResult(issues: ReviewIssue[]): ReviewResult {
  return {
    summary: 'Summary text.',
    verdict: {
      ready: false,
      reasoning: 'Issues found that block merge.',
      autoFixable: true,
      confidence: 'high',
    },
    strengths: [],
    issues,
    stats: {
      total: issues.length,
      critical: issues.filter((i) => i.severity === 'critical').length,
      important: issues.filter((i) => i.severity === 'important').length,
      minor: issues.filter((i) => i.severity === 'minor').length,
    },
  };
}

const CONTEXT = { number: 42, title: 'Fix the thing', repo: 'owner/repo' };

function mockOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    text: vi.fn().mockResolvedValue('ok'),
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

describe('resolveWebhookUrl', () => {
  it('prefers the env override over the config file value', () => {
    expect(
      resolveWebhookUrl(
        'https://hooks.slack.com/services/T/B/S',
        'https://hooks.slack.com/services/T/B/SECRET',
      ),
    ).toBe('https://hooks.slack.com/services/T/B/SECRET');
  });

  it('falls back to the config file value when no env var is set', () => {
    expect(resolveWebhookUrl('https://hooks.slack.com/services/T/B/S', undefined)).toBe(
      'https://hooks.slack.com/services/T/B/S',
    );
  });

  it('returns undefined when neither source is configured', () => {
    expect(resolveWebhookUrl(undefined, undefined)).toBeUndefined();
  });
});

describe('meetsSeverityThreshold', () => {
  it('defaults to critical when no threshold is provided', () => {
    expect(meetsSeverityThreshold({ critical: 0, important: 1, minor: 0 })).toBe(false);
    expect(meetsSeverityThreshold({ critical: 1, important: 0, minor: 0 })).toBe(true);
  });

  it('counts criticals for the critical threshold only', () => {
    expect(meetsSeverityThreshold({ critical: 0, important: 2, minor: 3 }, 'critical')).toBe(false);
  });

  it('includes criticals at the important threshold', () => {
    expect(meetsSeverityThreshold({ critical: 1, important: 0, minor: 0 }, 'important')).toBe(true);
  });

  it('notifies on any finding at the minor threshold', () => {
    expect(meetsSeverityThreshold({ critical: 0, important: 0, minor: 1 }, 'minor')).toBe(true);
  });
});

describe('getTopFindings', () => {
  it('orders most severe findings first', () => {
    const findings = [
      makeIssue('minor', 'a minor issue'),
      makeIssue('critical', 'a critical issue'),
      makeIssue('important', 'an important issue'),
      makeIssue('critical', 'another critical issue'),
    ];
    const top = getTopFindings(findings, 3);
    expect(top.map((f) => f.message)).toEqual([
      'a critical issue',
      'another critical issue',
      'an important issue',
    ]);
  });

  it('returns all findings when count exceeds the list length', () => {
    const findings = [makeIssue('minor', 'a'), makeIssue('important', 'b')];
    expect(getTopFindings(findings, 10)).toHaveLength(2);
  });

  it('returns an empty array for zero or negative counts', () => {
    const findings = [makeIssue('critical', 'a')];
    expect(getTopFindings(findings, 0)).toEqual([]);
    expect(getTopFindings(findings, -1)).toEqual([]);
  });
});

describe('defaultPrUrl', () => {
  it('builds a GitHub PR URL from repo and number', () => {
    expect(defaultPrUrl(CONTEXT)).toBe('https://github.com/owner/repo/pull/42');
  });
});

describe('formatSlackMessage', () => {
  it('builds a Blocks payload with header, verdict, severity and top findings', () => {
    const result = makeResult([
      makeIssue('critical', 'SQL injection risk'),
      makeIssue('important', 'Missing error handling'),
    ]);
    const payload = formatSlackMessage(result, CONTEXT);

    expect(payload.blocks[0].type).toBe('section');
    const headerText = (payload.blocks[0].text as { text: string }).text;
    expect(headerText).toContain('#42 Fix the thing');
    expect(headerText).toContain('https://github.com/owner/repo/pull/42');

    const fields = payload.blocks[1].fields as Array<{ text: string }>;
    expect(fields[0].text).toContain('Changes requested');
    expect(fields[1].text).toContain('1 critical');
    expect(fields[1].text).toContain('1 important');

    const findingsText = (payload.blocks[2].text as { text: string }).text;
    expect(findingsText).toContain('SQL injection risk');
    expect(findingsText).toContain('Missing error handling');
    // Most severe finding comes first in the payload body.
    expect(findingsText.indexOf('SQL injection risk')).toBeLessThan(
      findingsText.indexOf('Missing error handling'),
    );
  });

  it('includes a ready verdict label', () => {
    const result = makeResult([]);
    result.verdict.ready = true;
    const payload = formatSlackMessage(result, CONTEXT);
    const fields = payload.blocks[1].fields as Array<{ text: string }>;
    expect(fields[0].text).toContain('Ready to merge');
  });

  it('omits the top-findings block when there are no issues', () => {
    const payload = formatSlackMessage(makeResult([]), CONTEXT);
    const types = payload.blocks.map((b) => b.type);
    expect(types).toEqual(['section', 'section', 'divider']);
  });
});

describe('formatTeamsMessage', () => {
  it('builds an Adaptive Card payload with facts and actions', () => {
    const result = makeResult([makeIssue('critical', 'Secrets in repo')]);
    const payload = formatTeamsMessage(result, CONTEXT);

    const attachment = payload.attachments[0];
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = attachment.content as Record<string, unknown>;

    const textBlocks = card.body as Array<{ type: string; text?: string }>;
    const header = textBlocks.find((b) => (b.text ?? '').includes('OpenCode AI Reviewer'));
    expect(header?.text).toContain('#42');

    const facts = (
      card.body as Array<{ type: string; facts?: Array<{ title: string; value: string }> }>
    ).find((b) => b.type === 'FactSet')?.facts;
    expect(facts?.find((f) => f.title === 'Verdict')?.value).toBe('⛔ Changes requested');
    expect(facts?.find((f) => f.title === 'Critical')?.value).toBe('1');

    const findingsText = textBlocks.map((b) => b.text ?? '').join('\n');
    expect(findingsText).toContain('Secrets in repo');

    const actions = card.actions as Array<{ type: string; url: string }>;
    expect(actions[0].type).toBe('Action.OpenUrl');
    expect(actions[0].url).toBe('https://github.com/owner/repo/pull/42');
  });

  it('omits top findings when no issues exist', () => {
    const payload = formatTeamsMessage(makeResult([]), CONTEXT);
    const card = payload.attachments[0].content as Record<string, unknown>;
    const textBlocks = card.body as Array<{ type: string; text?: string }>;
    const allText = textBlocks.map((b) => b.text ?? '').join('\n');
    expect(allText).not.toContain('Top findings');
  });
});

describe('postToWebhook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts a JSON payload and returns true on success', async () => {
    fetchMock.mockResolvedValue(mockOkResponse());
    const ok = await postToWebhook('https://hooks.slack.com/services/T/B/S', { blocks: [] });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/services/T/B/S');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"blocks":[]}');
  });

  it('returns false on non-2xx responses', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: vi.fn().mockResolvedValue('bad'),
    });
    const ok = await postToWebhook('https://hooks.slack.com/services/T/B/S', {});
    expect(ok).toBe(false);
  });

  it('returns false for non-http URLs without calling fetch', async () => {
    const ok = await postToWebhook('file:///etc/passwd', {});
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const ok = await postToWebhook('https://hooks.slack.com/services/T/B/S', {});
    expect(ok).toBe(false);
  });
});

describe('sendNotification', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  const enabledConfig = {
    enabled: true,
    minSeverity: 'critical' as const,
    slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' },
    teams: { webhookUrl: 'https://outlook.office.com/webhook/T' },
  };

  it('does nothing when config is undefined', async () => {
    await sendNotification(makeResult([makeIssue('critical', 'x')]), undefined, CONTEXT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when notifications are disabled', async () => {
    await sendNotification(
      makeResult([makeIssue('critical', 'x')]),
      { enabled: false, slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' } },
      CONTEXT,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the severity threshold is not met', async () => {
    await sendNotification(
      makeResult([makeIssue('important', 'x')]),
      {
        enabled: true,
        minSeverity: 'critical',
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S' },
      },
      CONTEXT,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends to both Slack and Teams when configured', async () => {
    fetchMock.mockResolvedValue(mockOkResponse());
    await sendNotification(makeResult([makeIssue('critical', 'x')]), enabledConfig, CONTEXT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://hooks.slack.com/services/T/B/S');
    expect(urls).toContain('https://outlook.office.com/webhook/T');
  });

  it('gives env webhook URLs precedence over the config file values', async () => {
    fetchMock.mockResolvedValue(mockOkResponse());
    await sendNotification(
      makeResult([makeIssue('critical', 'x')]),
      { enabled: true, slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/PLACEHOLDER' } },
      CONTEXT,
      {
        env: {
          SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/SECRET',
        } as NodeJS.ProcessEnv,
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.com/services/T/B/SECRET');
  });

  it('skips a channel with an invalid URL and still notifies the valid one', async () => {
    fetchMock.mockResolvedValue(mockOkResponse());
    await sendNotification(
      makeResult([makeIssue('critical', 'x')]),
      {
        enabled: true,
        slack: { webhookUrl: 'not-a-url' },
        teams: { webhookUrl: 'https://outlook.office.com/webhook/T' },
      },
      CONTEXT,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://outlook.office.com/webhook/T');
  });
});
