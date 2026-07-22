import { promises as fs, existsSync } from 'fs';
import * as cp from 'node:child_process';
import * as path from 'path';
import * as core from '@actions/core';
import { emptyResult, parseJsonlFile } from './jsonl-parser.js';
import type { LearningStore } from './learning/store.js';
import { MCPManager } from './mcp/client.js';
import { getGitStatus, runOpenCode } from './opencode.js';
import { buildAuditPrompt, buildFixPrompt, buildReviewPrompt } from './prompts/builder.js';
import type {
  AgentConfig,
  FixResult,
  MCPContextEntry,
  PRContext,
  PreviousFindingIteration,
  ReviewIssue,
  ReviewResult,
} from './types/index.js';
import { GitHubHelper } from './utils/github.js';

/**
 * Orchestrates PR review, auto-fix, and audit workflows.
 * Wraps MCP context enrichment, learning-store queries, and OpenCode CLI invocation.
 */
export class ReviewEngine {
  private mcp: MCPManager;
  private github: GitHubHelper;
  private config: AgentConfig;
  private lessonsCache: { lessons: string[]; timestamp: number } | null = null;
  private static readonly LESSONS_CACHE_TTL = 60_000;

  /**
   * @param config - Agent configuration (models, batch size, MCP servers, etc.).
   * @param githubToken - GitHub API token for PR/issue operations.
   * @param repo - Repository in "owner/name" format.
   * @param learningStore - Optional learning store for recording/querying past findings.
   */
  constructor(
    config: AgentConfig,
    githubToken: string,
    repo: string,
    private learningStore?: LearningStore,
  ) {
    this.config = config;
    this.github = new GitHubHelper(githubToken, repo);
    this.mcp = new MCPManager(config.mcpServers);
  }

