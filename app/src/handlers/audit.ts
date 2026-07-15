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
    console.warn(`Failed to ensure audit labels: ${err instanceof Error ? err.message : err}`);
  }

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
    console.error(`Error reading audit prompts: ${err instanceof Error ? err.message : err}`, err);
    return;
  }

  const auditTarget =
    targetDir ||
    config.audit.targetDirs[Math.floor(Math.random() * config.audit.targetDirs.length)] ||
    '.';

  let promptContent: string;
  try {
    promptContent = await fs.readFile(selectedFile, 'utf-8');
  } catch (err) {
    console.error(`Failed to read audit prompt file: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const engine = new ReviewEngine(config, token, repo);

  try {
    let result: ReviewResult;
    try {
      result = await engine.runAudit(promptContent, auditTarget, category);
    } catch (err) {
      console.error(`Audit engine failed: ${err instanceof Error ? err.message : err}`);
      return;
    }

    console.log(
      `Audit complete: ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`,
    );

    if (result.stats.critical > 0 || result.stats.important > 0) {
      const issueBody = buildAuditIssue(category, auditTarget, result);
      const title = `[Audit:${category}] ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`;

      const severityLabel = result.stats.critical > 0 ? 'audit:critical' : 'audit:important';
      const labels = ['audit', `audit:${category}`, severityLabel];
      if (config.audit.autoFix) labels.push(config.audit.triggerLabel);

      try {
        const issue = await gh.createIssue(title, issueBody, labels);
        if (issue) {
          console.log(`Created issue #${issue.number}: ${issue.url}`);
        }
      } catch (err) {
        console.error(`Failed to create audit issue: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log('No critical or important issues found — skipping issue creation');
    }
  } finally {
    try {
      await engine.cleanup();
    } catch (err) {
      console.error(`Engine cleanup failed: ${err instanceof Error ? err.message : err}`);
    }
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
