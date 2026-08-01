import { DEFAULT_CONFIG, getDefaultMCPServers } from '@opencode-pr-agent/lib';
import type { AgentConfig } from '@opencode-pr-agent/lib';

/**
 * Parse an integer from an environment variable with a fallback.
 * @param envVar - Environment variable value (may be undefined).
 * @param fallback - Default value if envVar is not set or not a valid integer.
 * @returns The parsed integer or the fallback value.
 */
function parseEnvInt(envVar: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(envVar || String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Build the agent configuration from environment variables and defaults.
 * @returns The resolved agent configuration object.
 */
export function buildConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    reviewModel: process.env.REVIEW_MODEL || DEFAULT_CONFIG.reviewModel,
    fixModel: process.env.FIX_MODEL || DEFAULT_CONFIG.fixModel,
    auditModel: process.env.AUDIT_MODEL || undefined,
    synthesisModel: process.env.SYNTHESIS_MODEL || undefined,
    verificationModel: process.env.VERIFICATION_MODEL || undefined,
    metaReviewModel: process.env.META_REVIEW_MODEL || undefined,
    explanationModel: process.env.EXPLANATION_MODEL || undefined,
    conversationModel: process.env.CONVERSATION_MODEL || undefined,
    analysisModel: process.env.ANALYSIS_MODEL || undefined,
    batchSize: parseEnvInt(process.env.BATCH_SIZE, 3),
    maxLinesPerFile: parseEnvInt(process.env.MAX_LINES_PER_FILE, 200),
    maxIterations: parseEnvInt(process.env.MAX_ITERATIONS, 3),
    enableMCP: process.env.ENABLE_MCP !== 'false',
    mcpServers:
      process.env.ENABLE_MCP !== 'false'
        ? getDefaultMCPServers(process.env.GITHUB_TOKEN || '')
        : [],
    projectContext: {
      description: process.env.PROJECT_DESCRIPTION || '',
      conventionsPath: process.env.CONVENTIONS_PATH || undefined,
      typecheckCommands: process.env.TYPECHECK_COMMANDS
        ? process.env.TYPECHECK_COMMANDS.split(',')
        : [],
      lintCommands: process.env.LINT_COMMANDS ? process.env.LINT_COMMANDS.split(',') : [],
    },
    review: {
      ...DEFAULT_CONFIG.review,
      inline: process.env.REVIEW_INLINE !== 'false',
      ...(process.env.TOKEN_BUDGET ? { tokenBudget: JSON.parse(process.env.TOKEN_BUDGET) } : {}),
      ...(process.env.ENABLE_REACHABILITY !== undefined
        ? { enableReachability: process.env.ENABLE_REACHABILITY !== 'false' }
        : {}),
      reviewBudget: {
        enabled: process.env.REVIEW_BUDGET === 'true',
        summaryThreshold: Math.max(
          parseEnvInt(process.env.REVIEW_BUDGET_SUMMARY_THRESHOLD, 500),
          1,
        ),
        splitThreshold: Math.max(
          parseEnvInt(process.env.REVIEW_BUDGET_SPLIT_THRESHOLD, 1000),
          Math.max(parseEnvInt(process.env.REVIEW_BUDGET_SUMMARY_THRESHOLD, 500), 1),
        ),
      },
    },
    learning: {
      ...DEFAULT_CONFIG.learning,
      enabled: true,
      feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
      metaReview: { enabled: true, interval: 5, minFindingsForReview: 3 },
      patternDiscovery: { enabled: true, minFrequency: 3, windowSize: 100 },
    },
    rateLimiting: {
      ...DEFAULT_CONFIG.rateLimiting,
      enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
      reviewsPerRepoPerHour: parseEnvInt(
        process.env.RATE_LIMIT_REVIEWS_PER_REPO_HOUR,
        DEFAULT_CONFIG.rateLimiting.reviewsPerRepoPerHour,
      ),
      reviewsPerUserPerDay: parseEnvInt(
        process.env.RATE_LIMIT_REVIEWS_PER_USER_DAY,
        DEFAULT_CONFIG.rateLimiting.reviewsPerUserPerDay,
      ),
      prCooldownMinutes: parseEnvInt(
        process.env.RATE_LIMIT_PR_COOLDOWN_MINUTES,
        DEFAULT_CONFIG.rateLimiting.prCooldownMinutes,
      ),
      conversationCooldownSeconds: parseEnvInt(
        process.env.RATE_LIMIT_CONVERSATION_COOLDOWN_SECONDS,
        DEFAULT_CONFIG.rateLimiting.conversationCooldownSeconds,
      ),
      dailyTokenBudget: parseEnvInt(
        process.env.RATE_LIMIT_DAILY_TOKEN_BUDGET,
        DEFAULT_CONFIG.rateLimiting.dailyTokenBudget,
      ),
      estimatedTokensPerCommand: parseEnvInt(
        process.env.RATE_LIMIT_ESTIMATED_TOKENS_PER_COMMAND,
        DEFAULT_CONFIG.rateLimiting.estimatedTokensPerCommand,
      ),
      estimatedTokensPerInteractive: parseEnvInt(
        process.env.RATE_LIMIT_ESTIMATED_TOKENS_PER_INTERACTIVE,
        DEFAULT_CONFIG.rateLimiting.estimatedTokensPerInteractive,
      ),
      adminUsers: process.env.RATE_LIMIT_ADMIN_USERS
        ? process.env.RATE_LIMIT_ADMIN_USERS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : DEFAULT_CONFIG.rateLimiting.adminUsers,
      retentionHours: parseEnvInt(
        process.env.RATE_LIMIT_RETENTION_HOURS,
        DEFAULT_CONFIG.rateLimiting.retentionHours,
      ),
    },
  };
}
