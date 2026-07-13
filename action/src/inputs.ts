import * as core from '@actions/core';
import type { ActionMode } from '@opencode-pr-agent/lib';

const VALID_MODES: ActionMode[] = ['review', 'fix', 'audit'];

export interface ActionInputs {
  mode: ActionMode;
  githubToken: string;
  openAiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
  reviewModel: string;
  fixModel: string;
  auditModel: string;
  reviewPromptFile?: string;
  reviewPromptExtra?: string;
  enableFix: boolean;
  maxFixIterations: number;
  enableAudit: boolean;
  auditTargetDir?: string;
  maxFilesPerBatch: number;
  maxLinesPerFile: number;
  projectContext?: string;
  enableMCP: boolean;
  includeStrengths: boolean;
  reviewCommentSummary: boolean;
  runChecksAfterFix?: string;
  auditPromptFile?: string;
  auditCreateIssues: boolean;
  auditAutoFix: boolean;
  auditLabels: string[];
}

export function parseInputs(): ActionInputs {
  const modeStr = core.getInput('mode', { required: true }).toLowerCase().trim();
  if (!VALID_MODES.includes(modeStr as ActionMode)) {
    throw new Error(`Invalid mode: "${modeStr}". Must be one of: ${VALID_MODES.join(', ')}`);
  }

  const maxFixIterations = parseInt(core.getInput('max_fix_iterations') || '3', 10);
  if (isNaN(maxFixIterations) || maxFixIterations < 1 || maxFixIterations > 10) {
    throw new Error('max_fix_iterations must be between 1 and 10');
  }

  const maxFilesPerBatch = parseInt(core.getInput('max_files_per_batch') || '3', 10);
  if (isNaN(maxFilesPerBatch) || maxFilesPerBatch < 1) {
    throw new Error('max_files_per_batch must be a positive integer');
  }

  const maxLinesPerFile = parseInt(core.getInput('max_lines_per_file') || '500', 10);
  if (isNaN(maxLinesPerFile) || maxLinesPerFile < 1) {
    throw new Error('max_lines_per_file must be a positive integer');
  }

  const auditLabelsStr = core.getInput('audit_labels') || 'audit';
  const auditLabels = auditLabelsStr.split(',').map((l) => l.trim()).filter(Boolean);

  return {
    mode: modeStr as ActionMode,
    githubToken: core.getInput('github_token', { required: true }),
    openAiKey: core.getInput('openai_api_key') || undefined,
    anthropicKey: core.getInput('anthropic_api_key') || undefined,
    geminiKey: core.getInput('gemini_api_key') || undefined,
    reviewModel: core.getInput('review_model') || 'opencode/deepseek-v4-flash-free',
    fixModel: core.getInput('fix_model') || 'opencode/deepseek-v4-flash-free',
    auditModel: core.getInput('audit_model') || 'opencode/deepseek-v4-flash-free',
    reviewPromptFile: core.getInput('review_prompt_file') || undefined,
    reviewPromptExtra: core.getInput('review_prompt_extra') || undefined,
    enableFix: core.getInput('enable_fix') !== 'false',
    maxFixIterations,
    enableAudit: core.getInput('enable_audit') === 'true',
    auditTargetDir: core.getInput('audit_target_dir') || undefined,
    maxFilesPerBatch,
    maxLinesPerFile,
    projectContext: core.getInput('project_context') || undefined,
    enableMCP: core.getInput('enable_mcp') !== 'false',
    includeStrengths: core.getInput('include_strengths') !== 'false',
    reviewCommentSummary: core.getInput('review_comment_summary') !== 'false',
    runChecksAfterFix: core.getInput('run_checks_after_fix') || undefined,
    auditPromptFile: core.getInput('audit_prompt_file') || undefined,
    auditCreateIssues: core.getInput('audit_create_issues') !== 'false',
    auditAutoFix: core.getInput('audit_auto_fix') === 'true',
    auditLabels,
  };
}
