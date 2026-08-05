/**
 * Zod schemas for validating JSONL review output and configuration.
 * Provides runtime validation that TypeScript types alone cannot.
 */

import { z } from 'zod';
import { MODEL_STRING_REGEX } from '../utils/model-string.js';

/** Error message shared by every model-field regex in AgentConfigSchema. */
const MODEL_STRING_ERROR = 'Must be "provider/model-name" format (e.g. "openai/gpt-4o")';

/** Zod schema validating severity levels. */
export const SeveritySchema = z.enum(['critical', 'important', 'minor']);

// ─── Review JSONL Entry Schemas ───────────────────────────
/** Zod schema validating a review summary entry. Requires text at least 10 characters. */
export const ReviewSummarySchema = z.object({
  type: z.literal('summary'),
  text: z.string().min(10, 'Summary text must be at least 10 characters'),
});

/** Zod schema validating a review verdict entry. Requires ready boolean and reasoning. */
export const ReviewVerdictSchema = z.object({
  type: z.literal('verdict'),
  ready: z.boolean(),
  reasoning: z.string().min(5, 'Verdict reasoning must be at least 5 characters'),
  autoFixable: z.boolean().optional().default(false),
  confidence: z.enum(['high', 'medium', 'low']).optional().default('low'),
});

/** Zod schema validating a review strength entry. Requires message at least 5 characters. */
export const ReviewStrengthSchema = z.object({
  type: z.literal('strength'),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  message: z.string().min(5),
});

/** Zod schema validating a review issue finding. Requires non-empty file, positive line number, valid severity, and message. */
export const ReviewIssueSchema = z.object({
  type: z.literal('issue'),
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive(),
  message: z.string().min(5, 'Issue message must be at least 5 characters'),
  suggestion: z.string().optional(),
  suggestionCode: z.string().optional(),
  inline: z.boolean().optional().default(false),
  theoreticalRisk: z.boolean().optional(),
  entryPointPath: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  category: z.string().optional(),
});

/**
 * Zod schema validating a review executive summary entry.
 * Mirrors the manual parser's lenient handling (jsonl-parser.ts): a non-string
 * purpose/riskRationale falls back to '', an unknown riskLevel falls back to
 * 'low', and non-string breakingChanges entries are filtered out. This keeps
 * the schema and the manual/file parsers in agreement.
 */
export const ReviewExecutiveSummarySchema = z.object({
  type: z.literal('executive_summary'),
  purpose: z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string()),
  riskLevel: z.preprocess(
    (v) => (typeof v === 'string' && ['low', 'medium', 'high'].includes(v) ? v : 'low'),
    z.enum(['low', 'medium', 'high']),
  ),
  riskRationale: z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string()),
  breakingChanges: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((c: unknown) => typeof c === 'string') : []),
    z.array(z.string()),
  ),
});

/** Zod discriminated union for all review entry types. */
export const ReviewEntrySchema = z.discriminatedUnion('type', [
  ReviewSummarySchema,
  ReviewVerdictSchema,
  ReviewStrengthSchema,
  ReviewIssueSchema,
  ReviewExecutiveSummarySchema,
]);

// ─── Configuration Schema ─────────────────────────────────
/** Zod schema validating MCP server configuration. */
export const MCPServerConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['local', 'remote']),
  command: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  environment: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedEnv: z
    .array(z.string())
    .optional()
    .describe(
      'Allowlist of parent env var names forwarded to a local MCP subprocess. Keys are ' +
        'case-sensitive. Unset → built-in safe default; empty array → no parent vars ' +
        'forwarded; `environment` always overrides.',
    ),
});

/** Zod schema validating project context configuration. */
export const ProjectContextConfigSchema = z.object({
  description: z.string(),
  conventionsPath: z.string().optional(),
  typecheckCommands: z.array(z.string()).default([]),
  lintCommands: z.array(z.string()).default([]),
  customRules: z.string().optional(),
});

