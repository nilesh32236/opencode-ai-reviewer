/**
 * Shared types for the OpenCode PR Agent system.
 * Used by both the GitHub Action and GitHub App.
 */

// ─── Severity ─────────────────────────────────────────────
export type Severity = 'critical' | 'important' | 'minor';

// ─── Review Output (JSONL) ────────────────────────────────
export interface ReviewSummary {
  type: 'summary';
  text: string;
}

export interface ReviewVerdict {
  type: 'verdict';
  ready: boolean;
  reasoning: string;
}

export interface ReviewStrength {
  type: 'strength';
  file: string;
  line: number;
  message: string;
}

export interface ReviewIssue {
  type: 'issue';
  severity: Severity;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  inline?: boolean;
}

export type ReviewEntry = ReviewSummary | ReviewVerdict | ReviewStrength | ReviewIssue;

// ─── GitHub Context ───────────────────────────────────────
export interface PRContext {
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  author: string;
  labels: string[];
  changedFiles: ChangedFile[];
  linkedIssue?: number;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface IssueContext {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface ReviewComment {
  author: string;
  path: string;
  line?: number;
  body: string;
}

// ─── Configuration ────────────────────────────────────────
export interface AgentConfig {
  /** OpenCode model to use for reviews */
  reviewModel: string;
  /** OpenCode model to use for fixes */
  fixModel: string;
  /** Max files per sub-agent batch */
  batchSize: number;
  /** Max review-fix iterations */
  maxIterations: number;
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
}

export interface MCPServerConfig {
  name: string;
  type: 'local' | 'remote';
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
}

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

export interface ReviewConfig {
  /** Skip review for PRs with these labels */
  skipLabels: string[];
  /** Skip review for these actors */
  skipActors: string[];
  /** Whether to post inline comments */
  postInlineComments: boolean;
  /** Whether to require a verdict */
  requireVerdict: boolean;
  /** Command triggers (e.g., /oc, /review) */
  commandTriggers: string[];
}

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
export interface MCPContextEntry {
  source: string;
  content: string;
  relevance: number; // 0-1
}

export interface MCPQueryResult {
  entries: MCPContextEntry[];
  totalTokens: number;
}

// ─── Action/App Inputs ────────────────────────────────────
export interface ReviewInput {
  prNumber?: number;
  repo?: string;
  model?: string;
  githubToken: string;
  config?: Partial<AgentConfig>;
}

export interface FixInput {
  prNumber: number;
  repo: string;
  model?: string;
  githubToken: string;
  iteration: number;
}

export interface AuditInput {
  targetDir?: string;
  promptName?: string;
  autoFix: boolean;
  repo: string;
  githubToken: string;
}

// ─── JSONL Finding Types ──────────────────────────────────
export type FindingType = 'summary' | 'verdict' | 'strength' | 'issue';

export interface BaseFinding {
  type: FindingType;
}

export interface SummaryFinding extends BaseFinding {
  type: 'summary';
  text: string;
}

export interface VerdictFinding extends BaseFinding {
  type: 'verdict';
  ready: boolean;
  reasoning: string;
}

export interface StrengthFinding extends BaseFinding {
  type: 'strength';
  file?: string;
  line?: number;
  message: string;
}

export interface IssueFinding extends BaseFinding {
  type: 'issue';
  severity: Severity;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  inline?: boolean;
}

export type Finding = SummaryFinding | VerdictFinding | StrengthFinding | IssueFinding;

// ─── Results ──────────────────────────────────────────────
export interface ReviewResult {
  summary: string;
  verdict: {
    ready: boolean;
    reasoning: string;
  };
  strengths: ReviewStrength[];
  issues: ReviewIssue[];
  stats: {
    total: number;
    critical: number;
    important: number;
    minor: number;
  };
  rawLines?: string[];
  failedLines?: number;
}

export interface FixResult {
  changesMade: boolean;
  filesChanged: string[];
  commitMessage?: string;
  stuck?: boolean;
  stuckReason?: string;
}

export interface AuditResult {
  category: string;
  targetDir: string;
  summary: string;
  issues: ReviewIssue[];
  stats: {
    critical: number;
    important: number;
    minor: number;
  };
  issueCreated?: number;
}

// ─── Prompt Template ──────────────────────────────────────
export interface PromptTemplate {
  name: string;
  description: string;
  buildPrompt: (context: PromptContext) => string;
}

export interface PromptContext {
  pr?: PRContext;
  issue?: IssueContext;
  reviewComments?: ReviewComment[];
  auditTarget?: string;
  mcpContext?: MCPContextEntry[];
  projectContext: ProjectContextConfig;
  iteration?: number;
  customInstructions?: string;
}

// ─── Action Mode ──────────────────────────────────────────
export type ActionMode = 'review' | 'fix' | 'audit';

// ─── Issue Details ────────────────────────────────────────
export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
}

// ─── Review Comment (for posting) ─────────────────────────
export interface ReviewPostComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

// ─── Review Payload ───────────────────────────────────────
export interface ReviewPayload {
  commit_id: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  comments: ReviewPostComment[];
}

// ─── Prompt Config ────────────────────────────────────────
export interface PromptConfig {
  review?: {
    systemPrompt?: string;
    extraContext?: string;
    customRules?: string[];
  };
  fix?: {
    systemPrompt?: string;
    maxIterations?: number;
    runChecks?: string[];
  };
  audit?: {
    promptsDir?: string;
    categories?: string[];
    targetDirs?: string[];
    createIssues?: boolean;
    autoFix?: boolean;
  };
  project?: {
    name?: string;
    description?: string;
    conventions?: string[];
    commandReference?: Record<string, string>;
  };
}

// ─── Defaults ─────────────────────────────────────────────
export const DEFAULT_CONFIG: AgentConfig = {
  reviewModel: 'opencode/deepseek-v4-flash-free',
  fixModel: 'opencode/deepseek-v4-flash-free',
  batchSize: 3,
  maxIterations: 3,
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
    postInlineComments: true,
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
};
