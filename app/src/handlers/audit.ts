import { promises as fs } from 'fs';
import path from 'path';
import type { AgentConfig, ReviewResult } from '@opencode-pr-agent/lib';
import { GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';

export async function handleAudit(
  repo: string,
  token: string,
  config: AgentConfig,
  targetDir?: string,
  promptName?: string,
): Promise<void> {
  console.log(`🔎 Starting audit for ${repo}${targetDir ? ` targeting ${targetDir}` : ''}`);

  const gh = new GitHubHelper(token, repo);

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

  const promptsDir = config.audit.promptsDir;
  let selectedFile: string;
  let category: string;

  try {
    const prompts = await fs.readdir(promptsDir);
    const mdFiles = prompts.filter((f) => f.endsWith('.md'));

    if (mdFiles.length === 0) {
      console.log(`No prompt files found in ${promptsDir}`);
      return;
    }

    if (promptName) {
      const specific = path.join(promptsDir, `${promptName}.md`);
      if (!(await fs.stat(specific))) {
        console.log(`Prompt '${promptName}' not found`);
        return;
      }
      selectedFile = specific;
      category = promptName;
    } else {
      const rand = Math.floor(Math.random() * mdFiles.length);
      selectedFile = path.join(promptsDir, mdFiles[rand]);
      category = path.basename(mdFiles[rand], '.md');
    }
  } catch (err) {
    console.log(`Error reading audit prompts: ${err}`);
    return;
  }

  const auditTarget =
    targetDir ||
    config.audit.targetDirs[Math.floor(Math.random() * config.audit.targetDirs.length)] ||
    '.';

  const promptContent = await fs.readFile(selectedFile, 'utf-8');

  const engine = new ReviewEngine(config, token, repo);

  try {
    const result = await engine.runAudit(promptContent, auditTarget);

    console.log(
      `Audit complete: ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`,
    );

    if (result.stats.critical > 0 || result.stats.important > 0) {
      const issueBody = buildAuditIssue(category, auditTarget, result);
      const title = `[Audit:${category}] ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`;

      const severityLabel = result.stats.critical > 0 ? 'audit:critical' : 'audit:important';
      const labels = ['audit', `audit:${category}`, severityLabel];
      if (config.audit.autoFix) labels.push(config.audit.triggerLabel);

      const issue = await gh.createIssue(title, issueBody, labels);
      console.log(`Created issue #${issue.number}: ${issue.url}`);
    } else {
      console.log('No critical or important issues found — skipping issue creation');
    }
  } finally {
    await engine.cleanup();
  }
}

function buildAuditIssue(category: string, targetDir: string, result: ReviewResult): string {
  const lines = [
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
    lines.push(`- **${issue.severity}** \`${issue.file}:${issue.line}\` — ${issue.message}`);
    if (issue.suggestion) {
      lines.push(`  - *Fix:* ${issue.suggestion}`);
    }
  }

  lines.push('', '---', '', 'Comment `/fix` on this issue to trigger the automated fix workflow.');

  return lines.join('\n');
}
