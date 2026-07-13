import { promises as fs } from 'fs';
import type {
  AgentConfig,
  PRContext,
  ReviewResult,
  MCPContextEntry,
} from './types/index.js';
import { MCPManager } from './mcp/client.js';
import { buildReviewPrompt, buildFixPrompt, buildAuditPrompt } from './prompts/builder.js';
import { runOpenCode, ensureOutputDir, getGitStatus } from './opencode.js';
import { GitHubHelper } from './utils/github.js';
import { parseJsonlFile } from './jsonl-parser.js';

export class ReviewEngine {
  private mcp: MCPManager;
  private github: GitHubHelper;
  private config: AgentConfig;

  constructor(config: AgentConfig, githubToken: string, repo: string) {
    this.config = config;
    this.github = new GitHubHelper(githubToken, repo);
    this.mcp = new MCPManager(config.mcpServers);
  }

  async reviewPR(pr: PRContext): Promise<ReviewResult> {
    let mcpContext: MCPContextEntry[] = [];
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const libraries = detectLibraries(pr.changedFiles.map((f) => f.path));
        if (libraries.length > 0) {
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

    const contextMarkdown = this.buildPRContextString(pr);
    const mcpSection =
      mcpContext.length > 0
        ? '\n\n## Library Context\n' + mcpContext.map((e) => e.content).join('\n')
        : '';

    const prompt = buildReviewPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        maxFilesPerBatch: this.config.batchSize,
      },
      contextMarkdown + mcpSection
    );

    const promptFile = '/tmp/opencode-review-prompt.txt';
    await fs.writeFile(promptFile, prompt);

    await runOpenCode(prompt, {
      model: this.config.reviewModel,
    });

    return parseJsonlFile('.opencode/review-output.jsonl');
  }

  async runFix(
    prNumber: number,
    iteration: number,
    contextMarkdown: string
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
      iteration
    );

    const promptFile = '/tmp/opencode-fix-prompt.txt';
    await fs.writeFile(promptFile, prompt);

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
      targetDir
    );

    const promptFile = '/tmp/opencode-audit-prompt.txt';
    await fs.writeFile(promptFile, prompt);

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
      parts.push(`- \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions})`);
      if (f.patch) {
        parts.push('  ```diff');
        parts.push(`  ${f.patch}`);
        parts.push('  ```');
      }
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

    if (file.includes('useQuery') || file.includes('useMutation') || file.includes('query-client')) {
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
