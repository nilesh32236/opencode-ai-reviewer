// Shared types for the OpenCode PR Agent system.
// Used by both the GitHub Action and GitHub App.

// ─── Changelog ───────────────────────────────────────────
/** Configuration for the `/changelog` release-notes command. */
import type { ChangelogConfig } from '../changelog/types.js';
export type { ChangelogConfig } from '../changelog/types.js';

// ─── Severity ─────────────────────────────────────────────
/** Severity levels for review findings. */
export type Severity = 'critical' | 'important' | 'minor';

// ─── Review Output (JSONL) ────────────────────────────────
/** A textual summary of the review. */
export interface ReviewSummary {
  /** Discriminator for summary type */
  type: 'summary';
  /** Markdown summary text */
  text: string;
}

/** A verdict indicating whether the PR is ready to merge. */
export interface ReviewVerdict {
  /** Discriminator for verdict type */
  type: 'verdict';
  /** Whether the PR is ready to merge */
  ready: boolean;
  /** Reasoning behind the verdict */
  reasoning: string;
  /** Whether issues found are auto-fixable */
  autoFixable?: boolean;
  /** Confidence level of the verdict */
  confidence?: 'high' | 'medium' | 'low';
}

/** A positive aspect or strength found in the PR. */
export interface ReviewStrength {
  /** Discriminator for strength type */
  type: 'strength';
  /** Optional file path where the strength was observed */
  file?: string;
  /** Optional line number */
  line?: number;
  /** Description of the strength */
  message: string;
}

/** A review issue or finding requiring attention. */
export interface ReviewIssue {
  /** Discriminator for issue type */
  type: 'issue';
  /** Severity of the issue */
  severity: Severity;
  /** File path where the issue was found */
  file: string;
  /** Line number where the issue was found */
  line: number;
  /** Description of the issue */
  message: string;
  /** Suggested fix for the issue */
  suggestion?: string;
  /** Raw replacement code for GitHub suggestion diff block */
  suggestionCode?: string;
  /** Whether this should be posted as an inline review comment */
  inline?: boolean;
  /** Whether this issue was reported in a previous iteration */
  previouslyReported?: boolean;
  /** GitHub comment ID after posting */
  commentId?: number;
  /** Whether the vulnerability is theoretically reachable (default: false means reachable) */
  theoreticalRisk?: boolean;
  /** Entry point path if the finding is reachable from user input */
  entryPointPath?: string;
  /** File path of the entry point if the finding is reachable from user input */
  entryPointFile?: string;
  /** Confidence level of the finding */
  confidence?: 'high' | 'medium' | 'low';
  /** Category of the finding (e.g. security, performance); defaults to 'general'. */
  category?: string;
  /** Specialized agent that reported this finding (set on the multi-agent path). */
  agent?: AgentCategory;
}

/** Previous fix iteration data for tracking progress across fix cycles. */
export interface PreviousFindingIteration {
  /** Iteration number */
  iteration: number;
  /** Issues reported in this iteration */
  issues: ReviewIssue[];
  /** Summary of the fix applied */
  fixSummary?: string;
  /** Files changed by the fix */
  filesChanged?: string[];
  /** Head SHA after the fix */
  headSha?: string;
  /** GitHub comment IDs posted for this iteration */
  commentIds?: Array<{
    file: string;
    line: number;
    commentId: number;
    nodeId?: string;
  }>;
}

/** Union type of all possible review entry types in JSONL output. */
export type ReviewEntry = ReviewSummary | ReviewVerdict | ReviewStrength | ReviewIssue;

// ─── GitHub Context ───────────────────────────────────────
/** Context parameters for a Pull Request being reviewed. */
export interface PRContext {
  /** Pull request number on GitHub */
  number: number;
  /** Title of the pull request */
  title: string;
  /** Markdown description body of the pull request */
  body: string;
  /** Head branch name */
  headRef: string;
  /** Full name (owner/repo) of the repository hosting the head branch, when
   * known. Differs from the base repo for fork-backed pull requests. */
  headRepoFullName?: string;
  /** Git SHA of the head commit */
  headSha: string;
  /** Base target branch name */
  baseRef: string;
  /** Git SHA of the base commit the PR branches from, when known. */
  baseSha?: string;
  /** GitHub username of the PR author */
  author: string;
  /** List of label names attached to the PR */
  labels: string[];
  /** Changed files included in the PR diff */
  changedFiles: ChangedFile[];
  /** Linked issue number parsed from PR body, if any */
  linkedIssue?: number;
}

/** A file that was changed in a pull request. */
export interface ChangedFile {
  /** File path relative to repo root */
  path: string;
  /** Change status */
  status: 'added' | 'modified' | 'removed' | 'renamed';
  /** Number of added lines */
  additions: number;
  /** Number of deleted lines */
  deletions: number;
  /** Unified diff patch content, if available */
  patch?: string;
}

/** Git blame attribution for a single line of a changed file. */
export interface BlameInfo {
  /** Full commit SHA of the last modification to this line. */
  commitSha: string;
  /** Author of the last modification. */
  author: string;
  /** Date (YYYY-MM-DD) of the last modification. */
  date: string;
  /** Whether the line was introduced by a commit belonging to the current PR. */
  isInPRDiff: boolean;
}

/** Context for a GitHub issue to be processed. */
export interface IssueContext {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue body in markdown */
  body: string;
  /** Label names attached to the issue */
  labels: string[];
  /** Comments on the issue */
  comments: IssueComment[];
}

/** A comment on a GitHub issue. */
export interface IssueComment {
  /** GitHub API database ID of the comment */
  id: number;
  /** GitHub username of the comment author */
  author: string;
  /** ISO 8601 timestamp when the comment was created */
  createdAt: string;
  /** Comment body in markdown */
  body: string;
}

/** A review comment posted on a PR. */
export interface ReviewComment {
  /** GitHub username of the comment author */
  author: string;
  /** File path the comment refers to */
  path: string;
  /** Optional line number the comment refers to */
  line?: number;
  /** Comment body in markdown */
  body: string;
}

// ─── Configuration ────────────────────────────────────────
/** Supported Git hosting platforms. */
export type Platform = 'github' | 'gitlab';

/** Supported documentation comment styles. */
export const DOC_STYLES = ['jsdoc', 'tsdoc', 'rest', 'doxygen', 'numpy', 'auto'] as const;

/** Documentation comment style supported by the `/docs` command. */
export type DocStyle = (typeof DOC_STYLES)[number];

/**
 * Check whether a value is a supported documentation style.
 * @param value - Candidate style value.
 * @returns True when the value is a `DocStyle`.
 */
export function isDocStyle(value: unknown): value is DocStyle {
  return typeof value === 'string' && (DOC_STYLES as readonly string[]).includes(value);
}

/** Configuration for the `/docs` documentation-generation command. */
export interface DocsConfig {
  /** Whether the docs command is enabled (default: false). */
  enabled: boolean;
  /** Doc comment style to fall back to when a file has no existing convention (default: 'auto'). */
  style: DocStyle;
}

/** Configuration for the `/describe` PR-description command. */
export interface DescribeConfig {
  /** Whether the describe command is enabled (default: true). */
  enabled: boolean;
  /** Optional model override for PR description generation (defaults to `describeModel` / `reviewModel`). */
  model?: string;
}

// ─── Custom LLM Providers ───────────────────────────────
/** Supported custom LLM provider types. */
export type LLMProviderType = 'openai-compatible' | 'azure' | 'bedrock' | 'ollama';

/**
 * Configuration for a single custom LLM provider.
 *
 * `openai-compatible` and `ollama` providers are injected into the OpenCode
 * CLI config (`OPENCODE_CONFIG_CONTENT`) as a `provider` map entry backed by
 * the `@ai-sdk/openai-compatible` adapter, so any OpenAI-compatible API
 * (self-hosted gateways, Ollama, vLLM, etc.) works out of the box. `azure` and
 * `bedrock` use the CLI's built-in providers: their settings are translated
 * into the standard `AZURE_*` / `AWS_*` environment variables the CLI and AI
 * SDK already read.
 */
export interface LLMProviderConfig {
  /** Provider type. */
  type: LLMProviderType;
  /** Custom base URL for OpenAI-compatible APIs (e.g. "https://llm.corp.example/v1"). */
  baseUrl?: string;
  /**
   * API key. May reference an environment variable via the OpenCode CLI
   * `{env:VAR_NAME}` substitution syntax to avoid committing secrets to the
   * config file (e.g. "{env:INTERNAL_LLM_KEY}").
   */
  apiKey?: string;
  /** Azure OpenAI endpoint URL (e.g. "https://my-resource.openai.azure.com"). */
  endpoint?: string;
  /** Azure OpenAI resource name (alternative to a full endpoint URL). */
  resourceName?: string;
  /** Azure OpenAI API version (default: "2024-02-15-preview"). */
  apiVersion?: string;
  /** Azure OpenAI deployment name (used as the model id via "azure/<deployment>"). */
  deployment?: string;
  /** AWS Bedrock model ID (e.g. "us.anthropic.claude-sonnet-4-5-v2:0"). */
  modelId?: string;
  /** AWS region for Bedrock (defaults to the AWS_REGION env var). */
  region?: string;
  /** Ollama model name (e.g. "llama3", "codellama"). */
  model?: string;
  /** Model names exposed by this provider (OpenAI-compatible / Ollama). */
  models?: string[];
}

