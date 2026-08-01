import { GitHubHelper, Logger, parseCommand } from '@opencode-pr-agent/lib';
import type {
  AgentConfig,
  GitHubEvent,
  RateLimitStatus,
  RateLimiter,
  Subscriber,
} from '@opencode-pr-agent/lib';
import { getToken } from '../utils/token.js';

const STATUS_MARKER = '<!-- rate-limits-status -->';

/**
 * Create a subscriber that handles `/rate-limits` (view usage) and
 * `/rate-limits-reset` (reset limits) admin commands. Only GitHub users listed
 * in `rateLimiting.adminUsers` (compared case-insensitively) are allowed to run
 * these.
 * @param rateLimiter - The shared RateLimiter instance.
 * @param config - The resolved agent configuration (source of adminUsers).
 * @returns A subscriber object for admin rate limit commands.
 */
export function createAdminSubscriber(rateLimiter: RateLimiter, config: AgentConfig): Subscriber {
  const logger = new Logger('AdminSubscriber');
  return {
    name: 'AdminSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const body = (comment?.body as string) || '';
        const parsed = body ? parseCommand(body) : null;
        if (
          !parsed ||
          (parsed.command !== 'rate-limits' && parsed.command !== 'rate-limits-reset')
        ) {
          return;
        }

        const adminUsers = config.rateLimiting.adminUsers || [];
        const author = (comment?.user as Record<string, string> | undefined)?.login || '';
        if (!adminUsers.some((u) => u.toLowerCase() === author.toLowerCase())) {
          return;
        }

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const gh = new GitHubHelper(getToken(), event.repo || '');

        if (parsed.command === 'rate-limits') {
          const status = await rateLimiter.getStatus();
          await gh.postOrUpdateComment(prNumber, STATUS_MARKER, formatStatus(status));
          return;
        }

        await handleReset(gh, rateLimiter, parsed, prNumber);
      } catch (err) {
        logger.error(`AdminSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}

/**
 * Execute a `/rate-limits-reset` command and post the confirmation comment.
 * @param gh - GitHub helper for posting the result.
 * @param rateLimiter - The shared RateLimiter instance.
 * @param parsed - Parsed command with optional --repo/--user/--all flags.
 * @param prNumber - PR/issue number to post the result on.
 */
async function handleReset(
  gh: GitHubHelper,
  rateLimiter: RateLimiter,
  parsed: { flags: Record<string, string | boolean> },
  prNumber: number,
): Promise<void> {
  // The flag parser only captures values after '='. A space-separated form like
  // `--repo <name>` parses --repo as boolean true; treat that as invalid syntax
  // rather than silently falling through to a global reset.
  if (parsed.flags.repo === true || parsed.flags.user === true) {
    await gh.postOrUpdateComment(
      prNumber,
      STATUS_MARKER,
      'Invalid syntax — use `--repo=<name>` or `--user=<login>` (equals form).',
    );
    return;
  }

  const repoFlag =
    typeof parsed.flags.repo === 'string' ? (parsed.flags.repo as string) : undefined;
  const userFlag =
    typeof parsed.flags.user === 'string' ? (parsed.flags.user as string) : undefined;
  const allFlag = parsed.flags.all === true;

  let removed: number;
  if (allFlag || (!repoFlag && !userFlag)) {
    removed = await rateLimiter.resetAll();
  } else if (repoFlag) {
    removed = await rateLimiter.resetRepo(repoFlag);
  } else {
    removed = await rateLimiter.resetUser(userFlag as string);
  }

  const lines = [
    '## 🔄 Rate Limits Reset',
    `Removed **${removed}** rate-limit record(s).`,
    allFlag ? '- **Scope:** all' : '',
    repoFlag ? `- **Repo:** \`${repoFlag}\`` : '',
    userFlag ? `- **User:** \`${userFlag}\`` : '',
  ].filter(Boolean);

  await gh.postOrUpdateComment(prNumber, STATUS_MARKER, lines.join('\n'));
}

/**
 * Format a RateLimitStatus as a markdown comment body.
 * @param status - Aggregated rate limit usage.
 * @returns A markdown summary of current usage.
 */
function formatStatus(status: RateLimitStatus): string {
  const lines: string[] = ['## 📊 Rate Limit Status', ''];

  lines.push('### Per-Repo Hourly (command tier)');
  if (status.repoHourly.length === 0) {
    lines.push('_No command-tier activity in the last hour._');
  } else {
    for (const r of status.repoHourly) {
      lines.push(`- \`${r.repo}\`: **${r.count}** / ${r.limit}`);
    }
  }

  lines.push('', '### Per-User Daily (all tiers)');
  if (status.userDaily.length === 0) {
    lines.push('_No activity in the last 24 hours._');
  } else {
    for (const u of status.userDaily) {
      lines.push(`- \`${u.user}\`: **${u.count}** / ${u.limit}`);
    }
  }

  lines.push('', '### Daily Token Budget');
  lines.push(`- **Used:** ${status.tokenUsageToday} / **Budget:** ${status.tokenBudget}`);

  return lines.join('\n');
}
