import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_CONFIG,
  EventBus,
  FeedbackSubscriber,
  GitHubHelper,
  GitLabAdapter,
  LearningStore,
  Logger,
  type MCPServerConfig,
  MCPServerConfigSchema,
  type PlatformAdapter,
  ReviewEngine,
  SuppressionSubscriber,
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
import { runChangelog } from './changelog.js';
import { runDescribe } from './describe.js';
import { runDocs } from './docs.js';
import { runAutofixLoop, runFix, runFixIssue } from './fix.js';
import { type ActionInputs, parseInputs } from './inputs.js';
import { buildLLMConfig } from './llm.js';
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
    // Load the config file before parsing inputs so the config file's
    // `llm.defaultProvider` can drive bare-model resolution/validation for the
    // model inputs (parseInputs would otherwise fail a bare "llama3" before the
    // config default provider could ever apply). The configFile input is read
    // directly here; parseInputs re-reads it for the ActionInputs.configFile field.
    const platform = (process.env.PLATFORM || 'github') as string as 'github' | 'gitlab';
    const loadedConfig = loadConfig(undefined, platform, core.getInput('config') || undefined);

    // Assign into the outer function-scoped `inputs` (declared above the try)
    // rather than shadowing it: the outer `finally` block saves the learning
    // cache based on `inputs.enableStateCache`, so a shadowing local would
    // leave the outer variable undefined and `cacheManager.save()` would never
    // run on default-configured runs.
    inputs = parseInputs(loadedConfig?.llm);

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
      // On GitLab the GitHub Actions context is not populated, so the branch
      // ref used in the cache key must come from GitLab CI's CI_COMMIT_REF_NAME
      // (distinct branches then produce distinct cache keys). On GitHub the
      // StateCacheManager falls back to the Actions context ref.
      const cacheBranch = platform === 'gitlab' ? process.env.CI_COMMIT_REF_NAME : undefined;
      cacheManager = new StateCacheManager(inputs.stateCacheKey, {
        repo,
        ...(cacheBranch && { branch: cacheBranch }),
      });
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

    // Stage-model precedence: explicit per-stage input > global model input >
    // .opencode-reviewer.yml > built-in default (undefined → engine fallback).
    // Per-stage inputs already fold the global model in via parseInputs, so a
    // stage value is "explicit or global"; only globalModelExplicit tells them
    // apart, and a global model must outrank the config file.
    const resolveStageModel = (
      stageExplicit: boolean | undefined,
      stageValue: string | undefined,
      configValue: string | undefined,
    ): string | undefined => {
      if (stageExplicit) return stageValue;
      if (inputs?.globalModelExplicit) return stageValue;
      return configValue ?? stageValue;
    };

    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      reviewModel:
        resolveStageModel(
          inputs.reviewModelExplicit,
          inputs.reviewModel,
          loadedConfig?.reviewModel,
        ) ?? DEFAULT_CONFIG.reviewModel,
      fixModel:
        resolveStageModel(inputs.fixModelExplicit, inputs.fixModel, loadedConfig?.fixModel) ??
        DEFAULT_CONFIG.fixModel,
      auditModel: resolveStageModel(undefined, inputs.auditModel, loadedConfig?.auditModel),
      synthesisModel: resolveStageModel(
        undefined,
        inputs.synthesisModel,
        loadedConfig?.synthesisModel,
      ),
      verificationModel: resolveStageModel(
        undefined,
        inputs.verificationModel,
        loadedConfig?.verificationModel,
      ),
      metaReviewModel: resolveStageModel(
        undefined,
        inputs.metaReviewModel,
        loadedConfig?.metaReviewModel,
      ),
      explanationModel: resolveStageModel(
        undefined,
        inputs.explanationModel,
        loadedConfig?.explanationModel,
      ),
      conversationModel: resolveStageModel(
        undefined,
        inputs.conversationModel,
        loadedConfig?.conversationModel,
      ),
      analysisModel: resolveStageModel(
        undefined,
        inputs.analysisModel,
        loadedConfig?.analysisModel,
      ),
      docsModel: resolveStageModel(undefined, inputs.docsModel, loadedConfig?.docsModel),
      describeModel: resolveStageModel(
        undefined,
        inputs.describeModel,
        loadedConfig?.describeModel,
      ),
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
        streamComments: inputs.streamComments,
        streamBatchSize: inputs.streamBatchSize,
        legacyBatching:
          loadedConfig?.review?.legacyBatching ?? DEFAULT_CONFIG.review.legacyBatching,
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
        // Explicit workflow inputs are authoritative; only when the input is
        // omitted does the repo config value (or the opt-in default) apply.
        enableTestGapDetection: inputs.enableTestGapDetectionExplicit
          ? inputs.enableTestGapDetection
          : (loadedConfig?.review?.enableTestGapDetection ?? inputs.enableTestGapDetection),
        includePreExisting: loadedConfig?.review?.includePreExisting ?? inputs.includePreExisting,
        suggestTitleAndLabels:
          loadedConfig?.review?.suggestTitleAndLabels ??
          DEFAULT_CONFIG.review.suggestTitleAndLabels,
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
      docs: {
        enabled: loadedConfig?.docs?.enabled ?? DEFAULT_CONFIG.docs?.enabled ?? false,
        style: loadedConfig?.docs?.style ?? inputs.docStyle ?? DEFAULT_CONFIG.docs?.style ?? 'auto',
      },
      changelog: loadedConfig?.changelog
        ? {
            enabled: loadedConfig.changelog.enabled ?? DEFAULT_CONFIG.changelog?.enabled ?? false,
            outputFormat:
              loadedConfig.changelog.outputFormat ??
              DEFAULT_CONFIG.changelog?.outputFormat ??
              'markdown',
            categories:
              loadedConfig.changelog.categories ?? DEFAULT_CONFIG.changelog?.categories ?? {},
            filePath:
              loadedConfig.changelog.filePath ??
              DEFAULT_CONFIG.changelog?.filePath ??
              'CHANGELOG.md',
            createPR:
              loadedConfig.changelog.createPR ?? DEFAULT_CONFIG.changelog?.createPR ?? false,
            prBranchPrefix:
              loadedConfig.changelog.prBranchPrefix ??
              DEFAULT_CONFIG.changelog?.prBranchPrefix ??
              'changelog',
            subdirectoryFilter:
              loadedConfig.changelog.subdirectoryFilter ??
              DEFAULT_CONFIG.changelog?.subdirectoryFilter,
            includeFiles:
              loadedConfig.changelog.includeFiles ??
              DEFAULT_CONFIG.changelog?.includeFiles ??
              false,
            since: loadedConfig.changelog.since ?? DEFAULT_CONFIG.changelog?.since,
          }
        : DEFAULT_CONFIG.changelog,
      describe: {
        enabled: loadedConfig?.describe?.enabled ?? DEFAULT_CONFIG.describe.enabled,
        model:
          inputs.describeModel || loadedConfig?.describe?.model || DEFAULT_CONFIG.describe.model,
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
            suppressionRules: {
              enabled:
                loadedConfig.learning.suppressionRules?.enabled ??
                DEFAULT_CONFIG.learning.suppressionRules.enabled,
              minDismissals:
                loadedConfig.learning.suppressionRules?.minDismissals ??
                DEFAULT_CONFIG.learning.suppressionRules.minDismissals,
              ttlDays:
                loadedConfig.learning.suppressionRules?.ttlDays ??
                DEFAULT_CONFIG.learning.suppressionRules.ttlDays,
              maxReviews:
                loadedConfig.learning.suppressionRules?.maxReviews ??
                DEFAULT_CONFIG.learning.suppressionRules.maxReviews,
              maxRules:
                loadedConfig.learning.suppressionRules?.maxRules ??
                DEFAULT_CONFIG.learning.suppressionRules.maxRules,
              excludeSeverities:
                loadedConfig.learning.suppressionRules?.excludeSeverities ??
                DEFAULT_CONFIG.learning.suppressionRules.excludeSeverities,
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
      notifications: loadedConfig?.notifications ?? DEFAULT_CONFIG.notifications,
      multiAgent: loadedConfig?.multiAgent ?? DEFAULT_CONFIG.multiAgent,
      secrets: loadedConfig?.secrets ?? DEFAULT_CONFIG.secrets,
      // Explicit workflow inputs are authoritative so a PR cannot silently
      // disable SCA by editing .opencode-reviewer.yml; only when an input is
      // omitted does the repo config value (or input default) apply.
      sca: {
        enabled: inputs.scaEnabledExplicit
          ? inputs.scaEnabled
          : (loadedConfig?.sca?.enabled ?? inputs.scaEnabled),
        minSeverity: inputs.scaMinSeverityExplicit
          ? inputs.scaMinSeverity
          : (loadedConfig?.sca?.minSeverity ?? inputs.scaMinSeverity),
        lockFilePatterns:
          loadedConfig?.sca?.lockFilePatterns ?? DEFAULT_CONFIG.sca?.lockFilePatterns ?? [],
        excludePatterns:
          loadedConfig?.sca?.excludePatterns ?? DEFAULT_CONFIG.sca?.excludePatterns ?? [],
      },
      llm: buildLLMConfig(inputs, loadedConfig),
    };

    const learningStore = new LearningStore();

    try {
      const eventBus = new EventBus();
      // Persist duration/token telemetry for completed pipeline stages so
      // /metrics keeps reporting latency and token usage.
      eventBus.register(new TelemetrySubscriber(learningStore));
      // Persist dismissal/dispute feedback signals (registered before the
      // suppression sweep below so rule generation runs against feedback).
      eventBus.register(new FeedbackSubscriber(learningStore));
      // Close the dismissal-feedback learning loop: aggregate high-confidence
      // dismissal patterns into suppression rules and sweep expired ones.
      eventBus.register(new SuppressionSubscriber(learningStore, config));
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
        case 'docs':
          if (config.docs?.enabled === false) {
            core.info('Skipping docs mode — docs generation is disabled (docs.enabled: false)');
            break;
          }
          await runDocs(inputs, config, engine, gh);
          break;
        case 'changelog':
          await runChangelog(config, gh);
          break;
        case 'describe':
          if (config.describe?.enabled === false) {
            core.info(
              'Skipping describe mode — PR description generation is disabled (describe.enabled: false)',
            );
            break;
          }
          await runDescribe(inputs, config, engine, gh, repo, token);
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