/**
 * Configuration for custom LLM providers.
 *
 * Declares a map of provider id → provider configuration, mirroring the
 * OpenCode CLI's `provider` config section so a single provider (or several)
 * can serve any OpenAI-compatible, Azure, Bedrock, or Ollama model. The
 * `defaultProvider` is an optional convenience that prefixes bare model names
 * (e.g. model "llama3" with defaultProvider "ollama" resolves to
 * "ollama/llama3").
 */
export interface LLMConfig {
  /** Optional provider used to prefix bare model names (e.g. "ollama", "azure"). */
  defaultProvider?: string;
  /** Map of provider id → provider configuration. */
  providers?: Record<string, LLMProviderConfig>;
}

/** Top-level agent configuration for reviews, fixes, audits, and learning. */
export interface AgentConfig {
  /** Platform to use (github or gitlab, defaults to github). */
  platform?: Platform;
  /** Model to use for reviews */
  reviewModel: string;
  /** Model to use for fixes */
  fixModel: string;
  /** Model to use for audit */
  auditModel?: string;
  /** Model to use for documentation generation */
  docsModel?: string;
  /** Model to use for synthesis of collated batch results */
  synthesisModel?: string;
  /** Model to use for meta-verification (false-positive filtering) */
  verificationModel?: string;
  /** Model to use for meta-review quality evaluation */
  metaReviewModel?: string;
  /** Model to use for PR explanation */
  explanationModel?: string;
  /** Model to use for interactive conversation */
  conversationModel?: string;
  /** Model to use for issue analysis */
  analysisModel?: string;
  /** Model to use for PR description generation */
  describeModel?: string;
  /** Max files per sub-agent batch */
  batchSize: number;
  /** Max diff lines per file in context (0 = unlimited) */
  maxLinesPerFile: number;
  /** Max review-fix iterations */
  maxIterations: number;
  /** Max execution timeout in minutes */
  timeoutMinutes?: number;
  /** Whether to use MCP servers for context enrichment */
  enableMCP: boolean;
  /** MCP server configurations */
  mcpServers: MCPServerConfig[];
  /** Project-specific context */
  projectContext: ProjectContextConfig;
  /** Review behavior */
  review: ReviewConfig;
  /** Audit behavior */
  audit: AuditConfig;
  /** Documentation generation behavior */
  docs?: DocsConfig;
  /** PR description generation behavior */
  describe: DescribeConfig;
  /** Changelog / release-notes generation behavior */
  changelog?: ChangelogConfig;
  /** Learning behavior */
  learning: LearningConfig;
  /** Conversation / @mention behavior */
  conversation: ConversationConfig;
  /** Linter configurations for hybrid analysis */
  linters: LinterConfig[];
  /** Rate limiting behavior for the Probot app */
  rateLimiting: RateLimitingConfig;
  /** Structured event logging configuration for the event bus. */
  eventLogging?: EventLoggingConfig;
  /** Pluggable event subscribers to register at startup. */
  eventSubscribers?: PluggableSubscriberConfig[];
  /** Webhook notification configuration for Slack/Teams. */
  notifications?: NotificationsConfig;
  /** Multi-agent review architecture with specialized agents (opt-in, default disabled). */
  multiAgent?: MultiAgentConfig;
  /** Deterministic hardcoded secret / credential scanning (default: enabled). */
  secrets?: SecretDetectorConfig;
  /** Deterministic Software Composition Analysis (SCA) of changed dependency lock files (default: enabled). */
  sca?: SCAConfig;
  /** Custom LLM providers (self-hosted OpenAI-compatible, Azure, Bedrock, Ollama). */
  llm?: LLMConfig;
}

// ─── Multi-Agent Architecture ────────────────────────────
/** Domain category of a specialized review agent. */
export type AgentCategory = 'security' | 'performance' | 'quality' | 'logic';

/** Per-agent runtime configuration. */
export interface MultiAgentAgentConfig {
  /** Whether this agent participates in multi-agent reviews (default: true). */
  enabled: boolean;
  /** Optional model override for this agent (defaults to `reviewModel`). */
  model?: string;
  /** Optional path to a custom prompt file that replaces the built-in agent prompt. */
  promptFile?: string;
}

/** Configuration for the multi-agent review architecture. */
export interface MultiAgentConfig {
  /** Master switch; multi-agent mode is opt-in (default: false). */
  enabled: boolean;
  /** Per-category agent configuration. Unlisted categories are enabled by default. */
  agents: Partial<Record<AgentCategory, MultiAgentAgentConfig>>;
  /** Synthesis agent that consolidates per-agent findings into the final review. */
  synthesis: {
    /** Whether the synthesis pass runs (default: true — always consolidate). */
    enabled: boolean;
    /** Optional model override for the synthesis agent (defaults to `synthesisModel`). */
    model?: string;
  };
}

/** A review finding attributed to a specific specialized agent. */
export interface AgentFinding extends ReviewIssue {
  /** The specialized agent category that produced this finding. */
  agent: AgentCategory;
}

/** The outcome of a single specialized agent's review pass. */
export interface AgentResult {
  /** The agent category that produced this result. */
  agent: AgentCategory;
  /** Findings reported by the agent (each carries its originating agent). */
  findings: AgentFinding[];
  /** Strengths reported by the agent. */
  strengths: ReviewStrength[];
  /** Raw JSONL output produced by the agent. */
  rawOutput: string;
  /** Number of malformed/parse-failed JSONL lines in the agent's output. */
  failedLines?: number;
  /** Wall-clock duration of the agent run in milliseconds. */
  durationMs: number;
  /** Total tokens consumed by the agent run. */
  tokensUsed: number;
  /** Whether the agent run completed successfully. */
  success: boolean;
  /** Error message when the agent run failed. */
  error?: string;
}

/** Default multi-agent configuration (opt-in, all agents enabled when active). */
export const DEFAULT_MULTI_AGENT_CONFIG: MultiAgentConfig = {
  enabled: false,
  agents: {
    security: { enabled: true },
    performance: { enabled: true },
    quality: { enabled: true },
    logic: { enabled: true },
  },
  synthesis: { enabled: true },
};

/** Configuration for the built-in event logging subscriber. */
export interface EventLoggingConfig {
  /** Whether structured event logging to a JSONL file is enabled (default: false). */
  enabled: boolean;
  /** Path to the structured event log file (default: `.opencode/events.ndjson`). */
  path?: string;
}

/** Configuration for a pluggable event subscriber loaded from a module path. */
export interface PluggableSubscriberConfig {
  /** Display name for the subscriber (used for logging and health tracking). */
  name: string;
  /** Module path exporting the subscriber (default, `subscriber`, or `createSubscriber` export). */
  path: string;
}

/** Configuration for Slack incoming-webhook notifications. */
export interface SlackConfig {
  /** Slack incoming webhook URL (e.g. https://hooks.slack.com/services/...). */
  webhookUrl?: string;
  /** Optional channel override (e.g. "#code-reviews"). */
  channel?: string;
}

/** Configuration for Microsoft Teams incoming-webhook notifications. */
export interface TeamsConfig {
  /** Teams Office 365 connector or workflow webhook URL. */
  webhookUrl?: string;
}

/** Configuration for webhook-based review notifications to Slack/Teams. */
export interface NotificationsConfig {
  /** Master switch; notifications are only sent when explicitly enabled (default: false). */
  enabled?: boolean;
  /** Minimum severity required before a notification is sent (default: 'critical'). */
  minSeverity?: Severity;
  /** Slack incoming-webhook settings. */
  slack?: SlackConfig;
  /** Microsoft Teams webhook settings. */
  teams?: TeamsConfig;
}

/** Configuration for an MCP server used for context enrichment. */
export interface MCPServerConfig {
  /** Name of the MCP server */
  name: string;
  /** Server type — local process or remote URL */
  type: 'local' | 'remote';
  /** Command and arguments for local servers */
  command?: string[];
  /** URL for remote servers */
  url?: string;
  /** Environment variables for local servers */
  environment?: Record<string, string>;
  /** Connection timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /** Whitelist of allowed tool name patterns. Defaults to ['resolve', 'search'] if unset */
  allowedTools?: string[];
  /** Allowlist of env var names forwarded from the parent process to a local subprocess.
   * Keys must exactly match the env var names and are case-sensitive on POSIX. When unset,
   * a built-in safe default set is used; an explicit empty array forwards no parent variables.
   * `environment` vars are always merged on top. */
  allowedEnv?: string[];
}

