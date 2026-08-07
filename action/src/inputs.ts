import * as core from '@actions/core';
import {
  type ActionMode,
  type CostTrackingVerbosity,
  DEFAULT_ALLOWLIST,
  DOC_STYLES,
  type DocStyle,
  type FailOnSeverity,
  type LLMConfig,
  type Severity,
  isDocStyle,
  validateModelString,
  validateRunChecksCommand,
} from '@opencode-pr-agent/lib';

const VALID_MODES: ActionMode[] = [
  'review',
  'fix',
  'audit',
  'post',
  'analyze',
  'self-heal',
  'setup',
  'docs',
  'describe',
  'changelog',
];

const VALID_FAIL_ON_SEVERITIES: readonly FailOnSeverity[] = [
  'off',
  'critical',
  'important',
  'minor',
];

const VALID_SCA_SEVERITIES: readonly Severity[] = ['critical', 'important', 'minor'];

export { DEFAULT_ALLOWLIST, validateRunChecksCommand };
/**
 * Parse and validate a timeout value from a raw string.
 * @param raw - The raw timeout string (e.g. "30"). Defaults to "20" if empty.
 * @returns The parsed timeout in minutes.
 */
export function parseTimeoutMinutes(raw: string): number {
  const timeoutMinutes = Number.parseInt(raw || '20', 10);
  if (isNaN(timeoutMinutes) || timeoutMinutes < 1) {
    throw new Error('timeout_minutes must be a positive integer');
  }
  return timeoutMinutes;
}

/**
 * Parse an optional USD cost rate (per 1K tokens) from a raw string.
 * Returns undefined for empty or invalid input.
 * @param raw - The raw cost rate string (e.g. "0.0025").
 * @returns The parsed rate, or undefined.
 */
function parseCostRate(raw: string): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const rate = Number(trimmed);
  return Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}

/**
 * Validate and normalize the cost tracking verbosity input.
 * @param raw - Raw verbosity string ('off' | 'summary' | 'detailed').
 * @returns A valid CostTrackingVerbosity, defaulting to 'summary'.
 */
function parseCostTrackingVerbosity(raw: string): CostTrackingVerbosity {
  if (raw === 'off' || raw === 'detailed') return raw;
  return 'summary';
}

