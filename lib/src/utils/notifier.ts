import type {
  NotificationsConfig,
  Platform,
  ReviewIssue,
  ReviewResult,
  Severity,
} from '../types/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  type SpilloverSummary,
  computeSpilloverSummary,
  mergeSpilloverSummaries,
} from './filter-findings.js';
import { Logger } from './logger.js';
import { escapeInlineCode } from './markdown.js';
import { redactReviewResult, redactSecrets } from './redact.js';
import { withRetryAndTimeout } from './retry.js';
import { dnsResolvesBlockedHost, isBlockedIpHost } from './safe-exec.js';
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
 * Operator opt-in gate for PR-editable config-file webhook URLs. A hostile PR
 * can point `notifications.slack.webhookUrl` at an arbitrary external endpoint
 * and receive review summaries (verdict, findings, file paths) — a
 * code-intelligence exfiltration channel. Environment URLs are authoritative
 * and always honored; config-file URLs require explicit opt-in
 * (`OPENCODE_ALLOW_CONFIG_WEBHOOK=1`), mirroring `isEventSubscribersEnabled`.
 */
export const CONFIG_WEBHOOK_ENV = 'OPENCODE_ALLOW_CONFIG_WEBHOOK';

/**
 * Whether config-file webhook URLs may be used for notification delivery.
 * @param env - Environment record to read the opt-in flag from.
 * @returns True only when the operator explicitly opted in.
 */
export function isConfigWebhookAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONFIG_WEBHOOK_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

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

/** Default number of findings shown in Slack/Teams notifications. */
export const DEFAULT_NOTIFICATION_FINDINGS = 3;

/** Options controlling notification message rendering. */
export interface NotificationMessageOptions {
  /**
   * Maximum findings listed (highest severity first); the hidden tail is
   * reported as a "+N more" spillover line. Defaults to 3 (legacy behavior
   * lists the top 3, now with visible spillover accounting).
   */
  maxFindings?: number;
}

/**
 * Compute severity-aware spillover accounting for notification findings
 * hidden beyond the listed top N, merged with any pre-existing spillover
 * carried on the review result (e.g. from sensitivity-cap filtering).
 * @param result - Review result whose issues were ranked.
 * @param visibleCount - Number of findings actually listed.
 * @returns The combined spillover summary, or undefined when nothing is hidden.
 */
export function getNotificationSpillover(
  result: ReviewResult,
  visibleCount: number,
): SpilloverSummary | undefined {
  const ranked = [...result.issues].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const tail = ranked.slice(Math.max(0, visibleCount));
  return mergeSpilloverSummaries(
    result.spillover,
    tail.length > 0 ? computeSpilloverSummary(tail) : undefined,
  );
}

/**
 * Format a notification-safe spillover suffix for findings hidden beyond the
 * listed top N, e.g. `…and 4 more (1 critical · 2 important · 1 minor)`. The
 * line is fully generated (counts plus fixed words) so it needs no
 * Slack-mrkdwn or Adaptive-Card escaping.
 * @param spillover - Spillover accounting.
 * @returns The spillover line, or undefined when nothing was hidden.
 */
export function formatNotificationSpilloverLine(
  spillover: SpilloverSummary | undefined | null,
): string | undefined {
  if (!spillover || spillover.count <= 0) return undefined;
  const parts: string[] = [];
  if (spillover.critical > 0) parts.push(`${spillover.critical} critical`);
  if (spillover.important > 0) parts.push(`${spillover.important} important`);
  if (spillover.minor > 0) parts.push(`${spillover.minor} minor`);
  const breakdown = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
  const noun = spillover.count === 1 ? 'finding' : 'findings';
  return `…and ${spillover.count} more ${noun}${breakdown}`;
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
 * model-generated finding cannot spoof links, inject formatting, or corrupt
 * the layout.
 * @param text - Raw text to embed in a mrkdwn block.
 * @returns The text with `&`, `<`, and `>` HTML-escaped and `*`, `_`, `` ` ``,
 * and `~` backslash-escaped.
 */
function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_`~])/g, '\\$1');
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
 * Cap text to a character budget and append fail-open accounting.
 *
 * Truncates `text` to `budget` chars, appends `suffix` (e.g. a spillover
 * line), and — when truncation cut shown text but the suffix does not already
 * say so — appends an explicit truncation notice. The notice budget is
 * reserved up front so the notice itself is never cut by the cap.
 * @param text - Full text to cap.
 * @param suffix - Already-computed suffix to append (possibly empty).
 * @param budget - Maximum total characters for the returned string.
 * @returns Capped text with suffix and optional truncation notice.
 */
