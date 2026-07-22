import { promises as fs, existsSync, readFileSync } from 'fs';
import * as cp from 'node:child_process';
import * as path from 'path';
import * as core from '@actions/core';
import { emptyResult, parseJsonlFile } from './jsonl-parser.js';
import type { LearningStore } from './learning/store.js';
import { MCPManager } from './mcp/client.js';
import { getGitStatus, runOpenCode } from './opencode.js';
import {
  buildAuditPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildSynthesisPrompt,
} from './prompts/builder.js';
import type {
  AgentConfig,
  FixResult,
  PRContext,
  PreviousFindingIteration,
  ReviewIssue,
  ReviewResult,
  ReviewStrength,
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
   * Review a pull request by splitting changed files into batches and running
   * concurrent sub-agent reviews with a final synthesis pass.
   *
   * @param pr - Pull request context with changed files.
   * @param iteration - Optional fix iteration index (0-indexed).
   * @param promptFile - Optional custom review prompt file path.
   * @param promptExtra - Optional extra instructions appended to the review prompt.
   * @param timeoutMinutes - Optional timeout override per run.
   * @param previousFindings - Optional findings from previous fix iterations.
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
   * @returns Consolidated ReviewResult with deduplicated findings.
   */
  async reviewPR(
    pr: PRContext,
    _iteration?: number,
    promptFile?: string,
    promptExtra?: string,
    timeoutMinutes?: number,
    previousFindings?: PreviousFindingIteration[],
    workingDirectory?: string,
  ): Promise<ReviewResult> {
    let mcpDocs = '';
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const libraries = detectLibraries(
          pr.changedFiles.map((f) => f.path),
          workingDirectory,
        );
        if (libraries.length > 0) {
          mcpDocs = await this.mcp.getLibraryDocs(libraries);
        }
      } catch (err) {
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const workDir = workingDirectory || process.cwd();
    const batchSize = this.config.batchSize || 3;
    const files = pr.changedFiles;
    const prContext = this.buildPRContextString(pr);
    const baseContext = mcpDocs
      ? prContext + '\n\n## Library Documentation\n' + mcpDocs
      : prContext;

    // Get relevant lessons from learning store (with caching)
    let lessons: string[] | undefined;
    if (this.learningStore) {
      try {
        lessons = await this.getRelevantLessons(pr.changedFiles.map((f) => f.path));
      } catch (err) {
        core.warning(
          `Failed to get learning store lessons: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // If PR is small enough for a single batch, skip concurrent processing
    if (files.length <= batchSize) {
      const prompt = buildReviewPrompt(
        {
          projectContext: this.config.projectContext.description || undefined,
          reviewPromptFile: promptFile,
          reviewPromptExtra: promptExtra,
        },
        baseContext,
        lessons,
        previousFindings,
      );

      const runResult = await runOpenCode(prompt, {
        model: this.config.reviewModel,
        timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
        workingDirectory: workDir,
      });

      if (!runResult.success) {
        core.warning('OpenCode review execution failed, returning fallback empty result');
        const r = emptyResult();
        r.verdict.reasoning = 'Review execution failed';
        return r;
      }

      const outputPath = path.join(workDir, '.opencode', 'review-output.jsonl');
      try {
        return await parseJsonlFile(outputPath);
      } catch {
        core.warning(`Failed to parse review output at ${outputPath}, returning empty result`);
        const r = emptyResult();
        r.verdict.reasoning = 'Failed to parse review output';
        return r;
      }
    }

    // Split files into batches for concurrent processing
    const fileBatches: Array<(typeof files)[number][]> = [];
    for (let i = 0; i < files.length; i += batchSize) {
      fileBatches.push(files.slice(i, i + batchSize));
    }

    const batchPromises = fileBatches.map(async (batch, idx) => {
      const batchDir = path.join(workDir, `.opencode`, `batch-${idx}`);
      const batchPR = { ...pr, changedFiles: batch };
      const batchContext = this.buildPRContextString(batchPR);
      const context = mcpDocs
        ? batchContext + '\n\n## Library Documentation\n' + mcpDocs
        : batchContext;

      const prompt = buildReviewPrompt(
        {
          projectContext: this.config.projectContext.description || undefined,
          reviewPromptFile: promptFile,
          reviewPromptExtra: promptExtra,
        },
        context,
        lessons,
        previousFindings,
      );

      const runResult = await runOpenCode(prompt, {
        model: this.config.reviewModel,
        timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
        workingDirectory: batchDir,
      });

      if (!runResult.success) {
        core.warning(`Batch ${idx} review execution failed, returning empty result`);
        return emptyResult();
      }

      const outputPath = path.join(batchDir, '.opencode', 'review-output.jsonl');
      try {
        return await parseJsonlFile(outputPath);
      } catch {
        core.warning(`Failed to parse batch ${idx} review output, returning empty result`);
        return emptyResult();
      }
    });

    const batchResults = await Promise.all(batchPromises);

    // Collate findings from all batches
    const allIssues: ReviewIssue[] = [];
    const allStrengths: ReviewStrength[] = [];
    const allRawLines: string[] = [];
    let totalFailedLines = 0;

    for (const br of batchResults) {
      allIssues.push(...br.issues);
      allStrengths.push(...br.strengths);
      if (br.rawLines) allRawLines.push(...br.rawLines);
      totalFailedLines += br.failedLines || 0;
    }

    // Build synthesis payload from collated batch raw lines
    const findingsJsonl = allRawLines.join('\n');
    const synthesisPrompt = buildSynthesisPrompt(
      { projectContext: this.config.projectContext.description || undefined },
      findingsJsonl,
    );

    const synthesisResult = await runOpenCode(synthesisPrompt, {
      model: this.config.reviewModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
    });

    if (!synthesisResult.success) {
      core.warning('Synthesis pass failed, falling back to merged batch results');
      return {
        summary:
          allIssues.length > 0
            ? `Found ${allIssues.length} issues across ${fileBatches.length} batches`
            : 'No issues found',
        verdict: {
          ready: allIssues.length === 0,
          reasoning: allIssues.length > 0 ? `Found ${allIssues.length} issues` : 'No issues found',
          autoFixable: false,
          confidence: 'medium' as const,
        },
        strengths: allStrengths,
        issues: allIssues,
        stats: {
          total: allIssues.length,
          critical: allIssues.filter((i) => i.severity === 'critical').length,
          important: allIssues.filter((i) => i.severity === 'important').length,
          minor: allIssues.filter((i) => i.severity === 'minor').length,
        },
        rawLines: allRawLines,
        failedLines: totalFailedLines,
      };
    }

    const finalOutputPath = path.join(workDir, '.opencode', 'review-output.jsonl');
    try {
      return await parseJsonlFile(finalOutputPath);
    } catch {
      core.warning('Synthesis output parse failed, falling back to merged batch results');
      return {
        summary: allIssues.length > 0 ? `Found ${allIssues.length} issues` : 'No issues found',
        verdict: {
          ready: allIssues.length === 0,
          reasoning: 'Synthesis failed, using merged batch results',
          autoFixable: false,
          confidence: 'medium' as const,
        },
        strengths: allStrengths,
        issues: allIssues,
        stats: {
          total: allIssues.length,
          critical: allIssues.filter((i) => i.severity === 'critical').length,
          important: allIssues.filter((i) => i.severity === 'important').length,
          minor: allIssues.filter((i) => i.severity === 'minor').length,
        },
        rawLines: allRawLines,
        failedLines: totalFailedLines,
      };
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
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
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
    workingDirectory?: string,
  ): Promise<FixResult> {
    let mcpDocs = '';
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const pr = cachedPR ?? (await this.github.getPR(prNumber));
        const libraries = detectLibraries(
          pr.changedFiles.map((f) => f.path),
          workingDirectory,
        );
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
      workingDirectory,
    });
    if (!fixRunResult.success) {
      core.warning(
        'OpenCode fix execution failed or timed out. Checking for partial changes on disk...',
      );
      // Give filesystem time to flush writes from the killed process
      await new Promise((r) => setTimeout(r, 500));
    }

    const workDir = workingDirectory || process.cwd();

    let changesMade = false;
    let filesChanged: string[] = [];
    let stuck = false;
    let stuckReason: string | undefined;
    let summary: string | undefined;

    try {
      const status = getGitStatus(workDir);
      changesMade = status.trim().length > 0;

      try {
        const stuckContent = await fs.readFile(path.join(workDir, '.fix-stuck.md'), 'utf-8');
        stuck = stuckContent.trim().length > 0;
        stuckReason = stuckContent;
        await fs.unlink(path.join(workDir, '.fix-stuck.md'));
      } catch {
        core.debug('No .fix-stuck.md — proceeding normally');
      }

      try {
        summary = await fs.readFile(path.join(workDir, '.fix-summary.md'), 'utf-8');
        await fs.unlink(path.join(workDir, '.fix-summary.md'));
      } catch {
        core.debug('No .fix-summary.md — proceeding normally');
      }

      if (changesMade) {
        try {
          const raw = cp
            .execFileSync('git', ['diff', '--name-only', 'HEAD'], {
              encoding: 'utf-8',
              cwd: workDir,
            })
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
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
   * @returns Parsed audit result with issues and verdict.
   */
  async runAudit(
    promptContent: string,
    targetDir: string,
    category: string,
    timeoutMinutes?: number,
    workingDirectory?: string,
  ): Promise<ReviewResult> {
    let mcpDocs = '';
    if (this.config.enableMCP) {
      try {
        await this.mcp.connect();
        const libraries = detectLibrariesFromDir(targetDir, workingDirectory);
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
      workingDirectory,
    });
    if (!auditRunResult.success) {
      core.warning('OpenCode audit execution failed, returning fallback empty result');
      const r = emptyResult();
      r.verdict.reasoning = 'Audit execution failed';
      return r;
    }

    const auditDir = workingDirectory || process.cwd();
    const outputPath = path.join(auditDir, `.opencode/audit-${category}.jsonl`);
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

  private async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const now = Date.now();
    if (this.lessonsCache && now - this.lessonsCache.timestamp < ReviewEngine.LESSONS_CACHE_TTL) {
      return this.lessonsCache.lessons;
    }
    if (!this.learningStore) return [];
    const lessons = await this.learningStore.getRelevantLessons(filePaths);
    this.lessonsCache = { lessons, timestamp: now };
    return lessons;
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

// ---- Manifest-based library detection helpers ----

const PACKAGE_JSON_MAP: Record<string, string> = {
  next: 'next.js',
  react: 'react',
  '@tanstack/react-query': '@tanstack/react-query',
  express: 'express',
  prisma: 'prisma',
  zod: 'zod',
  tailwindcss: 'tailwindcss',
  vue: 'vue',
  svelte: 'svelte',
  '@nestjs/core': 'express',
  vitest: 'vitest',
  graphql: 'graphql',
};

function detectLibrariesFromDeps(
  deps: Record<string, string>,
  map: Record<string, string>,
): string[] {
  const libs: string[] = [];
  for (const [pkgName, libName] of Object.entries(map)) {
    if (pkgName in deps) {
      libs.push(libName);
    }
  }
  return libs;
}

function detectLibrariesFromManifests(rootDir: string): string[] | null {
  const libs = new Set<string>();

  // package.json — JS/TS
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    if (existsSync(pkgPath)) {
      const content = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const lib of detectLibrariesFromDeps(deps, PACKAGE_JSON_MAP)) {
        libs.add(lib);
      }
    }
  } catch {
    // fall through
  }

  // composer.json — PHP
  try {
    const composerPath = path.join(rootDir, 'composer.json');
    if (existsSync(composerPath)) {
      const content = readFileSync(composerPath, 'utf-8');
      const composer = JSON.parse(content);
      const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
      if ('laravel/framework' in deps) libs.add('laravel');
      if ('symfony/symfony' in deps) libs.add('symfony');
      if ('symfony/framework-bundle' in deps) libs.add('symfony');
      if ('illuminate/support' in deps) libs.add('laravel');
    }
  } catch {
    // fall through
  }

  // Cargo.toml — Rust
  try {
    const cargoPath = path.join(rootDir, 'Cargo.toml');
    if (existsSync(cargoPath)) {
      const content = readFileSync(cargoPath, 'utf-8');
      const depMatch = content.match(/\[dependencies\]([^[]*)/);
      if (depMatch) {
        const depsText = depMatch[1];
        for (const line of depsText.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
          const depName = trimmed.split('=')[0]?.trim().replace(/["']/g, '');
          if (depName === 'actix-web') libs.add('actix-web');
          if (depName === 'axum') libs.add('axum');
          if (depName === 'rocket') libs.add('rocket');
          if (depName === 'tokio') libs.add('tokio');
          if (depName === 'serde') libs.add('serde');
          if (depName === 'diesel') libs.add('diesel');
          if (depName === 'sqlx') libs.add('sqlx');
        }
      }
    }
  } catch {
    // fall through
  }

  // go.mod — Go
  try {
    const goModPath = path.join(rootDir, 'go.mod');
    if (existsSync(goModPath)) {
      const content = readFileSync(goModPath, 'utf-8');
      const lines = content.split('\n');
      let inRequireBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('require (') || trimmed.startsWith('require\t')) {
          inRequireBlock = trimmed.endsWith('(');
          continue;
        }
        if (inRequireBlock) {
          if (trimmed === ')') {
            inRequireBlock = false;
            continue;
          }
        } else if (!trimmed.startsWith('require')) {
          continue;
        }
        const parts = trimmed.split(/\s+/);
        const pkg = parts[0];
        if (pkg === 'github.com/gin-gonic/gin') libs.add('gin');
        if (pkg === 'github.com/labstack/echo' || pkg === 'github.com/labstack/echo/v4')
          libs.add('echo');
        if (pkg === 'github.com/gorilla/mux') libs.add('gorilla/mux');
        if (pkg === 'github.com/jackc/pgx') libs.add('pgx');
        if (pkg === 'github.com/jmoiron/sqlx') libs.add('sqlx');
      }
    }
  } catch {
    // fall through
  }

  return libs.size > 0 ? [...libs] : null;
}

/**
 * Detect libraries from a list of changed files.
 * First tries manifest-based detection (package.json, composer.json, etc.)
 * if rootDir is provided. Falls back to path/file-extension heuristics.
 */
function detectLibraries(files: string[], rootDir?: string): string[] {
  // Prefer manifest-based detection when rootDir is available
  if (rootDir) {
    const manifestLibs = detectLibrariesFromManifests(rootDir);
    if (manifestLibs) {
      return manifestLibs;
    }
  }

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

/**
 * Detect libraries from a target directory.
 * First tries manifest-based detection if rootDir is provided.
 * Falls back to directory-name heuristics.
 */
function detectLibrariesFromDir(dir: string, rootDir?: string): string[] {
  // Prefer manifest-based detection when rootDir is available
  if (rootDir) {
    const manifestLibs = detectLibrariesFromManifests(rootDir);
    if (manifestLibs) {
      return manifestLibs;
    }
  }

  const libs = new Set<string>();

  // PHP-only directories in WordPress plugins — no JS libraries apply.
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

  // Generic `src` directory
  if (dir === 'src' || dir.endsWith('/src')) {
    const projectRoot = rootDir || process.cwd();
    const hasPackageJson = existsSync(path.join(projectRoot, 'package.json'));
    const hasComposerJson = existsSync(path.join(projectRoot, 'composer.json'));

    if (hasPackageJson) {
      libs.add('react');
    }
    if (!hasComposerJson) {
      libs.add('express');
      libs.add('prisma');
      libs.add('zod');
    }
  }

  // Pure backend directories
  if (dir.includes('backend') || dir.includes('api') || dir.includes('server')) {
    libs.add('express');
    libs.add('prisma');
    libs.add('zod');
  }

  return [...libs];
}