  /**
   * Run a code review on a pull request.
   * Enriches context with MCP library docs and learning-store lessons,
   * builds a review prompt, runs OpenCode CLI, and parses the output.
   *
   * @param pr - Pull request context (files, diff, metadata).
   * @param iteration - Optional iteration number for auto-fix cycles.
   * @param reviewPromptFile - Optional path to a custom review prompt file.
   * @param reviewPromptExtra - Optional extra text appended to the review prompt.
   * @param timeoutMinutes - Optional timeout override (defaults to config.timeoutMinutes).
   * @returns Parsed review result with verdict, issues, and strengths.
   */
  async reviewPR(
    pr: PRContext,
    iteration?: number,
    reviewPromptFile?: string,
    reviewPromptExtra?: string,
    timeoutMinutes?: number,
    previousFindings?: PreviousFindingIteration[],
  ): Promise<ReviewResult> {
    core.info(
      `Reviewing PR #${pr.number} (${pr.changedFiles.length} files)${iteration !== undefined ? ` (Iteration ${iteration + 1})` : ''}`,
    );

    const mcpContext: MCPContextEntry[] = [];
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const libraries = detectLibraries(pr.changedFiles.map((f) => f.path));
        if (libraries.length > 0) {
          core.info(`Fetching MCP docs for: ${libraries.join(', ')}`);
          const docs = await this.mcp.getLibraryDocs(libraries);
          if (docs) {
            mcpContext.push({
              source: 'context7',
              content: docs,
              relevance: 0.9,
            });
          }
        }
      } catch (err) {
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    core.info('Building PR context string');
    let contextMarkdown = this.buildPRContextString(pr);

    if (previousFindings && previousFindings.length > 0) {
      const latest = previousFindings[previousFindings.length - 1];
      if (latest.headSha && latest.headSha !== pr.headSha) {
        try {
          core.info(
            `Computing diff since last review (${latest.headSha.slice(0, 7)}...${pr.headSha.slice(0, 7)})`,
          );
          const fixDiff = await this.github.getDiffSince(latest.headSha, pr.headSha);
          if (fixDiff) {
            const diffSection = '\n\n## Changes Since Last Review\n```diff\n' + fixDiff + '\n```';
            if (contextMarkdown.length + diffSection.length < 50_000) {
              contextMarkdown += diffSection;
              core.info(`Added diff since last review (${fixDiff.length} bytes)`);
            } else {
              core.info('Diff too large to include in context — skipping');
            }
          }
        } catch (err) {
          core.warning(`Could not compute diff since last review: ${String(err)}`);
        }
      }
    }

    const contextSize = Buffer.byteLength(contextMarkdown, 'utf-8');
    core.info(`PR context size: ${(contextSize / 1024).toFixed(1)} KB`);

    const mcpSection =
      mcpContext.length > 0
        ? '\n\n## Library Context\n' + mcpContext.map((e) => e.content).join('\n')
        : '';

    const store = this.learningStore;
    const lessons = store
      ? await (async () => {
          try {
            const now = Date.now();
            if (
              this.lessonsCache &&
              now - this.lessonsCache.timestamp < ReviewEngine.LESSONS_CACHE_TTL
            ) {
              return this.lessonsCache.lessons;
            }
            const result = await store.getRelevantLessons(pr.changedFiles.map((f) => f.path));
            this.lessonsCache = { lessons: result, timestamp: now };
            return result;
          } catch {
            core.warning('Failed to fetch relevant lessons, defaulting to empty array');
            return [];
          }
        })()
      : [];

    const autoFixExtra =
      iteration !== undefined
        ? `This is review iteration ${iteration + 1} of autofix. If this is the final check, verify carefully that no regressions or new bugs were introduced, and that the code compiles/passes all checks. Only set "ready" to true if you are confident it is production-ready.`
        : undefined;
    const combinedExtra =
      [reviewPromptExtra, autoFixExtra].filter(Boolean).join('\n\n') || undefined;

    const prompt = buildReviewPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        maxFilesPerBatch: this.config.batchSize,
        reviewPromptFile,
        reviewPromptExtra: combinedExtra,
      },
      contextMarkdown + mcpSection,
      lessons,
      previousFindings,
    );

    const promptSize = Buffer.byteLength(prompt, 'utf-8');
    core.info(`Total prompt size: ${(promptSize / 1024).toFixed(1)} KB`);

    core.info(`Running OpenCode review (model: ${this.config.reviewModel})`);
    const runResult = await runOpenCode(prompt, {
      model: this.config.reviewModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
    });
    if (!runResult.success) {
      core.warning('OpenCode review execution failed, returning fallback result');
      const r = emptyResult();
      r.verdict.reasoning = 'Review execution failed';
      return r;
    }

    core.info('Parsing review output');
    try {
      return await parseJsonlFile('.opencode/review-output.jsonl');
    } catch {
      core.warning('Failed to parse review output, returning empty result');
      const r = emptyResult();
      r.verdict.reasoning = 'Failed to parse review output';
      return r;
    }
  }

  /**
   * Run the auto-fix workflow on a PR.
   * Builds a fix prompt enriched with MCP library docs, runs OpenCode CLI,
   * and reads results (git status, stuck marker, fix summary) from disk.
   *
   * @param prNumber - PR number being fixed.
   * @param iteration - Current fix iteration (0-indexed).
   * @param contextMarkdown - PR context as markdown string.
   * @param cachedPR - Optional pre-fetched PR context to avoid redundant API calls.
   * @param timeoutMinutes - Optional timeout override (defaults to config.timeoutMinutes).
   * @returns Fix result indicating whether changes were made, files changed, and stuck/summary info.
   */
  async runFix(
    prNumber: number,
    iteration: number,
    contextMarkdown: string,
    cachedPR?: PRContext,
    timeoutMinutes?: number,
    issues?: ReviewIssue[],
    verificationError?: string,
  ): Promise<FixResult> {
    let mcpDocs = '';
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const pr = cachedPR ?? (await this.github.getPR(prNumber));
        const libraries = detectLibraries(pr.changedFiles.map((f) => f.path));
        if (libraries.length > 0) {
          mcpDocs = await this.mcp.getLibraryDocs(libraries);
        }
      } catch (err) {
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const fixContext = mcpDocs
      ? contextMarkdown + '\n\n## Library Documentation\n' + mcpDocs
      : contextMarkdown;

    const prompt = buildFixPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        maxFixIterations: this.config.maxIterations,
      },
      fixContext,
      iteration,
      issues,
      verificationError,
    );

    const fixRunResult = await runOpenCode(prompt, {
      model: this.config.fixModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
    });
    if (!fixRunResult.success) {
      core.warning(
        'OpenCode fix execution failed or timed out. Checking for partial changes on disk...',
      );
      // Give filesystem time to flush writes from the killed process
      await new Promise((r) => setTimeout(r, 500));
    }

    let changesMade = false;
    let filesChanged: string[] = [];
    let stuck = false;
    let stuckReason: string | undefined;
    let summary: string | undefined;

    try {
      const status = getGitStatus();
      changesMade = status.trim().length > 0;

      try {
        const stuckContent = await fs.readFile('.fix-stuck.md', 'utf-8');
        stuck = stuckContent.trim().length > 0;
        stuckReason = stuckContent;
        await fs.unlink('.fix-stuck.md');
      } catch {
        core.debug('No .fix-stuck.md — proceeding normally');
      }

      try {
        summary = await fs.readFile('.fix-summary.md', 'utf-8');
        await fs.unlink('.fix-summary.md');
      } catch {
        core.debug('No .fix-summary.md — proceeding normally');
      }

      if (changesMade) {
        try {
          const raw = cp
            .execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf-8' })
            .toString()
            .trim();
          filesChanged = raw ? raw.split('\n') : [];
        } catch {
          core.warning('Could not get git diff to determine changed files');
        }
      }
    } catch (err) {
      core.warning(
        `Error reading fix results after OpenCode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { changesMade, filesChanged, stuck, stuckReason, summary };
  }

  /**
   * Run a codebase audit for a specific category.
   * Builds an audit prompt with MCP enrichment, runs OpenCode CLI,
   * and parses the output JSONL file.
   *
   * @param promptContent - Base audit prompt content.
   * @param targetDir - Directory to audit.
   * @param category - Audit category name (used for output file naming).
   * @param timeoutMinutes - Optional timeout override (defaults to config.timeoutMinutes).
   * @returns Parsed audit result with issues and verdict.
   */
  async runAudit(
    promptContent: string,
    targetDir: string,
    category: string,
    timeoutMinutes?: number,
  ): Promise<ReviewResult> {
    let mcpDocs = '';
    if (this.config.enableMCP) {
      try {
        await this.mcp.connect();
        const libraries = detectLibrariesFromDir(targetDir);
        if (libraries.length > 0) {
          mcpDocs = await this.mcp.getLibraryDocs(libraries);
        }
      } catch (err) {
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const enrichedPrompt = mcpDocs
      ? promptContent + '\n\n## Library Documentation\n' + mcpDocs
      : promptContent;

    const prompt = buildAuditPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
      },
      enrichedPrompt,
      targetDir,
      category,
    );

    const auditRunResult = await runOpenCode(prompt, {
      model: this.config.reviewModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
    });
    if (!auditRunResult.success) {
      core.warning('OpenCode audit execution failed, returning fallback empty result');
      const r = emptyResult();
      r.verdict.reasoning = 'Audit execution failed';
      return r;
    }

    const outputPath = `.opencode/audit-${category}.jsonl`;
    try {
      return await parseJsonlFile(outputPath);
    } catch {
      core.warning(`Failed to parse audit output at ${outputPath}, returning empty result`);
      const r = emptyResult();
      r.verdict.reasoning = 'Failed to parse audit output';
      return r;
    }
  }

  /**
   * Gracefully shut down MCP connections and learning store.
   * Has a hard timeout of 15 seconds — remaining resources are left to clean up
   * in the background if the deadline is exceeded.
   */
  async cleanup(): Promise<void> {
    const timeoutMs = 15_000;
    const start = Date.now();

    const mcpTask = this.mcp
      .disconnect()
      .catch(() => core.warning('MCP disconnect failed during cleanup'));

    const storeTask = this.learningStore
      ?.close()
      .catch(() => core.warning('LearningStore close failed during cleanup'));

    const tasks = [mcpTask];
    if (storeTask) tasks.push(storeTask);

    const result = await Promise.race([
      Promise.allSettled(tasks).then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);

    if (result === 'timeout') {
      const elapsed = Date.now() - start;
      core.warning(
        `Cleanup did not finish within ${timeoutMs}ms (took ${elapsed}ms) — MCP/learning store may still be shutting down in background`,
      );
    }
  }

  private buildPRContextString(pr: PRContext): string {
    const parts: string[] = [];
    const maxLines = this.config.maxLinesPerFile;

    parts.push(`## PR #${pr.number}: ${pr.title}`);
    parts.push('');
    parts.push(`**Author:** ${pr.author}`);
    parts.push(`**Branch:** \`${pr.headRef}\` → \`${pr.baseRef}\``);
    if (pr.labels.length > 0) {
      parts.push(`**Labels:** ${pr.labels.join(', ')}`);
    }
    parts.push('');

    if (pr.body) {
      parts.push('### Description');
      parts.push('');
      parts.push(pr.body);
      parts.push('');
    }

    parts.push('### Changed Files');
    parts.push('');
    for (const f of pr.changedFiles) {
      const stats = `${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
      parts.push(`- \`${stats}\``);
    }
    parts.push('');
    const totalDiffLines = pr.changedFiles.reduce(
      (s, f) => s + (f.patch ? f.patch.split('\n').length : 0),
      0,
    );
    if (totalDiffLines > maxLines && maxLines > 0) {
      parts.push(
        `> Total diff: ~${totalDiffLines} lines across ${pr.changedFiles.length} files. For large changes, read each file individually using the \`read\` tool and dispatch sub-agents to review batches of files.`,
      );
    }

    return parts.join('\n');
  }
}