function appendTruncationNotice(text: string, suffix: string, budget: number): string {
  const notice = '\n… list truncated — see PR for full findings';
  const room = Math.max(0, budget - suffix.length);
  const capped = truncateText(text, room);
  if (suffix !== '' || !capped.endsWith('…')) return `${capped}${suffix}`;
  return `${truncateText(text, Math.max(0, room - notice.length))}${suffix}${notice}`;
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
  // `issue.file` is model-derived and therefore PR-influenceable: a crafted
  // path containing a backtick closes the code span and lets the rest of the
  // filename render as live mrkdwn — including a clickable `<url|label>` — in
  // the one channel the operator trusts for a "Ready to merge" verdict.
  // `findingBulletTeams` below escapes the identical value, so this was an
  // inconsistency rather than a decision.
  //
  // Two layers: `escapeInlineCode` keeps the path inside its code span (it
  // escapes backticks and collapses newlines), and the angle brackets are then
  // entity-encoded so no live link syntax survives in the payload at all. The
  // second layer is redundant while the path stays inside a code span — Slack
  // does not linkify there — but this string also flows through shared
  // truncation and spillover formatting, and a boundary control that depends on
  // every downstream renderer treating a code span as literal is not a control.
  const codePath = escapeInlineCode(`${issue.file}:${issue.line}`)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `${issue.severity === 'critical' ? '🔴' : issue.severity === 'important' ? '🟠' : '🔵'} ${issue.severity.toUpperCase()}: \`${codePath}\` — ${escapeMrkdwn(issue.message)}`;
}

/**
 * Escape untrusted text for a Teams Adaptive Card TextBlock/Fact value.
 * Adaptive Cards use a different markdown subset than Slack mrkdwn, so the
 * Slack HTML-entity escapes (`&lt;` etc.) must not leak here. Backslash-escape
 * formatting metacharacters and collapse newlines so a title or finding
 * cannot break card layout.
 * @param text - Raw text to embed in an Adaptive Card.
 * @returns The text safe for Adaptive Card interpolation.
 */
function escapeTeamsText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_|`\[\]()#~\\])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Build a compact Adaptive-Card bullet describing a finding, with
 * Teams-specific escaping and layout-safe single-line text.
 * @param issue - The finding to render.
 * @returns A bullet string for Teams cards.
 */
function findingBulletTeams(issue: ReviewIssue): string {
  const badge = issue.severity === 'critical' ? '🔴' : issue.severity === 'important' ? '🟠' : '🔵';
  return `${badge} ${issue.severity.toUpperCase()}: \`${escapeTeamsText(`${issue.file}:${issue.line}`)}\` — ${escapeTeamsText(issue.message)}`;
}

/**
 * Format a review summary as a Slack Blocks payload.
 * @param result - Review result to summarize.
 * @param context - PR context (title, number, repo, URL).
 * @param options - Optional rendering options (listed-findings budget).
 * @returns A Slack incoming-webhook payload with a `blocks` array.
 */
