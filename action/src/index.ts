import * as fs from 'node:fs';
import * as path from 'node:path';
import { restoreCache, saveCache } from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_CONFIG,
  GitHubHelper,
  LearningStore,
  type MCPServerConfig,
  MCPServerConfigSchema,
  ReviewEngine,
  configureGit,
  getDefaultMCPServers,
  loadConfig,
  mergeConfigWithInputs,
  setupOpenCode,
  setupWorkspaceDependencies,
} from '@opencode-pr-agent/lib';
import { runAnalyze } from './analyze.js';
import { runAudit } from './audit.js';
import { runAutofixLoop, runFix, runFixIssue } from './fix.js';
import { type ActionInputs, parseInputs } from './inputs.js';
import { runPost } from './post.js';
import { runReview } from './review.js';

const sanitize = (message: string): string => {
  return message
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-+/]+/gi, '$1***')
    .replace(/(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]+/g, '***')
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, 'sk-***')
    .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1***');
};

function buildCacheKey(prefix: string): string {
  const repoNwo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const branch = github.context.ref.replace('refs/heads/', '');
  return `${prefix}-${repoNwo}-${branch}`;
}

class StateCacheManager {
  private learningDbMtimeMs = 0;
  private readonly stateDir: string;
  private readonly cacheKeyPrefix: string;

  constructor(cacheKeyPrefix: string) {
    this.cacheKeyPrefix = cacheKeyPrefix;
    this.stateDir = path.resolve(process.cwd(), '.opencode');
  }