/** Parsed and validated GitHub Action inputs for the OpenCode PR Agent. */
export interface ActionInputs {
  /** The operation mode: review, fix, audit, or post. */
  mode: ActionMode;
  /** GitHub token used for API authentication. */
  githubToken: string;
  /** Optional OpenAI API key. */
  openAiKey?: string;
  /** Optional Anthropic API key. */
  anthropicKey?: string;
  /** Optional Google Gemini API key. */
  geminiKey?: string;
  /** Optional default LLM provider used to prefix bare model names. */
  llmDefaultProvider?: string;
  /** Optional custom base URL for an OpenAI-compatible API. */
  llmBaseUrl?: string;
  /** Optional API key for the custom OpenAI-compatible base URL. */
  llmApiKey?: string;
  /** Optional Ollama base URL (default: http://localhost:11434/v1). */
  ollamaBaseUrl?: string;
  /** Optional Ollama model name. */
  ollamaModel?: string;
  /** Optional Azure OpenAI endpoint URL. */
  azureEndpoint?: string;
  /** Optional Azure OpenAI API key. */
  azureKey?: string;
  /** Optional Azure OpenAI deployment name. */
  azureDeployment?: string;
  /** Optional AWS Bedrock model ID. */
  bedrockModelId?: string;
  /** Optional AWS region for Bedrock. */
  bedrockRegion?: string;
  /** Model identifier for review operations. */
  reviewModel: string;
  /** Model identifier for fix operations. */
  fixModel: string;
  /** Model identifier for audit operations. */
  auditModel?: string;
  /** Model identifier for synthesis of collated batch results. */
  synthesisModel?: string;
  /** Model identifier for meta-verification (false-positive filtering). */
  verificationModel?: string;
  /** Whether the meta-verification pass is enabled. */
  enableMetaVerification: boolean;
  /** Whether test-gap detection (modified code without test updates) is enabled (default: false). */
  enableTestGapDetection: boolean;
  /** Whether the enable_test_gap_detection input was explicitly set by the workflow. */
  enableTestGapDetectionExplicit: boolean;
  /** Whether pre-existing (non-PR) code is reviewed at full audit priority (default: false). */
  includePreExisting: boolean;
  /** Model identifier for meta-review quality evaluation. */
  metaReviewModel?: string;
  /** Model identifier for PR explanation. */
  explanationModel?: string;
  /** Model identifier for interactive conversation. */
  conversationModel?: string;
  /** Model identifier for issue analysis. */
  analysisModel?: string;
  /** Model identifier for PR description generation. */
  describeModel?: string;
  /** Model identifier for documentation generation. */
  docsModel?: string;
  /** Doc comment style for the /docs command ('auto' infers per file). */
  docStyle: DocStyle;
  /** Optional path to a custom review prompt file. */
  reviewPromptFile?: string;
  /** Optional extra instructions appended to the review prompt. */
  reviewPromptExtra?: string;
  /** Optional path to a custom describe prompt file. */
  describePromptFile?: string;
  /** Optional extra instructions appended to the describe prompt. */
  describePromptExtra?: string;
  /** Optional path to a custom config file (overrides .opencode-reviewer.yml discovery). */
  configFile?: string;
  /** Whether automated fix mode is enabled. */
  enableFix: boolean;
  /** Maximum number of fix iterations allowed. */
  maxFixIterations: number;
  /** Whether automated audit mode is enabled. */
  enableAudit: boolean;
  /** Optional target directory for audit scans. */
  auditTargetDir?: string;
  /** List of target directories for multi-directory audits. */
  auditTargetDirs: string[];
  /** Maximum files to include per review batch. */
  maxFilesPerBatch: number;
  /** Maximum lines per file to process. */
  maxLinesPerFile: number;
  /** Optional project context/description string. */
  projectContext?: string;
  /** Whether MCP (Model Context Protocol) servers are enabled. */
  enableMCP: boolean;
  /** Whether to include strengths in review output. */
  includeStrengths: boolean;
  /** Whether to post a review summary comment on the PR. */
  reviewCommentSummary: boolean;
  /** Optional command to run after fix operations for verification. */
  runChecksAfterFix?: string;
  /** Allowlist of allowed programs for the verification command. */
  checkAllowlist: string[];
  /** Optional path to a custom audit prompt file. */
  auditPromptFile?: string;
  /** Whether to create GitHub issues for audit findings. */
  auditCreateIssues: boolean;
  /** Whether auto-fix is enabled during audit operations. */
  auditAutoFix: boolean;
  /** Labels to apply to created audit issues. */
  auditLabels: string[];
  /** Version of opencode to use. */
  opencodeVersion: string;
  /** In setup mode, probe every configured model instead of only the review model. */
  probeAllModels: boolean;
  /** Timeout in minutes for the operation. */
  timeoutMinutes: number;
  /** Whether to post review comments inline on the diff. */
  reviewInline: boolean;
  /** Severity threshold at or above which the action fails (default: 'off'). */
  failOnSeverity: FailOnSeverity;
  /** Whether the fail_on_severity input was explicitly set by the workflow. */
  failOnSeverityExplicit: boolean;
  /** Whether the learning state cache is enabled. */
  enableStateCache: boolean;
  /** Cache key prefix for learning state storage. */
  stateCacheKey: string;
  /** CI failure logs for self-heal mode. */
  ciFailureLogs?: string;
  /** Name of the failed CI step. */
  failedStep?: string;
  /** Name of the failed workflow. */
  failedWorkflow?: string;
  /** Whether token usage / cost data is exposed to users. */
  costTrackingEnabled: boolean;
  /** Detail level for token/cost exposure. */
  costTrackingVerbosity: CostTrackingVerbosity;
  /** Cost per 1K input tokens (USD) for cost estimation. */
  costTrackingInputCostPer1K?: number;
  /** Cost per 1K output tokens (USD) for cost estimation. */
  costTrackingOutputCostPer1K?: number;
  /** Whether the deterministic dependency vulnerability (SCA) scan runs (default: true). */
  scaEnabled: boolean;
  /** Minimum severity for SCA findings (critical | important | minor, default: important). */
  scaMinSeverity: Severity;
  /** Whether the sca_enabled input was explicitly set by the workflow. */
  scaEnabledExplicit: boolean;
  /** Whether the sca_min_severity input was explicitly set by the workflow. */
  scaMinSeverityExplicit: boolean;
}

