import type {
  NotificationsConfig,
  Platform,
  ReviewIssue,
  ReviewResult,
  Severity,
} from '../types/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Logger } from './logger.js';
import { withRetryAndTimeout } from './retry.js';
import { countAtOrAboveSeverity } from './threshold.js';
import type { SeverityStats } from './threshold.js';

/** Context describing the PR a review summary notification is about. */
export interface NotificationContext {
  /** Pull request number on the host platform. */
  number: number;
  /** Title of the pull request. */
  title: string;
  /** Repository in owner/repo format. */
  repo: string;
  /** Platform the review ran on; used to build the default PR/MR link. */
  platform?: Platform;
  /** Optional absolute PR/MR URL; defaults to a platform URL built from repo/number. */
  url?: string;
}

/** A single Slack Block (any BlockKit element). */
export interface SlackBlock {
  /** Block type identifier (e.g. 'section', 'divider'). */
  type: string;
  [key: string]: unknown;
}

/** A TextBlock element in an Adaptive Card body. */
export interface TeamsTextBlock {
  /** Element type discriminator. */
  type: 'TextBlock';
  /** Markdown-ish text to render. */
  text: string;
  /** Whether the text may wrap across lines. */
  wrap?: boolean;
  /** Relative font size (e.g. 'Large'). */
  size?: string;
  /** Font weight (e.g. 'Bolder'). */
  weight?: string;
}

/** A FactSet element in an Adaptive Card body. */
export interface TeamsFactSet {
  /** Element type discriminator. */
  type: 'FactSet';
  /** Key/value fact rows. */
  facts: Array<{ title: string; value: string }>;
}

/** A single element allowed inside an Adaptive Card body. */
export type TeamsCardBodyElement = TeamsTextBlock | TeamsFactSet;

/** The Adaptive Card content embedded in a Teams message attachment. */
export interface TeamsCardContent {
  /** Adaptive Card schema URL. */
  $schema: string;
  /** Adaptive Card type identifier. */
  type: string;
  /** Adaptive Card schema version. */
  version: string;
  /** Card body elements. */
  body: TeamsCardBodyElement[];
  /** Card action buttons. */
  actions?: Array<{ type: string; title: string; url: string }>;
}

/** An attachment wrapper describing the content type of a card. */
export interface TeamsAttachment {
  /** MIME type of the embedded card (e.g. Adaptive Card). */
  contentType: string;
  /** The embedded Adaptive Card content. */
  content: TeamsCardContent;
}

/** A Teams message payload containing an Adaptive Card attachment. */
export interface TeamsMessage {
  /** Message envelope type (always 'message'). */
  type: string;
  /** Card attachments to render. */
  attachments: TeamsAttachment[];
}

/** Options controlling a single sendNotification invocation. */
export interface SendNotificationOptions {
  /** Optional pre-configured logger (defaults to a new 'Notifier' logger). */
  logger?: Logger;
  /** Environment used to resolve webhook URL overrides (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Severity rank used for deterministic top-findings ordering. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  important: 1,
  minor: 2,
};

/**
 * Upper bound for a Slack `section` block's `text` field. Slack rejects blocks
 * over 3000 characters; the bound is kept below the hard limit for margin.
 */
const SLACK_SECTION_TEXT_LIMIT = 2900;

/**
 * Resolve the effective webhook URL for a channel. Environment variables are
 * authoritative (they hold real secrets and are not PR-editable); the config
 * file value only serves as a fallback placeholder.
 * @param configUrl - Webhook URL from the config file, if any.
 * @param envVar - Environment variable override (e.g. SLACK_WEBHOOK_URL).
 * @returns The resolved webhook URL, or undefined when neither source is set.
 */
export function resolveWebhookUrl(
  configUrl: string | undefined,
  envVar: string | undefined,
): string | undefined {
  const override = envVar?.trim();
  if (override) return override;
  const fallback = configUrl?.trim();
  return fallback || undefined;
}

/**
 * Decide whether a review result meets the configured minimum severity
 * threshold. Reuses the shared at-or-above counting semantics so
 * `minSeverity: 'important'` includes criticals and `'minor'` includes all.
 * @param stats - Finding counts by severity.
 * @param minSeverity - Minimum severity to notify on (defaults to 'critical').
 * @returns True when at least one finding is at or above the threshold.
 */
export function meetsSeverityThreshold(stats: SeverityStats, minSeverity?: Severity): boolean {
  const threshold = minSeverity ?? 'critical';
  return countAtOrAboveSeverity(stats, threshold) > 0;
}

/**
 * Extract the top N most severe findings, most severe first.
 * Severity is ranked critical > important > minor; ties keep their input order.
 * @param issues - Review findings to rank.
 * @param count - Maximum number of findings to return.
 * @returns The top N findings (sorted by severity, descending).
 */
export function getTopFindings(issues: ReviewIssue[], count: number): ReviewIssue[] {
  return [...issues]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, Math.max(0, count));
}

/**
 * Build the default PR/MR URL for a repository/PR pair, honoring the platform
 * the review ran on so GitLab merge requests do not link to a nonexistent
 * github.com page.
 * @param context - Notification context carrying repo, number, and platform.
 * @returns A PR/MR URL string.
 */