function detectLibraries(files: string[]): string[] {
  const libraries = new Set<string>();

  for (const file of files) {
    if (file.includes('package.json') || file.endsWith('.lock')) continue;

    // React / Next.js detection
    if (file.endsWith('.tsx') || file.endsWith('.jsx')) {
      libraries.add('react');
    }
    if (
      file.includes('/pages/') ||
      file.includes('/app/') ||
      file.endsWith('next.config.js') ||
      file.endsWith('next.config.ts')
    ) {
      libraries.add('next.js');
    }

    // React Query detection
    if (
      file.includes('useQuery') ||
      file.includes('useMutation') ||
      file.includes('query-client') ||
      file.endsWith('queries.ts') ||
      file.endsWith('queries.tsx')
    ) {
      libraries.add('@tanstack/react-query');
    }

    // Express / NestJS detection
    if (
      file.includes('/routes/') ||
      file.includes('/middleware/') ||
      file.endsWith('router.ts') ||
      file.endsWith('router.js')
    ) {
      libraries.add('express');
    }
    if (
      file.includes('/controllers/') ||
      file.includes('/modules/') ||
      file.endsWith('.module.ts')
    ) {
      libraries.add('express');
    }

    // Prisma detection
    if (file.includes('prisma/') || file.includes('.prisma') || file.endsWith('schema.prisma')) {
      libraries.add('prisma');
    }

    // Zod detection
    if (
      file.endsWith('.schema.ts') ||
      file.includes('/schemas/') ||
      file.includes('/validators/') ||
      file.endsWith('validation.ts')
    ) {
      libraries.add('zod');
    }

    // Tailwind CSS detection
    if (
      file.includes('tailwind') ||
      file.endsWith('tailwind.config.js') ||
      file.endsWith('tailwind.config.ts')
    ) {
      libraries.add('tailwindcss');
    }

    // Additional library detection
    if (file.endsWith('.vue')) {
      libraries.add('vue');
    }
    if (file.endsWith('.svelte')) {
      libraries.add('svelte');
    }
    if (file.includes('/graphql/') || file.endsWith('.graphql') || file.endsWith('.gql')) {
      libraries.add('graphql');
    }
    if (file.includes('/__tests__/') || file.includes('.test.') || file.includes('.spec.')) {
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        libraries.add('vitest');
      }
    }
  }

  return [...libraries];
}

