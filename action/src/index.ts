import * as fs from 'node:fs';
import * as path from 'node:path';
import { restoreCache, saveCache } from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_CONFIG,
  EventBus,
  GitHubHelper,
  GitLabAdapter,
  LearningStore,
  type MCPServerConfig,
  MCPServerConfigSchema,
  type PlatformAdapter,
  ReviewEngine,
  TelemetrySubscriber,
  configureGit,
  getDefaultMCPServers,
  loadConfig,
  mergeConfigWithInputs,
  registerEventSubscribers,
  setupOpenCode,
  setupWorkspaceDependencies,
} from '@opencode-pr-agent/lib';
import { runAnalyze } from './analyze.js';
import { runAudit } from './audit.js';
import { runAutofixLoop, runFix, runFixIssue } from './fix.js';
import { type ActionInputs, parseInputs } from './inputs.js';
import { runPost } from './post.js';
import { runReview } from './review.js';
import { runSelfHeal } from './self-heal.js';
import { runSetup } from './setup.js';
import { sanitize } from './utils.js';

function buildCacheKey(prefix: string, repo?: string, branch?: string): string {
  const repoNwo = repo || `${github.context.repo.owner}/${github.context.repo.repo}`;
  const branchRef = branch || github.context.ref.replace('refs/heads/', '');
  return `${prefix}-${repoNwo}-${branchRef}`;
}

class StateCacheManager {
  private learningDbMtimeMs = 0;
  private readonly stateDir: string;
  private readonly cacheKeyPrefix: string;
  private readonly repo: string;
  private readonly branch: string;

  constructor(cacheKeyPrefix: string, repo?: string, branch?: string) {
    this.cacheKeyPrefix = cacheKeyPrefix;
    this.stateDir = path.resolve(process.cwd(), '.opencode');
    this.repo = repo || `${github.context.repo.owner}/${github.context.repo.repo}`;
    this.branch = branch || github.context.ref.replace('refs/heads/', '');
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
    const primaryKey = buildCacheKey(this.cacheKeyPrefix, this.repo, this.branch);
    const restoreKeys = [`${this.cacheKeyPrefix}-${this.repo}-`];
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

    const cacheKey = buildCacheKey(this.cacheKeyPrefix, this.repo, this.branch);
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

    const platform = (process.env.PLATFORM || 'github') as string as 'github' | 'gitlab';
    const loadedConfig = loadConfig(undefined, platform, inputs.configFile);

    if (platform === 'gitlab') {
      if (!process.env.CI_PROJECT_NAMESPACE || !process.env.CI_PROJECT_NAME) {
        core.setFailed(
          'GitLab platform requires CI_PROJECT_NAMESPACE and CI_PROJECT_NAME env vars',
        );
        return;
      }
    }

    if (loadedConfig?.fix?.checkAllowlist?.length) {
      inputs.checkAllowlist = loadedConfig.fix.checkAllowlist;
    }

    const token = inputs.githubToken;
    const repo =
      platform === 'gitlab'
        ? `${process.env.CI_PROJECT_NAMESPACE || ''}/${process.env.CI_PROJECT_NAME || ''}`
        : core.getInput('repo') || `${github.context.repo.owner}/${github.context.repo.repo}`;

    if (inputs.enableStateCache) {
      cacheManager = new StateCacheManager(inputs.stateCacheKey, repo);
      await cacheManager.restore();
    }

    if (inputs.mode !== 'setup') {
      await setupOpenCode(inputs.opencodeVersion, token);
      await setupWorkspaceDependencies(process.cwd());
    }

    const gitUser =
      core.getInput('git_user_name') ||
      (platform === 'gitlab'
        ? process.env.GITLAB_USER_LOGIN || 'opencode-reviewer[bot]'
        : process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]');
    const gitEmail =
      core.getInput('git_user_email') ||
      (platform === 'gitlab'
        ? `${process.env.GITLAB_USER_LOGIN || 'opencode-reviewer[bot]'}@noreply.gitlab.com`
        : `${process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]'}@users.noreply.github.com`);
    configureGit(gitUser, gitEmail, token);

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
      auditModel: inputs.auditModel,
      synthesisModel: inputs.synthesisModel,
      verificationModel: inputs.verificationModel,
      metaReviewModel: inputs.metaReviewModel,
      explanationModel: inputs.explanationModel,
      conversationModel: inputs.conversationModel,
      analysisModel: inputs.analysisModel,
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
        ...(loadedConfig?.review?.skipLabels && { skipLabels: loadedConfig.review.skipLabels }),
        ...(loadedConfig?.review?.skipActors && { skipActors: loadedConfig.review.skipActors }),
        inline: loadedConfig?.review?.inline ?? inputs.reviewInline,
        ...(loadedConfig?.review?.tokenBudget && { tokenBudget: loadedConfig.review.tokenBudget }),
        ...(loadedConfig?.review?.enableReachability !== undefined && {
          enableReachability: loadedConfig.review.enableReachability,
        }),
        reviewBudget: {
          enabled:
            loadedConfig?.review?.budget?.enabled ??
            DEFAULT_CONFIG.review.reviewBudget?.enabled ??
            false,
          summaryThreshold:
            loadedConfig?.review?.budget?.summaryThreshold ??
            DEFAULT_CONFIG.review.reviewBudget?.summaryThreshold ??
            500,
          splitThreshold:
            loadedConfig?.review?.budget?.splitThreshold ??
            DEFAULT_CONFIG.review.reviewBudget?.splitThreshold ??
            1000,
        },
        costTracking: {
          enabled: loadedConfig?.review?.costTracking?.enabled ?? inputs.costTrackingEnabled,
          verbosity: loadedConfig?.review?.costTracking?.verbosity ?? inputs.costTrackingVerbosity,
          ...(loadedConfig?.review?.costTracking?.inputCostPer1K !== undefined && {
            inputCostPer1K: loadedConfig.review.costTracking.inputCostPer1K,
          }),
          ...(loadedConfig?.review?.costTracking?.outputCostPer1K !== undefined && {
            outputCostPer1K: loadedConfig.review.costTracking.outputCostPer1K,
          }),
          // Explicit action inputs take precedence over config-file rates.
          ...(inputs.costTrackingInputCostPer1K !== undefined && {
            inputCostPer1K: inputs.costTrackingInputCostPer1K,
          }),
          ...(inputs.costTrackingOutputCostPer1K !== undefined && {
            outputCostPer1K: inputs.costTrackingOutputCostPer1K,
          }),
        },
        sensitivity: {
          minSeverity:
            loadedConfig?.review?.sensitivity?.minSeverity ??
            DEFAULT_CONFIG.review.sensitivity?.minSeverity ??
            'warning',
          confidenceThreshold:
            loadedConfig?.review?.sensitivity?.confidenceThreshold ??
            DEFAULT_CONFIG.review.sensitivity?.confidenceThreshold ??
            'low',
          maxFindingsPerCategory:
            loadedConfig?.review?.sensitivity?.maxFindingsPerCategory ??
            DEFAULT_CONFIG.review.sensitivity?.maxFindingsPerCategory,
          maxTotalFindings:
            loadedConfig?.review?.sensitivity?.maxTotalFindings ??
            DEFAULT_CONFIG.review.sensitivity?.maxTotalFindings,
          focusAreas:
            loadedConfig?.review?.sensitivity?.focusAreas ??
            DEFAULT_CONFIG.review.sensitivity?.focusAreas,
          ignorePatterns:
            loadedConfig?.review?.sensitivity?.ignorePatterns ??
            DEFAULT_CONFIG.review.sensitivity?.ignorePatterns,
        },
        categories: loadedConfig?.review?.categories ?? DEFAULT_CONFIG.review.categories,
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
      conversation: {
        ...DEFAULT_CONFIG.conversation,
        ...(loadedConfig?.conversation && {
          maxTurns: loadedConfig.conversation.maxTurns ?? DEFAULT_CONFIG.conversation.maxTurns,
          slidingWindowSize:
            loadedConfig.conversation.slidingWindowSize ??
            DEFAULT_CONFIG.conversation.slidingWindowSize,
          contextTokenBudget:
            loadedConfig.conversation.contextTokenBudget ??
            DEFAULT_CONFIG.conversation.contextTokenBudget,
          ...(loadedConfig.conversation.summarizationModel !== undefined && {
            summarizationModel: loadedConfig.conversation.summarizationModel,
          }),
        }),
      },
      eventLogging: loadedConfig?.eventLogging ?? DEFAULT_CONFIG.eventLogging,
      eventSubscribers: loadedConfig?.eventSubscribers ?? DEFAULT_CONFIG.eventSubscribers,
    };