/** Project-level context config fed into review prompts. */
export interface ProjectContextConfig {
  /** Project description for the prompt */
  description: string;
  /** Path to AGENTS.md or equivalent convention doc */
  conventionsPath?: string;
  /** Commands to run for type checking */
  typecheckCommands: string[];
  /** Commands to run for linting */
  lintCommands: string[];
  /** Custom rules to append to the prompt */
  customRules?: string;
}

/** Configuration for token budget-based context allocation. */
export interface TokenBudgetConfig {
  /** Whether token budget optimization is enabled (opt-in) */
  enabled: boolean;
  /** Max diff lines per file for complex files (high complexity score) */
  maxLinesComplex: number;
  /** Max diff lines per file for simple files (low complexity score) */
  maxLinesSimple: number;
  /** Complexity score threshold above which a file is considered complex */
  complexityThreshold: number;
  /** Complexity score threshold below which a file is considered simple */
  simpleThreshold: number;
}

/** Metrics tracked for token budget savings logging. */
export interface TokenBudgetMetrics {
  /** Total lines that would have been used with equal allocation */
  baselineLines: number;
  /** Total lines actually used with token budget */
  budgetedLines: number;
  /** Number of files classified as simple */
  simpleCount: number;
  /** Number of files classified as medium (interpolation range) */
  mediumCount: number;
  /** Number of files classified as complex */
  complexCount: number;
}

/** Budget review mode determined by diff size. */
export type ReviewBudgetMode = 'full' | 'summary' | 'split';

/** Configuration for budget-based review of large PRs. */
export interface ReviewBudgetConfig {
  /** Enable budget-based review adaptation (default: false — opt-in) */
  enabled: boolean;
  /** Diff line threshold for summary-only mode (default: 500) */
  summaryThreshold: number;
  /** Diff line threshold for split recommendation mode (default: 1000) */
  splitThreshold: number;
}

/** Detail level for exposing token usage / cost data to users. */
export type CostTrackingVerbosity = 'off' | 'summary' | 'detailed';

/** Configuration for token usage / cost tracking exposure. */
export interface CostTrackingConfig {
  /** Whether token usage and cost data are surfaced to users (default: false) */
  enabled?: boolean;
  /** How much detail to expose: 'off' (nothing), 'summary' (totals), 'detailed' (totals + prompt/completion breakdown) */
  verbosity?: CostTrackingVerbosity;
  /** Cost per 1K input tokens in USD (used for cost estimation) */
  inputCostPer1K?: number;
  /** Cost per 1K output tokens in USD (used for cost estimation) */
  outputCostPer1K?: number;
}

/** Token usage and cost data accumulated for a review pipeline run. */
export interface TokenUsage {
  /** Total number of tokens consumed across all model calls */
  totalTokens: number;
  /** Total prompt (input) tokens, when parseable */
  promptTokens?: number;
  /** Total completion (output) tokens, when parseable */
  completionTokens?: number;
  /** Total wall-clock duration of the run in milliseconds */
  durationMs: number;
  /** Estimated cost of the run in USD, when rates are configured or the model is known */
  estimatedCost?: number;
}

/** Configuration for review behavior. */
/** Minimum severity floor options for per-repository sensitivity configuration. */
export type MinSeverity = 'warning' | 'error' | 'critical';

/** Confidence floor options for per-repository sensitivity configuration. */
export type ConfidenceThreshold = 'low' | 'medium' | 'high';

/** Per-category override for review sensitivity. */
export interface CategoryOverride {
  /** Minimum severity floor for this category (overrides the global `minSeverity`). */
  minSeverity?: MinSeverity;
  /** Whether findings in this category are enabled (default: true). */
  enabled?: boolean;
  /** Maximum findings kept for this category (overrides `maxFindingsPerCategory`). */
  maxFindings?: number;
}

/** Per-repository sensitivity configuration for tuning reviewer strictness. */
export interface ReviewSensitivityConfig {
  /** Minimum severity floor: 'warning' keeps everything, 'error' drops minor, 'critical' keeps only critical. */
  minSeverity?: MinSeverity;
  /** Confidence floor: 'low' keeps everything, 'medium' drops low-confidence, 'high' keeps only high-confidence. */
  confidenceThreshold?: ConfidenceThreshold;
  /** Maximum findings kept per category (highest severity first). */
  maxFindingsPerCategory?: number;
  /** Maximum total findings kept (highest severity first). */
  maxTotalFindings?: number;
  /** If set, only findings whose category matches one of these are kept. */
  focusAreas?: string[];
  /** Glob patterns applied to finding file paths. */
  ignorePatterns?: string[];
}

/** Severity threshold for failing the action/check run when findings at or above
 * this severity are found. `'off'` disables failure from findings entirely. */
export type FailOnSeverity = 'off' | 'critical' | 'important' | 'minor';

/** Main review configuration controlling what is reviewed and how findings are reported. */
export interface ReviewConfig {
  /** Skip review for PRs with these labels */
  skipLabels: string[];
  /** Skip review for these actors */
  skipActors: string[];
  /** Whether to post findings as inline review comments on the PR diff */
  inline: boolean;
  /** Whether to require a verdict */
  requireVerdict: boolean;
  /** Command triggers (e.g., /oc, /review) */
  commandTriggers: string[];
  /** Glob patterns for files to exclude from review (e.g., lockfiles, generated code) */
  excludePatterns: string[];
  /** Whether to run a meta-verification pass that drops false-positive findings */
  enableMetaVerification: boolean;
  /** Whether to run test-gap detection that flags code changes lacking
   * corresponding test updates and surfaces structured gap context to the
   * review prompt (default: false). */
  enableTestGapDetection: boolean;
  /** Whether to suppress low-confidence findings from review output */
  suppressLowConfidence?: boolean;
  /** Whether to enable lightweight reachability analysis on security findings */
  enableReachability: boolean;
  /** Whether to index the codebase and enrich the review prompt with cross-file context */
  enableCodebaseIndex?: boolean;
  /** Whether to include pre-existing (non-PR) code in reviews at full audit priority.
   * When false (default), git blame annotations are injected into the prompt so the
   * model deprioritizes issues on lines that predate the PR. */
  includePreExisting?: boolean;
  /** Token budget configuration for smart context allocation */
  tokenBudget?: TokenBudgetConfig;
  /** Budget-based review configuration for large PRs */
  reviewBudget?: ReviewBudgetConfig;
  /** Token usage / cost tracking configuration */
  costTracking?: CostTrackingConfig;
  /** Per-repository sensitivity configuration for tuning reviewer strictness */
  sensitivity?: ReviewSensitivityConfig;
  /** Per-category overrides for review sensitivity */
  categories?: Record<string, CategoryOverride>;
  /** Severity threshold at or above which the action/check run fails
   * (default: 'critical'). Use 'off' to never fail from findings. */
  failOnSeverity: FailOnSeverity;
  /** Whether to post a conventional-commit title and label suggestion comment
   * after review (default: false). Read-only — the suggestion never modifies
   * the PR directly; it only suggests via a comment. */
  suggestTitleAndLabels?: boolean;
  /** Whether to post review findings incrementally as each file batch completes
   * (default: false). When true, findings appear progressively instead of only
   * after the full review finishes. */
  streamComments?: boolean;
  /** Number of findings to accumulate before posting a streaming batch
   * (default: 0 = post per-batch as soon as the batch completes). */
  streamBatchSize?: number;
}

/** Configuration for deterministic hardcoded secret / credential scanning. */
export interface SecretDetectorConfig {
  /** Whether static secret detection runs during review and audit (default: true). */
  enabled: boolean;
  /** Shannon entropy floor above which a long token is flagged as a possible
   * secret (default: 4.5). */
  entropyThreshold: number;
  /** Minimum token length considered for generic high-entropy detection (default: 32). */
  minLength: number;
  /** Values that should never be flagged. Each entry is matched as a literal
   * substring against the raw token and its redacted form, or compiled as a
   * RegExp when prefixed with `/` (e.g. `/test-token-[a-z]+/`). */
  allowlist: string[];
  /** When true, the GitHub Action fails when any hardcoded secret is detected
   * (default: false — findings still block via `review.failOnSeverity: critical`). */
  failCI: boolean;
  /** Glob patterns for files to skip during the secret scan (in addition to the
   * review `excludePatterns`). */
  excludePatterns: string[];
}

/** Ecosystem identifier used when querying the OSV advisory database. The
 * values match OSV's canonical ecosystem casing (case-sensitive on the API). */
export type Ecosystem = 'npm' | 'PyPI' | 'crates.io' | 'Go' | 'RubyGems';

