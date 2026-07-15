import { promises as fs } from 'fs';
import { parseJsonlFile } from './jsonl-parser.js';
import type { LearningStore } from './learning/store.js';
import { MCPManager } from './mcp/client.js';
import { ensureOutputDir, getGitStatus, runOpenCode } from './opencode.js';
import { buildAuditPrompt, buildFixPrompt, buildReviewPrompt } from './prompts/builder.js';
import type { AgentConfig, MCPContextEntry, PRContext, ReviewResult } from './types/index.js';
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
      ? await this.learningStore.getRelevantLessons(pr.changedFiles.map((f) => f.path))
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
    await runOpenCode(prompt, {
      model: this.config.reviewModel,
    });

    console.log('Parsing review output');
    return parseJsonlFile('.opencode/review-output.jsonl');
  }

  async runFix(
    prNumber: number,
    iteration: number,
    contextMarkdown: string,
  ): Promise<{ changesMade: boolean; stuck?: boolean; stuckReason?: string }> {
    let mcpDocs = '';
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const pr = await this.github.getPR(prNumber);
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
        // No stuck file — good
      }

      return { changesMade, stuck, stuckReason };
    } catch {
      return { changesMade: false };
    }
  }

  async runAudit(promptContent: string, targetDir: string): Promise<ReviewResult> {
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
    );

    await runOpenCode(prompt, {
      model: this.config.reviewModel,
    });

    return parseJsonlFile('.audit-output.jsonl');
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
    if (file.includes('package.json')) continue;

    if (file.endsWith('.tsx') || file.endsWith('.jsx')) {
      libraries.add('next.js');
      libraries.add('react');
    }

    if (
      file.includes('useQuery') ||
      file.includes('useMutation') ||
      file.includes('query-client')
    ) {
      libraries.add('@tanstack/react-query');
    }

    if (file.includes('routes/') || file.includes('middleware/') || file.includes('app.')) {
      libraries.add('express');
    }

    if (file.includes('prisma/') || file.includes('.prisma')) {
      libraries.add('prisma');
    }

    if (file.includes('schema') || file.includes('validation')) {
      libraries.add('zod');
    }

    if (file.endsWith('.css') || file.includes('tailwind')) {
      libraries.add('tailwindcss');
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