    const learningStore = new LearningStore();

    try {
      const eventBus = new EventBus();
      // Persist duration/token telemetry for completed pipeline stages so
      // /metrics keeps reporting latency and token usage.
      eventBus.register(new TelemetrySubscriber(learningStore));
      const registeredSubscribers = await registerEventSubscribers(
        eventBus,
        config.eventLogging,
        config.eventSubscribers,
      );
      if (registeredSubscribers.length > 0) {
        core.info(`Registered ${registeredSubscribers.length} event subscriber(s)`);
      }

      const gh: PlatformAdapter =
        platform === 'gitlab' ? new GitLabAdapter(token, repo) : new GitHubHelper(token, repo);
      engine = new ReviewEngine(config, gh, learningStore, eventBus, repo);

      switch (inputs.mode) {
        case 'analyze':
          await runAnalyze(inputs, config, engine, gh, repo, token);
          break;
        case 'review':
          await runReview(inputs, config, engine, gh, repo);
          break;
        case 'fix':
          {
            const isPr =
              platform === 'gitlab'
                ? !!process.env.CI_MERGE_REQUEST_IID
                : !!github.context.payload.pull_request ||
                  !!github.context.payload.issue?.pull_request;
            const issueNum =
              platform === 'gitlab'
                ? Number(process.env.CI_MERGE_REQUEST_IID || '0')
                : github.context.payload.issue?.number ||
                  github.context.payload.pull_request?.number;
            if (isPr) {
              await runAutofixLoop(inputs, config, engine, gh, repo, token);
            } else if (issueNum && !isPr) {
              await runFixIssue(inputs, config, engine, gh, repo, token);
            } else if (inputs.enableFix) {
              await runAutofixLoop(inputs, config, engine, gh, repo, token);
            } else {
              await runFix(inputs, config, engine, gh);
            }
          }
          break;
        case 'audit':
          await runAudit(inputs, config, engine, gh);
          break;
        case 'self-heal':
          await runSelfHeal(inputs, config, engine, gh, repo, token);
          break;
        case 'post':
          await runPost(inputs, gh, repo, token);
          break;
        case 'setup':
          await runSetup(inputs, config, gh, repo, token);
          break;
        default:
          core.setFailed(`Unknown mode: ${inputs.mode}`);
      }
    } finally {
      if (engine) {
        await engine.cleanup();
      } else {
        try {
          await learningStore.close();
        } catch (err) {
          core.warning(`Failed to close learning store: ${err}`);
        }
      }
    }
  } catch (error) {
    const mode = core.getInput('mode') || 'unknown';
    const prNumber = process.env.CI_MERGE_REQUEST_IID
      ? Number(process.env.CI_MERGE_REQUEST_IID)
      : github.context.payload.pull_request?.number ||
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
