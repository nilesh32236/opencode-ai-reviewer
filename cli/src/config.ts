import { type AgentConfig, DEFAULT_CONFIG, type PromptConfig } from '@opencode-pr-agent/lib';

/** Options for building a local AgentConfig. */
export interface ConfigOptions {
  /** Model to use for the review (defaults to the built-in review model). */
  model?: string;
}

/**
 * Build a full {@link AgentConfig} for a local CLI review by layering a loaded
 * `.opencode-reviewer.yml` (or `--config`) file over the built-in defaults, then
 * applying explicit CLI flag overrides. Local-specific concerns (learning store,
 * MCP servers, rate limiting, event subscribers) are disabled since they are
 * GitHub-app concerns with no offline equivalent.
 * @param loadedConfig - Parsed config file, or null when none was found.
 * @param options - CLI overrides.
 * @returns A fully-populated AgentConfig for local review execution.
 */
export function buildAgentConfig(
  loadedConfig: PromptConfig | null,
  options: ConfigOptions = {},
): AgentConfig {
  const model = options.model?.trim() || DEFAULT_CONFIG.reviewModel;

  const projectDescription = [
    loadedConfig?.project?.name ? `**Project:** ${loadedConfig.project.name}` : '',
    loadedConfig?.project?.description || '',
    loadedConfig?.project?.conventions?.length
      ? `\n## Conventions\n${loadedConfig.project.conventions.map((c) => `- ${c}`).join('\n')}`
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
    enableMCP: false,
    mcpServers: [],
    projectContext: {
      description: projectDescription,
      typecheckCommands: loadedConfig?.fix?.runChecks || [],
      lintCommands: [],
      customRules: loadedConfig?.review?.customRules?.join('\n') || undefined,
    },
    review: {
      ...DEFAULT_CONFIG.review,
      ...(loadedConfig?.review?.skipLabels !== undefined && {
        skipLabels: loadedConfig.review.skipLabels,
      }),
      ...(loadedConfig?.review?.skipActors !== undefined && {
        skipActors: loadedConfig.review.skipActors,
      }),
      inline: loadedConfig?.review?.inline ?? DEFAULT_CONFIG.review.inline,
      ...(loadedConfig?.review?.suppressLowConfidence !== undefined && {
        suppressLowConfidence: loadedConfig.review.suppressLowConfidence,
      }),
      ...(loadedConfig?.review?.excludePatterns !== undefined && {
        excludePatterns: loadedConfig.review.excludePatterns,
      }),
      enableMetaVerification:
        loadedConfig?.review?.enableMetaVerification ??
        DEFAULT_CONFIG.review.enableMetaVerification,
      includePreExisting:
        loadedConfig?.review?.includePreExisting ?? DEFAULT_CONFIG.review.includePreExisting,
      ...(loadedConfig?.review?.enableReachability !== undefined && {
        enableReachability: loadedConfig.review.enableReachability,
      }),
      ...(loadedConfig?.review?.enableCodebaseIndex !== undefined && {
        enableCodebaseIndex: loadedConfig.review.enableCodebaseIndex,
      }),
      ...(loadedConfig?.review?.tokenBudget !== undefined && {
        tokenBudget: loadedConfig.review.tokenBudget,
      }),
      ...(loadedConfig?.review?.sensitivity !== undefined && {
        sensitivity: loadedConfig.review.sensitivity,
      }),
      ...(loadedConfig?.review?.categories !== undefined && {
        categories: loadedConfig.review.categories,
      }),
    },
    audit: {
      ...DEFAULT_CONFIG.audit,
      promptsDir: loadedConfig?.audit?.promptsDir || DEFAULT_CONFIG.audit.promptsDir,
      ...(loadedConfig?.audit?.targetDirs !== undefined && {
        targetDirs: loadedConfig.audit.targetDirs,
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
