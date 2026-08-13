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
  parseTokenUsage,
  parseTokenUsageDetailed,
  checkHealth,
  parseOpenCodeVersion,
  isVersionCompatible,
  setOpenCodeRunMode,
  setLLMProviderConfig,
  buildLocalOpenCodeConfig,
  buildLLMProviderMap,
  MINIMUM_OPENCODE_VERSION,
} from './opencode.js';
export type {
  TokenUsageBreakdown,
  OpenCodeHealth,
  OpenCodeVersion,
  CheckHealthOptions,
  OpenCodeRunMode,
} from './opencode.js';
export { GitHubHelper } from './utils/github.js';
export { GitLabAdapter } from './utils/gitlab-adapter.js';
export {
  getGitBlame,
  parseBlamePorcelain,
  parsePatchHunks,
  MAX_BLAME_LINES_PER_FILE,
} from './utils/blame.js';
export type { BlameRange, BlameAttribution, GetGitBlameOptions } from './utils/blame.js';
export type {
  PlatformAdapter,
  ReviewPostResult,
  ReviewThreadInfo,
  ReviewCommentDetail,
  ReviewCommentThread,
} from './platform/adapter.js';
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
export type { ResolveConfigOptions } from './config.js';
export type { LinterConfig, LinterResult, LinterFinding } from './types/index.js';
export { MCPManager } from './mcp/client.js';
export {
  context7Server,
  githubMCPServer,
  getDefaultMCPServers,
  MCP_PACKAGE_VERSIONS,
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
export { withRetry, withRetryAndTimeout } from './utils/retry.js';
export { estimateTokens } from './utils/token-estimate.js';
export {
  ConversationStateManager,
  conversationThreadId,
  formatAutoCloseMessage,
} from './conversation/state.js';
export type { AutoCloseDecision } from './conversation/state.js';
export { DEFAULT_ALLOWLIST, validateRunChecksCommand } from './utils/command.js';
export { CircuitBreaker } from './utils/circuit-breaker.js';
export type { CircuitState, CircuitBreakerOptions } from './utils/circuit-breaker.js';
export { gatherReviewThread } from './utils/review-thread.js';
export type { ThreadComment, ReviewThreadResult } from './utils/review-thread.js';
export { sanitizeString } from './utils/sanitize.js';
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
  buildTokenUsageSection,
  formatConfidenceLabel,
  formatIssueBullet,
  getSeverityBadge,
} from './utils/review-body.js';
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
  computeMinHashSignature,
  lshCandidates,
  MINHASH_SIGNATURE_SIZE,
  LSH_BANDS,
  LSH_ROWS,
} from './pattern-detector/minhash.js';
export { RuleApprovalSubscriber } from './pattern-detector/rule-approval.js';
export * from './utils/validation.js';
export { countAtOrAboveSeverity, shouldFailOnSeverity } from './utils/threshold.js';
export type { SeverityStats } from './utils/threshold.js';
export {
  sendNotification,
  formatSlackMessage,
  formatTeamsMessage,
  postToWebhook,
  getTopFindings,
  meetsSeverityThreshold,
  resolveWebhookUrl,
  defaultPrUrl,
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
export { RateLimiter } from './utils/rate-limiter.js';
export type {
  RateLimitStore,
  RateLimitResult,
  RateLimitCheckOptions,
  RateLimitStatus,
  RateLimitReason,
} from './utils/rate-limiter.js';
