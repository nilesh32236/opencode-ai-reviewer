/**
 * Zod schemas for validating JSONL review output and configuration.
 * Provides runtime validation that TypeScript types alone cannot.
 */

import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'important', 'minor']);

// ─── Review JSONL Entry Schemas ───────────────────────────
export const ReviewSummarySchema = z.object({
  type: z.literal('summary'),
  text: z.string().min(10, 'Summary text must be at least 10 characters'),
});

export const ReviewVerdictSchema = z.object({
  type: z.literal('verdict'),
  ready: z.boolean(),
  reasoning: z.string().min(5, 'Verdict reasoning must be at least 5 characters'),
  autoFixable: z.boolean().optional().default(false),
  confidence: z.enum(['high', 'medium', 'low']).optional().default('low'),
});

export const ReviewStrengthSchema = z.object({
  type: z.literal('strength'),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  message: z.string().min(5),
});

export const ReviewIssueSchema = z.object({
  type: z.literal('issue'),
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive(),
  message: z.string().min(5, 'Issue message must be at least 5 characters'),
  suggestion: z.string().optional(),
  inline: z.boolean().optional().default(false),
});

export const ReviewEntrySchema = z.discriminatedUnion('type', [
  ReviewSummarySchema,
  ReviewVerdictSchema,
  ReviewStrengthSchema,
  ReviewIssueSchema,
]);

// ─── Configuration Schema ─────────────────────────────────
export const MCPServerConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['local', 'remote']),
  command: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  environment: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const ProjectContextConfigSchema = z.object({
  description: z.string(),
  conventionsPath: z.string().optional(),
  typecheckCommands: z.array(z.string()).default([]),
  lintCommands: z.array(z.string()).default([]),
  customRules: z.string().optional(),
});

export const ReviewConfigSchema = z.object({
  skipLabels: z.array(z.string()).default(['autofix', 'autofix:approved', 'autofix:merged']),
  skipActors: z.array(z.string()).default(['github-actions[bot]']),
  inline: z.boolean().default(true),
  requireVerdict: z.boolean().default(true),
  commandTriggers: z.array(z.string()).default(['/oc', '/review']),
});

export const AuditConfigSchema = z.object({
  promptsDir: z.string().default('.audit-prompts'),
  targetDirs: z.array(z.string()).default([]),
  autoFix: z.boolean().default(true),
  triggerLabel: z.string().default('autofix-trigger'),
  issueSeverityThreshold: SeveritySchema.default('important'),
});

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

export type ParsedReviewOutput = {
  valid: z.infer<typeof ReviewEntrySchema>[];
  invalid: { line: number; raw: string; error: string }[];
  summary?: string;
  verdict?: { ready: boolean; reasoning: string };
  strengths: z.infer<typeof ReviewStrengthSchema>[];
  issues: z.infer<typeof ReviewIssueSchema>[];
};

/**
 * Parse a JSONL file content into structured review output.
 * Handles malformed lines gracefully — one bad line doesn't corrupt the rest.
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

/**
 * Validate and merge user config with defaults.
 */
export function validateConfig(userConfig: unknown): z.infer<typeof AgentConfigSchema> {
  return AgentConfigSchema.parse(userConfig);
}
