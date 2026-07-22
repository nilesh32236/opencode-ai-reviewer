import * as fs from 'node:fs';
import * as path from 'node:path';
import { restoreCache, saveCache } from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_CONFIG,
  GitHubHelper,
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

function getLearningDbMtime(stateDir: string): number {
  const dbPath = path.join(stateDir, 'learning.db');
  try {
    return fs.statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}

let learningDbMtimeMs = 0;

async function restoreStateCache(cacheKeyPrefix: string, stateDir: string): Promise<void> {
  const repoNwo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const branch = github.context.ref.replace('refs/heads/', '');
  const primaryKey = `${cacheKeyPrefix}-${repoNwo}-${branch}`;
  const restoreKeys = [`${cacheKeyPrefix}-${repoNwo}-`];

  if (!fs.existsSync(stateDir)) {
    core.info(`Restoring learning state from cache...`);
    try {
      const cacheKey = await restoreCache([stateDir], primaryKey, restoreKeys);
      if (cacheKey) {
        core.info(`Restored learning state from cache key: ${cacheKey}`);
      } else {
        core.info('No cached learning state found — starting fresh');
      }
    } catch (error) {
      core.warning(`Failed to restore learning state cache: ${error}`);
    }
  } else {
    core.info('.opencode/ directory already exists — skipping cache restore');
  }

  learningDbMtimeMs = getLearningDbMtime(stateDir);
}

async function saveStateCache(cacheKeyPrefix: string, stateDir: string): Promise<void> {
  if (!fs.existsSync(stateDir)) {
    core.info('No learning state directory found — skipping cache save');
    return;
  }

  const currentMtime = getLearningDbMtime(stateDir);
  if (currentMtime > 0 && currentMtime === learningDbMtimeMs) {
    core.info('Learning state unchanged — skipping cache save');
    return;
  }

  const repoNwo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const branch = github.context.ref.replace('refs/heads/', '');
  const cacheKey = `${cacheKeyPrefix}-${repoNwo}-${branch}`;

  try {
    await saveCache([stateDir], cacheKey);
    core.info(`Saved learning state to cache key: ${cacheKey}`);
  } catch (error) {
    core.warning(`Failed to save learning state cache: ${error}`);
  }
}

async function run(): Promise<void> {
  let inputs: ActionInputs | undefined;
  let engine: ReviewEngine | undefined;
  let stateDir = '';

  try {
    inputs = parseInputs();
    const loadedConfig = loadConfig();

    if (loadedConfig?.fix?.checkAllowlist?.length) {
      inputs.checkAllowlist = loadedConfig.fix.checkAllowlist;
    }

    const repo =
      core.getInput('repo') || `${github.context.repo.owner}/${github.context.repo.repo}`;
    const token = inputs.githubToken;
    stateDir = path.resolve(process.cwd(), inputs.stateCacheDir);

    if (inputs.enableStateCache) {
      await restoreStateCache(inputs.stateCacheKey, stateDir);
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

    engine = new ReviewEngine(config, token, repo);
    const gh = new GitHubHelper(token, repo);

    try {
      switch (inputs.mode) {
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
    process.exitCode = 1;
  } finally {
    if (inputs?.enableStateCache) {
      await saveStateCache(inputs.stateCacheKey, stateDir);
    }
  }
}

run().catch((err) => {
  core.setFailed(sanitize(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
  process.exit(1);
});