function detectLibrariesFromDir(dir: string): string[] {
  const libs = new Set<string>();

  // PHP-only directories in WordPress plugins — no JS libraries apply.
  // Returning an empty set avoids injecting irrelevant MCP docs for express/prisma.
  const phpOnlyPatterns = ['includes', 'templates', 'vendor', 'admin', 'languages'];
  if (phpOnlyPatterns.some((p) => dir.includes(p))) {
    return [];
  }

  // JS/React source directories
  if (dir.includes('frontend') || dir.includes('app') || dir.includes('components')) {
    libs.add('next.js');
    libs.add('react');
    libs.add('@tanstack/react-query');
  }

  // Generic `src` directory — only add Node.js libs if no composer.json at root,
  // since `src` is also used by WordPress plugins for React admin UI.
  if (dir === 'src' || dir.endsWith('/src')) {
    // Check for package.json to confirm it's a JS project before adding Node libs.
    const hasPackageJson = existsSync(path.join(process.cwd(), 'package.json'));
    const hasComposerJson = existsSync(path.join(process.cwd(), 'composer.json'));

    if (hasPackageJson) {
      libs.add('react');
    }
    // If this is a hybrid (WP plugin with both composer + package.json), skip server-side libs.
    if (!hasComposerJson) {
      libs.add('express');
      libs.add('prisma');
      libs.add('zod');
    }
  }

  // Pure backend directories (no ambiguity)
  if (dir.includes('backend') || dir.includes('api') || dir.includes('server')) {
    libs.add('express');
    libs.add('prisma');
    libs.add('zod');
  }

  return [...libs];
}
