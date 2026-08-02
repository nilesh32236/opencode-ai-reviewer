import { DEFAULT_CONFIG, getDefaultMCPServers, loadConfig } from '@opencode-pr-agent/lib';
import type { AgentConfig, TokenBudgetConfig } from '@opencode-pr-agent/lib';

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
 * Clamp an integer into a [min, max] range so that hostile or malformed env
 * overrides (negative, absurdly large) cannot silently disable rate limits.
 * @param value - Parsed integer value.
 * @param min - Inclusive minimum.
 * @param max - Inclusive maximum (defaults to Number.MAX_SAFE_INTEGER).
 * @returns The clamped integer.
 */
function clampInt(value: number, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Parse the TOKEN_BUDGET environment override into a TokenBudgetConfig.
 * Unlike the other env overrides, TOKEN_BUDGET is free-form JSON, so guard the
 * parse: a malformed value must degrade gracefully to the fallback (the
 * default config) instead of throwing at buildConfig() time on every webhook.
 * @param raw - Raw environment variable value (may be undefined).
 * @param fallback - Default token budget config if raw is unset or invalid.
 * @returns The parsed token budget config, or the fallback.
 */
function parseTokenBudgetEnv(
  raw: string | undefined,
  fallback: TokenBudgetConfig | undefined,
): TokenBudgetConfig | undefined {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as TokenBudgetConfig)
      : fallback;
  } catch {
    return fallback;
  }
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
      tokenBudget: parseTokenBudgetEnv(process.env.TOKEN_BUDGET, DEFAULT_CONFIG.review.tokenBudget),
      ...(process.env.ENABLE_REACHABILITY !== undefined
        ? { enableReachability: process.env.ENABLE_REACHABILITY !== 'false' }
        : {}),
      ...(process.env.ENABLE_META_VERIFICATION !== undefined
        ? { enableMetaVerification: process.env.ENABLE_META_VERIFICATION !== 'false' }
        : {}),
      ...(process.env.ENABLE_CODEBASE_INDEX !== undefined
        ? { enableCodebaseIndex: process.env.ENABLE_CODEBASE_INDEX !== 'false' }
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
    conversation: {
      ...DEFAULT_CONFIG.conversation,
      mentionHandle:
        process.env.CONVERSATION_MENTION_HANDLE || DEFAULT_CONFIG.conversation.mentionHandle,
      maxTurns: clampInt(
        parseEnvInt(process.env.CONVERSATION_MAX_TURNS, DEFAULT_CONFIG.conversation.maxTurns),
        0,
        1000,
      ),
      slidingWindowSize: clampInt(
        parseEnvInt(
          process.env.CONVERSATION_SLIDING_WINDOW_SIZE,
          DEFAULT_CONFIG.conversation.slidingWindowSize,
        ),
        1,
        500,
      ),
      contextTokenBudget: clampInt(
        parseEnvInt(
          process.env.CONVERSATION_CONTEXT_TOKEN_BUDGET,
          DEFAULT_CONFIG.conversation.contextTokenBudget,
        ),
        1000,
        1000000,
      ),
      ...(process.env.CONVERSATION_SUMMARIZATION_MODEL !== undefined &&
      process.env.CONVERSATION_SUMMARIZATION_MODEL.trim() !== ''
        ? { summarizationModel: process.env.CONVERSATION_SUMMARIZATION_MODEL.trim() }
        : {}),
    },
    rateLimiting: {
      ...DEFAULT_CONFIG.rateLimiting,
      enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
      reviewsPerRepoPerHour: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_REVIEWS_PER_REPO_HOUR,
          DEFAULT_CONFIG.rateLimiting.reviewsPerRepoPerHour,
        ),
        0,
        1000,
      ),
      reviewsPerUserPerDay: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_REVIEWS_PER_USER_DAY,
          DEFAULT_CONFIG.rateLimiting.reviewsPerUserPerDay,
        ),
        0,
        10000,
      ),
      prCooldownMinutes: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_PR_COOLDOWN_MINUTES,
          DEFAULT_CONFIG.rateLimiting.prCooldownMinutes,
        ),
        0,
        1440,
      ),
      conversationCooldownSeconds: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_CONVERSATION_COOLDOWN_SECONDS,
          DEFAULT_CONFIG.rateLimiting.conversationCooldownSeconds,
        ),
        0,
        3600,
      ),
      dailyTokenBudget: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_DAILY_TOKEN_BUDGET,
          DEFAULT_CONFIG.rateLimiting.dailyTokenBudget,
        ),
        0,
      ),
      estimatedTokensPerCommand: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_ESTIMATED_TOKENS_PER_COMMAND,
          DEFAULT_CONFIG.rateLimiting.estimatedTokensPerCommand,
        ),
        0,
      ),
      estimatedTokensPerInteractive: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_ESTIMATED_TOKENS_PER_INTERACTIVE,
          DEFAULT_CONFIG.rateLimiting.estimatedTokensPerInteractive,
        ),
        0,
      ),
      adminUsers: process.env.RATE_LIMIT_ADMIN_USERS
        ? process.env.RATE_LIMIT_ADMIN_USERS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : DEFAULT_CONFIG.rateLimiting.adminUsers,
      retentionHours: clampInt(
        parseEnvInt(
          process.env.RATE_LIMIT_RETENTION_HOURS,
          DEFAULT_CONFIG.rateLimiting.retentionHours,
        ),
        1,
        8760,
      ),
    },
  };
}

/**
 * Merge a repository's `.opencode-reviewer.yml` sensitivity settings into the
 * base agent configuration. The App builds a server-global config from env
 * vars + defaults (no per-repo context at startup), so per-repo sensitivity
 * tuning is applied here at the point where a repo working directory exists.
 *
 * Only the `review.sensitivity` / `review.categories` / `review.enableCodebaseIndex`
 * / `review.enableMetaVerification` fields are merged (the engine filters findings
 * off those fields and respects the codebase-index / meta-verification toggles);
 * all other config-file sections remain Action-only.
 * Unknown/malformed config files degrade gracefully to the
 * base config so a broken repo config never breaks the review.
 *
 * @param baseConfig - The base agent configuration (from `buildConfig()`).
 * @param workingDir - Repository working directory containing `.opencode-reviewer.yml`.
 * @returns The base config merged with the repo's sensitivity settings.
 */
export function mergeRepoConfig(baseConfig: AgentConfig, workingDir?: string): AgentConfig {
  if (!workingDir) return baseConfig;
  const repoConfig = loadConfig(workingDir);
  const sensitivity = repoConfig?.review?.sensitivity;
  const categories = repoConfig?.review?.categories;
  const enableCodebaseIndex = repoConfig?.review?.enableCodebaseIndex;
  const enableMetaVerification = repoConfig?.review?.enableMetaVerification;
  if (
    !sensitivity &&
    !categories &&
    enableCodebaseIndex === undefined &&
    enableMetaVerification === undefined
  ) {
    return baseConfig;
  }
  return {
    ...baseConfig,
    review: {
      ...baseConfig.review,
      ...(sensitivity && {
        sensitivity: {
          ...baseConfig.review.sensitivity,
          ...sensitivity,
        },
      }),
      ...(categories && { categories }),
      ...(enableCodebaseIndex !== undefined && { enableCodebaseIndex }),
      ...(enableMetaVerification !== undefined && { enableMetaVerification }),
    },
  };
}
