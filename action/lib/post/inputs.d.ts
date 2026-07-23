import type { ActionMode } from '@opencode-pr-agent/lib';
/**
 * Parse and validate a timeout value from a raw string.
 * @param raw - The raw timeout string (e.g. "30"). Defaults to "20" if empty.
 * @returns The parsed timeout in minutes.
 */
export declare function parseTimeoutMinutes(raw: string): number;
/** Parsed and validated GitHub Action inputs for the OpenCode PR Agent. */
export interface ActionInputs {
    /** The operation mode: review, fix, audit, or post. */
    mode: ActionMode;
    /** GitHub token used for API authentication. */
    githubToken: string;
    /** Optional OpenAI API key. */
    openAiKey?: string;
    /** Optional Anthropic API key. */
    anthropicKey?: string;
    /** Optional Google Gemini API key. */
    geminiKey?: string;
    /** Model identifier for review operations. */
    reviewModel: string;
    /** Model identifier for fix operations. */
    fixModel: string;
    /** Model identifier for audit operations. */
    auditModel: string;
    /** Optional path to a custom review prompt file. */
    reviewPromptFile?: string;
    /** Optional extra instructions appended to the review prompt. */
    reviewPromptExtra?: string;
    /** Whether automated fix mode is enabled. */
    enableFix: boolean;
    /** Maximum number of fix iterations allowed. */
    maxFixIterations: number;
    /** Whether automated audit mode is enabled. */
    enableAudit: boolean;
    /** Optional target directory for audit scans. */
    auditTargetDir?: string;
    /** List of target directories for multi-directory audits. */
    auditTargetDirs: string[];
    /** Maximum files to include per review batch. */
    maxFilesPerBatch: number;
    /** Maximum lines per file to process. */
    maxLinesPerFile: number;
    /** Optional project context/description string. */
    projectContext?: string;
    /** Whether MCP (Model Context Protocol) servers are enabled. */
    enableMCP: boolean;
    /** Whether to include strengths in review output. */
    includeStrengths: boolean;
    /** Whether to post a review summary comment on the PR. */
    reviewCommentSummary: boolean;
    /** Optional command to run after fix operations for verification. */
    runChecksAfterFix?: string;
    /** Allowlist of allowed programs for the verification command. */
    checkAllowlist: string[];
    /** Optional path to a custom audit prompt file. */
    auditPromptFile?: string;
    /** Whether to create GitHub issues for audit findings. */
    auditCreateIssues: boolean;
    /** Whether auto-fix is enabled during audit operations. */
    auditAutoFix: boolean;
    /** Labels to apply to created audit issues. */
    auditLabels: string[];
    /** Version of opencode to use. */
    opencodeVersion: string;
    /** Timeout in minutes for the operation. */
    timeoutMinutes: number;
    /** Whether to post review comments inline on the diff. */
    reviewInline: boolean;
    /** Whether the learning state cache is enabled. */
    enableStateCache: boolean;
    /** Cache key prefix for learning state storage. */
    stateCacheKey: string;
}
/**
 * Parse and validate all GitHub Action inputs from workflow environment.
 * @returns A fully populated ActionInputs object.
 */
export declare function parseInputs(): ActionInputs;
