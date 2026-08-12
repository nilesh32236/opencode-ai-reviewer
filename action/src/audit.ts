import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import {
  type AgentConfig,
  Logger,
  type PlatformAdapter,
  type ReviewEngine,
} from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Tracks the last audit issue number per category for this process. When the
 * existing-issue search fails, the fail-open create path reuses the recorded
 * issue (updating it) instead of creating a fresh duplicate on every invocation,
 * bounding duplicate accumulation during a search outage. State is per-process,
 * so it cannot survive across workflow runs; on the first fail-open of a process
 * a new issue is created and recorded for subsequent reuse.
 */
const lastAuditIssueByCategory = new Map<string, number>();

/**
 * Reset the per-process audit-issue registry. Exported for tests.
 */
export function resetAuditIssueRegistry(): void {
  lastAuditIssueByCategory.clear();
}

/**
 * Short deterministic hash of a string, used to disambiguate audit category
 * slugs that normalize to the same value. Stable across processes and runs.
 * @param input - The string to hash.
 * @returns A short lowercase base-36 hash.
 */
function categoryHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalize an audit category into a URL- and label-safe slug. The category is
 * derived from the `audit-prompt-name` input or prompt filenames, so it may
 * contain spaces, &, #, or other characters GitHub disallows in labels. The
 * slug is lowercased, has reserved-character runs and leading/trailing hyphens
 * trimmed, and is truncated so `audit:` + slug stays under GitHub's
 * 50-character label limit. When normalization actually transforms the
 * category, a short deterministic hash of the original is appended so distinct
 * categories that collapse to the same slug (e.g. "auth & access" vs
 * "auth # access") keep separate labels, titles, update markers, and dedup
 * registry keys. Categories that are already valid lowercase slugs are
 * truncated to the same 44-character cap (otherwise a long valid slug would
 * still exceed GitHub's label limit).
 * @param category - The raw audit category string.
 * @returns The canonical, collision-resistant slug (never empty).
 */
function normalizeAuditCategory(category: string): string {
  const slug = category
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === category) return slug.slice(0, 44);
  const base = slug || 'uncategorized';
  const suffix = categoryHash(category);
  return `${base.slice(0, 44 - suffix.length - 1)}-${suffix}`.slice(0, 44);
}

/**
 * Execute a codebase audit: select a random (or named) audit prompt,
 * run the audit engine on a target directory, optionally create a
 * GitHub issue with the findings, and add severity labels.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 */
export async function runAudit(
  inputs: ActionInputs,
  config: AgentConfig,
  engine: ReviewEngine,
  gh: PlatformAdapter,
): Promise<void> {
  const promptsDirRaw = core.getInput('audit-prompts-dir');
  let promptsDir = promptsDirRaw || config.audit.promptsDir;
  const targetDir = inputs.auditTargetDir;
  // The canonical input is `audit_prompt_name` (declared in action.yml). The
  // kebab-case variant is read as a fallback for workflows written against the
  // older, undeclared name so those configs keep working.
  const promptName = core.getInput('audit_prompt_name') || core.getInput('audit-prompt-name');

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
  // Normalize the category into a URL- and label-safe slug before it reaches
  // the GitHub API. The category is derived from the audit-prompt-name input or
  // prompt filenames, so it may contain spaces, &, #, or other reserved
  // characters that would otherwise produce a malformed API query or an
  // invalid label name (GitHub disallows spaces in labels). A deterministic
  // hash is appended when normalization transforms the category so distinct
  // categories that collapse to the same slug never share a label/issue.
  const safeCategory = normalizeAuditCategory(category);
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
    const labels = [...inputs.auditLabels, `audit:${safeCategory}`];

    if (result.stats.critical > 0) {
      labels.push('audit:critical');
    } else {
      labels.push('audit:important');
    }

    if (inputs.auditAutoFix) {
      labels.push('autofix-trigger');
    }

    const issueBody = buildAuditIssueBody(safeCategory, auditTarget, result);
    const titlePrefix = `[Audit:${safeCategory}]`;
    const title = `${titlePrefix} ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`;

    let existingIssueNumber: number | undefined;
    try {
      const issueState = process.env.PLATFORM === 'gitlab' ? 'opened' : 'open';
      const openAuditIssues = (await gh.paginate(
        `/issues?state=${issueState}&labels=audit:${encodeURIComponent(safeCategory)}`,
        { perPage: 100, maxPages: 10, throwOnError: true },
      )) as Array<{ number: number; title: string }>;
      const match = openAuditIssues.find((issue: { number: number; title: string }) =>
        issue.title.startsWith(titlePrefix),
      );
      if (match) {
        existingIssueNumber = match.number;
      }
    } catch (err) {
      core.warning(
        sanitize(
          `Failed to search for existing open audit issue — creating issue without deduplication: ${err instanceof Error ? err.message : err}`,
        ),
      );
      // Do not fail closed and drop the audit's findings on a transient search
      // failure: fall back to creating the issue (accepting a rare duplicate)
      // so the findings are never silently lost. Only setFailed if even that
      // fallback write fails (handled in the create branch below). To bound
      // duplicate accumulation during a search outage, reuse the last issue this
      // process tracked for the category when one is known.
      existingIssueNumber = lastAuditIssueByCategory.get(safeCategory);
    }

    if (existingIssueNumber) {
      core.info(
        `Audit category ${safeCategory} already has open issue #${existingIssueNumber} — updating existing issue`,
      );
      new Logger('Audit').info('Updating existing audit issue', {
        operation: 'audit.update',
        category: safeCategory,
        issueNumber: existingIssueNumber,
      });
      try {
        await gh.postOrUpdateComment(
          existingIssueNumber,
          `<!-- audit-update-${safeCategory} -->`,
          issueBody,
        );
        lastAuditIssueByCategory.set(safeCategory, existingIssueNumber);
        core.setOutput('issue-number', String(existingIssueNumber));
      } catch (err) {
        core.warning(sanitize(`Failed to update existing audit issue: ${String(err)}`));
        core.setFailed('Audit issue tracking failed — could not update issue');
      }
    } else {
      try {
        const issue = await gh.createIssue(title, issueBody, labels);
        if (issue) {
          lastAuditIssueByCategory.set(safeCategory, issue.number);
          core.setOutput('issue-number', String(issue.number));
          core.info(`Created issue #${issue.number}: ${issue.url}`);
        } else {
          core.setFailed('Audit issue tracking failed — could not create issue');
        }
      } catch (error) {
        core.warning(sanitize(`Failed to create audit issue: ${String(error)}`));
        core.setFailed('Audit issue tracking failed — could not create issue');
      }
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
  // `category` is the canonical safe slug (see normalizeAuditCategory), matching
  // the label, title prefix, and update marker so the public body header never
  // diverges from — or interpolates raw untrusted text into — the issue.
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
