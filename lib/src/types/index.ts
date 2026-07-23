// Shared types for the OpenCode PR Agent system.
// Used by both the GitHub Action and GitHub App.

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
  /** Whether this should be posted as an inline review comment */
  inline?: boolean;
  /** Whether this issue was reported in a previous iteration */
  previouslyReported?: boolean;
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
  /** Git SHA of the head commit */
  headSha: string;
  /** Base target branch name */
  baseRef: string;
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
/** Top-level agent configuration for reviews, fixes, audits, and learning. */
export interface AgentConfig {
  /** Model to use for reviews */
  reviewModel: string;
  /** Model to use for fixes */
  fixModel: string;
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
  /** Learning behavior */
  learning: LearningConfig;
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

/** Configuration for review behavior. */
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
}

// ─── JSONL Finding Types ──────────────────────────────────
/** Discriminated type for JSONL review findings. */
export type FindingType = 'summary' | 'verdict' | 'strength' | 'issue';

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
  /** Whether to post inline */
  inline?: boolean;
  /** Whether previously reported */
  previouslyReported?: boolean;
}

/** Union type of all possible JSONL finding types. */
export type Finding = SummaryFinding | VerdictFinding | StrengthFinding | IssueFinding;

// ─── Results ──────────────────────────────────────────────
/** Aggregated result of a completed review. */
export interface ReviewResult {
  /** Markdown summary text */
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
  };
  /** Raw JSONL lines from the model output */
  rawLines?: string[];
  /** Number of lines that failed to parse */
  failedLines?: number;
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
export type ActionMode = 'review' | 'fix' | 'audit' | 'post';

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

// ─── Prompt Config ────────────────────────────────────────
/** Full prompt configuration loaded from YAML/JSON config file. */
export interface PromptConfig {
  /** Review prompt configuration */
  review?: {
    /** Custom system prompt */
    systemPrompt?: string;
    /** Extra context to inject */
    extraContext?: string;
    /** Custom rules */
    customRules?: string[];
    /** Post findings as inline review comments (default: true) */
    inline?: boolean;
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
  /** Per-path and per-branch config overrides */
  overrides?: ConfigOverride[];
}

// ─── Defaults ─────────────────────────────────────────────
export const DEFAULT_CONFIG: AgentConfig = {
  reviewModel: 'opencode/deepseek-v4-flash-free',
  fixModel: 'opencode/deepseek-v4-flash-free',
  batchSize: 3,
  maxLinesPerFile: 200,
  maxIterations: 3,
  timeoutMinutes: 20,
  enableMCP: true,
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
  },
  audit: {
    promptsDir: '.audit-prompts',
    targetDirs: [],
    autoFix: true,
    triggerLabel: 'autofix-trigger',
    issueSeverityThreshold: 'important',
  },
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
  },
};

// ─── Event Bus ───────────────────────────────────────────
/** Category of a GitHub event for the event bus. */
export type EventCategory = 'pr' | 'issue' | 'comment' | 'review' | 'internal';

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
   * @returns Promise that resolves when handling is complete.
   */
  handle(event: GitHubEvent): Promise<void>;
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