/** Zod schema validating token budget configuration. */
export const TokenBudgetConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxLinesComplex: z.number().int().min(50).max(5000).default(200),
    maxLinesSimple: z.number().int().min(5).max(100).default(20),
    complexityThreshold: z.number().min(0).max(100).default(30),
    simpleThreshold: z.number().min(0).max(100).default(10),
  })
  .refine((data) => data.simpleThreshold <= data.complexityThreshold, {
    message: 'simpleThreshold must be <= complexityThreshold',
    path: ['simpleThreshold'],
  });

/** Zod schema validating budget-based review configuration. */
export const ReviewBudgetConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    summaryThreshold: z.number().int().min(1).default(500),
    splitThreshold: z.number().int().min(1).default(1000),
  })
  .refine((data) => data.splitThreshold >= data.summaryThreshold, {
    message: 'splitThreshold must be >= summaryThreshold',
    path: ['splitThreshold'],
  });

/**
 * Zod schema validating token usage / cost tracking configuration.
 * Every field is optional and the whole object is wrapped in `.catch({})` so
 * a malformed costTracking block (string boolean, quoted rate, invalid
 * verbosity) falls back to an empty object instead of failing the whole config
 * parse and silently discarding unrelated settings. `enabled`/`verbosity` have
 * no schema-level defaults: when the config file omits them (or defines only
 * rates), they stay `undefined` so the action inputs — the primary opt-in
 * mechanism — are honored via the `??` fallback in the action wrapper.
 */
export const CostTrackingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    verbosity: z.enum(['off', 'summary', 'detailed']).optional(),
    inputCostPer1K: z.number().nonnegative().optional(),
    outputCostPer1K: z.number().nonnegative().optional(),
  })
  .catch({});

/** Zod schema validating per-category sensitivity override. */
export const CategoryOverrideSchema = z.object({
  minSeverity: z.enum(['warning', 'error', 'critical']).optional(),
  enabled: z.boolean().optional(),
  // No 1..500 bounds here: out-of-range values are clamped by
  // `validateConfig()` (config.ts) instead of rejecting the whole config file.
  maxFindings: z.number().int().optional(),
});

/**
 * Zod schema validating per-repository sensitivity configuration.
 * Numeric caps intentionally omit `.min()/.max()` bounds — out-of-range values
 * are clamped by `validateConfig()` (config.ts) rather than failing the parse.
 * `maxTotalFindings` has no schema default so the cap is only active when a
 * repository explicitly configures it (the action/app defaults are neutral).
 */
export const ReviewSensitivitySchema = z.object({
  minSeverity: z.enum(['warning', 'error', 'critical']).default('warning'),
  confidenceThreshold: z.enum(['low', 'medium', 'high']).default('low'),
  maxFindingsPerCategory: z.number().int().optional(),
  maxTotalFindings: z.number().int().optional(),
  focusAreas: z.array(z.string()).optional().default([]),
  ignorePatterns: z.array(z.string()).optional().default([]),
});

/** Zod schema validating review configuration. */
export const ReviewConfigSchema = z.object({
  skipLabels: z.array(z.string()).default(['autofix', 'autofix:approved', 'autofix:merged']),
  skipActors: z.array(z.string()).default(['github-actions[bot]']),
  inline: z.boolean().default(true),
  requireVerdict: z.boolean().default(true),
  commandTriggers: z.array(z.string()).default(['/oc', '/review']),
  excludePatterns: z
    .array(z.string())
    .default([
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.generated.ts',
      '**/*.generated.js',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
    ]),
  enableReachability: z.boolean().optional().default(true),
  enableMetaVerification: z.boolean().optional().default(false),
  suppressLowConfidence: z.boolean().optional().default(false),
  enableCodebaseIndex: z.boolean().optional().default(true),
  includePreExisting: z.boolean().optional().default(false),
  tokenBudget: TokenBudgetConfigSchema.optional(),
  reviewBudget: ReviewBudgetConfigSchema.default(ReviewBudgetConfigSchema.parse({})),
  costTracking: CostTrackingConfigSchema.optional(),
  sensitivity: ReviewSensitivitySchema.optional(),
  categories: z.record(CategoryOverrideSchema).optional(),
  failOnSeverity: z.enum(['off', 'critical', 'important', 'minor']).default('off'),
});

