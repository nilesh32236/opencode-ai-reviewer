export * from './types/index.js';
export * from './types/schemas.js';
export {
  setupOpenCode,
  runOpenCode,
  validateModelString,
  ensureOutputDir,
  configureGit,
  getGitStatus,
  setupWorkspaceDependencies,
  resolveOpenCodePath,
  resolveRequireChecksum,
  parseTokenUsage,
  parseTokenUsageDetailed,
  checkHealth,
  parseOpenCodeVersion,
  isVersionCompatible,
  setOpenCodeRunMode,
  setLLMProviderConfig,
  setDualEmitSubagentPermissions,
  resolveDualEmitSubagentPermissions,
  setDualEmitMCP,
  resolveDualEmitMCP,
  shouldUseV2MCPServers,
  buildMCPConfigBlock,
  mergeMCPConfig,
  normalizeMCPConfigForVersion,
  isMCPConfigRejection,
  stripLegacyMCPKeys,
  stripV2ServersKey,
  noteMCPConfigRejection,
  MCP_V2_SERVERS_CUTOFF,
  buildLocalOpenCodeConfig,
  buildLLMProviderMap,
  MINIMUM_OPENCODE_VERSION,
  OPENCODE_VARIANT_MIN_VERSION,
  sanitizeVariant,
  resolveOpenCodeVariant,
  supportsOpenCodeVariant,
  isVariantFlagRejection,
  resolveResumeOnNetworkError,
  isNetworkErrorOutput,
  extractTaskId,
  isValidResumeTaskId,
  buildResumeArgs,
  createIsolatedOpenCodeHome,
  cleanupIsolatedOpenCodeHome,
  cleanupIsolatedOpenCodeHomeAsync,
  cleanupAskPassDirAsync,
  removeTempDirAsync,
  ensureSignalHandlers,
  downloadWithTimeout,
  getOpenCodeState,
} from './opencode.js';
export type {
  TokenUsageBreakdown,
  OpenCodeHealth,
  OpenCodeVersion,
  CheckHealthOptions,
  OpenCodeRunMode,
  OpenCodeStateSnapshot,
  SetupOpenCodeOptions,
} from './opencode.js';
export { GitHubHelper } from './utils/github.js';
export {
  buildChecksSummaryOutput,
  normalizeVerdictMode,
  resolveReviewEvent,
  validateInlinePositionsAgainstHunks,
} from './utils/github.js';
export type { MergeApprovalEvent, ReviewEvent } from './utils/github.js';
export { GitLabAdapter } from './utils/gitlab-adapter.js';
export {
  getGitBlame,
  parseBlamePorcelain,
  parsePatchHunks,
  MAX_BLAME_LINES_PER_FILE,
} from './utils/blame.js';
export type { BlameRange, BlameAttribution, GetGitBlameOptions } from './utils/blame.js';
export type {
  HeadCIStatus,
  PlatformAdapter,
  ReviewPostResult,
  ReviewThreadInfo,
  BotReviewInfo,
  ReviewCommentDetail,
  ReviewCommentThread,
} from './platform/adapter.js';
export { createPlatformAdapter, selectPlatform } from './platform/adapter.js';
export { checkHeadCIGreen, isHeadCIGreen } from './utils/head-ci.js';
export type { HeadCICheck, HeadCIGateResult, HeadCIGreenOptions } from './utils/head-ci.js';
export {
  MERGE_ADVISORY_LABEL,
  MERGE_APPROVAL_ASSOCIATIONS,
  MERGE_APPROVAL_LABEL,
  MERGE_APPROVAL_PERMISSIONS,
  MERGE_FORBIDDEN_LABELS,
  hasForbiddenMergeLabel,
  hasMergeApprovalLabel,
  isBotActor,
  isMergeAuthorized,
  isPrivilegedAssociation,
  isPrivilegedPermission,
} from './utils/merge-approval.js';
export type { MergeAuthorizationInput, MergeAuthorizationResult } from './utils/merge-approval.js';
export {
  emptyResult,
  parseJsonlFile,
  parseJsonlString,
  parseAgentJsonlString,
  normalizeAgentConfidence,
  buildInlineComments,
} from './jsonl-parser.js';
export type { InlineComment } from './jsonl-parser.js';
export { loadConfig, mergeConfigWithInputs, resolveConfig, validateConfig } from './config.js';
export { resolveExcludeAgentConfigs } from './config.js';
export type { ResolveConfigOptions } from './config.js';
export type { LinterConfig, LinterResult, LinterFinding } from './types/index.js';
export { MCPManager } from './mcp/client.js';
export {
  context7Server,
  githubMCPServer,
  getDefaultMCPServers,
  MCP_PACKAGE_VERSIONS,
  toV1ServerEntry,
  toV1ServersMap,
  toV2ServerEntry,
  toV2ServersMap,
} from './mcp/servers.js';
export {
  buildReviewPrompt,
  buildFixPrompt,
  buildAuditPrompt,
  buildDocsPrompt,
  buildReplyPrompt,
  buildExplainPrompt,
  buildDescribePrompt,
  buildSynthesisPrompt,
  buildMultiAgentSynthesisPrompt,
  loadPromptFile,
  loadAuditCategoryPrompt,
  listAuditCategories,
} from './prompts/builder.js';
export {
  AGENT_PROMPT_BUILDERS,
  buildSecurityPrompt,
  buildPerformancePrompt,
  buildQualityPrompt,
  buildLogicPrompt,
} from './agents/index.js';
export type { AgentPromptContext } from './agents/index.js';
export { ReviewEngine, AGENT_ORDER } from './engine.js';
export {
  ORCHESTRATOR_BUDGET_MARKER,
  BUDGETED_CONTEXT_WARNING,
  SUBAGENT_REVIEW_CONTEXT_LIMIT,
  MAX_BATCH_CONCURRENCY,
  buildPartialBatchWarning,
  computeChunkDelays,
  expectedReviewOpenCodeCalls,
} from './engine.js';
export type { AgentBatchContextOptions, ReviewRunOptions } from './engine.js';
export { SetupEngine } from './setup/engine.js';
export { CodebaseIndex } from './codebase-index/index.js';
export { CodebaseIndexCache } from './codebase-index/cache.js';
export { CodebaseExtractor } from './codebase-index/extractor.js';
export type { CodebaseExtractorOptions } from './codebase-index/extractor.js';
export type {
  IndexedSymbol,
  IndexedSymbolKind,
  ImportEdge,
  ImportKind,
  CallGraphEdge,
  WorkspaceInfo,
  CodebaseIndexData,
  CodebaseContext,
} from './codebase-index/types.js';
export type {
  SetupCheck,
  SetupCheckStatus,
  SetupResult,
  SetupEngineOptions,
} from './setup/types.js';
export { EventBus } from './event-bus/bus.js';
export type { SubscriberHealth } from './event-bus/bus.js';
export { EventRouter } from './event-bus/router.js';
export { LoggingSubscriber } from './event-bus/logging-subscriber.js';
export { sanitizePayload } from './event-bus/logging-subscriber.js';
export { registerEventSubscribers } from './event-bus/register-event-subscribers.js';
export { LearningStore } from './learning/store.js';
export { connectDb } from './learning/db/index.js';
export type {
  LearningRepository,
  TelemetryStats,
  PerPRStats,
  FeedbackBreakdown,
  LatencyStats,
  ReviewMetricsRow,
  SeverityDistribution,
  ReviewMetricsReport,
  ConversationExchangeInput,
  ConversationSessionInput,
  ConversationSessionPatch,
  ConversationSessionRow,
  ConversationTurnInput,
  ConversationTurnRow,
} from './learning/types.js';
export { MetricsService } from './analytics/metrics.js';
export { getDbPath } from './learning/schema.js';
export { withRetry, withRetryAndTimeout, isNetworkError } from './utils/retry.js';
export type { RetryOptions, RetryAttemptInfo } from './utils/retry.js';
export { estimateTokens } from './utils/token-estimate.js';
export {
  ConversationStateManager,
  conversationThreadId,
  formatAutoCloseMessage,
} from './conversation/state.js';
export type { AutoCloseDecision } from './conversation/state.js';
export { DEFAULT_ALLOWLIST, validateRunChecksCommand } from './utils/command.js';
export { CircuitBreaker, countHttpError } from './utils/circuit-breaker.js';
export type {
  CircuitState,
  CircuitBreakerOptions,
  CircuitBreakerMetrics,
} from './utils/circuit-breaker.js';
export { getErrorStatus } from './utils/errors.js';
export { gatherReviewThread } from './utils/review-thread.js';
export type { ThreadComment, ReviewThreadResult } from './utils/review-thread.js';
export { sanitizeString } from './utils/sanitize.js';
export { escapeInlineCode, sanitizeMarkdown } from './utils/markdown.js';
export {
  ALLOWED_LINTER_COMMANDS,
  ALLOWED_MCP_LOCAL_COMMANDS,
  AUTOFIX_APPROVAL_COMMANDS,
  AUTOFIX_APPROVAL_LABELS,
  DEFAULT_EVENT_LOG_PATH,
  EVENT_SUBSCRIBERS_ENV,
  PINNED_MCP_NPM_PACKAGES,
  REPO_LINTERS_ENV,
  buildSafetyHoldComment,
  evaluateFixSafety,
  getLinterIsolationArgs,
  hasManualApprovalForFix,
  isAllowedLinterCommand,
  isAllowedMcpLocalCommand,
  isBlockedIpHost,
  isConfinedPath,
  isDestructiveFix,
  isEventSubscribersEnabled,
  isRepoLintersEnabled,
  isSafeLinterArgs,
  isSafeRemoteMcpUrl,
  matchDestructivePattern,
  resolveConfinedEventLogPath,
  resolveConfinedWorkingDir,
} from './utils/safe-exec.js';
export type { FixSafetyVerdict } from './utils/safe-exec.js';
export { sanitizePromptInput } from './utils/prompt-sanitizer.js';
export { detectSecrets, shannonEntropy, mergeSecretFindings } from './utils/secret-detect.js';
export type { SecretFinding, SecretDetectOptions } from './utils/secret-detect.js';
export { TestGapDetector } from './utils/test-gap-detector.js';
export {
  extractExports,
  extractExportsFromContent,
  findTestFile,
  buildTestFileCandidates,
  suggestTestPath,
  parsePatchTouchedNewLines,
  buildContextString,
  isTestFile,
} from './utils/test-gap-detector.js';
export type {
  SourceSymbol,
  TestGapEntry,
  TestGapResult,
  TestSuggestion,
  TestSuggestionType,
} from './utils/test-gap-detector.js';
export { runSCAScan, scaVulnerabilityToIssue } from './sca/index.js';
export {
  detectLockFileType,
  extractChangedDependencies,
  parsePatchLines,
} from './sca/lockfile.js';
export type { LockFileType, PatchLine, ExtractOptions } from './sca/lockfile.js';
export {
  queryOSV,
  buildBatchQueries,
  severityFromCvss,
  severityFromOsvLabel,
  extractCveIds,
  extractFixedVersion,
} from './sca/osv-client.js';
export type { SCAScanOptions } from './sca/types.js';
export { getLabelColor } from './utils/label-color.js';
export {
  buildInlinePrelude,
  buildTokenUsageSection,
  formatConfidenceLabel,
  formatIssueBullet,
  formatReachabilityLabel,
  getSeverityBadge,
  getSeverityPriority,
  buildBlastRadiusSection,
  buildBlastRadiusOptions,
  MAX_BLAST_RADIUS_DEPENDENTS,
  MAX_BLAST_RADIUS_CHARS,
} from './utils/review-body.js';
export type {
  ReviewBodyOptions,
  BlastRadiusSectionOptions,
  InlinePreludeInput,
} from './utils/review-body.js';
export { looksLikeCode } from './utils/code-heuristic.js';
export {
  FingerprintStore,
  buildFingerprintKey,
  collectFingerprintsFromBodies,
  extractFingerprintFromBody,
  filterIssuesByFingerprints,
  fingerprintFinding,
  fingerprintFindingFull,
  fingerprintForIssue,
  fingerprintForIssueFull,
  legacyInlineKey,
  mapFingerprintsToCommentIds,
  normalizeFingerprintPath,
  normalizeFingerprintText,
  shouldPostFingerprint,
  toFingerprintIdMap,
  withFingerprintMarker,
  INLINE_FINGERPRINT_MARKER_PREFIX,
  INLINE_FINGERPRINT_PATTERN,
} from './utils/inline-fingerprint.js';
export type { FingerprintableIssue, FingerprintedThread } from './utils/inline-fingerprint.js';
export {
  autoResolveAddressedThreads,
  buildCurrentFingerprintSet,
  findAddressedThreads,
  isFingerprintStillValid,
} from './utils/auto-resolve.js';
export type { AddressableThread } from './utils/auto-resolve.js';
export {
  buildFixPayload,
  buildFixWithAiPrompt,
  buildFixApprovalPrompt,
  collectFixText,
  fixPayloadNeedsApproval,
  formatFixPayloadMarkdown,
  isCodeLikeSuggestion,
} from './utils/fix-payload.js';
export type { FixPayload } from './utils/fix-payload.js';
export {
  buildFunctionScoreOptions,
  buildFunctionScoreTable,
  collectFunctionScoreInputs,
  computeFunctionScores,
  CHURN_WEIGHT,
  MAX_FUNCTION_SCORE_ROWS,
  NESTING_WEIGHT,
  TEST_GAP_PENALTY,
} from './utils/function-scores.js';
export type { FunctionScore, FunctionScoreInput } from './utils/function-scores.js';
export {
  estimateReviewMinutes,
  formatEffortMinutesLine,
  formatSelfReviewChecklist,
  MAX_REVIEW_MINUTES,
  REVIEW_MINUTES_LINES_PER_MINUTE,
} from './utils/review-minutes.js';
export type { ReviewMinutesChangedFile } from './utils/review-minutes.js';
export {
  analyzeFindingReachability,
  analyzeBatchReachability,
} from './utils/reachability.js';
export type { ReachabilityResult } from './utils/reachability.js';
export { Logger, sanitizeError, sanitizeErrorMessage } from './utils/logger.js';
export type {
  LogLevel,
  LogContext,
  LoggerSink,
  LogFormat,
  StructuredLogEntry,
} from './utils/logger.js';
export {
  buildPRContextFromStagedDiff,
  buildPRContextFromBranchDiff,
  isInsideGitWorkTree,
  parseGitDiff,
  parseGitDiffBlocks,
  parseGitNumstat,
  unquoteGitPath,
  runGitCommand,
} from './git-diff.js';
export type { LocalDiffOptions } from './git-diff.js';
export {
  computeSha256,
  findChecksumAsset,
  getKnownChecksum,
  parseChecksumFile,
  verifyChecksum,
  buildMissingChecksumError,
  markIntegrityError,
  INTEGRITY_ERROR_STATUS,
} from './utils/checksum.js';
export { FeedbackSubscriber } from './learning/feedback-subscriber.js';
export { SuppressionSubscriber } from './learning/suppression-subscriber.js';
export { TelemetrySubscriber } from './learning/telemetry-subscriber.js';
export { MetaReviewEngine, MetaReviewSubscriber } from './meta-review/engine.js';
export { buildMetaReviewPrompt } from './meta-review/prompts.js';
export { PatternDetector, PatternDetectorOptions } from './pattern-detector/engine.js';
export {
  clusterFindings,
  clusterFindingsExact,
  clusterFindingsWithStatus,
  MAX_CLUSTER_INPUT,
  EXACT_CLUSTER_LIMIT,
} from './pattern-detector/cluster.js';
export type { ClusterResult } from './pattern-detector/cluster.js';
export {
  hashToken,
  // Array variant preserves the legacy `number[]` return shape.
  computeMinHashSignatureArray as computeMinHashSignature,
  lshCandidates,
  MINHASH_SIGNATURE_SIZE,
  LSH_BANDS,
  LSH_ROWS,
} from './pattern-detector/minhash-optimized.js';
export { RuleApprovalSubscriber } from './pattern-detector/rule-approval.js';
export {
  attachShellEvidence,
  collectFindingEvidence,
  defaultRunValidatorCommand,
  resolveShellValidateOptions,
  SHELL_VALIDATE_MAX_BYTES,
  SHELL_VALIDATE_TIMEOUT_MS,
} from './utils/shell-validate.js';
export type { ShellRunDeps, ShellValidateOptions } from './utils/shell-validate.js';
export * from './utils/validation.js';
export {
  findLinkedPRByMarker,
  findLinkedPRNumberByMarker,
  extractPRNumberFromText,
} from './utils/linked-pr.js';
export type { LinkedPRComment, LinkedPRIssue } from './utils/linked-pr.js';
export {
  commitAndPushWithLease,
  isWorkingTreeClean,
  prepareBranchWorkspace,
  pushBranchWithLease,
  resolveExecDefaults,
  EXEC_DEFAULT_MAX_BUFFER,
  EXEC_DEFAULT_TIMEOUT_MS,
} from './utils/branch-workspace.js';
export type {
  CommitAndPushOptions,
  ExecGitFn,
  PrepareBranchWorkspaceOptions,
  BranchWorkspaceResult,
  PushBranchOptions,
} from './utils/branch-workspace.js';
export { resolveInstallPlan, ensureWorkspaceDeps } from './utils/workspace-deps.js';
export type {
  InstallPlan,
  ResolveInstallPlanOptions,
  ExecProcessFn,
  EnsureWorkspaceDepsOptions,
} from './utils/workspace-deps.js';
export { runVerificationCycle, MAX_VERIFICATION_RETRIES } from './utils/verify-cycle.js';
export type { VerificationCycleOptions, VerificationCycleResult } from './utils/verify-cycle.js';
export { createGuardedCommandSubscriber } from './utils/guarded-subscriber.js';
export type {
  PrivilegeHooks,
  RateLimitHooks,
  GuardedSubscriberOptions,
} from './utils/guarded-subscriber.js';
export { REPO_CONFIG_MERGE_FIELDS, hasRepoConfigOverrides } from './utils/repo-config-spec.js';
export type { RepoMergeField } from './utils/repo-config-spec.js';
export {
  REVIEW_EFFORT_PRESETS,
  parseReviewEffort,
  resolveReviewEffort,
} from './utils/review-effort.js';
export type { ReviewEffortPreset } from './utils/review-effort.js';
export { countAtOrAboveSeverity, shouldFailOnSeverity } from './utils/threshold.js';
export type { SeverityStats } from './utils/threshold.js';
export { MINIMUM_NODE_VERSION, checkNodeFloor } from './utils/version.js';
export type { NodeFloorCheck, ParsedVersion } from './utils/version.js';
export {
  sendNotification,
  formatSlackMessage,
  formatTeamsMessage,
  postToWebhook,
  getTopFindings,
  meetsSeverityThreshold,
  resolveWebhookUrl,
  defaultPrUrl,
  isHttpsUrl,
  redactWebhookUrl,
} from './utils/notifier.js';
export type {
  NotificationContext,
  SlackBlock,
  SendNotificationOptions,
  TeamsAttachment,
  TeamsCardBodyElement,
  TeamsCardContent,
  TeamsFactSet,
  TeamsMessage,
  TeamsTextBlock,
} from './utils/notifier.js';
export {
  buildConversationPrompt,
  buildConversationSummaryPrompt,
  detectIntent,
  normalizeConversationConfig,
  extractCodeReferences,
  resolveCodeReferences,
} from './prompts/conversation.js';
export { buildSelfHealPrompt, extractRelevantLogSnippet } from './prompts/heal.js';
export type { SelfHealPromptInputs } from './prompts/heal.js';
export { buildVerificationPrompt } from './prompts/verify.js';
export {
  IterationRecord,
  REVIEW_MARKER,
  FIX_MARKER,
  buildAutofixStatusBody,
  buildFixBody,
  buildReadyBody,
} from './utils/autofix-body.js';
export { resolveFixedComments } from './utils/autofix-body.js';
export {
  buildAutofixDeferredBody,
  parseAnalysisPlan,
  postBlockingQuestions,
  markAnalysisReady,
} from './utils/analyze-parser.js';
export type { AnalysisPlanResult } from './utils/analyze-parser.js';
export { buildAutofixPRBody } from './utils/pr-body.js';
export type { PRBodyOptions } from './utils/pr-body.js';
export { buildDocsPRBody } from './utils/pr-body.js';
export type { DocsPRBodyOptions } from './utils/pr-body.js';
export { buildChangelogPRBody } from './utils/pr-body.js';
export type { ChangelogPRBodyOptions } from './utils/pr-body.js';
export {
  DESCRIBE_BODY_START,
  DESCRIBE_BODY_END,
  mergeDescribeBody,
} from './utils/describe-markers.js';
export {
  categorizePRs,
  formatMarkdown,
  formatJson,
  monorepoFilter,
  generateChangelog,
} from './changelog/index.js';
export type {
  ChangelogBaseline,
  FormatMarkdownOptions,
} from './changelog/index.js';
export type {
  MergedPR,
  ChangelogEntry,
  GitTag,
  ChangelogConfig,
  ChangelogResult,
} from './changelog/index.js';
export { parseCommand, ASK_COMMAND_PATTERN } from './utils/command-match.js';
export type { ParsedCommand } from './utils/command-match.js';
export {
  deriveSuggestedTitle,
  deriveSuggestedLabels,
  buildSuggestionComment,
  postSuggestionComment,
  TITLE_SUGGESTION_MARKER,
} from './utils/title-suggestion.js';
export type { TitleSuggestion } from './utils/title-suggestion.js';
export {
  mapRiskLevelToLabel,
  estimateReviewLabelMinutes,
  mapMinutesToLabel,
  collectReviewLabels,
  applyReviewLabels,
  RISK_LABELS,
  REVIEW_TIME_LABELS,
} from './utils/review-labels.js';
export { RateLimiter } from './utils/rate-limiter.js';
export type {
  RateLimitStore,
  RateLimitResult,
  RateLimitCheckOptions,
  RateLimitStatus,
  RateLimitReason,
} from './utils/rate-limiter.js';
