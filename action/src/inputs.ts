import * as core from '@actions/core';
import { DEFAULT_ALLOWLIST } from '@opencode-pr-agent/lib';
import type { ActionMode } from '@opencode-pr-agent/lib';

const VALID_MODES: ActionMode[] = ['review', 'fix', 'audit', 'post', 'analyze'];

/**
 * Parse and validate a timeout value from a raw string.
 * @param raw - The raw timeout string (e.g. "30"). Defaults to "20" if empty.
 * @returns The parsed timeout in minutes.
 */
export function parseTimeoutMinutes(raw: string): number {
  const timeoutMinutes = Number.parseInt(raw || '20', 10);
  if (isNaN(timeoutMinutes) || timeoutMinutes < 1) {
    throw new Error('timeout_minutes must be a positive integer');
  }
  return timeoutMinutes;
}

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
export function parseInputs(): ActionInputs {
  const modeStr = core.getInput('mode', { required: true }).toLowerCase().trim();
  if (!VALID_MODES.includes(modeStr as ActionMode)) {
    throw new Error(`Invalid mode: "${modeStr}". Must be one of: ${VALID_MODES.join(', ')}`);
  }

  const maxFixIterations = Number.parseInt(core.getInput('max_fix_iterations') || '3', 10);
  if (isNaN(maxFixIterations) || maxFixIterations < 1 || maxFixIterations > 10) {
    throw new Error('max_fix_iterations must be between 1 and 10');
  }

  const maxFilesPerBatch = Number.parseInt(core.getInput('max_files_per_batch') || '3', 10);
  if (isNaN(maxFilesPerBatch) || maxFilesPerBatch < 1) {
    throw new Error('max_files_per_batch must be a positive integer');
  }

  const maxLinesPerFile = Number.parseInt(core.getInput('max_lines_per_file') || '500', 10);
  if (isNaN(maxLinesPerFile) || maxLinesPerFile < 1) {
    throw new Error('max_lines_per_file must be a positive integer');
  }

  const auditLabelsStr = core.getInput('audit_labels') || 'audit';
  const auditLabels = auditLabelsStr
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  const auditTargetDirsStr = core.getInput('audit_target_dirs') || '';
  const auditTargetDirs = auditTargetDirsStr
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const opencodeVersion =
    core.getInput('opencode_version') || core.getInput('opencode-version') || 'latest';

  const globalModel = core.getInput('model');

  return {
    mode: modeStr as ActionMode,
    githubToken: core.getInput('github_token', { required: true }),
    openAiKey: core.getInput('openai_api_key') || undefined,
    anthropicKey: core.getInput('anthropic_api_key') || undefined,
    geminiKey: core.getInput('gemini_api_key') || undefined,
    reviewModel: core.getInput('review_model') || globalModel || 'opencode/deepseek-v4-flash-free',
    fixModel: core.getInput('fix_model') || globalModel || 'opencode/deepseek-v4-flash-free',
    auditModel: core.getInput('audit_model') || globalModel || 'opencode/deepseek-v4-flash-free',
    reviewPromptFile: core.getInput('review_prompt_file') || undefined,
    reviewPromptExtra: core.getInput('review_prompt_extra') || undefined,
    enableFix: core.getInput('enable_fix') !== 'false',
    maxFixIterations,
    enableAudit: core.getInput('enable_audit') === 'true',
    auditTargetDir: core.getInput('audit_target_dir') || undefined,
    auditTargetDirs,
    maxFilesPerBatch,
    maxLinesPerFile,
    projectContext: core.getInput('project_context') || undefined,
    enableMCP: core.getInput('enable_mcp') !== 'false',
    includeStrengths: core.getInput('include_strengths') !== 'false',
    reviewCommentSummary: core.getInput('review_comment_summary') !== 'false',
    runChecksAfterFix: core.getInput('run_checks_after_fix') || undefined,
    checkAllowlist: DEFAULT_ALLOWLIST,
    auditPromptFile: core.getInput('audit_prompt_file') || undefined,
    auditCreateIssues: core.getInput('audit_create_issues') !== 'false',
    auditAutoFix: core.getInput('audit_auto_fix') === 'true',
    auditLabels,
    opencodeVersion,
    timeoutMinutes: parseTimeoutMinutes(core.getInput('timeout_minutes')),
    reviewInline: core.getInput('review_inline') !== 'false',
    enableStateCache: core.getInput('enable_state_cache') !== 'false',
    stateCacheKey: core.getInput('state_cache_key') || 'opencode-learning-state',
  };
}
