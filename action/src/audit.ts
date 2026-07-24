import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Execute a codebase audit: select a random (or named) audit prompt,
 * run the audit engine on a target directory, optionally create a
 * GitHub issue with the findings, and add severity labels.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 */
export async function runAudit(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
): Promise<void> {
  const promptsDirRaw = core.getInput('audit-prompts-dir');
  let promptsDir = promptsDirRaw || config.audit.promptsDir;
  const targetDir = inputs.auditTargetDir;
  const promptName = core.getInput('audit-prompt-name');

  try {
    await gh.ensureLabels([
      'audit',
      'audit:critical',
      'audit:important',
      'audit:minor',
      'autofix',
      'autofix-trigger',
      'autofix:approved',
      'autofix:needs-fix',
    ]);
  } catch (err) {
    core.warning(sanitize(`Failed to ensure labels: ${err instanceof Error ? err.message : err}`));
  }

  if (!fs.existsSync(promptsDir)) {
    if (promptsDir === '.audit-prompts' && fs.existsSync('prompts/audit-categories')) {
      promptsDir = 'prompts/audit-categories';
    } else {
      core.setFailed(sanitize(`Audit prompts directory not found: ${promptsDir}`));
      return;
    }
  }

  let prompts: string[];
  try {
    prompts = (await fs.promises.readdir(promptsDir)).filter((f) => f.endsWith('.md'));
    if (prompts.length === 0 && fs.existsSync(path.join(promptsDir, 'audit-categories'))) {
      promptsDir = path.join(promptsDir, 'audit-categories');
      prompts = (await fs.promises.readdir(promptsDir)).filter((f) => f.endsWith('.md'));
    }
  } catch (err) {
    core.setFailed(
      sanitize(
        `Failed to read audit prompts directory ${promptsDir}: ${err instanceof Error ? err.message : err}`,
      ),
    );
    return;
  }

  if (prompts.length === 0) {
    core.setFailed(sanitize(`No prompt files found in ${promptsDir}`));
    return;
  }

  let selectedPrompt: string;
  let category: string;

  if (promptName) {
    const filename = `${promptName}.md`;
    if (!prompts.includes(filename)) {
      core.setFailed(sanitize(`Prompt '${promptName}' not found in ${promptsDir}`));
      return;
    }
    selectedPrompt = path.join(promptsDir, filename);
    category = promptName;
  } else {
    const rand = Math.floor(Math.random() * prompts.length);
    selectedPrompt = path.join(promptsDir, prompts[rand]);
    category = path.basename(prompts[rand], '.md');
  }

  const allTargetDirs = [
    ...(targetDir ? [targetDir] : []),
    ...inputs.auditTargetDirs,
    ...config.audit.targetDirs,
  ];
  const auditTarget =
    allTargetDirs.length > 0
      ? allTargetDirs[Math.floor(Math.random() * allTargetDirs.length)]
      : '.';
  const promptContent = fs.readFileSync(selectedPrompt, 'utf-8');

  const result = await engine.runAudit(promptContent, auditTarget, category);

  if (!result || (!result.summary && result.issues.length === 0)) {
    core.warning('Audit returned no meaningful content');
    return;
  }

  if (inputs.auditCreateIssues && (result.stats.critical > 0 || result.stats.important > 0)) {
    const labels = [...inputs.auditLabels, `audit:${category}`];

    if (result.stats.critical > 0) {
      labels.push('audit:critical');
    } else {
      labels.push('audit:important');
    }

    if (inputs.auditAutoFix) {
      labels.push('autofix-trigger');
    }

    const issueBody = buildAuditIssueBody(category, auditTarget, result);
    const title = `[Audit:${category}] ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`;

    try {
      const issue = await gh.createIssue(title, issueBody, labels);
      if (issue) {
        core.setOutput('issue-number', String(issue.number));
        core.info(`Created issue #${issue.number}: ${issue.url}`);
      }
    } catch (error) {
      core.warning(sanitize(`Failed to create audit issue: ${String(error)}`));
    }
  } else {
    core.info('No critical or important issues found — skipping issue creation');
  }
}

function buildAuditIssueBody(
  category: string,
  targetDir: string,
  result: {
    summary: string;
    stats: { critical: number; important: number; minor: number };
    issues: Array<{
      severity: string;
      file: string;
      line: number;
      message: string;
      suggestion?: string;
    }>;
  },
): string {
  const lines: string[] = [
    '<!-- audit-issue -->',
    '',
    `## Audit: ${category}`,
    '',
    `**Target directory:** \`${targetDir}\``,
    `**Results:** ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`,
    '',
    `**Summary:** ${result.summary}`,
    '',
    '### Findings',
    '',
  ];

  for (const issue of result.issues) {
    lines.push(
      `- **${issue.severity.toUpperCase()}** \`${issue.file}:${issue.line}\` — ${issue.message}`,
    );
    if (issue.suggestion) {
      lines.push(`  - *Fix:* ${issue.suggestion}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Comment `/fix` on this issue to trigger the automated fix workflow.');

  return lines.join('\n');
}
