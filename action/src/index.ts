import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_ALLOWLIST,
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
  getErrorStatus,
  loadConfig,
  mergeConfigWithInputs,
  parseReviewEffort,
  registerEventSubscribers,
  resolveExcludeAgentConfigs,
  resolveReviewEffort,
  setupOpenCode,
  setupWorkspaceDependencies,
} from '@opencode-pr-agent/lib';
import { runAnalyze } from './analyze.js';
import { runAudit } from './audit.js';
import { runChangelog } from './changelog.js';
import {
  GATED_COMMENT_EVENTS,
  PRIVILEGED_MODES,
  extractCommentCommand,
  extractOperatorInstruction,
  verifyCommentActorPermission,
} from './comment-commands.js';
import { runDescribe } from './describe.js';
import { runDocs } from './docs.js';
import { type FixOperatorInstruction, runAutofixLoop, runFix, runFixIssue } from './fix.js';
import { type ActionInputs, parseInputs } from './inputs.js';
import { buildLLMConfig } from './llm.js';
import { runPost } from './post.js';
import { runReview } from './review.js';
import { runSelfHeal } from './self-heal.js';
import { runSetup } from './setup.js';
import { StateCacheManager } from './state-cache.js';
import { createRunAbortController, describeAbortKind, resolvePrNumber, sanitize } from './utils.js';

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
    const rawPlatform = (process.env.PLATFORM || 'github').trim().toLowerCase();
    if (rawPlatform !== 'github' && rawPlatform !== 'gitlab') {
      core.setFailed(
        sanitize(
          `Unsupported PLATFORM: ${(process.env.PLATFORM ?? '')
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, 100)}`,
        ),
      );
      return;
    }
    const platform: 'github' | 'gitlab' = rawPlatform;
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

    // The verification allowlist is workflow-authoritative: the repo config
    // file lives in the PR branch, so a PR author must never be able to widen
    // it (e.g. adding "bash"/"curl"/"sh" to reach parseRunChecksCommands
    // execution). Config entries outside DEFAULT_ALLOWLIST are dropped with a
    // warning; narrowing (e.g. ["pnpm"]) is preserved.
    if (loadedConfig?.fix?.checkAllowlist?.length) {
      const requested = loadedConfig.fix.checkAllowlist;
      const allowed = requested.filter((c) => DEFAULT_ALLOWLIST.includes(c));
      const dropped = requested.filter((c) => !DEFAULT_ALLOWLIST.includes(c));
      if (dropped.length > 0) {
        core.warning(
          sanitize(
            `Ignoring checkAllowlist entries not in the workflow allowlist (${DEFAULT_ALLOWLIST.join(', ')}): ${dropped.join(', ')}`,
          ),
        );
      }
      if (allowed.length > 0) {
        inputs.checkAllowlist = allowed;
      }
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
      // Export the validated variant to the environment so every
      // `runOpenCode()` invocation picks it up via the OPENCODE_VARIANT
      // fallback (no engine changes needed; unset means default behavior).
      if (inputs.opencodeVariant) {
        process.env.OPENCODE_VARIANT = inputs.opencodeVariant;
      }
      // Export the validated resume flag so every `runOpenCode()` invocation
      // picks it up via the INPUT_RESUME_ON_NETWORK_ERROR fallback (unset or
      // false means current behavior; explicit per-run options still win).
      // Always synced: an explicit false must override a stale true left in
      // the runner environment from an earlier step.
      process.env.INPUT_RESUME_ON_NETWORK_ERROR = inputs.resumeOnNetworkError ? 'true' : 'false';
      await setupOpenCode(inputs.opencodeVersion, token, undefined, {
        requireChecksum: inputs.requireOpencodeChecksum,
      });
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

    // Single `review.effort` / `review_effort` preset knob: action input wins
    // over the config file; explicit per-setting values always override the
    // preset; `balanced` and unset resolve to current behavior (identity).
    // An explicitly-set-but-invalid input blocks the config-file fallback so
    // invalid values fall back to defaults (fail-open) per the README.
    const effectiveEffort = inputs.reviewEffortExplicit
      ? parseReviewEffort(inputs.reviewEffort)
      : parseReviewEffort(loadedConfig?.review?.effort);
    const effortPreset = resolveReviewEffort(effectiveEffort);
    if (effortPreset && effectiveEffort) {
      core.info(`Using review effort preset: ${effectiveEffort}`);
    }

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
      docsModel: inputs.docsModel,
      describeModel: inputs.describeModel,
      batchSize:
        effortPreset && !inputs.maxFilesPerBatchExplicit
          ? effortPreset.batchSize
          : inputs.maxFilesPerBatch,
      maxLinesPerFile:
        effortPreset && !inputs.maxLinesPerFileExplicit
          ? effortPreset.maxLinesPerFile
          : inputs.maxLinesPerFile,
      maxIterations: loadedConfig?.fix?.maxIterations ?? inputs.maxFixIterations,
      timeoutMinutes: inputs.timeoutMinutes,
      enableMCP: inputs.enableMCP,
      mcpServers,
      projectContext: {
        description: inputs.projectContext || (mergedDefaults.project_context as string) || '',
        typecheckCommands: loadedConfig?.fix?.runChecks || [],
        lintCommands: [],
        customRules: loadedConfig?.review?.customRules?.join('\n') || undefined,
        autoLoadAgentsMd:
          loadedConfig?.project?.autoLoadAgentsMd ??
          loadedConfig?.project?.autoLoadConventions ??
          false,
        ...(loadedConfig?.project?.autoLoadConventions !== undefined && {
          autoLoadConventions: loadedConfig.project.autoLoadConventions,
        }),
        ...(loadedConfig?.project?.attributionFooter !== undefined && {
          attributionFooter: loadedConfig.project.attributionFooter,
        }),
      },
      review: {
        ...DEFAULT_CONFIG.review,
        ...(loadedConfig?.review?.skipLabels && { skipLabels: loadedConfig.review.skipLabels }),
        ...(loadedConfig?.review?.skipActors && { skipActors: loadedConfig.review.skipActors }),
        inline: loadedConfig?.review?.inline ?? inputs.reviewInline,
        dedupFingerprints:
          loadedConfig?.review?.dedupFingerprints ??
          loadedConfig?.review?.dedup_fingerprints ??
          inputs.dedupFingerprints,
        enableReviewsArrayInline:
          loadedConfig?.review?.enableReviewsArrayInline ?? inputs.enableReviewsArrayInline,
        updateInPlace: loadedConfig?.review?.updateInPlace ?? inputs.updateInPlace,
        autoResolveAddressed: loadedConfig?.review?.autoResolveAddressed ?? true,
        emitChecksSummary: loadedConfig?.review?.emitChecksSummary ?? inputs.emitChecksSummary,
        // When the workflow explicitly sets verdict_mode it is authoritative
        // so a PR cannot weaken/strengthen its own gate by editing
        // .opencode-reviewer.yml. Only when the input is omitted does the
        // repo config value apply.
        verdictMode: inputs.verdictModeExplicit
          ? inputs.verdictMode
          : (loadedConfig?.review?.verdictMode ?? inputs.verdictMode),
        streamComments: inputs.streamComments,
        streamBatchSize: inputs.streamBatchSize,
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
          effortPreset &&
          !inputs.enableMetaVerificationExplicit &&
          loadedConfig?.review?.enableMetaVerification === undefined
            ? effortPreset.enableMetaVerification
            : (loadedConfig?.review?.enableMetaVerification ?? inputs.enableMetaVerification),
        // Explicit workflow inputs are authoritative; only when the input is
        // omitted does the repo config value (or the opt-in default) apply.
        enableTestGapDetection: inputs.enableTestGapDetectionExplicit
          ? inputs.enableTestGapDetection
          : (loadedConfig?.review?.enableTestGapDetection ?? inputs.enableTestGapDetection),
        includePreExisting: loadedConfig?.review?.includePreExisting ?? inputs.includePreExisting,
        showFunctionScores: loadedConfig?.review?.showFunctionScores ?? false,
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
        // Canonical camelCase key wins over the deprecated snake_case alias;
        // falls back to the built-in default (true) when neither is set.
        excludeAgentConfigs:
          resolveExcludeAgentConfigs(loadedConfig?.review) ??
          DEFAULT_CONFIG.review.excludeAgentConfigs ??
          true,
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
          noiseBudget:
            loadedConfig?.review?.sensitivity?.noiseBudget ??
            DEFAULT_CONFIG.review.sensitivity?.noiseBudget,
          focusAreas:
            loadedConfig?.review?.sensitivity?.focusAreas ??
            DEFAULT_CONFIG.review.sensitivity?.focusAreas,
          ignorePatterns:
            loadedConfig?.review?.sensitivity?.ignorePatterns ??
            DEFAULT_CONFIG.review.sensitivity?.ignorePatterns,
        },
        categories: loadedConfig?.review?.categories ?? DEFAULT_CONFIG.review.categories,
        ...(loadedConfig?.review?.pathInstructions &&
          Object.keys(loadedConfig.review.pathInstructions).length > 0 && {
            pathInstructions: loadedConfig.review.pathInstructions,
          }),
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
        useMarkers: inputs.describeUseMarkersExplicit
          ? inputs.describeUseMarkers
          : (loadedConfig?.describe?.useMarkers ?? DEFAULT_CONFIG.describe.useMarkers ?? false),
        publishAsComment: inputs.describePublishAsCommentExplicit
          ? inputs.describePublishAsComment
          : (loadedConfig?.describe?.publishAsComment ??
            DEFAULT_CONFIG.describe.publishAsComment ??
            true),
        enableDiagram:
          inputs.enableDiagram ??
          loadedConfig?.describe?.enableDiagram ??
          DEFAULT_CONFIG.describe.enableDiagram ??
          false,
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
      // Explicit workflow input (true or false) takes precedence over repo
      // config; otherwise the repo config value (or the warn-only default)
      // applies. Fail-open: the engine warns and continues unless
      // enforcement is on.
      toolchain: {
        enforceNodeFloor: inputs.enforceNodeFloorExplicit
          ? inputs.enforceNodeFloor
          : (loadedConfig?.toolchain?.enforceNodeFloor ?? inputs.enforceNodeFloor),
      },
      llm: buildLLMConfig(inputs, loadedConfig),
    };

    const learningStore = new LearningStore();

    // Per-run AbortController: deadline derived from the effective run budget
    // (config.timeoutMinutes, default 20m). The signal is advisory-only: it is
    // threaded into mode runners for pre-iteration abort checks, withRetry
    // backoff sleeps, and execWithTimeout races, but engine LLM calls accept
    // no AbortSignal so in-flight LLM calls are not cancellable and hung
    // subprocesses are reported (exit 124) rather than killed. Wall-clock
    // Date.now() checks in fix.ts/self-heal.ts remain as the outer scheduling
    // guard. The deadline fires with a TimeoutError reason so timeout-vs-cancel
    // stays distinguishable in logs (see describeAbortKind).
    const runAbort = createRunAbortController(config.timeoutMinutes);
    const runSignal = runAbort.signal;

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

      // Authorization gate: comment-triggered commands (/fix, /analyze,
      // manual re-review) must only be honored when the commenter holds
      // write/admin permission. Without this, any user who can comment could
      // trigger LLM runs, force-push branches, open PRs, and post comments
      // with the repo-scoped token. Fail closed on lookup failure.
      //
      // Scope notes:
      // - GitHub-only. On GitLab the action is invoked from .gitlab-ci.yml
      //   pipeline jobs and never parses a comment webhook in-process (there
      //   is no note-event payload or actor available), so there is no
      //   untrusted comment-actor vector to gate here.
      // - Covers issue_comment, pull_request_review_comment, AND
      //   pull_request_review (submitted-review) events: a review body can
      //   carry `/fix` / `/review` and trigger a workflow, so it must pass
      //   the same permission check (payload.review.body).
      // - Fail-closed on trigger/gate mismatch: workflow triggers use
      //   substring `contains(body, '/fix')` semantics, which fire on text
      //   like 'a/fix' that the strict gate regex intentionally does not
      //   recognize. When a comment event reaches a privileged mode (fix,
      //   review) the gate therefore requires permission EVEN when no
      //   recognized command extracts — otherwise the workflow would run
      //   privileged work unauthenticated. Non-privileged modes keep the
      //   command-presence check so stray comments neither fail nor gate.
      // Triggering-comment body, hoisted so it survives the auth gate and can
      // be forwarded to the fix agent as an operator instruction. Resolved in
      // two layers: the explicit `comment-body` action input wins (future
      // workflow wiring: ${{ github.event.comment.body }}), falling back to
      // the in-process comment payload (covers workflows that omit the input).
      // Classification (token stripping/truncation) lives in extractOperatorInstruction (comment-commands.ts); here we
      // only decide *whether* a comment qualifies. The permission gate above
      // still runs first — content is consumed only after authorization, and
      // stays an operator instruction, never untrusted third-party content.
      // GitLab path: no comment payload exists, so this resolves to undefined
      // (documented no-op) unless the input is explicitly passed.
      // Tracks whether the comment-event gate already authorized this run, so
      // explicit `comment-body` inputs on comment events are not re-checked
      // (and explicit inputs on non-comment events get their own check).
      let commentEventAuthorized = false;
      const resolveGateBody = (): string | undefined => {
        if (platform !== 'github') return undefined;
        if (!GATED_COMMENT_EVENTS.has(github.context.eventName)) return undefined;
        const comment = github.context.payload.comment as { body?: unknown } | undefined;
        if (comment && typeof comment.body === 'string') return comment.body;
        const review = github.context.payload.review as { body?: unknown } | undefined;
        if (review && typeof review.body === 'string') return review.body;
        return undefined;
      };
      let fixOperator: FixOperatorInstruction | undefined;
      const resolveFixOperator = async (): Promise<FixOperatorInstruction | undefined> => {
        if (inputs?.mode !== 'fix') return undefined;
        const explicitRaw = inputs?.commentBody?.trim() ? inputs.commentBody : undefined;
        const payloadBody =
          platform === 'github'
            ? ((): string | undefined => {
                const c = github.context.payload.comment as
                  | { body?: unknown; user?: { login?: string } }
                  | undefined;
                if (typeof c?.body === 'string') return c.body;
                const r = github.context.payload.review as { body?: unknown } | undefined;
                return typeof r?.body === 'string' ? r.body : undefined;
              })()
            : undefined;
        const payloadActor =
          platform === 'github'
            ? ((): string | undefined => {
                const c = github.context.payload.comment as
                  | { body?: unknown; user?: { login?: string } }
                  | undefined;
                const login =
                  c?.user?.login ??
                  (github.context.payload.review as { user?: { login?: string } } | undefined)?.user
                    ?.login;
                if (typeof login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(login)) return login;
                // Only fall back to the workflow actor when a comment payload
                // body exists; otherwise a non-comment trigger
                // (schedule/dispatch/label) with an explicit input would get a
                // misleading 'authorized /fix comment by @<scheduler>' header.
                if (typeof c?.body !== 'string') {
                  const r = github.context.payload.review as { body?: unknown } | undefined;
                  if (typeof r?.body !== 'string') return undefined;
                }
                const fallback = github.context.actor;
                if (typeof fallback === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(fallback))
                  return fallback;
                return undefined;
              })()
            : undefined;
        // Explicit input wins: the workflow author deliberately threaded it.
        // Gated on the same fix/oc command check as the payload fallback so a
        // miswired workflow passing '/review ...' via comment-body never
        // becomes a fix operator instruction. On non-comment events
        // (schedule/workflow_dispatch/label) the comment-event gate never ran,
        // so the explicit input gets its own permission check here (checking
        // the workflow actor) instead of driving privileged work
        // unauthenticated; on comment events the gate above already authorized.
        if (explicitRaw) {
          const cmd = extractCommentCommand(explicitRaw);
          if (cmd !== 'fix' && cmd !== 'oc') return undefined;
          const classified = extractOperatorInstruction(explicitRaw);
          if (!classified) return undefined;
          if (!commentEventAuthorized) {
            const authorized = await verifyCommentActorPermission(token);
            if (!authorized) {
              return undefined;
            }
            commentEventAuthorized = true;
          }
          return payloadActor
            ? { instruction: explicitRaw, actor: payloadActor }
            : { instruction: explicitRaw };
        }
        // Payload fallback: only for authorized /fix (/oc alias) triggers, so
        // stray non-command comments never become fix instructions.
        if (payloadBody) {
          const command = extractCommentCommand(payloadBody);
          if (command !== 'fix' && command !== 'oc') return undefined;
          const classified = extractOperatorInstruction(payloadBody);
          if (!classified) return undefined;
          return payloadActor
            ? { instruction: payloadBody, actor: payloadActor }
            : { instruction: payloadBody };
        }
        return undefined;
      };
      if (platform === 'github' && GATED_COMMENT_EVENTS.has(github.context.eventName)) {
        const gateBody = resolveGateBody();
        const command = extractCommentCommand(gateBody ?? '');
        const isPrivileged = inputs?.mode ? PRIVILEGED_MODES.has(inputs.mode) : false;
        if (command !== null) {
          const authorized = await verifyCommentActorPermission(token);
          if (!authorized) {
            return;
          }
          commentEventAuthorized = true;
        } else if (isPrivileged) {
          // Fail closed: the workflow may have triggered on a substring
          // ('a/fix') the strict gate regex does not recognize — or on a
          // bodyless review event (empty approval) where no command can
          // extract. A privileged mode must never run unauthenticated, so
          // require permission whenever the command gate did not authorize,
          // whether or not a body is present.
          core.warning(
            sanitize(
              'Comment event reached privileged mode without a recognized slash-command — requiring write permission anyway (fail-closed for substring triggers like "a/fix")',
            ),
          );
          const authorized = await verifyCommentActorPermission(token);
          if (!authorized) {
            return;
          }
          commentEventAuthorized = true;
        } else if (gateBody !== undefined) {
          core.info('Ignoring non-command comment event — skipping authorization gate');
        }
      }
      fixOperator = await resolveFixOperator();
      // Harden the explicit-input path: resolveFixOperator authorizes the
      // workflow actor for non-comment events, but a denial there returns
      // undefined rather than stopping the run. When fix mode was explicitly
      // driven by a `comment-body` /fix input yet authorization failed,
      // fail closed instead of silently running an unprompted fix.
      // (verifyCommentActorPermission already recorded the failure via
      // setFailed; this return just prevents the run from continuing.)
      if (platform === 'github' && inputs?.mode === 'fix' && inputs?.commentBody?.trim()) {
        const explicitCmd = extractCommentCommand(inputs.commentBody);
        if (
          (explicitCmd === 'fix' || explicitCmd === 'oc') &&
          extractOperatorInstruction(inputs.commentBody) !== undefined &&
          !commentEventAuthorized &&
          fixOperator === undefined
        ) {
          return;
        }
      }

      switch (inputs.mode) {
        case 'analyze':
          await runAnalyze(inputs, config, engine, gh, repo, token, runSignal);
          break;
        case 'review':
          await runReview(inputs, config, engine, gh, repo, runSignal);
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
              await runAutofixLoop(inputs, config, engine, gh, repo, token, runSignal, fixOperator);
            } else if (issueNum && !isPr) {
              await runFixIssue(inputs, config, engine, gh, repo, gitEmail, runSignal, fixOperator);
            } else {
              // No PR/issue in the event payload (e.g. schedule/workflow_dispatch).
              // Fall back to the explicit `pr-number` input and classify the target
              // via the platform API: an issue number routes to the issue-fix flow
              // instead of 404ing on /pulls/<issue>.
              const explicitNum = await resolvePrNumber();
              let isExplicitMr = true;
              if (explicitNum !== null) {
                try {
                  isExplicitMr = await gh.isMR(explicitNum);
                } catch (err) {
                  const status = getErrorStatus(err);
                  const suffix = status !== undefined ? ` (status ${status})` : '';
                  core.setFailed(
                    sanitize(
                      `Failed to classify #${explicitNum} as PR/issue${suffix}: ${err instanceof Error ? err.message : err}`,
                    ),
                  );
                  return;
                }
              }
              if (explicitNum !== null && !isExplicitMr) {
                await runFixIssue(
                  inputs,
                  config,
                  engine,
                  gh,
                  repo,
                  gitEmail,
                  runSignal,
                  fixOperator,
                );
              } else if (inputs.enableFix) {
                await runAutofixLoop(
                  inputs,
                  config,
                  engine,
                  gh,
                  repo,
                  token,
                  runSignal,
                  fixOperator,
                );
              } else {
                await runFix(inputs, config, engine, gh, runSignal, fixOperator);
              }
            }
          }
          break;
        case 'audit':
          await runAudit(inputs, config, engine, gh, runSignal);
          break;
        case 'docs':
          if (config.docs?.enabled === false) {
            core.info('Skipping docs mode — docs generation is disabled (docs.enabled: false)');
            break;
          }
          await runDocs(inputs, config, engine, gh, runSignal);
          break;
        case 'changelog':
          await runChangelog(config, gh, runSignal);
          break;
        case 'describe':
          if (config.describe?.enabled === false) {
            core.info(
              'Skipping describe mode — PR description generation is disabled (describe.enabled: false)',
            );
            break;
          }
          await runDescribe(inputs, config, engine, gh, repo, token, runSignal);
          break;
        case 'self-heal':
          await runSelfHeal(inputs, config, engine, gh, repo, token, runSignal);
          break;
        case 'post':
          await runPost(inputs, gh, repo, token, runSignal);
          break;
        case 'setup':
          await runSetup(inputs, config, gh, repo, token, runSignal);
          break;
        default:
          core.setFailed(`Unknown mode: ${inputs.mode}`);
      }
    } finally {
      runAbort.dispose();
      if (engine) {
        // Never let a cleanup failure mask the run's real outcome (or fail an
        // otherwise-successful run): warn-and-continue, mirroring the
        // learningStore.close() guard below.
        try {
          await engine.cleanup();
        } catch (err) {
          const msg = `engine.cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
          core.warning(sanitize(msg));
          new Logger('Action').warn(msg, {
            operation: 'engine.cleanup',
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
    const abortKind = describeAbortKind(error);
    const abortSuffix =
      abortKind === 'timeout'
        ? ' (run deadline exceeded: TimeoutError)'
        : abortKind === 'cancelled'
          ? ' (run cancelled: AbortError)'
          : '';
    core.setFailed(
      `Action failed (mode: ${mode}, pr/issue: ${prNumber})${abortSuffix}: ${sanitize(withDownloadRemediation(error instanceof Error ? error.message : String(error)))}`,
    );
  } finally {
    if (inputs?.enableStateCache && cacheManager) {
      // Defensive: cache persistence must never alter the run's pass/fail
      // signal. StateCacheManager.save() currently swallows internally, but a
      // future rejection from inside this finally block would otherwise mask
      // the real outcome.
      try {
        await cacheManager.save();
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to save state cache: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
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

void run();
