import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_CONFIG,
  EventBus,
  GitHubHelper,
  GitLabAdapter,
  LearningStore,
  Logger,
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
import { StateCacheManager } from './state-cache.js';
import { sanitize } from './utils.js';

async function run(): Promise<void> {
  // The GitHub Action defaults to human-readable logs because CI already
  // captures stdout and `::`-prefixed core commands render nicely in the
  // Actions UI. Structured NDJSON is opt-in via the `LOG_FORMAT=json` env var;
  // it is never forced by NODE_ENV here so action logs stay readable unless
  // explicitly configured otherwise. Set at the top of the entrypoint so the
  // format is resolved before any Logger is constructed (module-scope mutation
  // between imports would rely on ESM import hoisting and could be reordered).
  if (!process.env.LOG_FORMAT) {
    process.env.LOG_FORMAT = 'human';
  }

  // One-shot process: seed a single process-wide trace ID so every subsystem
  // logger (cache manager, MCP, metrics, engine, bus) shares one correlation ID.
  const correlationId = Logger.setRootCorrelationId();

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
      cacheManager = new StateCacheManager(inputs.stateCacheKey, { repo });
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
    // Pin the commit author email to a stable bot identity (overridable via the
    // `git_user_email` input). Deriving it from the triggering actor would make
    // the autofix branch-reuse gate in `runFixIssue` depend on which human
    // triggered `/fix`, so a re-trigger by a different actor would discard the
    // bot's in-progress branch. The fixed bot email keeps the comparison stable
    // across actors and makes the bot's own autofix commits consistently
    // attributed. This is a reuse heuristic, not a security boundary — git
    // author emails are self-asserted and forgeable.
    const gitEmail =
      core.getInput('git_user_email') ||
      (platform === 'gitlab'
        ? 'opencode-reviewer[bot]@noreply.gitlab.com'
        : 'opencode-ai-reviewer[bot]@users.noreply.github.com');
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
            const message = `Invalid MCP servers config: ${result.error.message}`;
            core.warning(sanitize(message));
            new Logger('MCP').warn('Invalid MCP servers config', {
              operation: 'mcp.validation',
              error: result.error.message,
            });
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
        // When the workflow explicitly sets fail_on_severity it is authoritative
        // so a PR cannot disable its own gate by editing .opencode-reviewer.yml.
        // Only when the input is omitted does the repo config value apply.
        failOnSeverity: inputs.failOnSeverityExplicit
          ? inputs.failOnSeverity
          : (loadedConfig?.review?.failOnSeverity ?? inputs.failOnSeverity),
        ...(loadedConfig?.review?.suppressLowConfidence !== undefined && {
          suppressLowConfidence: loadedConfig.review.suppressLowConfidence,
        }),
        enableMetaVerification:
          loadedConfig?.review?.enableMetaVerification ?? inputs.enableMetaVerification,
        includePreExisting: loadedConfig?.review?.includePreExisting ?? inputs.includePreExisting,
        ...(loadedConfig?.review?.tokenBudget && { tokenBudget: loadedConfig.review.tokenBudget }),
        ...(loadedConfig?.review?.enableReachability !== undefined && {
          enableReachability: loadedConfig.review.enableReachability,
        }),
        ...(loadedConfig?.review?.enableCodebaseIndex !== undefined && {
          enableCodebaseIndex: loadedConfig.review.enableCodebaseIndex,
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
      engine = new ReviewEngine(config, gh, learningStore, eventBus, repo, correlationId);

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
              await runFixIssue(inputs, config, engine, gh, repo, gitEmail);
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
          core.warning(sanitize(`Failed to close learning store: ${err}`));
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
      `Action failed (mode: ${mode}, pr/issue: ${prNumber}): ${sanitize(withDownloadRemediation(error instanceof Error ? error.message : String(error)))}`,
    );
  } finally {
    if (inputs?.enableStateCache && cacheManager) {
      await cacheManager.save();
    }
  }
}

const DOWNLOAD_FAILURE_PATTERNS = [
  /failed to download/i,
  /could not find asset/i,
  /release .* not found/i,
  /download timed out/i,
  /checksum (mismatch|verification)/i,
  /network error/i,
];

/**
 * Append a concise remediation hint when an error indicates an OpenCode binary
 * download failure and the underlying message does not already contain next
 * steps (e.g. errors thrown outside `setupOpenCode`'s download wrapper).
 * @param message - The error message about to be surfaced via core.setFailed.
 * @returns The message, with a download-remediation hint appended when relevant.
 */
function withDownloadRemediation(message: string): string {
  const isDownloadFailure = DOWNLOAD_FAILURE_PATTERNS.some((re) => re.test(message));
  const hasRemediation = /re-run the workflow|next steps|firewall|proxy/i.test(message);
  if (isDownloadFailure && !hasRemediation) {
    return `${message}\n\nIf this is a transient network or GitHub server error, re-run the workflow to retry. For checksum errors, clear the action cache and re-run.`;
  }
  return message;
}

run();
