/**
 * Zod schemas for validating JSONL review output and configuration.
 * Provides runtime validation that TypeScript types alone cannot.
 */

import { z } from 'zod';

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
});

/** Zod discriminated union for all review entry types. */
export const ReviewEntrySchema = z.discriminatedUnion('type', [
  ReviewSummarySchema,
  ReviewVerdictSchema,
  ReviewStrengthSchema,
  ReviewIssueSchema,
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
 * The whole object is wrapped in `.catch({})` so a non-object costTracking
 * block falls back to an empty object instead of failing the whole config
 * parse and silently discarding unrelated settings. Each field additionally
 * uses `.catch(undefined)` so a single invalid field (string boolean, quoted
 * rate, out-of-enum verbosity, negative rate) is dropped WITHOUT discarding
 * valid sibling fields — e.g. an explicit `enabled: true` opt-in or a valid
 * `outputCostPer1K` next to a negative input rate are preserved.
 * `enabled`/`verbosity` have no schema-level defaults: when the config file
 * omits them (or defines only rates), they stay `undefined` so the action
 * inputs — the primary opt-in mechanism — are honored via the `??` fallback in
 * the action wrapper.
 */
export const CostTrackingConfigSchema = z
  .object({
    enabled: z.boolean().optional().catch(undefined),
    verbosity: z.enum(['off', 'summary', 'detailed']).optional().catch(undefined),
    inputCostPer1K: z.number().nonnegative().optional().catch(undefined),
    outputCostPer1K: z.number().nonnegative().optional().catch(undefined),
  })
  .catch({});

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
  tokenBudget: TokenBudgetConfigSchema.optional(),
  reviewBudget: ReviewBudgetConfigSchema.default(ReviewBudgetConfigSchema.parse({})),
  costTracking: CostTrackingConfigSchema.optional(),
});

/** Zod schema validating audit configuration. */
export const AuditConfigSchema = z.object({
  promptsDir: z.string().default('.audit-prompts'),
  targetDirs: z.array(z.string()).default([]),
  autoFix: z.boolean().default(true),
  triggerLabel: z.string().default('autofix-trigger'),
  issueSeverityThreshold: SeveritySchema.default('important'),
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

/** Zod schema validating the full agent configuration, merging provided values with defaults. */
export const AgentConfigSchema = z.object({
  platform: z.enum(['github', 'gitlab']).optional().default('github'),
  reviewModel: z.string().default('opencode/deepseek-v4-flash-free'),
  fixModel: z.string().default('opencode/deepseek-v4-flash-free'),
  auditModel: z.string().optional(),
  synthesisModel: z.string().optional(),
  verificationModel: z.string().optional(),
  metaReviewModel: z.string().optional(),
  explanationModel: z.string().optional(),
  conversationModel: z.string().optional(),
  analysisModel: z.string().optional(),
  batchSize: z.number().int().min(1).max(10).default(3),
  maxLinesPerFile: z.number().int().min(0).max(5000).default(200),
  maxIterations: z.number().int().min(1).max(10).default(3),
  enableMCP: z.boolean().default(true),
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
});

// ─── Parse & Validate Helpers ─────────────────────────────

/** Parsed review output containing valid entries, invalid line errors, and extracted summary/verdict/findings. */
export type ParsedReviewOutput = {
  /** Validated entries that passed schema checks */
  valid: z.infer<typeof ReviewEntrySchema>[];
  /** Lines that failed to parse, with line number and error details */
  invalid: { line: number; raw: string; error: string }[];
  /** Extracted summary text, if any */
  summary?: string;
  /** Extracted verdict, if any */
  verdict?: { ready: boolean; reasoning: string };
  /** Extracted strength findings */
  strengths: z.infer<typeof ReviewStrengthSchema>[];
  /** Extracted issue findings */
  issues: z.infer<typeof ReviewIssueSchema>[];
};

/**
 * Parse raw JSONL review output string into structured review findings.
 * Gracefully isolates malformed lines without failing the entire output.
 *
 * @param jsonlContent - Raw multiline JSONL string returned by the model.
 * @returns Parsed review output with valid findings and isolated line errors.
 */
export function parseReviewOutput(jsonlContent: string): ParsedReviewOutput {
  const lines = jsonlContent.split('\n').filter((l) => l.trim());
  const result: ParsedReviewOutput = {
    valid: [],
    invalid: [],
    strengths: [],
    issues: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    try {
      const parsed = ReviewEntrySchema.parse(JSON.parse(raw));
      result.valid.push(parsed);

      if (parsed.type === 'summary') result.summary = parsed.text;
      if (parsed.type === 'verdict')
        result.verdict = { ready: parsed.ready, reasoning: parsed.reasoning };
      if (parsed.type === 'strength') result.strengths.push(parsed);
      if (parsed.type === 'issue') result.issues.push(parsed);
    } catch (err) {
      result.invalid.push({
        line: i + 1,
        raw: raw.length > 200 ? raw.slice(0, 200) + '...' : raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

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
      systemPrompt: z.string().optional(),
      extraContext: z.string().optional(),
      customRules: z.array(z.string()).optional(),
      inline: z.boolean().optional(),
      excludePatterns: z.array(z.string()).optional(),
      tokenBudget: TokenBudgetConfigSchema.optional(),
      enableReachability: z.boolean().optional(),
      budget: z
        .object({
          enabled: z.boolean().optional(),
          summaryThreshold: z.number().int().min(1).optional(),
          splitThreshold: z.number().int().min(1).optional(),
        })
        .optional(),
      costTracking: CostTrackingConfigSchema.optional(),
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
  overrides: z.array(ConfigOverrideSchema).optional(),
  linters: z.array(LinterConfigSchema).optional(),
});

/**
 * Validate and merge user config with defaults.
 *
 * @param userConfig - Raw user-provided configuration object (e.g., parsed from YAML).
 * @returns Fully validated and defaulted agent configuration.
 */
export function validateConfig(userConfig: unknown): z.infer<typeof AgentConfigSchema> {
  return AgentConfigSchema.parse(userConfig);
}