/** A single dependency resolved from a changed lock file. */
export interface SCADependency {
  /** Repo-relative path of the lock file the dependency was parsed from. */
  file: string;
  /** 1-based line number in the new-file where the dependency/version appears. */
  line: number;
  /** Package name as it appears in the lock file. */
  name: string;
  /** Exact pinned version detected in the lock file. */
  version: string;
  /** OSV ecosystem the package belongs to. */
  ecosystem: Ecosystem;
}

/** A known vulnerability returned by the OSV advisory database for a dependency. */
export interface SCAVulnerability {
  /** The changed dependency this advisory applies to. */
  dependency: SCADependency;
  /** OSV advisory ID (e.g. `GHSA-xxxx-xxxx-xxxx`). */
  id: string;
  /** CVE IDs aliased by this advisory (empty when only a GHSA id exists). */
  cveIds: string[];
  /** Human-readable advisory summary from OSV. */
  summary: string;
  /** Project severity derived from the CVSS score / database severity. */
  severity: Severity;
  /** Raw CVSS v3 score when the advisory carries one. */
  cvssScore?: number;
  /** Best-known patched version for the affected dependency, when known. */
  fixedVersion?: string;
  /** Advisory reference URLs. */
  references: string[];
}

/** Configuration for deterministic Software Composition Analysis (SCA). */
export interface SCAConfig {
  /** Whether the SCA pass runs during review when lock files change (default: true). */
  enabled: boolean;
  /** Minimum severity at or above which findings are reported (default: 'important'). */
  minSeverity: Severity;
  /** Glob patterns identifying dependency lock files to scan. */
  lockFilePatterns: string[];
  /** Glob patterns for lock files to skip during the SCA scan. */
  excludePatterns: string[];
}

/** Default glob patterns for the lock files supported by the SCA pass. */
export const DEFAULT_SCA_LOCK_FILE_PATTERNS: string[] = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/requirements.txt',
  '**/go.sum',
  '**/Gemfile.lock',
];

// ─── Conversation / @mention ─────────────────────────────
/** Configuration for the interactive conversation / @mention feature. */
export interface ConversationConfig {
  /** The mention handle to trigger on (without @) */
  mentionHandle: string;
  /** Whether to enable conversation mode */
  enabled: boolean;
  /** Max conversation turns (assistant responses) before auto-close. 0 = unlimited. */
  maxTurns: number;
  /** Number of most recent messages to keep in full when summarizing older context */
  slidingWindowSize: number;
  /** Token budget for the full conversation prompt (~75% of the model limit) */
  contextTokenBudget: number;
  /** Optional model override for summarization calls (defaults to conversation/review model) */
  summarizationModel?: string;
  /** Whether the `/ask` follow-up command is enabled (default: true). */
  askCommandEnabled?: boolean;
  /** Maximum code references resolved into context from a single message (default: 5). */
  maxCodeReferences?: number;
}

/** Tier of a rate-limited action. */
export type RateLimitTier = 'command' | 'interactive';

/** Configuration for rate limiting in the Probot app. */
export interface RateLimitingConfig {
  /** Master switch for rate limit enforcement (default: true). */
  enabled: boolean;
  /** Max command-tier reviews per repository per hour (default: 10). */
  reviewsPerRepoPerHour: number;
  /** Max reviews (all tiers combined) per GitHub user per day (default: 50). */
  reviewsPerUserPerDay: number;
  /** Minimum minutes between command-tier actions on the same PR (default: 2). */
  prCooldownMinutes: number;
  /** Minimum seconds between interactive actions on the same PR (default: 30). */
  conversationCooldownSeconds: number;
  /** Max estimated tokens consumed per rolling day across all actions (default: 500000). */
  dailyTokenBudget: number;
  /** Estimated tokens charged per command-tier action (default: 25000). */
  estimatedTokensPerCommand: number;
  /** Estimated tokens charged per interactive action (default: 5000). */
  estimatedTokensPerInteractive: number;
  /** GitHub usernames allowed to run /rate-limits and /rate-limits-reset commands. */
  adminUsers: string[];
  /** How long rate-limit rows are retained before cleanup (hours, default: 48). */
  retentionHours: number;
}

/** Intent of a conversation interaction. */
export type ConversationIntent = 'explain' | 'fix' | 'general';

/** A `file:line` code reference extracted from a conversation message. */
export interface CodeReference {
  /** File path relative to repo root (e.g. `src/foo.ts`). */
  file: string;
  /** Single line number, when referenced as `file:line`. */
  line?: number;
  /** End line of a range, when referenced as `file:start-end`. */
  endLine?: number;
}

/** A single message in a conversation thread. */
export interface ConversationMessage {
  /** Role of the message author */
  role: 'user' | 'assistant';
  /** The message body (markdown) */
  body: string;
  /** GitHub username of the author */
  author?: string;
}

/** Context for an interactive conversation on a PR comment. */
export interface ConversationContext {
  /** Unique identifier for the conversation thread (repo+pr+file), when known */
  threadId?: string;
  /** Repository in "owner/repo" format (used to build collision-free fallback thread ids) */
  repo?: string;
  /** File path the comment is attached to (for review comments) */
  filePath?: string;
  /** Diff hunk context around the comment */
  diffHunk?: string;
  /** Full conversation thread */
  thread: ConversationMessage[];
  /** PR context for understanding the broader change */
  prContext: PRContext;
  /** Detected intent of the user's request */
  intent: ConversationIntent;
  /** Resolved `file:line` code references mentioned in the latest message. */
  codeReferences?: CodeReference[];
}

/**
 * Tracks state for an active conversation thread so long-running
 * conversations can be summarized and auto-closed gracefully.
 */
export interface ConversationState {
  /** Unique identifier for the conversation thread (repo+pr+thread-root-id) */
  threadId: string;
  /** Number of assistant responses posted so far */
  turnCount: number;
  /** Unix timestamp of the last message */
  lastActivityTimestamp: number;
  /** Previously generated summary of older messages (before sliding window) */
  summarySnapshot?: string;
  /** Number of older messages covered by the current summary snapshot */
  summarizedCount?: number;
  /** Whether the thread has already been auto-closed (avoid duplicate close messages) */
  alreadyClosed?: boolean;
}

/** Configuration for audit behavior. */
export interface AuditConfig {
  /** Audit prompt directory */
  promptsDir: string;
  /** Target directories for audit */
  targetDirs: string[];
  /** Whether to auto-trigger fixes */
  autoFix: boolean;
  /** Label for triggering fixes */
  triggerLabel: string;
  /** Severity threshold for creating issues */
  issueSeverityThreshold: Severity;
}

// ─── MCP Context Enrichment ───────────────────────────────
/** A single entry from MCP context enrichment. */
export interface MCPContextEntry {
  /** Source server name */
  source: string;
  /** Enriched context content */
  content: string;
  /** Relevance score from 0 to 1 */
  relevance: number;
}

/** Result of querying MCP servers for context enrichment. */
export interface MCPQueryResult {
  /** Retrieved context entries */
  entries: MCPContextEntry[];
  /** Total token count consumed */
  totalTokens: number;
}

// ─── Action/App Inputs ────────────────────────────────────
/** Input parameters for the review action/app. */
export interface ReviewInput {
  /** Pull request number to review */
  prNumber?: number;
  /** Repository in owner/repo format */
  repo?: string;
  /** Model identifier to use */
  model?: string;
  /** GitHub token for API access */
  githubToken: string;
  /** Platform identifier (github or gitlab). */
  platform?: Platform;
  /** Optional partial config overrides */
  config?: Partial<AgentConfig>;
}

/** Input parameters for the fix action/app. */
export interface FixInput {
  /** Pull request number to fix */
  prNumber: number;
  /** Repository in owner/repo format */
  repo: string;
  /** Model identifier to use */
  model?: string;
  /** GitHub token for API access */
  githubToken: string;
  /** Platform identifier (github or gitlab). */
  platform?: Platform;
  /** Current fix iteration number */
  iteration: number;
}

/** Input parameters for the audit action/app. */
export interface AuditInput {
  /** Target directory for audit scan */
  targetDir?: string;
  /** Prompt name to use */
  promptName?: string;
  /** Whether to auto-apply fixes */
  autoFix: boolean;
  /** Repository in owner/repo format */
  repo: string;
  /** GitHub token for API access */
  githubToken: string;
  /** Platform identifier (github or gitlab). */
  platform?: Platform;
}

// ─── JSONL Finding Types ──────────────────────────────────
/** Discriminated type for JSONL review findings. */
export type FindingType = 'summary' | 'verdict' | 'strength' | 'issue' | 'executive_summary';

/** Base interface for all finding types. */
export interface BaseFinding {
  /** Discriminator field */
  type: FindingType;
}

/** A summary finding in JSONL format. */
export interface SummaryFinding extends BaseFinding {
  /** Discriminator for summary finding */
  type: 'summary';
  /** Summary text */
  text: string;
}

