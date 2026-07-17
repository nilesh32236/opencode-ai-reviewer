import { promises as fs } from 'fs';
import * as cp from 'node:child_process';
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

  async reviewPR(pr: PRContext, iteration?: number): Promise<ReviewResult> {
    console.log(
      `Reviewing PR #${pr.number} (${pr.changedFiles.length} files)${iteration !== undefined ? ` (Iteration ${iteration + 1})` : ''}`,
    );

    const mcpContext: MCPContextEntry[] = [];
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const libraries = detectLibraries(pr.changedFiles.map((f) => f.path));
        if (libraries.length > 0) {
          console.log(`Fetching MCP docs for: ${libraries.join(', ')}`);
          const docs = await this.mcp.getLibraryDocs(libraries);
          if (docs) {
            mcpContext.push({
              source: 'context7',
              content: docs,
              relevance: 0.9,
            });
          }
        }
      } catch {
        // Non-critical — proceed without MCP
      }
    }

    console.log('Building PR context string');
    const contextMarkdown = this.buildPRContextString(pr);
    const contextSize = Buffer.byteLength(contextMarkdown, 'utf-8');
    console.log(`PR context size: ${(contextSize / 1024).toFixed(1)} KB`);

    const mcpSection =
      mcpContext.length > 0
        ? '\n\n## Library Context\n' + mcpContext.map((e) => e.content).join('\n')
        : '';

    const lessons = this.learningStore
      ? await (async () => {
          try {
            return await this.learningStore!.getRelevantLessons(pr.changedFiles.map((f) => f.path));
          } catch {
            console.warn('Failed to fetch relevant lessons, defaulting to empty array');
            return [];
          }
        })()
      : [];

    const prompt = buildReviewPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        maxFilesPerBatch: this.config.batchSize,
        reviewPromptExtra:
          iteration !== undefined
            ? `This is review iteration ${iteration + 1} of autofix. If this is the final check, verify carefully that no regressions or new bugs were introduced, and that the code compiles/passes all checks. Only set "ready" to true if you are confident it is production-ready.`
            : undefined,
      },
      contextMarkdown + mcpSection,
      lessons,
    );

    const promptSize = Buffer.byteLength(prompt, 'utf-8');
    console.log(`Total prompt size: ${(promptSize / 1024).toFixed(1)} KB`);

    console.log(`Running OpenCode review (model: ${this.config.reviewModel})`);
    const runResult = await runOpenCode(prompt, {
      model: this.config.reviewModel,
    });
    if (!runResult.success) {
      console.warn('OpenCode review execution failed, returning fallback result');
      return {
        summary: '',
        verdict: {
          ready: false,
          reasoning: 'Review execution failed',
          autoFixable: false,
          confidence: 'low',
        },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
    }

    console.log('Parsing review output');
    try {
      return await parseJsonlFile('.opencode/review-output.jsonl');
    } catch {
      console.warn('Failed to parse review output, returning empty result');
      return {
        summary: '',
        verdict: {
          ready: false,
          reasoning: 'Failed to parse review output',
          autoFixable: false,
          confidence: 'low',
        },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
    }
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
      } catch {
        // Non-critical
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

    const fixRunResult = await runOpenCode(prompt, {
      model: this.config.fixModel,
    });
    if (!fixRunResult.success) {
      console.warn('OpenCode fix execution failed, returning default FixResult');
      return { changesMade: false, filesChanged: [] };
    }

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
        // No stuck file — good
      }

      let filesChanged: string[] = [];
      if (changesMade) {
        try {
          const raw = cp.execSync('git diff --name-only', { encoding: 'utf-8' }).toString().trim();
          filesChanged = raw ? raw.split('\n') : [];
        } catch {}
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
      } catch {
        // Non-critical
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
    });
    if (!auditRunResult.success) {
      console.warn('OpenCode audit execution failed, returning fallback empty result');
      return {
        summary: '',
        verdict: {
          ready: false,
          reasoning: 'Audit execution failed',
          autoFixable: false,
          confidence: 'low',
        },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
    }

    const outputPath = `.opencode/audit-${category}.jsonl`;
    try {
      return await parseJsonlFile(outputPath);
    } catch {
      console.warn(`Failed to parse audit output at ${outputPath}, returning empty result`);
      return {
        summary: '',
        verdict: {
          ready: false,
          reasoning: 'Failed to parse audit output',
          autoFixable: false,
          confidence: 'low',
        },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.mcp.disconnect();
    } catch {
      console.warn('MCP disconnect failed during cleanup');
    }
    try {
      await this.learningStore?.close();
    } catch {
      console.warn('LearningStore close failed during cleanup');
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