export function formatSlackMessage(
  result: ReviewResult,
  context: NotificationContext,
  options?: NotificationMessageOptions,
): { blocks: SlackBlock[] } {
  const prUrl = context.url ?? defaultPrUrl(context);
  const maxFindings = Math.max(0, options?.maxFindings ?? DEFAULT_NOTIFICATION_FINDINGS);
  const topFindings = getTopFindings(result.issues, maxFindings);
  const spilloverLine = formatNotificationSpilloverLine(
    getNotificationSpillover(result, topFindings.length),
  );

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

  if (topFindings.length > 0 || spilloverLine !== undefined) {
    const findingsText = `*Top findings:*\n${topFindings.map(findingBullet).join('\n')}`;
    // Reserve room for the spillover suffix so the appended accounting can
    // never push the section block over Slack's 3000-character limit.
    const suffix = spilloverLine !== undefined ? `\n${spilloverLine}` : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Slack rejects a section block whose text exceeds 3000 characters;
        // issue messages are model-generated and unbounded, so cap the body.
        // A bare '…' never tells users content was cut: when truncation cut
        // shown text and no spillover suffix already says so, append an
        // explicit notice (budget reserved up front so it is never cut).
        text: appendTruncationNotice(findingsText, suffix, SLACK_SECTION_TEXT_LIMIT),
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
 * @param options - Optional rendering options (listed-findings budget).
 * @returns A Teams message payload containing an Adaptive Card attachment.
 */
export function formatTeamsMessage(
  result: ReviewResult,
  context: NotificationContext,
  options?: NotificationMessageOptions,
): TeamsMessage {
  const prUrl = context.url ?? defaultPrUrl(context);
  const maxFindings = Math.max(0, options?.maxFindings ?? DEFAULT_NOTIFICATION_FINDINGS);
  const topFindings = getTopFindings(result.issues, maxFindings);
  const verdict = verdictLabel(result);
  const spilloverLine = formatNotificationSpilloverLine(
    getNotificationSpillover(result, topFindings.length),
  );
  const spilloverSuffix = spilloverLine !== undefined ? `\n${spilloverLine}` : '';

  const topFindingBlocks: TeamsTextBlock[] =
    topFindings.length > 0 || spilloverLine !== undefined
      ? [
          {
            type: 'TextBlock',
            text: '**Top findings:**',
            wrap: true,
          },
          {
            type: 'TextBlock',
            // Cap like the Slack section block: finding text is
            // model-generated and unbounded (with truncation notice, see above).
            text: appendTruncationNotice(
              topFindings.map(findingBulletTeams).join('\n'),
              spilloverSuffix,
              // Same 3000-char cap as the Slack section block (see above).
              SLACK_SECTION_TEXT_LIMIT,
            ),
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
              text: `**${escapeTeamsText(context.title)}**`,
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

  // DNS-rebinding guard (issue #546): refuse hostnames that resolve to
  // internal addresses even though the literal hostname is clean.
  try {
    if (await dnsResolvesBlockedHost(new URL(url).hostname)) {
      log.warn(
        `Skipping webhook notification: hostname resolves to a blocked internal address: ${redactWebhookUrl(url)}`,
      );
      return false;
    }
  } catch {
    log.warn(`Skipping webhook notification: unparsable URL: ${redactWebhookUrl(url)}`);
    return false;
  }

  try {
    const response = await getWebhookBreaker(url).call(() =>
      withRetryAndTimeout(
        async (signal) => {
          const res = await fetch(url, {
            method: 'POST',
            // SECURITY: never follow redirects. The https-only and
            // DNS-rebinding guards immediately above validate the ORIGINAL url
            // only; under the default `redirect: 'follow'` a single 3xx walks
            // straight past both and can land on `http://169.254.169.254/`.
            // That also defeats the cleartext-transmission rationale in the
            // guard above, since the redirected hop may be plain http. The
            // guard set was only ever reasoned about for the initial URL, so
            // the transport must not be permitted to change it underneath us.
            redirect: 'manual',
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
 *
 * Host canonicalization covers alternate IP representations that naive
 * dotted-decimal regexes miss: single-decimal (`http://2130706433/`),
 * octal/hex dotted (`0x7f.0.0.1`, `0177.0.0.1`), short forms (`127.1`), and
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `[::ffff:7f00:1]`). The check stays
 * synchronous by design (no DNS resolution): hostnames that do not parse as
 * IPs are checked against hostname blocklists only.
 * @param url - Candidate URL string.
 * @returns True when the URL is a safe https endpoint.
 */
export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    // `URL.hostname` retains brackets for IPv6 literals (`[::1]`), but
    // `isBlockedIpHost` expects a bare host — strip them first (non-greedy
    // bracket class) and drop any `%zone` suffix before the host check.
    const host =
      parsed.hostname
        .toLowerCase()
        .replace(/^\[([^\]]*)\]$/, '$1')
        .split('%')[0] ?? '';
    return !isBlockedIpHost(host);
  } catch {
    return false;
  }
}

/**
 * Redact a webhook URL for safe logging so secrets embedded in the URL are
 * never written to the log output. Masks the path/query/hash and strips any
 * `userinfo` (`username:password@`) credentials.
 * @param url - Full webhook URL.
 * @returns A redacted URL string (origin + masked path, no credentials).
 */
export function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
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
 *
 * **Egress boundary.** The payload is redacted *here*, not by the caller.
 * Webhooks are the one sink outside the repository's access control, so a
 * finding that quotes a hardcoded credential from the diff would otherwise be
 * republished in plaintext to an endpoint the repo cannot audit. Redacting on
 * entry means `action/src/review.ts` and `app/src/handlers/pr-review.ts` — and
 * any future caller — are covered by construction rather than by remembering.
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
  const logger =
    options.logger ?? new Logger('Notifier', { prNumber: context.number, repo: context.repo });

  let slackUrl = resolveWebhookUrl(config.slack?.webhookUrl, env.SLACK_WEBHOOK_URL);
  let teamsUrl = resolveWebhookUrl(config.teams?.webhookUrl, env.TEAMS_WEBHOOK_URL);
  if (!slackUrl && !teamsUrl) return;

  // Severity is decided on the raw stats, which are integers — redacting the
  // result before this point could not change the outcome either way.
  const minSeverity = config.minSeverity ?? 'critical';
  if (!meetsSeverityThreshold(result.stats, minSeverity)) {
    return;
  }

  // Everything below this line formats model-derived text into an outbound
  // payload, so redact once, at the boundary, rather than in every formatter.
  const safeResult = redactReviewResult(result);
  const safeContext: NotificationContext = {
    ...context,
    title: redactSecrets(context.title ?? ''),
  };

  // Config-file fallback warnings fire only on an actual send (after the
  // empty-URL and severity-threshold early returns) and only for the channel
  // that will actually be used, to avoid noise when nothing will be sent.
  // SECURITY: config-file URLs are PR-editable. Without the operator opt-in
  // (OPENCODE_ALLOW_CONFIG_WEBHOOK=1) they are skipped fail-closed instead of
  // sent with a warning — a warn-only send still exfiltrates review summaries
  // to an attacker-chosen endpoint.
  const configWebhookOk = isConfigWebhookAllowed(env);
  if (slackUrl && config.slack?.webhookUrl?.trim() && !env.SLACK_WEBHOOK_URL?.trim()) {
    if (!configWebhookOk) {
      logger.warn(
        'Skipping Slack notification: webhook URL comes from the PR-editable config file. ' +
          `Set ${CONFIG_WEBHOOK_ENV}=1 or SLACK_WEBHOOK_URL to enable.`,
      );
      slackUrl = undefined;
    } else {
      logger.warn(
        'Using Slack webhook URL from the config file, which is PR-editable and may embed ' +
          'credentials. Prefer supplying SLACK_WEBHOOK_URL via environment variable.',
      );
    }
  }
  if (teamsUrl && config.teams?.webhookUrl?.trim() && !env.TEAMS_WEBHOOK_URL?.trim()) {
    if (!configWebhookOk) {
      logger.warn(
        'Skipping Teams notification: webhook URL comes from the PR-editable config file. ' +
          `Set ${CONFIG_WEBHOOK_ENV}=1 or TEAMS_WEBHOOK_URL to enable.`,
      );
      teamsUrl = undefined;
    } else {
      logger.warn(
        'Using Teams webhook URL from the config file, which is PR-editable and may embed ' +
          'credentials. Prefer supplying TEAMS_WEBHOOK_URL via environment variable.',
      );
    }
  }
  if (!slackUrl && !teamsUrl) return;

  // Slack incoming webhooks normally post to the channel bound to the URL, but
  // a top-level `channel` override is honored when the integration allows it.
  const slackPayload = config.slack?.channel
    ? { ...formatSlackMessage(safeResult, safeContext), channel: config.slack.channel }
    : formatSlackMessage(safeResult, safeContext);

  // Both channels are independent side effects; dispatch them concurrently so a
  // slow or unreachable webhook never serializes the review path twice over.
  await Promise.allSettled([
    slackUrl
      ? postToWebhook(slackUrl, slackPayload, logger).then((ok) => {
          if (ok) logger.info(`Sent Slack notification for PR #${context.number}`);
        })
      : Promise.resolve(),
    teamsUrl
      ? postToWebhook(teamsUrl, formatTeamsMessage(safeResult, safeContext), logger).then((ok) => {
          if (ok) logger.info(`Sent Teams notification for PR #${context.number}`);
        })
      : Promise.resolve(),
  ]);
}