/** A verdict finding in JSONL format. */
export interface VerdictFinding extends BaseFinding {
  /** Discriminator for verdict finding */
  type: 'verdict';
  /** Whether the PR is ready to merge */
  ready: boolean;
  /** Reasoning for the verdict */
  reasoning: string;
  /** Whether issues are auto-fixable */
  autoFixable?: boolean;
  /** Confidence level */
  confidence?: 'high' | 'medium' | 'low';
}

/** A strength finding in JSONL format. */
export interface StrengthFinding extends BaseFinding {
  /** Discriminator for strength finding */
  type: 'strength';
  /** Optional file path */
  file?: string;
  /** Optional line number */
  line?: number;
  /** Strength description */
  message: string;
}

/** An issue finding in JSONL format. */
export interface IssueFinding extends BaseFinding {
  /** Discriminator for issue finding */
  type: 'issue';
  /** Issue severity */
  severity: Severity;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Issue description */
  message: string;
  /** Suggested fix */
  suggestion?: string;
  /** Raw replacement code for GitHub suggestion diff block */
  suggestionCode?: string;
  /** Whether to post inline */
  inline?: boolean;
  /** Whether previously reported */
  previouslyReported?: boolean;
  /** Whether the vulnerability is theoretically reachable (default: false means reachable) */
  theoreticalRisk?: boolean;
  /** Entry point path if the finding is reachable from user input */
  entryPointPath?: string;
  /** File path of the entry point if the finding is reachable from user input */
  entryPointFile?: string;
  /** Confidence level of the finding */
  confidence?: 'high' | 'medium' | 'low';
  /** Category of the finding (e.g. security, performance); defaults to 'general'. */
  category?: string;
  /** Specialized agent that reported this finding (parsed from the JSONL `agent` field). */
  agent?: AgentCategory;
}

/** An executive summary finding in JSONL format. */
export interface ExecutiveSummaryFinding extends BaseFinding {
  /** Discriminator for executive summary finding */
  type: 'executive_summary';
  /** 1-2 sentence description of the PR's core purpose */
  purpose: string;
  /** Risk level assessment */
  riskLevel: 'low' | 'medium' | 'high';
  /** Reasoning for the risk level */
  riskRationale: string;
  /** List of breaking changes (empty if none) */
  breakingChanges: string[];
}

/** Union type of all possible JSONL finding types. */
export type Finding =
  | SummaryFinding
  | VerdictFinding
  | StrengthFinding
  | IssueFinding
  | ExecutiveSummaryFinding;

// ─── Results ──────────────────────────────────────────────
/** Executive summary with risk assessment for a PR. */
export interface ExecutiveSummary {
  /** 1-2 sentence description of the PR's core purpose */
  purpose: string;
  /** Risk level assessment */
  riskLevel: 'low' | 'medium' | 'high';
  /** Reasoning for the risk level */
  riskRationale: string;
  /** List of breaking changes (empty if none) */
  breakingChanges: string[];
}

/** Result of a pull request code review pass. */
export interface ReviewResult {
  /** Summary of the review pass */
  summary: string;
  /** Verdict with readiness decision */
  verdict: {
    /** Whether the PR is ready to merge */
    ready: boolean;
    /** Reasoning behind the verdict */
    reasoning: string;
    /** Whether issues found are auto-fixable */
    autoFixable: boolean;
    /** Confidence level */
    confidence: 'high' | 'medium' | 'low';
  };
  /** Strengths identified during review */
  strengths: ReviewStrength[];
  /** Issues identified during review */
  issues: ReviewIssue[];
  /** Statistics about the review findings */
  stats: {
    /** Total number of findings */
    total: number;
    /** Number of critical issues */
    critical: number;
    /** Number of important issues */
    important: number;
    /** Number of minor issues */
    minor: number;
    /** Number of high-confidence issues */
    highConfidence?: number;
    /** Number of medium-confidence issues */
    mediumConfidence?: number;
    /** Number of low-confidence issues */
    lowConfidence?: number;
  };
  /** Raw JSONL lines from the model output */
  rawLines?: string[];
  /** Number of lines that failed to parse */
  failedLines?: number;
  /** Number of file batches whose review failed (review is partial when > 0) */
  failedBatches?: number;
  /** Number of specialized agents that failed (multi-agent path; partial when > 0) */
  failedAgents?: number;
  /** True when this result is a dedup short-circuit (already reviewed / in-flight)
   * rather than a real review pass. Callers should treat it as a no-op success,
   * NOT as "no meaningful content" or a failure. */
  skipped?: boolean;
  /** Optional executive summary with risk assessment */
  executiveSummary?: ExecutiveSummary;
  /** Optional token usage / cost data accumulated for this run (server-side, not AI-derived) */
  usage?: TokenUsage;
}

/** Result of an auto-fix operation. */
export interface FixResult {
  /** Whether any file changes were made */
  changesMade: boolean;
  /** Files that were modified by the fix */
  filesChanged: string[];
  /** Whether the fix got stuck */
  stuck?: boolean;
  /** Reason for getting stuck, if applicable */
  stuckReason?: string;
  /** Summary of changes made */
  summary?: string;
}

/** Result of a self-heal operation that diagnoses and fixes CI failures. */
export interface SelfHealResult {
  /** Whether any file changes were made */
  changesMade: boolean;
  /** Files that were modified by the heal */
  filesChanged: string[];
  /** Root cause diagnosis (e.g., 'build-error', 'test-failure', 'lint-error', 'dependency-issue') */
  diagnosis?: string;
  /** Detailed diagnostic report in markdown */
  diagnosticReport?: string;
  /** Summary of changes made */
  summary?: string;
}

/** Result of a codebase audit. */
export interface AuditResult {
  /** Category name of the audit */
  category: string;
  /** Target directory that was audited */
  targetDir: string;
  /** Markdown summary of findings */
  summary: string;
  /** Issues found during audit */
  issues: ReviewIssue[];
  /** Statistics about audit findings */
  stats: {
    /** Number of critical issues */
    critical: number;
    /** Number of important issues */
    important: number;
    /** Number of minor issues */
    minor: number;
  };
  /** GitHub issue number created from findings, if any */
  issueCreated?: number;
}

// ─── Analyze Result ────────────────────────────────────────
/** Structured analysis plan for implementing a fix from an issue. */
export interface AnalysisPlan {
  /** Issue number being analyzed */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** Priority of the fix */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Brief summary of the analysis */
  summary: string;
  /** Files that need to be modified */
  affectedFiles: string[];
  /** Step-by-step implementation steps */
  implementationPlan: string[];
  /** Optional suggestions or alternatives */
  suggestions?: string[];
  /** Questions for the maintainer */
  questionsForMaintainer?: string[];
}

/** Result of an issue analysis. */
export interface AnalyzeResult {
  /** Issue number */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** Priority of the fix */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Summary of the analysis */
  summary: string;
  /** Files that need to be modified */
  affectedFiles: string[];
  /** Step-by-step implementation plan */
  implementationPlan: string[];
  /** Optional suggestions or alternatives */
  suggestions?: string[];
  /** Questions for the maintainer */
  questionsForMaintainer?: string[];
  /** Raw markdown of the analysis report */
  rawMarkdown: string;
}

/** Structured PR description generated by the `describe` mode. */
export interface DescribeResult {
  /** PR number being described. */
  prNumber: number;
  /** Suggested PR title (conventional-commit style). */
  title: string;
  /** Change overview grouped by component/area. */
  changeOverview: string;
  /** Testing guidance for the PR. */
  testingNotes: string;
  /** List of breaking changes (empty when none). */
  breakingChanges: string[];
  /** Suggested GitHub labels. */
  suggestedLabels: string[];
  /** Suggested conventional-commit title. */
  suggestedConventionalCommitTitle: string;
  /** Raw markdown of the generated PR description. */
  rawMarkdown: string;
}

// ─── Prompt Template ──────────────────────────────────────
/** A named prompt template for review/audit generation. */
export interface PromptTemplate {
  /** Template name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Function that builds the prompt string from context */
  buildPrompt: (context: PromptContext) => string;
}

/** Context data injected into prompt templates. */
export interface PromptContext {
  /** PR context, if applicable */
  pr?: PRContext;
  /** Issue context, if applicable */
  issue?: IssueContext;
  /** Existing review comments on the PR */
  reviewComments?: ReviewComment[];
  /** Audit target directory */
  auditTarget?: string;
  /** MCP-enriched context */
  mcpContext?: MCPContextEntry[];
  /** Project-level configuration */
  projectContext: ProjectContextConfig;
  /** Current fix iteration number */
  iteration?: number;
  /** Custom instructions appended to the prompt */
  customInstructions?: string;
}

// ─── Action Mode ──────────────────────────────────────────
/** Operating mode of the action/app. */
export type ActionMode =
  | 'review'
  | 'fix'
  | 'audit'
  | 'post'
  | 'analyze'
  | 'self-heal'
  | 'setup'
  | 'docs'
  | 'describe'
  | 'changelog';

