import { type ActionMode, type CostTrackingVerbosity, DEFAULT_ALLOWLIST, type DocStyle, type FailOnSeverity, validateRunChecksCommand } from '@opencode-pr-agent/lib';
export { DEFAULT_ALLOWLIST, validateRunChecksCommand };
/**
 * Parse and validate a timeout value from a raw string.
 * @param raw - The raw timeout string (e.g. "30"). Defaults to "20" if empty.
 * @returns The parsed timeout in minutes.
 */
export declare function parseTimeoutMinutes(raw: string): number;
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
    /** Model identifier for documentation generation. */
    docsModel?: string;
    /** Doc comment style for the /docs command ('auto' infers per file). */
    docStyle: DocStyle;
    /** Optional path to a custom review prompt file. */
    reviewPromptFile?: string;
    /** Optional extra instructions appended to the review prompt. */
    reviewPromptExtra?: string;
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
}
/**
 * Parse and validate all GitHub Action inputs from workflow environment.
 *
 * @param configDefaultProvider - The `.opencode-reviewer.yml` `llm.defaultProvider`
 * (when one is configured). Used as a fallback when the `llm_default_provider`
 * action input is unset, so a workflow author who relies on the config file's
 * default provider gets bare model names resolved (and validated) correctly.
 * @returns A fully populated ActionInputs object.
 */
export declare function parseInputs(configDefaultProvider?: string): ActionInputs;