/** Zod schema validating audit configuration. */
export const AuditConfigSchema = z.object({
  promptsDir: z.string().default('.audit-prompts'),
  targetDirs: z.array(z.string()).default([]),
  autoFix: z.boolean().default(true),
  triggerLabel: z.string().default('autofix-trigger'),
  issueSeverityThreshold: SeveritySchema.default('minor'),
});

/** Zod schema validating learning configuration with nested meta-review and pattern discovery defaults. */
export const LearningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  feedbackSignals: z.array(z.string()).default(['dismissed', 'reaction', 'disputed_comment']),
  metaReview: z
    .object({
      enabled: z.boolean().default(true),
      interval: z.number().int().min(1).max(100).default(5),
      minFindingsForReview: z.number().int().min(1).default(3),
    })
    .default({}),
  patternDiscovery: z
    .object({
      enabled: z.boolean().default(true),
      minFrequency: z.number().int().min(1).default(3),
      windowSize: z.number().int().min(10).max(1000).default(100),
    })
    .default({}),
});

/** Zod schema for linter configuration. */
export const LinterConfigSchema = z.object({
  pattern: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  workingDirectory: z.string().optional(),
  parseFormat: z.enum(['eslint', 'ruff', 'generic']).optional().default('generic'),
  timeout: z.number().int().positive().optional(),
});

/** Zod schema validating rate limiting configuration. */
export const RateLimitingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  reviewsPerRepoPerHour: z.number().int().min(0).max(1000).default(10),
  reviewsPerUserPerDay: z.number().int().min(0).max(10000).default(50),
  prCooldownMinutes: z.number().int().min(0).max(1440).default(2),
  conversationCooldownSeconds: z.number().int().min(0).max(3600).default(30),
  dailyTokenBudget: z.number().int().min(0).default(500000),
  estimatedTokensPerCommand: z.number().int().min(0).default(25000),
  estimatedTokensPerInteractive: z.number().int().min(0).default(5000),
  adminUsers: z.array(z.string()).default([]),
  retentionHours: z.number().int().min(1).max(8760).default(48),
});

/** Zod schema validating structured event logging configuration. */
export const EventLoggingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  path: z.string().default('.opencode/events.ndjson'),
});

/** Zod schema validating a pluggable event subscriber configuration entry. */
export const PluggableSubscriberConfigSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

/** Zod schema validating the full agent configuration, merging provided values with defaults. */
export const AgentConfigSchema = z.object({
  platform: z.enum(['github', 'gitlab']).optional().default('github'),
  reviewModel: z
    .string()
    .regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR)
    .default('opencode/deepseek-v4-flash-free'),
  fixModel: z
    .string()
    .regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR)
    .default('opencode/deepseek-v4-flash-free'),
  auditModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  synthesisModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  verificationModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  metaReviewModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  explanationModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  conversationModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  analysisModel: z.string().regex(MODEL_STRING_REGEX, MODEL_STRING_ERROR).optional(),
  batchSize: z.number().int().min(1).max(10).default(3),
  maxLinesPerFile: z.number().int().min(0).max(5000).default(200),
  maxIterations: z.number().int().min(1).max(10).default(3),
  enableMCP: z.boolean().default(false),
  mcpServers: z.array(MCPServerConfigSchema).default([]),
  projectContext: ProjectContextConfigSchema.default({
    description: '',
    typecheckCommands: [],
    lintCommands: [],
  }),
  review: ReviewConfigSchema.default({}),
  audit: AuditConfigSchema.default({}),
  learning: LearningConfigSchema.default({}),
  linters: z.array(LinterConfigSchema).default([]),
  rateLimiting: RateLimitingConfigSchema.default(RateLimitingConfigSchema.parse({})),
  eventLogging: EventLoggingConfigSchema.default(EventLoggingConfigSchema.parse({})),
  eventSubscribers: z.array(PluggableSubscriberConfigSchema).default([]),
});