// ─── Issue Details ────────────────────────────────────────
/** Details of a GitHub issue. */
export interface IssueDetails {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue body in markdown */
  body: string;
  /** Label names */
  labels: string[];
  /** Issue state (open, closed) */
  state: string;
}

// ─── Review Comment (for posting) ─────────────────────────
/** A review comment to post on a PR diff. */
export interface ReviewPostComment {
  /** File path */
  path: string;
  /** Line number */
  line: number;
  /** Which side of the diff to post on */
  side: 'LEFT' | 'RIGHT';
  /** Comment body in markdown */
  body: string;
}

// ─── Review Payload ───────────────────────────────────────
/** Full payload for submitting a PR review via GitHub API. */
export interface ReviewPayload {
  /** SHA of the commit to review */
  commit_id: string;
  /** Review event type */
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  /** Top-level review body */
  body: string;
  /** Inline review comments */
  comments: ReviewPostComment[];
}

// ─── Config Override ──────────────────────────────────────
/** Per-path and per-branch configuration overrides for the agent. */
export interface ConfigOverride {
  /** Glob pattern for file paths (e.g. "packages/frontend/**") */
  path?: string;
  /** Glob pattern for branch names (e.g. "feature/*") */
  branch?: string;
  /** Review config overrides */
  review?: {
    /** Custom rules for this path/branch */
    customRules?: string[];
    /** Whether to use inline comments */
    inline?: boolean;
  };
  /** Fix config overrides */
  fix?: {
    /** Max iterations for this path/branch */
    maxIterations?: number;
  };
  /** Audit config overrides */
  audit?: {
    /** Audit categories for this path/branch */
    categories?: string[];
  };
}

// ─── Linter Configuration ─────────────────────────────────
/** Configuration for a linter/formatter tool. */
export interface LinterConfig {
  /** Glob pattern for files this linter applies to (e.g. "**\/*.ts") */
  pattern: string;
  /** Command to execute (e.g. "npx eslint", "ruff") */
  command: string;
  /** Arguments appended after file paths */
  args?: string[];
  /** Working directory relative to repo root */
  workingDirectory?: string;
  /** Output parse format. Defaults to "generic". */
  parseFormat?: 'eslint' | 'ruff' | 'generic';
  /** Timeout in milliseconds (default: 60000). */
  timeout?: number;
}

/** A single finding from a linter. */
export interface LinterFinding {
  /** File path relative to repo root */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column number, if available */
  column?: number;
  /** Severity (error, warning, etc.) */
  severity: string;
  /** Rule identifier (e.g. "no-unused-vars") */
  ruleId?: string;
  /** Human-readable message */
  message: string;
  /** Raw output line from the linter */
  raw: string;
}

/** Result of running a linter. */
export interface LinterResult {
  /** Human-readable tool name */
  tool: string;
  /** Linter command that was run */
  command: string;
  /** Exit code */
  exitCode: number;
  /** Raw stdout */
  stdout: string;
  /** Raw stderr */
  stderr: string;
  /** Parsed findings */
  findings: LinterFinding[];
  /** Whether the tool executed successfully */
  success: boolean;
}

// ─── Prompt Config ────────────────────────────────────────
/** Full prompt configuration loaded from YAML/JSON config file. */
export interface PromptConfig {
  /** Review prompt configuration */
  review?: {
    /** Skip review for PRs with these labels */
    skipLabels?: string[];
    /** Skip review for these actors */
    skipActors?: string[];
    /** Custom system prompt */
    systemPrompt?: string;
    /** Extra context to inject */
    extraContext?: string;
    /** Custom rules */
    customRules?: string[];
    /** Post findings as inline review comments (default: true) */
    inline?: boolean;
    /** Suppress low-confidence findings from review output (default: false) */
    suppressLowConfidence?: boolean;
    /** Patterns to exclude from review */
    excludePatterns?: string[];
    /** Token budget configuration for smart context allocation */
    tokenBudget?: TokenBudgetConfig;
    /** Enable lightweight reachability analysis on security findings (default: true) */
    enableReachability?: boolean;
    /** Enable the meta-verification pass that drops false-positive findings (default: false) */
    enableMetaVerification?: boolean;
    /** Enable test-gap detection that flags code changes lacking test updates (default: false) */
    enableTestGapDetection?: boolean;
    /** Enable codebase indexing for cross-file review context (default: true) */
    enableCodebaseIndex?: boolean;
    /** Review pre-existing (non-PR) code at full audit priority (default: false) */
    includePreExisting?: boolean;
    /** Budget-based review configuration for large PRs */
    budget?: {
      /** Enable budget-based review adaptation (default: true) */
      enabled?: boolean;
      /** Diff line threshold for summary-only mode (default: 500) */
      summaryThreshold?: number;
      /** Diff line threshold for split recommendation mode (default: 1000) */
      splitThreshold?: number;
    };
    /** Token usage / cost tracking configuration */
    costTracking?: CostTrackingConfig;
    /** Per-repository sensitivity configuration for tuning reviewer strictness */
    sensitivity?: ReviewSensitivityConfig;
    /** Per-category overrides for review sensitivity */
    categories?: Record<string, CategoryOverride>;
    /** Severity threshold at or above which the action/check run fails
     * (default: 'critical'). Use 'off' to never fail from findings. */
    failOnSeverity?: FailOnSeverity;
    /** Post a conventional-commit title and label suggestion comment after
     * review (default: false). */
    suggestTitleAndLabels?: boolean;
    /** Post findings incrementally as batches complete (default: false). */
    streamComments?: boolean;
    /** Number of findings to accumulate before posting a streaming batch
     * (default: 0 = per-batch). */
    streamBatchSize?: number;
  };
  /** Fix prompt configuration */
  fix?: {
    /** Custom system prompt for fixes */
    systemPrompt?: string;
    /** Max fix iterations */
    maxIterations?: number;
    /** Validation commands to run after fix */
    runChecks?: string[];
    /** Allowlisted commands for runChecks */
    checkAllowlist?: string[];
  };
  /** Audit prompt configuration */
  audit?: {
    /** Directory containing audit prompts */
    promptsDir?: string;
    /** Audit categories to run */
    categories?: string[];
    /** Target directories to audit */
    targetDirs?: string[];
    /** Whether to create GitHub issues from findings */
    createIssues?: boolean;
    /** Whether to auto-apply fixes */
    autoFix?: boolean;
  };
  /** Documentation generation configuration */
  docs?: DocsConfig;
  /** PR description generation (`/describe`) configuration */
  describe?: {
    enabled?: boolean;
    model?: string;
  };
  /** Changelog / release-notes generation (`/changelog`) configuration */
  changelog?: ChangelogConfig;
  /** Learning configuration */
  learning?: {
    /** Whether learning is enabled */
    enabled?: boolean;
    /** Feedback signal types to collect */
    feedbackSignals?: string[];
    /** Meta-review configuration */
    metaReview?: {
      /** Whether meta-review is enabled */
      enabled?: boolean;
      /** Number of reviews between meta-review runs */
      interval?: number;
      /** Minimum findings to trigger a meta-review */
      minFindingsForReview?: number;
    };
    /** Pattern discovery configuration */
    patternDiscovery?: {
      /** Whether pattern discovery is enabled */
      enabled?: boolean;
      /** Minimum frequency for a pattern to be recorded */
      minFrequency?: number;
      /** Sliding window size in reviews */
      windowSize?: number;
    };
    /** Suppression-rule generation configuration */
    suppressionRules?: {
      /** Whether suppression-rule generation is enabled */
      enabled?: boolean;
      /** Minimum dismissals for a pattern to generate a suppression rule */
      minDismissals?: number;
      /** Time-to-live in days before a rule expires */
      ttlDays?: number;
      /** Maximum number of reviews a rule is injected before it expires */
      maxReviews?: number;
      /** Cap on active rules injected into review prompts */
      maxRules?: number;
      /** Finding severities that never generate a suppression rule */
      excludeSeverities?: string[];
    };
  };
  /** Project metadata configuration */
  project?: {
    /** Project name */
    name?: string;
    /** Project description */
    description?: string;
    /** Coding conventions */
    conventions?: string[];
    /** Reference for shell commands (name → command) */
    commandReference?: Record<string, string>;
  };
  /** Conversation / @mention context-window management configuration */
  conversation?: {
    /** Max conversation turns before auto-close (0 = unlimited) */
    maxTurns?: number;
    /** Number of most recent messages kept in full when summarizing older context */
    slidingWindowSize?: number;
    /** Token budget for the full conversation prompt */
    contextTokenBudget?: number;
    /** Optional model override for summarization calls */
    summarizationModel?: string;
    /** Whether the `/ask` follow-up command is enabled (default: true) */
    askCommandEnabled?: boolean;
    /** Maximum code references resolved into context from a single message (default: 5) */
    maxCodeReferences?: number;
  };
  /** Per-path and per-branch config overrides */
  overrides?: ConfigOverride[];
  /** Linter configuration */
  linters?: LinterConfig[];
  /** Structured event logging configuration for the event bus. */
  eventLogging?: EventLoggingConfig;
  /** Pluggable event subscribers to register at startup. */
  eventSubscribers?: PluggableSubscriberConfig[];
  /** Webhook notification configuration for Slack/Teams. */
  notifications?: NotificationsConfig;
  /** Deterministic hardcoded secret / credential scanning (default: enabled). */
  secrets?: SecretDetectorConfig;
  /** Deterministic Software Composition Analysis (SCA) of changed lock files (default: enabled). */
  sca?: SCAConfig;
  /** Multi-agent review architecture configuration (default: disabled). */
  multiAgent?: MultiAgentConfig;
  /** Custom LLM providers (self-hosted OpenAI-compatible, Azure, Bedrock, Ollama). */
  llm?: LLMConfig;
}