  private getLearningDbMtime(): number {
    const dbPath = path.join(this.stateDir, 'learning.db');
    try {
      return fs.statSync(dbPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  async restore(): Promise<void> {
    if (fs.existsSync(this.stateDir)) {
      core.info('.opencode/ directory already exists — skipping cache restore');
      this.learningDbMtimeMs = this.getLearningDbMtime();
      return;
    }

    core.info('Restoring learning state from cache...');
    const primaryKey = buildCacheKey(this.cacheKeyPrefix);
    const restoreKeys = [
      `${this.cacheKeyPrefix}-${github.context.repo.owner}/${github.context.repo.repo}-`,
    ];
    try {
      const cacheKey = await restoreCache([this.stateDir], primaryKey, restoreKeys);
      if (cacheKey) {
        core.info(`Restored learning state from cache key: ${cacheKey}`);
      } else {
        core.info('No cached learning state found — starting fresh');
      }
    } catch (error) {
      core.warning(`Failed to restore learning state cache: ${error}`);
    }

    this.learningDbMtimeMs = this.getLearningDbMtime();
  }

  async save(): Promise<void> {
    if (!fs.existsSync(this.stateDir)) {
      core.info('No learning state directory found — skipping cache save');
      return;
    }

    const dbPath = path.join(this.stateDir, 'learning.db');
    if (!fs.existsSync(dbPath)) {
      core.info('No learning.db found — skipping cache save');
      return;
    }

    const currentMtime = this.getLearningDbMtime();
    if (currentMtime > 0 && currentMtime === this.learningDbMtimeMs) {
      core.info('Learning state unchanged — skipping cache save');
      return;
    }

    const cacheKey = buildCacheKey(this.cacheKeyPrefix);
    try {
      await saveCache([this.stateDir], cacheKey);
      core.info(`Saved learning state to cache key: ${cacheKey}`);
    } catch (error) {
      core.warning(`Failed to save learning state cache: ${error}`);
    }
  }
}

async function run(): Promise<void> {
  let inputs: ActionInputs | undefined;
  let engine: ReviewEngine | undefined;
  let cacheManager: StateCacheManager | undefined;

  try {
    inputs = parseInputs();
    const loadedConfig = loadConfig();

    if (loadedConfig?.fix?.checkAllowlist?.length) {
      inputs.checkAllowlist = loadedConfig.fix.checkAllowlist;
    }

    const repo =
      core.getInput('repo') || `${github.context.repo.owner}/${github.context.repo.repo}`;
    const token = inputs.githubToken;

    if (inputs.enableStateCache) {
      cacheManager = new StateCacheManager(inputs.stateCacheKey);
      await cacheManager.restore();
    }

    await setupOpenCode(inputs.opencodeVersion);
    await setupWorkspaceDependencies(process.cwd());

    configureGit(
      core.getInput('git_user_name') || process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]',
      core.getInput('git_user_email') ||
        `${process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]'}@users.noreply.github.com`,
      token,
    );

    let mcpServers: MCPServerConfig[] = [];
    if (inputs.enableMCP) {
      const mcpServersJson = core.getInput('mcp-servers');
      if (mcpServersJson) {
        try {
          const parsed = JSON.parse(mcpServersJson);
          const result = MCPServerConfigSchema.array().safeParse(parsed);
          if (result.success) {
            mcpServers = result.data;
          } else {
            core.warning(`Invalid MCP servers config: ${result.error.message}`);
          }
        } catch {
          core.warning('Invalid MCP servers JSON, using defaults');
        }
      }
      if (mcpServers.length === 0) {
        mcpServers = getDefaultMCPServers(token);
      }
    }

    const mergedDefaults = mergeConfigWithInputs(loadedConfig, {});

    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      reviewModel: inputs.reviewModel,
      fixModel: inputs.fixModel,
      batchSize: inputs.maxFilesPerBatch,
      maxLinesPerFile: inputs.maxLinesPerFile,
      maxIterations: loadedConfig?.fix?.maxIterations ?? inputs.maxFixIterations,
      timeoutMinutes: inputs.timeoutMinutes,
      enableMCP: inputs.enableMCP,
      mcpServers,
      projectContext: {
        description: inputs.projectContext || (mergedDefaults.project_context as string) || '',
        typecheckCommands: loadedConfig?.fix?.runChecks || [],
        lintCommands: [],
        customRules: loadedConfig?.review?.customRules?.join('\n') || undefined,
      },
      review: {
        ...DEFAULT_CONFIG.review,
        inline: loadedConfig?.review?.inline ?? inputs.reviewInline,
      },
      audit: {
        ...DEFAULT_CONFIG.audit,
        promptsDir: loadedConfig?.audit?.promptsDir || DEFAULT_CONFIG.audit.promptsDir,
        targetDirs:
          inputs.auditTargetDirs.length > 0
            ? inputs.auditTargetDirs
            : inputs.auditTargetDir
              ? [inputs.auditTargetDir]
              : loadedConfig?.audit?.targetDirs || DEFAULT_CONFIG.audit.targetDirs,
        autoFix:
          loadedConfig?.audit?.autoFix !== undefined
            ? loadedConfig.audit.autoFix
            : DEFAULT_CONFIG.audit.autoFix,
      },
      learning: loadedConfig?.learning
        ? {
            enabled: loadedConfig.learning.enabled ?? DEFAULT_CONFIG.learning.enabled,
            feedbackSignals:
              loadedConfig.learning.feedbackSignals || DEFAULT_CONFIG.learning.feedbackSignals,
            metaReview: {
              enabled:
                loadedConfig.learning.metaReview?.enabled ??
                DEFAULT_CONFIG.learning.metaReview.enabled,
              interval:
                loadedConfig.learning.metaReview?.interval ??
                DEFAULT_CONFIG.learning.metaReview.interval,
              minFindingsForReview:
                loadedConfig.learning.metaReview?.minFindingsForReview ??
                DEFAULT_CONFIG.learning.metaReview.minFindingsForReview,
            },
            patternDiscovery: {
              enabled:
                loadedConfig.learning.patternDiscovery?.enabled ??
                DEFAULT_CONFIG.learning.patternDiscovery.enabled,
              minFrequency:
                loadedConfig.learning.patternDiscovery?.minFrequency ??
                DEFAULT_CONFIG.learning.patternDiscovery.minFrequency,
              windowSize:
                loadedConfig.learning.patternDiscovery?.windowSize ??
                DEFAULT_CONFIG.learning.patternDiscovery.windowSize,
            },
          }
        : DEFAULT_CONFIG.learning,
    };

    const learningStore = new LearningStore();

    try {
      engine = new ReviewEngine(config, token, repo, learningStore);
      const gh = new GitHubHelper(token, repo);

      switch (inputs.mode) {
        case 'analyze':
          await runAnalyze(inputs, config, engine, gh, repo, token);
          break;
        case 'review':
          await runReview(inputs, config, engine, gh, repo);
          break;
        case 'fix':
          if (github.context.payload.issue?.pull_request) {
            await runAutofixLoop(inputs, config, engine, gh, repo, token);
          } else if (
            github.context.payload.issue?.number &&
            !github.context.payload.issue?.pull_request
          ) {
            await runFixIssue(inputs, config, engine, gh, repo, token);
          } else if (inputs.enableFix) {
            await runAutofixLoop(inputs, config, engine, gh, repo, token);
          } else {
            await runFix(inputs, config, engine, gh);
          }
          break;
        case 'audit':
          await runAudit(inputs, config, engine, gh);
          break;
        case 'post':
          await runPost(inputs, gh, repo, token);
          break;
        default:
          core.setFailed(`Unknown mode: ${inputs.mode}`);
      }
    } finally {
      if (engine) {
        await engine.cleanup();
      } else {
        await learningStore.close().catch(() => {});
      }
    }
  } catch (error) {
    const mode = core.getInput('mode') || 'unknown';
    const prNumber =
      github.context.payload.pull_request?.number ||
      github.context.payload.issue?.number ||
      'unknown';
    core.setFailed(
      `Action failed (mode: ${mode}, pr/issue: ${prNumber}): ${sanitize(error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    if (inputs?.enableStateCache && cacheManager) {
      await cacheManager.save();
    }
  }
}

run();