// ─── Prompt Config Schema (YAML config file) ──────────────
/** Zod schema validating per-path/per-branch config overrides in the prompt config file. */
export const ConfigOverrideSchema = z.object({
  path: z.string().optional(),
  branch: z.string().optional(),
  review: z
    .object({
      customRules: z.array(z.string()).optional(),
      inline: z.boolean().optional(),
    })
    .optional(),
  fix: z
    .object({
      maxIterations: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  audit: z
    .object({
      categories: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Zod schema validating the full prompt configuration from a YAML/JSON config file. All sections are optional and will be merged with defaults. */
export const PromptConfigSchema = z.object({
  platform: z.enum(['github', 'gitlab']).optional(),
  review: z
    .object({
      skipLabels: z.array(z.string()).optional(),
      skipActors: z.array(z.string()).optional(),
      systemPrompt: z.string().optional(),
      extraContext: z.string().optional(),
      customRules: z.array(z.string()).optional(),
      inline: z.boolean().optional(),
      suppressLowConfidence: z.boolean().optional(),
      excludePatterns: z.array(z.string()).optional(),
      tokenBudget: TokenBudgetConfigSchema.optional(),
      enableReachability: z.boolean().optional(),
      enableMetaVerification: z.boolean().optional(),
      enableCodebaseIndex: z.boolean().optional(),
      includePreExisting: z.boolean().optional(),
      budget: z
        .object({
          enabled: z.boolean().optional(),
          summaryThreshold: z.number().int().min(1).optional(),
          splitThreshold: z.number().int().min(1).optional(),
        })
        .optional(),
      costTracking: CostTrackingConfigSchema.optional(),
      sensitivity: ReviewSensitivitySchema.optional(),
      categories: z.record(CategoryOverrideSchema).optional(),
      failOnSeverity: z.enum(['off', 'critical', 'important', 'minor']).optional(),
    })
    .optional(),
  fix: z
    .object({
      systemPrompt: z.string().optional(),
      maxIterations: z.number().int().min(1).max(10).optional(),
      runChecks: z.array(z.string()).optional(),
      checkAllowlist: z.array(z.string()).optional(),
    })
    .optional(),
  audit: z
    .object({
      promptsDir: z.string().optional(),
      categories: z.array(z.string()).optional(),
      targetDirs: z.array(z.string()).optional(),
      createIssues: z.boolean().optional(),
      autoFix: z.boolean().optional(),
    })
    .optional(),
  learning: z
    .object({
      enabled: z.boolean().optional(),
      feedbackSignals: z.array(z.string()).optional(),
      metaReview: z
        .object({
          enabled: z.boolean().optional(),
          interval: z.number().int().min(1).optional(),
          minFindingsForReview: z.number().int().min(0).optional(),
        })
        .optional(),
      patternDiscovery: z
        .object({
          enabled: z.boolean().optional(),
          minFrequency: z.number().int().min(1).optional(),
          windowSize: z.number().int().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  project: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      conventions: z.array(z.string()).optional(),
      commandReference: z.record(z.string()).optional(),
    })
    .optional(),
  conversation: z
    .object({
      maxTurns: z.number().int().min(0).max(1000).optional(),
      slidingWindowSize: z.number().int().min(1).max(500).optional(),
      contextTokenBudget: z.number().int().min(1000).max(1000000).optional(),
      summarizationModel: z.string().optional(),
      askCommandEnabled: z.boolean().optional(),
      maxCodeReferences: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
  overrides: z.array(ConfigOverrideSchema).optional(),
  linters: z.array(LinterConfigSchema).optional(),
  eventLogging: EventLoggingConfigSchema.optional(),
  eventSubscribers: z.array(PluggableSubscriberConfigSchema).optional(),
});