// ─── Defaults ─────────────────────────────────────────────

/** Default values for the conversation / @mention feature. */
export const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  mentionHandle: 'opencode-reviewer',
  enabled: true,
  maxTurns: 50,
  slidingWindowSize: 20,
  contextTokenBudget: 32000,
  askCommandEnabled: true,
  maxCodeReferences: 5,
};

/** Default values for webhook notifications (opt-in and low-noise by default). */
export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: false,
  minSeverity: 'critical',
};

/** Default values for deterministic hardcoded secret / credential scanning. */
export const DEFAULT_SECRET_DETECTOR_CONFIG: SecretDetectorConfig = {
  enabled: true,
  entropyThreshold: 4.5,
  minLength: 32,
  allowlist: [],
  failCI: false,
  excludePatterns: [],
};

/** Default values for deterministic Software Composition Analysis (SCA). */
export const DEFAULT_SCA_CONFIG: SCAConfig = {
  enabled: true,
  minSeverity: 'important',
  lockFilePatterns: DEFAULT_SCA_LOCK_FILE_PATTERNS,
  excludePatterns: [],
};

/** Default conventional-commit type → heading map for changelog categories. */
export const DEFAULT_CHANGELOG_CATEGORIES: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  docs: 'Documentation',
  refactor: 'Refactoring',
  perf: 'Performance',
  test: 'Tests',
  chore: 'Chores',
  build: 'Build System',
  ci: 'Continuous Integration',
  style: 'Styling',
  revert: 'Reverts',
};

/** Default values for the `/changelog` release-notes command (opt-in). */
export const DEFAULT_CHANGELOG_CONFIG: ChangelogConfig = {
  enabled: false,
  outputFormat: 'markdown',
  categories: DEFAULT_CHANGELOG_CATEGORIES,
  filePath: 'CHANGELOG.md',
  createPR: false,
  prBranchPrefix: 'changelog',
  includeFiles: false,
};

export const DEFAULT_CONFIG: AgentConfig = {
  platform: 'github',
  reviewModel: 'opencode/deepseek-v4-flash-free',
  fixModel: 'opencode/deepseek-v4-flash-free',
  auditModel: undefined,
  synthesisModel: undefined,
  verificationModel: undefined,
  metaReviewModel: undefined,
  explanationModel: undefined,
  conversationModel: undefined,
  analysisModel: undefined,
  docsModel: undefined,
  describeModel: undefined,
  batchSize: 3,
  maxLinesPerFile: 200,
  maxIterations: 3,
  timeoutMinutes: 20,
  enableMCP: false,
  mcpServers: [],
  projectContext: {
    description: '',
    typecheckCommands: [],
    lintCommands: [],
  },
  review: {
    skipLabels: ['autofix', 'autofix:approved', 'autofix:merged'],
    skipActors: ['github-actions[bot]'],
    inline: true,
    requireVerdict: true,
    commandTriggers: ['/oc', '/review'],
    excludePatterns: [
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
    ],
    enableMetaVerification: false,
    enableTestGapDetection: false,
    suppressLowConfidence: false,
    enableReachability: true,
    enableCodebaseIndex: true,
    tokenBudget: {
      enabled: false,
      maxLinesComplex: 200,
      maxLinesSimple: 20,
      complexityThreshold: 30,
      simpleThreshold: 10,
    },
    reviewBudget: {
      enabled: false,
      summaryThreshold: 500,
      splitThreshold: 1000,
    },
    costTracking: {
      enabled: false,
      verbosity: 'summary',
    },
    sensitivity: {
      minSeverity: 'warning',
      confidenceThreshold: 'low',
    },
    failOnSeverity: 'off',
    suggestTitleAndLabels: false,
    streamComments: false,
    streamBatchSize: 0,
  },
  audit: {
    promptsDir: '.audit-prompts',
    targetDirs: [],
    autoFix: true,
    triggerLabel: 'autofix-trigger',
    issueSeverityThreshold: 'minor',
  },
  docs: {
    enabled: false,
    style: 'auto',
  },
  describe: {
    enabled: true,
  },
  changelog: DEFAULT_CHANGELOG_CONFIG,
  learning: {
    enabled: true,
    feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
    metaReview: {
      enabled: true,
      interval: 5,
      minFindingsForReview: 3,
    },
    patternDiscovery: {
      enabled: true,
      minFrequency: 3,
      windowSize: 100,
    },
    suppressionRules: {
      enabled: true,
      minDismissals: 3,
      ttlDays: 30,
      maxReviews: 20,
      maxRules: 25,
      excludeSeverities: ['critical'],
    },
  },
  conversation: {
    ...DEFAULT_CONVERSATION_CONFIG,
  },
  linters: [],
  rateLimiting: {
    enabled: true,
    reviewsPerRepoPerHour: 10,
    reviewsPerUserPerDay: 50,
    prCooldownMinutes: 2,
    conversationCooldownSeconds: 30,
    dailyTokenBudget: 500000,
    estimatedTokensPerCommand: 25000,
    estimatedTokensPerInteractive: 5000,
    adminUsers: [],
    retentionHours: 48,
  },
  eventLogging: {
    enabled: false,
    path: '.opencode/events.ndjson',
  },
  eventSubscribers: [],
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  multiAgent: DEFAULT_MULTI_AGENT_CONFIG,
  secrets: DEFAULT_SECRET_DETECTOR_CONFIG,
  sca: DEFAULT_SCA_CONFIG,
};

// ─── Event Bus ───────────────────────────────────────────
/** Category of a GitHub event for the event bus. */
export type EventCategory = 'pr' | 'issue' | 'comment' | 'review' | 'internal' | 'pipeline';

/** Canonical event type identifiers for internal pipeline lifecycle events. */
export const PIPELINE_EVENT_TYPES = {
  REVIEW_STARTED: 'review.started',
  REVIEW_COMPLETED: 'review.completed',
  FIX_STARTED: 'fix.started',
  FIX_COMPLETED: 'fix.completed',
  AUDIT_STARTED: 'audit.started',
  AUDIT_COMPLETED: 'audit.completed',
  DOCS_STARTED: 'docs.started',
  DOCS_COMPLETED: 'docs.completed',
  ANALYZE_STARTED: 'analyze.started',
  ANALYZE_COMPLETED: 'analyze.completed',
  EXPLAIN_STARTED: 'explain.started',
  EXPLAIN_COMPLETED: 'explain.completed',
  DESCRIBE_STARTED: 'describe.started',
  DESCRIBE_COMPLETED: 'describe.completed',
  CONVERSATION_STARTED: 'conversation.started',
  CONVERSATION_COMPLETED: 'conversation.completed',
} as const;

/** A specific pipeline event type identifier (e.g. `review.started`). */
export type PipelineEventType = (typeof PIPELINE_EVENT_TYPES)[keyof typeof PIPELINE_EVENT_TYPES];

/** Common context fields carried by all pipeline lifecycle event payloads. */
export interface PipelineEventPayload {
  /** PR (or issue) number the event belongs to, when applicable. */
  prNumber?: number;
  /** Repository in owner/repo format, when known. */
  repo?: string;
  /** Model used for the pipeline stage. */
  modelUsed?: string;
  /** Wall-clock duration of the stage in milliseconds. */
  durationMs?: number;
  /** Total tokens consumed by the stage. */
  tokensUsed?: number;
  /** Unix timestamp of when the event occurred. */
  timestamp: number;
}

/** Payload for a `review.started` event. */
export interface ReviewStartedPayload extends PipelineEventPayload {
  /** PR number being reviewed. */
  prNumber: number;
}

/** Payload for a `review.completed` event. */
export interface ReviewCompletedPayload extends PipelineEventPayload {
  /** PR number that was reviewed. */
  prNumber: number;
  /** Markdown summary of the review. */
  reviewSummary?: string;
  /** Total number of findings (issues + strengths). */
  findingsCount?: number;
  /** Number of issues reported. */
  issuesCount?: number;
  /** Number of strengths reported. */
  strengthsCount?: number;
  /** Whether the review produced a verdict. */
  hasVerdict?: boolean;
  /** Number of distinct files covered by findings. */
  fileCount?: number;
}