export function defaultPrUrl(context: NotificationContext): string {
  if (context.platform === 'gitlab') {
    return `https://gitlab.com/${context.repo}/-/merge_requests/${context.number}`;
  }
  return `https://github.com/${context.repo}/pull/${context.number}`;
}

/**
 * Escape Slack mrkdwn metacharacters in untrusted text so a PR title or
 * model-generated finding cannot spoof links or corrupt the layout.
 * @param text - Raw text to embed in a mrkdwn block.
 * @returns The text with `&`, `<`, and `>` HTML-escaped.
 */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Truncate text to a maximum length, appending an ellipsis when cut so the
 * receiver can tell content was elided.
 * @param text - Text to truncate.
 * @param maxLength - Inclusive maximum length of the returned string.
 * @returns The original text when it fits, otherwise a truncated prefix with '…'.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Render the review verdict as a short human label.
 * @param result - Review result whose verdict is rendered.
 * @returns A verdict label (e.g. '✅ Ready to merge').
 */
function verdictLabel(result: ReviewResult): string {
  return result.verdict.ready ? '✅ Ready to merge' : '⛔ Changes requested';
}

/**
 * Build a compact markdown bullet describing a finding.
 * @param issue - The finding to render.
 * @returns A bullet string (e.g. "🔴 CRITICAL: src/a.ts:12 — message").
 */
function findingBullet(issue: ReviewIssue): string {
  return `${issue.severity === 'critical' ? '🔴' : issue.severity === 'important' ? '🟠' : '🔵'} ${issue.severity.toUpperCase()}: \`${issue.file}:${issue.line}\` — ${escapeMrkdwn(issue.message)}`;
}

/**
 * Format a review summary as a Slack Blocks payload.
 * @param result - Review result to summarize.
 * @param context - PR context (title, number, repo, URL).
 * @returns A Slack incoming-webhook payload with a `blocks` array.
 */
export function formatSlackMessage(
  result: ReviewResult,
  context: NotificationContext,
): { blocks: SlackBlock[] } {
  const prUrl = context.url ?? defaultPrUrl(context);
  const topFindings = getTopFindings(result.issues, 3);

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*OpenCode AI Reviewer — <${prUrl}|#${context.number}>: ${escapeMrkdwn(context.title)}*`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Verdict:*\n${verdictLabel(result)}` },
        {
          type: 'mrkdwn',
          text: `*Severity:*\n🔴 ${result.stats.critical} critical · 🟠 ${result.stats.important} important · 🔵 ${result.stats.minor} minor`,
        },
      ],
    },
  ];

  if (topFindings.length > 0) {
    const findingsText = `*Top findings:*\n${topFindings.map(findingBullet).join('\n')}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Slack rejects a section block whose text exceeds 3000 characters;
        // issue messages are model-generated and unbounded, so cap the body.
        text: truncateText(findingsText, SLACK_SECTION_TEXT_LIMIT),
      },
    });
  }

  blocks.push({ type: 'divider' });
  return { blocks };
}

/**
 * Format a review summary as a Teams Adaptive Card payload.
 * @param result - Review result to summarize.
 * @param context - PR context (title, number, repo, URL).
 * @returns A Teams message payload containing an Adaptive Card attachment.
 */
export function formatTeamsMessage(
  result: ReviewResult,
  context: NotificationContext,
): TeamsMessage {
  const prUrl = context.url ?? defaultPrUrl(context);
  const topFindings = getTopFindings(result.issues, 3);
  const verdict = verdictLabel(result);

  const topFindingBlocks: TeamsTextBlock[] =
    topFindings.length > 0
      ? [
          {
            type: 'TextBlock',
            text: '**Top findings:**',
            wrap: true,
          },
          {
            type: 'TextBlock',
            text: topFindings.map(findingBullet).join('\n'),
            wrap: true,
          },
        ]
      : [];

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              size: 'Large',
              weight: 'Bolder',
              text: `OpenCode AI Reviewer — PR #${context.number}`,
              wrap: true,
            },
            {
              type: 'TextBlock',
              text: `**${context.title}**`,
              wrap: true,
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Verdict', value: verdict },
                { title: 'Critical', value: String(result.stats.critical) },
                { title: 'Important', value: String(result.stats.important) },
                { title: 'Minor', value: String(result.stats.minor) },
              ],
            },
            ...topFindingBlocks,
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View pull request',
              url: prUrl,
            },
          ],
        },
      },
    ],
  };
}

/** Module-level circuit breakers keyed by webhook URL so a persistently failing
 * endpoint short-circuits on later reviews instead of being hammered each time. */
const webhookBreakers = new Map<string, CircuitBreaker>();

/**
 * Get (or lazily create) the circuit breaker guarding a webhook URL.
 * @param url - The webhook endpoint URL.
 * @returns The breaker instance for that URL.
 */
function getWebhookBreaker(url: string): CircuitBreaker {
  const existing = webhookBreakers.get(url);
  if (existing) return existing;
  const breaker = new CircuitBreaker({ name: 'webhook-notifier' });
  webhookBreakers.set(url, breaker);
  return breaker;
}

