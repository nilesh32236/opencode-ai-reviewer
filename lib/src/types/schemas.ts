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
  inline: z.boolean().optional().default(false),
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

/** Zod schema validating review configuration. */
export const ReviewConfigSchema = z.object({
  skipLabels: z.array(z.string()).default(['autofix', 'autofix:approved', 'autofix:merged']),
  skipActors: z.array(z.string()).default(['github-actions[bot]']),
  inline: z.boolean().default(true),
  requireVerdict: z.boolean().default(true),
  commandTriggers: z.array(z.string()).default(['/oc', '/review']),
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

/** Zod schema validating the full agent configuration, merging provided values with defaults. */
export const AgentConfigSchema = z.object({
  reviewModel: z.string().default('opencode/deepseek-v4-flash-free'),
  fixModel: z.string().default('opencode/deepseek-v4-flash-free'),
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
  review: z
    .object({
      systemPrompt: z.string().optional(),
      extraContext: z.string().optional(),
      customRules: z.array(z.string()).optional(),
      inline: z.boolean().optional(),
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
