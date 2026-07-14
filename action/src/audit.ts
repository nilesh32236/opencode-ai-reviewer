import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs';

export async function runAudit(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: GitHubHelper,
  repo: string,
  token: string,
): Promise<void> {
  const promptsDirRaw = core.getInput('audit-prompts-dir');
  const promptsDir = promptsDirRaw || config.audit.promptsDir;
  const targetDir = inputs.auditTargetDir;
  const promptName = core.getInput('audit-prompt-name');

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

  if (!fs.existsSync(promptsDir)) {
    core.setFailed(`Audit prompts directory not found: ${promptsDir}`);
    return;
  }

  const prompts = fs.readdirSync(promptsDir).filter((f) => f.endsWith('.md'));
  if (prompts.length === 0) {
    core.setFailed(`No prompt files found in ${promptsDir}`);
    return;
  }

  let selectedPrompt: string;
  let category: string;

  if (promptName) {
    const specific = path.join(promptsDir, `${promptName}.md`);
    if (!fs.existsSync(specific)) {
      core.setFailed(`Prompt '${promptName}' not found in ${promptsDir}`);
      return;
    }
    selectedPrompt = specific;
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
  const auditTarget = allTargetDirs.length > 0
    ? allTargetDirs[Math.floor(Math.random() * allTargetDirs.length)]
    : '.';
  const promptContent = fs.readFileSync(selectedPrompt, 'utf-8');

  const result = await engine.runAudit(promptContent, auditTarget);

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
      core.setOutput('issue-number', String(issue.number));
      core.info(`Created issue #${issue.number}: ${issue.url}`);
    } catch (error) {
      core.error(`Failed to create audit issue: ${String(error)}`);
    }
  } else {
    core.info('No critical or important issues found — skipping issue creation');
  }
}

function selectRandomTarget(dirs: string[]): string {
  if (dirs.length === 0) return '.';
  return dirs[Math.floor(Math.random() * dirs.length)];
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