/**
 * Parse and validate all GitHub Action inputs from workflow environment.
 *
 * @param configLlm - The `.opencode-reviewer.yml` `llm:` block (when one is
 * configured). Its `defaultProvider` is used as a fallback when the
 * `llm_default_provider` action input is unset, and its provider entries
 * (Azure `deployment` / Bedrock `modelId`) are used to route bare model names
 * when a provider is configured solely via the config file, so the workflow
 * author gets bare model names resolved (and validated) correctly.
 * @returns A fully populated ActionInputs object.
 */
export function parseInputs(configLlm?: LLMConfig): ActionInputs {
  const modeStr = core.getInput('mode', { required: true }).toLowerCase().trim();
  if (!VALID_MODES.includes(modeStr as ActionMode)) {
    throw new Error(`Invalid mode: "${modeStr}". Must be one of: ${VALID_MODES.join(', ')}`);
  }

  const maxFixIterations = Number.parseInt(core.getInput('max_fix_iterations') || '3', 10);
  if (isNaN(maxFixIterations) || maxFixIterations < 1 || maxFixIterations > 10) {
    throw new Error('max_fix_iterations must be between 1 and 10');
  }

  const maxFilesPerBatch = Number.parseInt(core.getInput('max_files_per_batch') || '3', 10);
  if (isNaN(maxFilesPerBatch) || maxFilesPerBatch < 1) {
    throw new Error('max_files_per_batch must be a positive integer');
  }

  const maxLinesPerFile = Number.parseInt(core.getInput('max_lines_per_file') || '500', 10);
  if (isNaN(maxLinesPerFile) || maxLinesPerFile < 1) {
    throw new Error('max_lines_per_file must be a positive integer');
  }

  const auditLabelsStr = core.getInput('audit_labels') || 'audit';
  const auditLabels = auditLabelsStr
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  const auditTargetDirsStr = core.getInput('audit_target_dirs') || '';
  const auditTargetDirs = auditTargetDirsStr
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const opencodeVersion =
    core.getInput('opencode_version') || core.getInput('opencode-version') || 'latest';

  const mode = modeStr as ActionMode;
  const globalModel = core.getInput('model').trim();

  // GitHub Actions inputs are not trimmed by default, so normalize each model
  // value before validation to avoid confusing "Invalid model format" errors
  // for values with surrounding whitespace.
  const modelInput = (name: string): string | undefined => {
    const value = core.getInput(name).trim();
    return value || undefined;
  };

  const githubToken = core.getInput('github_token', { required: true });
  if (!githubToken) {
    throw new Error('github_token input is required but was empty');
  }

  // A configured default LLM provider lets workflow authors write bare model
  // names (e.g. "llama3") that resolve to "ollama/llama3" before validation.
  // The action input wins over the config file's llm.defaultProvider; when
  // neither is set but an Azure deployment / Bedrock model id is given, the
  // provider is inferred so a bare model routes to the hosted deployment.
  const llmDefaultProviderInput = modelInput('llm_default_provider');
  const azureDeploymentInput = modelInput('azure_deployment_name');
  const bedrockModelIdInput = modelInput('aws_bedrock_model_id');
  // Provider entries may be configured solely via the config file (e.g.
  // `llm.providers.azure.deployment`), so mirror the lib-side resolveModel
  // lookup: use the config-file deployment/model id as a fallback when no
  // matching action input is supplied.
  const configAzureDeployment = Object.values(configLlm?.providers ?? {})
    .find((p) => p?.type === 'azure' && p.deployment?.trim())
    ?.deployment?.trim();
  const configBedrockModelId = Object.values(configLlm?.providers ?? {})
    .find((p) => p?.type === 'bedrock' && p.modelId?.trim())
    ?.modelId?.trim();
  const configDefaultProvider = configLlm?.defaultProvider;
  const effectiveDefaultProvider =
    llmDefaultProviderInput || configDefaultProvider
      ? (llmDefaultProviderInput || configDefaultProvider)!
      : azureDeploymentInput || configAzureDeployment
        ? 'azure'
        : bedrockModelIdInput || configBedrockModelId
          ? 'amazon-bedrock'
          : undefined;
  const resolveModel = (value: string | undefined): string | undefined => {
    if (!value) return value;
    const trimmed = value.trim();
    if (trimmed.includes('/')) return trimmed;
    if (!effectiveDefaultProvider?.trim()) return trimmed;
    const provider = effectiveDefaultProvider.trim();
    // Azure/Bedrock deployments are addressed by the deployment/model id, not
    // the bare model name: "llama3" + azure deployment "my-dep" → "azure/my-dep".
    if (provider === 'azure') {
      const deployment = azureDeploymentInput?.trim() || configAzureDeployment;
      if (deployment) return `azure/${deployment}`;
    }
    if (provider === 'amazon-bedrock') {
      const modelId = bedrockModelIdInput?.trim() || configBedrockModelId;
      if (modelId) return `amazon-bedrock/${modelId}`;
    }
    return `${provider}/${trimmed}`;
  };

  const reviewModel =
    resolveModel(modelInput('review_model') || globalModel) || 'opencode/deepseek-v4-flash-free';
  const fixModel =
    resolveModel(modelInput('fix_model') || globalModel) || 'opencode/deepseek-v4-flash-free';
  const auditModel = resolveModel(modelInput('audit_model') || globalModel) || undefined;
  const synthesisModel = resolveModel(modelInput('synthesis_model') || globalModel) || undefined;
  const verificationModel =
    resolveModel(modelInput('verification_model') || globalModel) || undefined;
  const metaReviewModel = resolveModel(modelInput('meta_review_model') || globalModel) || undefined;
  const explanationModel =
    resolveModel(modelInput('explanation_model') || globalModel) || undefined;
  const conversationModel =
    resolveModel(modelInput('conversation_model') || globalModel) || undefined;
  const analysisModel = resolveModel(modelInput('analysis_model') || globalModel) || undefined;
  const describeModel = resolveModel(modelInput('describe_model') || globalModel) || undefined;
  const docsModel = resolveModel(modelInput('docs_model') || globalModel) || undefined;

  const docStyleRaw = core.getInput('doc_style').trim().toLowerCase();
  if (docStyleRaw !== '' && !isDocStyle(docStyleRaw)) {
    throw new Error(
      `Invalid doc_style: "${docStyleRaw}". Must be one of: ${DOC_STYLES.join(', ')}`,
    );
  }
  const docStyle: DocStyle = isDocStyle(docStyleRaw) ? docStyleRaw : 'auto';

  const enableMetaVerification = core.getInput('enable_meta_verification') === 'true';
  const enableAudit = core.getInput('enable_audit') === 'true';

  const enableTestGapDetectionInput = core.getInput('enable_test_gap_detection');
  const enableTestGapDetectionRaw = enableTestGapDetectionInput.trim();
  if (
    enableTestGapDetectionRaw !== '' &&
    enableTestGapDetectionRaw !== 'true' &&
    enableTestGapDetectionRaw !== 'false'
  ) {
    throw new Error(
      `Invalid enable_test_gap_detection: "${enableTestGapDetectionInput.trim()}". Must be true or false.`,
    );
  }
  // Opt-in by default: an absent input resolves to disabled. The explicit-input
  // flag is NOT set for an omitted input so an `.opencode-reviewer.yml`
  // `review.enableTestGapDetection` continues to win when the workflow leaves it unset.
  const enableTestGapDetection =
    enableTestGapDetectionRaw === '' ? false : enableTestGapDetectionRaw === 'true';
  const enableTestGapDetectionExplicit = enableTestGapDetectionRaw !== '';

  const failOnSeverityInput = core.getInput('fail_on_severity');
  const failOnSeverityRaw = (failOnSeverityInput || 'off').trim().toLowerCase();
  if (!VALID_FAIL_ON_SEVERITIES.includes(failOnSeverityRaw as FailOnSeverity)) {
    throw new Error(
      `Invalid fail_on_severity: "${failOnSeverityRaw}". Must be one of: ${VALID_FAIL_ON_SEVERITIES.join(', ')}`,
    );
  }
  const failOnSeverity = failOnSeverityRaw as FailOnSeverity;
  const failOnSeverityExplicit = failOnSeverityInput.trim() !== '';

  const scaEnabledInput = core.getInput('sca_enabled');
  const scaEnabledRaw = scaEnabledInput.trim();
  if (scaEnabledRaw !== '' && scaEnabledRaw !== 'true' && scaEnabledRaw !== 'false') {
    throw new Error(`Invalid sca_enabled: "${scaEnabledInput.trim()}". Must be true or false.`);
  }
  // Empty (omitted) resolves to enabled by default; the explicit-input flag is
  // NOT set for an omitted input so an `.opencode-reviewer.yml` `sca.enabled`
  // continues to win, matching the sca_min_severity fallback behavior.
  const scaEnabled = scaEnabledRaw === '' ? true : scaEnabledRaw === 'true';
  const scaEnabledExplicit = scaEnabledRaw !== '';

  const scaMinSeverityInput = core.getInput('sca_min_severity');
  const scaMinSeverityRaw = (scaMinSeverityInput || 'important').trim().toLowerCase();
  if (!VALID_SCA_SEVERITIES.includes(scaMinSeverityRaw as Severity)) {
    throw new Error(
      `Invalid sca_min_severity: "${scaMinSeverityRaw}". Must be one of: ${VALID_SCA_SEVERITIES.join(', ')}`,
    );
  }
  const scaMinSeverity = scaMinSeverityRaw as Severity;
  const scaMinSeverityExplicit = scaMinSeverityInput.trim() !== '';

  // Models for features that are active in the selected mode are hard-gated so
  // an invalid value fails the action before any work starts. Models whose
  // feature is disabled (or that the action never runs, e.g. conversation) only
  // log a warning: a stale or deliberately unused value must not fail the whole
  // action, and runOpenCode() remains the authoritative fail-fast gate for any
  // model that is actually used.
  const activeModel: Record<string, boolean> = {
    reviewModel: true,
    fixModel: true,
    auditModel: mode === 'audit' || enableAudit,
    synthesisModel: mode === 'review',
    verificationModel: enableMetaVerification,
    metaReviewModel: mode === 'review' || mode === 'fix' || mode === 'audit',
    explanationModel: false,
    conversationModel: false,
    analysisModel: mode === 'analyze',
    describeModel: mode === 'describe',
    docsModel: mode === 'docs',
  };

  for (const [field, model] of Object.entries({
    reviewModel,
    fixModel,
    auditModel,
    synthesisModel,
    verificationModel,
    metaReviewModel,
    explanationModel,
    conversationModel,
    analysisModel,
    describeModel,
    docsModel,
  })) {
    if (!model) continue;
    try {
      validateModelString(model);
    } catch (error) {
      if (activeModel[field]) throw error;
      core.warning(
        `Ignoring invalid ${field} "${model}" for a disabled feature: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    mode,
    githubToken,
    openAiKey: core.getInput('openai_api_key') || undefined,
    anthropicKey: core.getInput('anthropic_api_key') || undefined,
    geminiKey: core.getInput('gemini_api_key') || undefined,
    llmDefaultProvider: llmDefaultProviderInput,
    llmBaseUrl: core.getInput('llm_base_url') || undefined,
    llmApiKey: core.getInput('llm_api_key') || undefined,
    ollamaBaseUrl: core.getInput('ollama_base_url') || undefined,
    ollamaModel: core.getInput('ollama_model') || undefined,
    azureEndpoint: core.getInput('azure_openai_endpoint') || undefined,
    azureKey: core.getInput('azure_openai_key') || undefined,
    azureDeployment: core.getInput('azure_deployment_name') || undefined,
    bedrockModelId: core.getInput('aws_bedrock_model_id') || undefined,
    bedrockRegion: core.getInput('aws_region') || undefined,
    reviewModel,
    fixModel,
    auditModel,
    synthesisModel,
    verificationModel,
    enableMetaVerification,
    enableTestGapDetection,
    enableTestGapDetectionExplicit,
    includePreExisting: core.getInput('include_pre_existing') === 'true',
    metaReviewModel,
    explanationModel,
    conversationModel,
    analysisModel,
    describeModel,
    docsModel,
    docStyle,
    reviewPromptFile: core.getInput('review_prompt_file') || undefined,
    reviewPromptExtra: core.getInput('review_prompt_extra') || undefined,
    describePromptFile: core.getInput('describe_prompt_file') || undefined,
    describePromptExtra: core.getInput('describe_prompt_extra') || undefined,
    configFile: core.getInput('config') || undefined,
    enableFix: core.getInput('enable_fix') !== 'false',
    maxFixIterations,
    enableAudit,
    auditTargetDir: core.getInput('audit_target_dir') || undefined,
    auditTargetDirs,
    maxFilesPerBatch,
    maxLinesPerFile,
    projectContext: core.getInput('project_context') || undefined,
    enableMCP: core.getInput('enable_mcp').trim().toLowerCase() === 'true',
    includeStrengths: core.getInput('include_strengths') !== 'false',
    reviewCommentSummary: core.getInput('review_comment_summary') !== 'false',
    runChecksAfterFix: core.getInput('run_checks_after_fix') || undefined,
    checkAllowlist: DEFAULT_ALLOWLIST,
    auditPromptFile: core.getInput('audit_prompt_file') || undefined,
    auditCreateIssues: core.getInput('audit_create_issues') !== 'false',
    auditAutoFix: core.getInput('audit_auto_fix') === 'true',
    auditLabels,
    opencodeVersion,
    probeAllModels: core.getInput('probe_all_models') === 'true',
    timeoutMinutes: parseTimeoutMinutes(core.getInput('timeout_minutes')),
    reviewInline: core.getInput('review_inline') !== 'false',
    failOnSeverity,
    failOnSeverityExplicit,
    enableStateCache: core.getInput('enable_state_cache') !== 'false',
    stateCacheKey: core.getInput('state_cache_key') || 'opencode-learning-state',
    ciFailureLogs: core.getInput('ci_failure_logs') || undefined,
    failedStep: core.getInput('failed_step') || undefined,
    failedWorkflow: core.getInput('failed_workflow') || undefined,
    costTrackingEnabled: core.getInput('cost_tracking_enabled') === 'true',
    costTrackingVerbosity: parseCostTrackingVerbosity(
      core.getInput('cost_tracking_verbosity') || 'summary',
    ),
    costTrackingInputCostPer1K: parseCostRate(core.getInput('cost_tracking_input_cost_per_1k')),
    costTrackingOutputCostPer1K: parseCostRate(core.getInput('cost_tracking_output_cost_per_1k')),
    scaEnabled,
    scaMinSeverity,
    scaEnabledExplicit,
    scaMinSeverityExplicit,
  };
}
