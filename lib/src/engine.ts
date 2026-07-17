import { promises as fs } from 'fs';
import * as cp from 'node:child_process';
import * as core from '@actions/core';
import { parseJsonlFile } from './jsonl-parser.js';
import type { LearningStore } from './learning/store.js';
import { MCPManager } from './mcp/client.js';
import { ensureOutputDir, getGitStatus, runOpenCode } from './opencode.js';
import { buildAuditPrompt, buildFixPrompt, buildReviewPrompt } from './prompts/builder.js';
import type {
  AgentConfig,
  FixResult,
  MCPContextEntry,
  PRContext,
  ReviewResult,
} from './types/index.js';
import { GitHubHelper } from './utils/github.js';

export class ReviewEngine {
  private mcp: MCPManager;
  private github: GitHubHelper;
  private config: AgentConfig;

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

  async reviewPR(
    pr: PRContext,
    iteration?: number,
    reviewPromptFile?: string,
    reviewPromptExtra?: string,
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
    const contextMarkdown = this.buildPRContextString(pr);
    const contextSize = Buffer.byteLength(contextMarkdown, 'utf-8');
    core.info(`PR context size: ${(contextSize / 1024).toFixed(1)} KB`);

    const mcpSection =
      mcpContext.length > 0
        ? '\n\n## Library Context\n' + mcpContext.map((e) => e.content).join('\n')
        : '';

    const lessons = this.learningStore
      ? await this.learningStore.getRelevantLessons(pr.changedFiles.map((f) => f.path))
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
    );

    const promptSize = Buffer.byteLength(prompt, 'utf-8');
    core.info(`Total prompt size: ${(promptSize / 1024).toFixed(1)} KB`);

    core.info(`Running OpenCode review (model: ${this.config.reviewModel})`);
    await runOpenCode(prompt, {
      model: this.config.reviewModel,
    });

    core.info('Parsing review output');
    return await parseJsonlFile('.opencode/review-output.jsonl');
  }

  async runFix(
    prNumber: number,
    iteration: number,
    contextMarkdown: string,
    cachedPR?: PRContext,
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
    );

    await runOpenCode(prompt, {
      model: this.config.fixModel,
    });

    try {
      const status = getGitStatus();
      const changesMade = status.trim().length > 0;

      let stuck = false;
      let stuckReason: string | undefined;
      try {
        const stuckContent = await fs.readFile('.fix-stuck.md', 'utf-8');
        stuck = true;
        stuckReason = stuckContent;
        await fs.unlink('.fix-stuck.md');
      } catch {
        core.debug('No .fix-stuck.md — proceeding normally');
      }

      let filesChanged: string[] = [];
      if (changesMade) {
        try {
          const raw = cp.execSync('git diff --name-only', { encoding: 'utf-8' }).toString().trim();
          filesChanged = raw ? raw.split('\n') : [];
        } catch {
          core.warning('Could not get git diff to determine changed files');
        }
      }

      return { changesMade, filesChanged, stuck, stuckReason };
    } catch {
      return { changesMade: false, filesChanged: [] };
    }
  }

  async runAudit(
    promptContent: string,
    targetDir: string,
    category: string,
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

    await runOpenCode(prompt, {
      model: this.config.reviewModel,
    });

    const outputPath = `.opencode/audit-${category}.jsonl`;
    return await parseJsonlFile(outputPath);
  }

  async cleanup(): Promise<void> {
    await this.mcp.disconnect();
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

  if (dir.includes('frontend') || dir.includes('app') || dir.includes('components')) {
    libs.add('next.js');
    libs.add('react');
    libs.add('@tanstack/react-query');
  }

  if (dir.includes('backend') || dir.includes('src')) {
    libs.add('express');
    libs.add('prisma');
    libs.add('zod');
  }

  return [...libs];
}