/** Payload for a `fix.started` event. */
export interface FixStartedPayload extends PipelineEventPayload {
  /** PR number being fixed. */
  prNumber?: number;
  /** Fix iteration index (0-indexed). */
  iteration?: number;
}

/** Payload for a `fix.completed` event. */
export interface FixCompletedPayload extends PipelineEventPayload {
  /** PR number that was fixed. */
  prNumber?: number;
  /** Fix iteration index (0-indexed). */
  iteration?: number;
  /** Whether any file changes were made. */
  changesMade?: boolean;
  /** Files modified by the fix. */
  filesChanged?: string[];
  /** Whether the fix got stuck. */
  stuck?: boolean;
  /** Reason the fix got stuck, if applicable. */
  stuckReason?: string;
}

/** Payload for an `audit.started` event. */
export interface AuditStartedPayload extends PipelineEventPayload {
  /** Audit category name. */
  category?: string;
  /** Directory being audited. */
  targetDir?: string;
}

/** Payload for an `audit.completed` event. */
export interface AuditCompletedPayload extends PipelineEventPayload {
  /** Audit category name. */
  category?: string;
  /** Directory that was audited. */
  targetDir?: string;
  /** Number of issues reported. */
  issuesCount?: number;
}

/** Payload for a `docs.started` event. */
export interface DocsStartedPayload extends PipelineEventPayload {
  /** PR number being documented. */
  prNumber?: number;
  /** Doc style requested for the run. */
  docStyle?: DocStyle;
}

/** Payload for a `docs.completed` event. */
export interface DocsCompletedPayload extends PipelineEventPayload {
  /** PR number that was documented. */
  prNumber?: number;
  /** Whether any documentation changes were made. */
  changesMade?: boolean;
  /** Files modified by the documentation pass. */
  filesChanged?: string[];
  /** Doc style used for the run. */
  docStyle?: DocStyle;
}

/** Payload for an `analyze.started` event. */
export interface AnalyzeStartedPayload extends PipelineEventPayload {
  /** Issue number being analyzed. */
  issueNumber?: number;
}

/** Payload for an `analyze.completed` event. */
export interface AnalyzeCompletedPayload extends PipelineEventPayload {
  /** Issue number that was analyzed. */
  issueNumber?: number;
}

/** Payload for an `explain.started` event. */
export interface ExplainStartedPayload extends PipelineEventPayload {
  /** PR number being explained. */
  prNumber?: number;
}

/** Payload for an `explain.completed` event. */
export interface ExplainCompletedPayload extends PipelineEventPayload {
  /** PR number that was explained. */
  prNumber?: number;
}

/** Payload for a `describe.started` event. */
export interface DescribeStartedPayload extends PipelineEventPayload {
  /** PR number being described. */
  prNumber?: number;
}

/** Payload for a `describe.completed` event. */
export interface DescribeCompletedPayload extends PipelineEventPayload {
  /** PR number that was described. */
  prNumber?: number;
}

/** Payload for a `conversation.started` event. */
export interface ConversationStartedPayload extends PipelineEventPayload {
  /** PR number the conversation belongs to. */
  prNumber?: number;
  /** Unique conversation thread identifier. */
  threadId?: string;
}

/** Payload for a `conversation.completed` event. */
export interface ConversationCompletedPayload extends PipelineEventPayload {
  /** PR number the conversation belongs to. */
  prNumber?: number;
  /** Unique conversation thread identifier. */
  threadId?: string;
  /** Number of assistant turns in the thread. */
  turnCount?: number;
  /** Reason the thread was auto-closed, if applicable. */
  autoCloseReason?: string;
}

/** Union of all pipeline lifecycle event payloads. */
export type PipelineEventPayloadMap = {
  'review.started': ReviewStartedPayload;
  'review.completed': ReviewCompletedPayload;
  'fix.started': FixStartedPayload;
  'fix.completed': FixCompletedPayload;
  'audit.started': AuditStartedPayload;
  'audit.completed': AuditCompletedPayload;
  'docs.started': DocsStartedPayload;
  'docs.completed': DocsCompletedPayload;
  'analyze.started': AnalyzeStartedPayload;
  'analyze.completed': AnalyzeCompletedPayload;
  'explain.started': ExplainStartedPayload;
  'explain.completed': ExplainCompletedPayload;
  'describe.started': DescribeStartedPayload;
  'describe.completed': DescribeCompletedPayload;
  'conversation.started': ConversationStartedPayload;
  'conversation.completed': ConversationCompletedPayload;
};

/** A generic event emitted on the internal event bus. */
export interface GitHubEvent {
  /** Event type identifier */
  type: string;
  /** Event category */
  category: EventCategory;
  /** Arbitrary event payload */
  payload: unknown;
  /** Unix timestamp of when the event occurred */
  timestamp: number;
  /** Repository in owner/repo format */
  repo?: string;
  /** PR number, if applicable */
  prNumber?: number;
  /** Correlation ID tracing this event (and downstream work) across subsystems */
  correlationId?: string;
}

/** A subscriber that listens for specific event types on the event bus. */
export interface Subscriber {
  /** Display name for logging */
  name: string;
  /** Event types this subscriber handles */
  subscribedEvents: string[];
  /**
   * Event handler function.
   *
   * @param event - The GitHub event to process.
   * @param signal - Optional AbortSignal for timeout cancellation.
   * @returns Promise that resolves when handling is complete.
   */
  handle(event: GitHubEvent, signal?: AbortSignal): Promise<void>;
}

// ─── Learning Store ──────────────────────────────────────
/** Configuration for the learning system. */
export interface LearningConfig {
  /** Whether learning is enabled */
  enabled: boolean;
  /** Feedback signal types to collect */
  feedbackSignals: string[];
  /** Meta-review configuration */
  metaReview: {
    /** Whether meta-review is enabled */
    enabled: boolean;
    /** Number of reviews between meta-review runs */
    interval: number;
    /** Minimum findings to trigger meta-review */
    minFindingsForReview: number;
  };
  /** Pattern discovery configuration */
  patternDiscovery: {
    /** Whether pattern discovery is enabled */
    enabled: boolean;
    /** Minimum frequency for a pattern to be recorded */
    minFrequency: number;
    /** Sliding window size in reviews */
    windowSize: number;
  };
  /** Suppression-rule generation from dismissal feedback */
  suppressionRules: {
    /** Whether suppression-rule generation is enabled */
    enabled: boolean;
    /** Minimum dismissals for a pattern to generate a suppression rule */
    minDismissals: number;
    /** Time-to-live in days before a rule expires */
    ttlDays: number;
    /** Maximum number of reviews a rule is injected before it expires */
    maxReviews: number;
    /** Cap on active rules injected into review prompts */
    maxRules: number;
    /** Finding severities that never generate a suppression rule */
    excludeSeverities: string[];
  };
}

/** Feedback signal recorded from user interactions with review findings. */
export interface LearningFeedback {
  /** Unique finding identifier */
  findingId: string;
  /** Type of feedback signal */
  signalType: 'dismissed' | 'reaction' | 'disputed_comment';
  /** Value of the signal (e.g., reaction emoji) */
  signalValue: string;
  /** PR number the finding belongs to */
  prNumber: number;
  /** ISO 8601 timestamp of when the feedback was recorded */
  createdAt: string;
}

/** Quality metrics computed for a review. */
export interface LearningQuality {
  /** PR number */
  prNumber: number;
  /** How actionable the findings were (0-1) */
  actionabilityScore: number;
  /** Accuracy score (0-1) */
  accuracyScore: number;
  /** Coverage score (0-1) */
  coverageScore: number;
  /** Consistency score (0-1) */
  consistencyScore: number;
  /** Duration of the review in milliseconds */
  durationMs?: number;
  /** Number of tokens used during the review */
  tokensUsed?: number;
}

/** A discovered pattern from review history. */
export interface LearningPattern {
  /** Unique key identifying the pattern */
  patternKey: string;
  /** Cluster of similar finding messages */
  messageCluster: string[];
  /** How many times this pattern has been observed */
  frequency: number;
  /** File types (extensions) where the pattern appears */
  fileTypes: string[];
  /** ISO 8601 timestamp of first occurrence */
  firstSeen: string;
  /** ISO 8601 timestamp of most recent occurrence */
  lastSeen: string;
}

/** A custom rule learned or manually defined for the project. */
export interface CustomRule {
  /** Rule text description */
  ruleText: string;
  /** Whether the rule was auto-discovered or manually added */
  source: 'auto' | 'manual';
  /** Approval status */
  status: 'pending' | 'active' | 'declined';
  /** ISO 8601 timestamp of when the rule was approved */
  approvedAt?: string;
}