/**
 * Post a JSON payload to a webhook URL with retry, a per-attempt timeout, and a
 * circuit breaker so a persistently failing endpoint is short-circuited on
 * later reviews. Failures are non-critical: they are logged as warnings and
 * reported via the boolean return value instead of throwing.
 * @param url - The webhook endpoint.
 * @param payload - JSON-serializable payload to post.
 * @param logger - Optional logger for failure diagnostics.
 * @returns True when the webhook accepted the payload, false otherwise.
 */
export async function postToWebhook(
  url: string,
  payload: unknown,
  logger?: Logger,
): Promise<boolean> {
  const log = logger ?? new Logger('Notifier');
  if (!isHttpsUrl(url)) {
    log.warn(
      `Skipping webhook notification: URL is not a valid https webhook URL: ${redactWebhookUrl(url)}`,
    );
    return false;
  }

  try {
    const response = await getWebhookBreaker(url).call(() =>
      withRetryAndTimeout(
        async (signal) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
          });
          if (!res.ok) {
            const err = new Error(
              `Webhook responded with HTTP ${res.status} ${res.statusText}`,
            ) as Error & {
              status: number;
            };
            err.status = res.status;
            throw err;
          }
          return res;
        },
        15_000,
        { operationName: 'notifier', maxRetries: 3 },
      ),
    );
    // Drain the response body. Some providers return HTTP 200 with a JSON body
    // reporting a content-level rejection (e.g. Slack's {"ok":false,...}); such
    // a body means the notification was NOT delivered even though the HTTP
    // status looked fine, so surface it as a failure instead of a success.
    const body = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { ok?: unknown }).ok === false
    ) {
      const reason = (parsed as { error?: unknown }).error;
      throw new Error(
        `Webhook rejected payload: ${typeof reason === 'string' ? reason : 'unknown'}`,
      );
    }
    return true;
  } catch (err) {
    log.warn(
      `Webhook notification failed for ${redactWebhookUrl(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Validate that a string is a usable webhook URL. Only `https:` is accepted:
 * webhooks are bearer credentials, so plain `http:` would transmit them over
 * cleartext. Config-file URLs are PR-editable (untrusted), so loopback,
 * link-local, RFC1918, and cloud-metadata hosts are also rejected to avoid
 * SSRF/exfiltration when no env secret override is set.
 * @param url - Candidate URL string.
 * @returns True when the URL is a safe https endpoint.
 */
function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
      return false;
    }
    if (host === '0.0.0.0' || host === '::' || host === '::1') return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Redact the query/path tokens of a webhook URL for safe logging so a secret
 * signature embedded in the URL is never written to the log output.
 * @param url - Full webhook URL.
 * @returns A redacted URL string (origin + masked path).
 */
function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = '/***';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '<invalid webhook URL>';
  }
}

/**
 * Send a review-summary notification to the configured Slack and/or Teams
 * webhooks when the review meets the minimum severity threshold. This is a
 * best-effort, non-blocking side effect: failures are logged as warnings and
 * never propagated to the caller.
 * @param result - Completed review result to summarize.
 * @param config - Notifications config (undefined or disabled skips sending).
 * @param context - PR context (number, title, repo, optional URL).
 * @param options - Optional logger and environment overrides.
 * @returns A promise that resolves once notifications have been attempted.
 */
export async function sendNotification(
  result: ReviewResult,
  config: NotificationsConfig | undefined,
  context: NotificationContext,
  options: SendNotificationOptions = {},
): Promise<void> {
  if (!config || config.enabled !== true) return;

  const env = options.env ?? process.env;
  const slackUrl = resolveWebhookUrl(config.slack?.webhookUrl, env.SLACK_WEBHOOK_URL);
  const teamsUrl = resolveWebhookUrl(config.teams?.webhookUrl, env.TEAMS_WEBHOOK_URL);
  if (!slackUrl && !teamsUrl) return;

  const minSeverity = config.minSeverity ?? 'critical';
  if (!meetsSeverityThreshold(result.stats, minSeverity)) {
    return;
  }

  const logger =
    options.logger ?? new Logger('Notifier', { prNumber: context.number, repo: context.repo });

  // Slack incoming webhooks normally post to the channel bound to the URL, but
  // a top-level `channel` override is honored when the integration allows it.
  const slackPayload = config.slack?.channel
    ? { ...formatSlackMessage(result, context), channel: config.slack.channel }
    : formatSlackMessage(result, context);

  // Both channels are independent side effects; dispatch them concurrently so a
  // slow or unreachable webhook never serializes the review path twice over.
  await Promise.allSettled([
    slackUrl
      ? postToWebhook(slackUrl, slackPayload, logger).then((ok) => {
          if (ok) logger.info(`Sent Slack notification for PR #${context.number}`);
        })
      : Promise.resolve(),
    teamsUrl
      ? postToWebhook(teamsUrl, formatTeamsMessage(result, context), logger).then((ok) => {
          if (ok) logger.info(`Sent Teams notification for PR #${context.number}`);
        })
      : Promise.resolve(),
  ]);
}
