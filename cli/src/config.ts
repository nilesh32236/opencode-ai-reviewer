import {
  type AgentConfig,
  DEFAULT_CONFIG,
  type PromptConfig,
  resolveConfig,
} from '@opencode-pr-agent/lib';

/** Options for building a local AgentConfig. */
export interface ConfigOptions {
  /** Model to use for the review (defaults to the built-in review model). */
  model?: string;
  /** Changed file paths, used to resolve per-path config `overrides`. */
  changedFiles?: string[];
  /** Current branch/head ref, used to resolve per-branch config `overrides`. */
  headRef?: string;
}

/**
 * Build a full {@link AgentConfig} for a local CLI review by layering a loaded
 * `.opencode-reviewer.yml` (or `--config`) file over the built-in defaults, then
 * applying explicit CLI flag overrides. Per-path / per-branch `overrides` from
 * the config file are resolved against the review's changed files and head ref,
 * mirroring the GitHub Action path (mergeConfigWithInputs + resolveConfig).
 * Local-specific concerns (learning store, rate limiting, event subscribers)
 * are disabled since they are GitHub-app concerns with no offline equivalent.
 * @param loadedConfig - Parsed config file, or null when none was found.
 * @param options - CLI overrides, changed files, and head ref.
 * @returns A fully-populated AgentConfig for local review execution.
 */
export function buildAgentConfig(
  loadedConfig: PromptConfig | null,
  options: ConfigOptions = {},
): AgentConfig {
  const model = options.model?.trim() || DEFAULT_CONFIG.reviewModel;

  // Resolve branch/path overrides against the files being reviewed and the
  // current head ref so `overrides` behave like they do in the Action.
  const resolvedConfig = loadedConfig
    ? resolveConfig(loadedConfig, {
        paths: options.changedFiles ?? [],
        branch: options.headRef,
      })
    : loadedConfig;
  const config = resolvedConfig ?? {};

  const projectDescription = [
    config.project?.name ? `**Project:** ${config.project.name}` : '',
    config.project?.description || '',
    config.project?.conventions?.length
      ? `\n## Conventions\n${config.project.conventions.map((c) => `- ${c}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    ...DEFAULT_CONFIG,
    reviewModel: model,
    fixModel: model,
    auditModel: model,
    synthesisModel: model,
    verificationModel: model,
    metaReviewModel: model,
    explanationModel: model,
    conversationModel: model,
    analysisModel: model,
    // MCP servers here are the *review engine's* context enrichors
    // (config.mcpServers, managed by lib's MCPManager), a GitHub-app concern
    // with no offline equivalent. This is distinct from the user's own OpenCode
    // CLI MCP servers/plugins, which buildLocalOpenCodeConfig leaves intact.
    enableMCP: false,
    mcpServers: [],
    projectContext: {
      description: projectDescription,
      typecheckCommands: config.fix?.runChecks || [],
      lintCommands: [],
      customRules: config.review?.customRules?.join('\n') || undefined,
    },
    review: {
      ...DEFAULT_CONFIG.review,
      ...(config.review?.skipLabels !== undefined && {
        skipLabels: config.review.skipLabels,
      }),
      ...(config.review?.skipActors !== undefined && {
        skipActors: config.review.skipActors,
      }),
      inline: config.review?.inline ?? DEFAULT_CONFIG.review.inline,
      ...(config.review?.excludePatterns !== undefined && {
        excludePatterns: config.review.excludePatterns,
      }),
      enableMetaVerification:
        config.review?.enableMetaVerification ?? DEFAULT_CONFIG.review.enableMetaVerification,
      includePreExisting:
        config.review?.includePreExisting ?? DEFAULT_CONFIG.review.includePreExisting,
      ...(config.review?.enableReachability !== undefined && {
        enableReachability: config.review.enableReachability,
      }),
      ...(config.review?.enableCodebaseIndex !== undefined && {
        enableCodebaseIndex: config.review.enableCodebaseIndex,
      }),
      ...(config.review?.tokenBudget !== undefined && {
        tokenBudget: config.review.tokenBudget,
      }),
      ...(config.review?.sensitivity !== undefined && {
        sensitivity: config.review.sensitivity,
      }),
      ...(config.review?.categories !== undefined && {
        categories: config.review.categories,
      }),
    },
    audit: {
      ...DEFAULT_CONFIG.audit,
      promptsDir: config.audit?.promptsDir || DEFAULT_CONFIG.audit.promptsDir,
      ...(config.audit?.targetDirs !== undefined && {
        targetDirs: config.audit.targetDirs,
      }),
    },
    learning: {
      ...DEFAULT_CONFIG.learning,
      enabled: false,
    },
    conversation: {
      ...DEFAULT_CONFIG.conversation,
      enabled: false,
    },
    linters: loadedConfig?.linters || [],
    rateLimiting: {
      ...DEFAULT_CONFIG.rateLimiting,
      enabled: false,
    },
    eventLogging: {
      ...DEFAULT_CONFIG.eventLogging,
      enabled: false,
    },
    eventSubscribers: [],
  };
}
