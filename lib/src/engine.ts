import { promises as fs, existsSync, mkdirSync, readFileSync } from 'fs';
import type { Dirent } from 'fs';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import * as os from 'os';
import * as path from 'path';
import { minimatch } from 'minimatch';
import {
  AGENT_PROMPT_BUILDERS,
  buildLogicPrompt,
  buildPerformancePrompt,
  buildQualityPrompt,
  buildSecurityPrompt,
} from './agents/index.js';
import type { AgentPromptContext } from './agents/index.js';
import { CodebaseIndex, CodebaseIndexCache } from './codebase-index/index.js';
import type { CodebaseIndexData } from './codebase-index/types.js';
import { conversationThreadId } from './conversation/state.js';
import type { ConversationStateManager } from './conversation/state.js';
import type { EventBus } from './event-bus/bus.js';
import { emptyResult, parseAgentJsonlString, parseJsonlFile } from './jsonl-parser.js';
import type { LearningStore } from './learning/store.js';
import { MCPManager } from './mcp/client.js';
import { ensureOutputDir, getGitStatus, runOpenCode } from './opencode.js';
import type { PlatformAdapter } from './platform/adapter.js';
import {
  buildAnalyzePrompt,
  buildAuditPrompt,
  buildDocsPrompt,
  buildExplainPrompt,
  buildFixPrompt,
  buildMultiAgentSynthesisPrompt,
  buildReviewPrompt,
  buildSynthesisPrompt,
} from './prompts/builder.js';
import {
  buildConversationPrompt,
  buildConversationSummaryPrompt,
  normalizeConversationConfig,
} from './prompts/conversation.js';
import { buildSelfHealPrompt } from './prompts/heal.js';
import { detectLanguages } from './prompts/language/index.js';
import { buildVerificationPrompt } from './prompts/verify.js';
import { runSCAScan } from './sca/index.js';
import type {
  AgentCategory,
  AgentConfig,
  AgentFinding,
  AgentResult,
  BlameInfo,
  ConversationConfig,
  ConversationContext,
  ConversationState,
  DocStyle,
  FixResult,
  LinterConfig,
  LinterFinding,
  LinterResult,
  MultiAgentAgentConfig,
  PRContext,
  PipelineEventPayload,
  PipelineEventPayloadMap,
  PipelineEventType,
  PreviousFindingIteration,
  ReviewBudgetMode,
  ReviewIssue,
  ReviewResult,
  ReviewStrength,
  SelfHealResult,
  TokenBudgetConfig,
  TokenBudgetMetrics,
  TokenUsage,
} from './types/index.js';
import { PIPELINE_EVENT_TYPES } from './types/index.js';
import { DEFAULT_SCA_CONFIG, DEFAULT_SECRET_DETECTOR_CONFIG } from './types/index.js';
import { filterBlameToPatch, getGitBlame, parsePatchHunks } from './utils/blame.js';
import { MAX_BLAME_LINES_PER_FILE, UNCOMMITTED_SHA } from './utils/blame.js';
import type { BlameRange } from './utils/blame.js';
import { computeReviewStats, filterFindings, severityRank } from './utils/filter-findings.js';
import { Logger } from './utils/logger.js';
import {
  detectDotnetLibraries,
  detectJavaLibraries,
  detectPythonLibraries,
  detectRubyLibraries,
} from './utils/manifest-detector.js';
import { validateModelString } from './utils/model-string.js';
import { analyzeBatchReachability } from './utils/reachability.js';
import { withRetry } from './utils/retry.js';
import { sanitizeString } from './utils/sanitize.js';
import { detectSecrets, mergeSecretFindings } from './utils/secret-detect.js';
import type { SecretDetectOptions, SecretFinding } from './utils/secret-detect.js';
import { TestGapDetector } from './utils/test-gap-detector.js';

/** Maximum number of batch chunks processed concurrently by `reviewPR`. */
export const MAX_BATCH_CONCURRENCY = 8;

/** Fixed inter-chunk backoff delay in milliseconds between concurrent chunks. */
export const INTER_CHUNK_DELAY_MS = 150;

/**
 * Maximum number of bytes read per file during the deterministic secret scan.
 * The scan is a best-effort post-pass that must never delay a review, so large
 * (or binary) files are truncated before the regex/entropy pass.
 */
const MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Overall wall-clock deadline for the deterministic SCA scan. The scan is
 * best-effort and runs on the review critical path, so a slow or unreachable
 * api.osv.dev must never block a review for minutes: the scan is aborted at
 * this deadline and degrades to no findings.
 */
const SCA_SCAN_DEADLINE_MS = 30_000;

/** Canonical dispatch order of the specialized review agents. */
export const AGENT_ORDER = ['security', 'performance', 'quality', 'logic'] as const;

/**
 * Fallback USD cost rates per 1K tokens for a few well-known models.
 * Used ONLY for cost estimation when the user has not supplied explicit
 * `inputCostPer1K` / `outputCostPer1K` config rates and the model name
 * matches one of these keys. The default `opencode/deepseek-v4-flash-free`
 * model is not listed because it is free — `estimatedCost` stays undefined.
 */
const KNOWN_MODEL_RATES: Record<string, { inputCostPer1K: number; outputCostPer1K: number }> = {
  'gpt-4o-mini': { inputCostPer1K: 0.00015, outputCostPer1K: 0.0006 },
  'gpt-4o': { inputCostPer1K: 0.0025, outputCostPer1K: 0.01 },
  'claude-3-5-sonnet': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
  'claude-3-5-haiku': { inputCostPer1K: 0.0008, outputCostPer1K: 0.004 },
  'gemini-1.5-pro': { inputCostPer1K: 0.00125, outputCostPer1K: 0.005 },
  'gemini-1.5-flash': { inputCostPer1K: 0.00035, outputCostPer1K: 0.00105 },
};

/**
 * Compute the number of fixed inter-chunk backoff delays that `reviewPR`
 * inserts between concurrently processed batch chunks.
 * @param batchCount - Number of file batches to process.
 * @param concurrencyLimit - Maximum number of batches processed concurrently.
 * @returns The number of `INTER_CHUNK_DELAY_MS` waits applied.
 */
export function computeChunkDelays(batchCount: number, concurrencyLimit: number): number {
  return Math.max(0, Math.ceil(batchCount / concurrencyLimit) - 1);
}

/**
 * Compute the expected number of `runOpenCode` invocations for a review.
 * Single-batch reviews run one pass; multi-batch reviews run one pass per
 * batch plus a final synthesis pass.
 * @param batchCount - Number of file batches to process.
 * @returns The expected number of OpenCode invocations.
 */
export function expectedReviewOpenCodeCalls(batchCount: number): number {
  return batchCount <= 1 ? 1 : batchCount + 1;
}

/**
 * Orchestrates PR review, auto-fix, and audit workflows.
 * Wraps MCP context enrichment, learning-store queries, and OpenCode CLI invocation.
 */
export class ReviewEngine {
  private mcp: MCPManager;
  private adapter: PlatformAdapter;
  private config: AgentConfig;
  private logger: Logger;
  private lessonsCache: { lessons: string[]; filePaths: string; timestamp: number } | null = null;
  private mcpDocsCache: { docs: string; libraries: string; timestamp: number } | null = null;
  private telemetry: TokenUsage | null = null;
  private static readonly LESSONS_CACHE_TTL = 60_000;
  private static readonly MCP_DOCS_CACHE_TTL = 60_000;

  /**
   * @param config - Agent configuration (models, batch size, MCP servers, etc.).
   * @param adapter - Platform adapter for MR/issue operations (GitHubHelper or GitLabAdapter).
   * @param learningStore - Optional learning store for recording/querying past findings.
   * @param eventBus - Optional event bus for publishing pipeline lifecycle events.
   * @param repo - Optional repository in "owner/repo" format, included on published
   * pipeline events for attribution in audit logs and downstream consumers.
   * @param correlationId - Optional correlation ID tracing this run across subsystems.
   */
  constructor(
    config: AgentConfig,
    adapter: PlatformAdapter,
    private learningStore?: LearningStore,
    private eventBus?: EventBus,
    private repo?: string,
    private correlationId?: string,
  ) {
    this.config = config;
    this.adapter = adapter;
    this.mcp = new MCPManager(config.mcpServers);
    this.logger = new Logger('ReviewEngine', { correlationId });
    // Resolve the effective correlation ID exactly once and reuse it for both
    // the engine's own log lines and pipeline event publishing. Without this,
    // a non-App invocation (e.g. the GitHub Action) leaves `this.correlationId`
    // undefined while the logger falls back to its own generated UUID, so
    // published events would not share the engine logs' trace ID.
    this.correlationId = this.logger.getCorrelationId();
  }

  /**
   * Run OpenCode with this engine's custom LLM provider configuration.
   *
   * Passing `llm` explicitly per run avoids the module-level LLM config global
   * in opencode.ts, which a long-lived multi-repo process would otherwise race:
   * the last-constructed engine's provider map would leak into in-flight runs of
   * other engines. The engine always supplies its own config (even when empty)
   * so concurrent runs are isolated from each other.
   * @param prompt - The prompt text to pass to OpenCode.
   * @param options - Execution options forwarded to {@link runOpenCode}.
   * @returns The {@link runOpenCode} result promise.
   */
  private runLLM(
    prompt: string,
    options: Omit<Parameters<typeof runOpenCode>[1], 'llm'>,
  ): ReturnType<typeof runOpenCode> {
    return runOpenCode(prompt, { ...options, llm: this.config.llm ?? {} });
  }

  /**
   * Get the accumulated token usage / cost telemetry for the most recent
   * pipeline run (review, fix, audit, analyze, etc.). Returns null when no
   * model call has been recorded yet on this engine instance.
   * @returns The accumulated telemetry, or null.
   */
  getLastTelemetry(): TokenUsage | null {
    return this.telemetry;
  }

  /**
   * Publish a pipeline lifecycle event on the event bus when one is attached.
   * Non-critical observability: publishing is fire-and-forget so subscriber
   * latency (pluggable third-party subscribers, slow filesystem writes) can
   * never block the review/fix/audit/analyze pipeline.
   * @param type - The pipeline event type to emit.
   * @param payload - The event payload (timestamp is added automatically).
   */
  private publishEvent<T extends PipelineEventType>(
    type: T,
    payload: Omit<PipelineEventPayloadMap[T], 'timestamp'>,
  ): void {
    if (!this.eventBus) return;
    const eventPayload = {
      ...payload,
      timestamp: Date.now(),
    } as PipelineEventPayloadMap[T];
    // GitHub issues and PRs share the same numbering space, so analyze/explain
    // events carrying an issueNumber are correlated to a PR/issue via prNumber.
    const numbered = eventPayload as PipelineEventPayload & { issueNumber?: number };
    const prNumber = numbered.prNumber ?? numbered.issueNumber;
    void this.eventBus
      .publish({
        type,
        category: 'pipeline',
        payload: eventPayload,
        timestamp: eventPayload.timestamp,
        prNumber,
        repo: this.repo ?? numbered.repo,
        correlationId: this.correlationId,
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to publish ${type} event: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Publish a pipeline "completed" event, attaching the engine's accumulated
   * duration/token telemetry so every completion event is self-describing.
   * @param type - The completed pipeline event type to emit.
   * @param payload - The event payload (without duration/token telemetry).
   */
  private publishCompleted<T extends PipelineEventType>(
    type: T,
    payload: Omit<PipelineEventPayloadMap[T], 'timestamp'>,
  ): void {
    const telemetry = this.getLastTelemetry();
    this.publishEvent(type, {
      ...payload,
      durationMs: telemetry?.durationMs ?? payload.durationMs,
      tokensUsed: telemetry?.totalTokens ?? payload.tokensUsed,
    });
  }

  /**
   * Determine the review budget mode from the total diff size.
   * Modes are selected using the configurable summary/split thresholds.
   *
   * @param totalDiffLines - Total number of diff lines across all changed files.
   * @returns The selected budget review mode ('full' | 'summary' | 'split').
   */
  private determineBudgetMode(totalDiffLines: number): ReviewBudgetMode {
    const budget = this.config.review.reviewBudget;
    if (!budget?.enabled) return 'full';
    if (totalDiffLines >= budget.splitThreshold) return 'split';
    if (totalDiffLines >= budget.summaryThreshold) return 'summary';
    return 'full';
  }

  /**
   * Prepend a split-recommendation banner to a review result summary when the
   * PR exceeds the split threshold. Other budget modes leave the result untouched.
   *
   * @param result - The review result to decorate.
   * @param budgetMode - The selected budget review mode.
   * @param totalDiffLines - Optional total number of diff lines across all changed files.
   * @returns The decorated review result.
   */
  private applyBudgetModeBanner(
    result: ReviewResult,
    budgetMode: ReviewBudgetMode,
    totalDiffLines?: number,
  ): ReviewResult {
    if (budgetMode !== 'split') return result;
    const lineCount =
      totalDiffLines !== undefined ? `~${totalDiffLines} lines` : 'a very large number of lines';
    const splitThreshold = this.config.review.reviewBudget?.splitThreshold ?? 1000;
    const banner = `## ⚠️ Large PR Detected (${lineCount})\n\nThis pull request is very large. Consider splitting it into smaller, focused PRs for faster, more thorough reviews. Ideally each PR should contain fewer than ${splitThreshold} lines of changes.\n\n---\n\n`;
    return {
      ...result,
      summary: banner + (result.summary || ''),
    };
  }

  /**
   * Run a `git` command asynchronously. Used for the short, once-per-review
   * probes in the codebase-index path so the review's event loop is not blocked
   * (important for the long-running Probot App). Rejects when `execFile` is
   * unavailable or the command fails — callers fall back gracefully.
   * @param args - Git arguments (excluding the leading `git`).
   * @param cwd - Directory the command runs in.
   * @returns The trimmed stdout.
   */
  private async execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (typeof cp.execFile !== 'function') {
        reject(new Error('execFile is not available'));
        return;
      }
      cp.execFile('git', args, { cwd, encoding: 'utf-8' }, (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Resolve the repository root to index. Uses the git top-level so index
   * paths are repo-root-relative and match `ChangedFile.path`, even when the
   * working directory is a package subdirectory of a monorepo. Falls back to
   * `workDir` when the directory is not a git checkout.
   * @param workDir - The directory the review runs in.
   * @returns The absolute repository root to build the codebase index from.
   */
  private async resolveCodebaseRoot(workDir: string): Promise<string> {
    try {
      const root = await this.execGit(['rev-parse', '--show-toplevel'], workDir);
      if (root) return root;
    } catch {
      // Not a git checkout — index relative to the working directory.
    }
    return workDir;
  }

  /**
   * Derive the codebase-index cache key. Keying solely on `headSha` would serve
   * a stale index during the autofix loop, where the working tree changes
   * between re-reviews of the same ref. A working-tree fingerprint (hash of
   * `git status --porcelain`) makes the cache invalidate whenever the tree
   * changes; a clean checkout keeps the stable `headSha` key.
   * @param headSha - The PR head SHA.
   * @param repoRoot - The repository root the index is built from.
   * @returns The cache key to store/load the index under.
   */
  private async codebaseIndexCacheKey(headSha: string, repoRoot: string): Promise<string> {
    try {
      const porcelain = await this.execGit(['status', '--porcelain'], repoRoot);
      if (porcelain === '') return headSha;
      const digest = createHash('sha256').update(porcelain).digest('hex').slice(0, 16);
      return `${headSha}-${digest}`;
    } catch {
      return headSha;
    }
  }

  /**
   * Resolve the codebase-index cache directory. The cache is stored OUTSIDE the
   * git checkout (under the OS temp dir, namespaced by the repository root) so
   * attacker-controlled PR content committed to the tree can never be loaded as
   * a trusted index, and so CI runs on a fresh checkout do not write (and
   * potentially commit) multi-MB JSON inside the workspace.
   * @param repoRoot - The repository root the index is built from.
   * @returns The absolute cache directory for this repository.
   */
  private codebaseIndexCacheDir(repoRoot: string): string {
    const digest = createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), 'opencode-codebase-index', digest);
  }

  /**
   * Resolve the set of commit SHAs that belong to the current PR. Used to mark
   * blamed lines as `[PR CHANGE]` by commit membership rather than diff position.
   * Prefers the PR's base SHA (`baseSha`) when the platform exposes it; falls
   * back to computing the merge-base against the base ref. Returns undefined
   * when the PR scope cannot be determined so callers can skip blame entirely.
   * @param pr - The PR context being reviewed.
   * @param workDir - Working directory the git commands run in.
   * @returns The set of PR commit SHAs, or undefined when unresolvable.
   */
  private async getPRCommits(pr: PRContext, workDir: string): Promise<Set<string> | undefined> {
    const head = pr.headSha;
    if (!head) return undefined;
    try {
      const base = pr.baseSha;
      let range = '';
      if (base) {
        range = `${base}..${head}`;
      } else if (pr.baseRef) {
        const mergeBase = await this.execGit(['merge-base', head, pr.baseRef], workDir);
        if (mergeBase) {
          range = `${mergeBase}..${head}`;
        }
      }
      if (!range) {
        // No base available — treat the head commit itself as the PR scope.
        return new Set([head]);
      }
      const revList = await this.execGit(['rev-list', range], workDir);
      const commits = new Set<string>();
      for (const line of revList.split('\n')) {
        const sha = line.trim();
        if (sha) commits.add(sha);
      }
      return commits.size > 0 ? commits : undefined;
    } catch (err) {
      this.logger.warn(
        `Could not resolve PR commit set: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Fetch git blame annotations for the changed files, bounded to the diff hunk
   * ranges shown in the review context. Best-effort: a failure or unresolved PR
   * scope for any single file degrades to no blame for that file, never a failed
   * review.
   * @param pr - The PR context being reviewed.
   * @param files - Changed files (already filtered by exclude patterns).
   * @param workDir - Working directory the git commands run in.
   * @returns Map of file path → line number → blame info.
   */
  private async buildBlameData(
    pr: PRContext,
    files: Array<{ path?: string; patch?: string }>,
    workDir: string,
  ): Promise<Map<string, Map<number, BlameInfo>>> {
    const blameData = new Map<string, Map<number, BlameInfo>>();
    // Blame paths are repo-root-relative (from the platform API), so run git
    // from the repository root — not the (possibly monorepo-subdirectory)
    // working directory — mirroring the codebase-index path.
    const repoRoot = await this.resolveCodebaseRoot(workDir);
    const prCommits = await this.getPRCommits(pr, repoRoot);
    if (!prCommits) {
      this.logger.warn('Skipping git blame enrichment: PR commit scope could not be resolved');
      return blameData;
    }
    const maxLinesPerFile =
      this.config.review.reviewBudget?.splitThreshold ?? MAX_BLAME_LINES_PER_FILE;
    for (const file of files) {
      if (!file?.path || !file.patch) continue;
      const ranges = parsePatchHunks(file.patch);
      if (ranges.length === 0) continue;
      try {
        const blame = await getGitBlame(file.path, ranges, {
          cwd: repoRoot,
          prCommits,
          headSha: pr.headSha,
          maxLinesPerFile,
        });
        if (blame.size > 0) blameData.set(file.path, blame);
      } catch (err) {
        this.logger.warn(
          `Git blame skipped for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return blameData;
  }

  /**
   * Format a per-file blame map into a compact markdown block that collapses
   * contiguous lines sharing the same commit/scope into a single range line.
   * @param blame - Line number → blame info for one file.
   * @returns The formatted `### Git Blame Annotations` body, or '' when empty.
   */
  private formatBlameAnnotations(blame: Map<number, BlameInfo>): string {
    if (blame.size === 0) return '';
    const sorted = [...blame.entries()].sort((a, b) => a[0] - b[0]);
    const lines: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      const [startLine, info] = sorted[i];
      let endLine = startLine;
      let j = i + 1;
      while (
        j < sorted.length &&
        sorted[j][0] === endLine + 1 &&
        sorted[j][1].commitSha === info.commitSha &&
        sorted[j][1].isInPRDiff === info.isInPRDiff
      ) {
        endLine = sorted[j][0];
        j++;
      }
      const scope = info.isInPRDiff ? '[PR CHANGE]' : 'pre-existing';
      // Uncommitted lines have no commit yet — render them as working-tree
      // changes rather than a confusing all-zero SHA.
      const shortSha =
        info.commitSha === UNCOMMITTED_SHA ? 'working tree' : info.commitSha.slice(0, 7);
      const authorPart = info.author ? `@${escapeMarkdown(info.author)}` : 'unknown author';
      const rangeStr =
        startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
      lines.push(
        `- ${rangeStr} — ${scope} ${authorPart}, ${info.date || 'unknown date'}, ${shortSha}`,
      );
      i = j;
    }
    return lines.join('\n');
  }

  /**
   * Build the injected cross-file codebase context for a set of changed files.
   * Filters out empty/missing paths and catches formatting failures so a
   * corrupt index can never fail the whole review — it degrades to a diff-only
   * review instead.
   * @param index - The codebase index engine (undefined when disabled/failed).
   * @param data - The loaded index data (undefined when disabled/failed).
   * @param files - Changed files to derive context for.
   * @returns The formatted cross-file markdown context, or '' when unavailable.
   */
  private formatCodebaseContext(
    index: CodebaseIndex | undefined,
    data: CodebaseIndexData | undefined,
    files: Array<{ path?: string }>,
  ): string {
    if (!index || !data) return '';
    const paths = files
      .map((f) => f?.path)
      .filter((p): p is string => typeof p === 'string' && Boolean(p));
    if (paths.length === 0) return '';
    try {
      return index.formatContext(index.getContextForFiles(data, paths));
    } catch (err) {
      this.logger.warn(
        `Codebase index context skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }

  /**
   * Resolve the model for a specific pipeline stage, falling back to reviewModel.
   * @param stageField - Optional per-stage model field name from AgentConfig.
   * @returns The resolved model string.
   */
  private resolveModel(
    stageField: keyof Pick<
      AgentConfig,
      | 'auditModel'
      | 'docsModel'
      | 'synthesisModel'
      | 'verificationModel'
      | 'metaReviewModel'
      | 'explanationModel'
      | 'conversationModel'
      | 'analysisModel'
    >,
  ): string {
    return this.config[stageField] ?? this.config.reviewModel;
  }

  /**
   * Review a pull request by splitting changed files into batches and running
   * concurrent sub-agent reviews with a final synthesis pass.
   *
   * @param pr - Pull request context with changed files.
   * @param _iteration - Optional fix iteration index (0-indexed).
   * @param promptFile - Optional custom review prompt file path.
   * @param promptExtra - Optional extra instructions appended to the review prompt.
   * @param timeoutMinutes - Optional timeout override per run.
   * @param previousFindings - Optional findings from previous fix iterations.
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
   * @param previousHeadSha - Optional previous head SHA for delta diff.
   * @param previousBotComments - Optional previous bot review comments for context awareness.
   * @returns Consolidated ReviewResult with deduplicated findings.
   */
  async reviewPR(
    pr: PRContext,
    _iteration?: number,
    promptFile?: string,
    promptExtra?: string,
    timeoutMinutes?: number,
    previousFindings?: PreviousFindingIteration[],
    workingDirectory?: string,
    previousHeadSha?: string,
    previousBotComments?: Array<{
      file: string;
      line: number | null;
      body: string;
      commentId: number;
    }>,
  ): Promise<ReviewResult> {
    // Reset telemetry so the reported usage reflects only this review invocation.
    this.telemetry = null;
    this.publishEvent(PIPELINE_EVENT_TYPES.REVIEW_STARTED, {
      prNumber: pr.number,
      modelUsed: this.config.reviewModel,
    });
    const result = await this.runReviewPipeline(
      pr,
      _iteration,
      promptFile,
      promptExtra,
      timeoutMinutes,
      previousFindings,
      workingDirectory,
      previousHeadSha,
      previousBotComments,
    );
    const finalResult = this.attachUsage(result);
    // Fire-and-forget completion publish: heavy subscribers (e.g. meta-review)
    // must not delay the handler's review post or observe unpersisted findings.
    this.publishCompleted(PIPELINE_EVENT_TYPES.REVIEW_COMPLETED, {
      prNumber: pr.number,
      reviewSummary: finalResult.summary,
      findingsCount: finalResult.issues.length + finalResult.strengths.length,
      issuesCount: finalResult.issues.length,
      strengthsCount: finalResult.strengths.length,
      hasVerdict: Boolean(finalResult.verdict?.reasoning),
      fileCount: new Set(finalResult.issues.map((i) => i.file).filter(Boolean)).size,
      modelUsed: this.config.reviewModel,
    });
    return finalResult;
  }

  private async runReviewPipeline(
    pr: PRContext,
    _iteration?: number,
    promptFile?: string,
    promptExtra?: string,
    timeoutMinutes?: number,
    previousFindings?: PreviousFindingIteration[],
    workingDirectory?: string,
    previousHeadSha?: string,
    previousBotComments?: Array<{
      file: string;
      line: number | null;
      body: string;
      commentId: number;
    }>,
  ): Promise<ReviewResult> {
    let mcpDocs = '';
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const libraries = detectLibraries(
          pr.changedFiles
            .map((f) => f?.path)
            .filter((p): p is string => typeof p === 'string' && Boolean(p)),
          workingDirectory,
        );
        if (libraries.length > 0) {
          mcpDocs = await this.getCachedMcpDocs(libraries);
        }
      } catch (err) {
        this.logger.warn(
          sanitizeString(
            `MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    const workDir = workingDirectory || process.cwd();
    const batchSize = this.config.batchSize || 3;

    // Fetch delta context if previousHeadSha is provided
    let deltaContext: string | undefined;
    if (previousHeadSha && previousHeadSha !== pr.headSha) {
      try {
        deltaContext = await this.adapter.getDiffSince(previousHeadSha, pr.headSha || pr.headRef);
      } catch (err) {
        this.logger.warn(
          `Failed to fetch delta diff since ${previousHeadSha}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Filter out excluded files (lockfiles, generated code, dist/, etc.)
    const excludePatterns = this.config.review.excludePatterns || [];
    const files =
      excludePatterns.length > 0
        ? pr.changedFiles.filter((f) => {
            if (!f?.path) return false;
            return !excludePatterns.some((pattern: string) => minimatch(f.path, pattern));
          })
        : pr.changedFiles;

    // Deterministic Software Composition Analysis (SCA) pass. Runs before the
    // "all files excluded" early-return so a PR that only touches lock files
    // still yields dependency findings. Reads the UNFILTERED changed-file list
    // because lock files are excluded from LLM review by default — dependency
    // changes would otherwise never surface. Best-effort: any failure (advisory
    // API unreachable, parse errors) degrades gracefully to no findings.
    let scaIssues: ReviewIssue[] = [];
    const scaConfig = this.config.sca ?? DEFAULT_SCA_CONFIG;
    if (scaConfig.enabled) {
      try {
        scaIssues = await runSCAScan(
          pr.changedFiles,
          workDir,
          {
            enabled: scaConfig.enabled,
            minSeverity: scaConfig.minSeverity,
            lockFilePatterns: scaConfig.lockFilePatterns,
            excludePatterns: scaConfig.excludePatterns,
            deadlineMs: SCA_SCAN_DEADLINE_MS,
          },
          this.logger,
        );
        if (scaIssues.length > 0) {
          this.logger.info(
            `SCA flagged ${scaIssues.length} known vulnerable dependency(ies) in the changed lock files`,
          );
        }
      } catch (err) {
        this.logger.warn(`SCA scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (files.length === 0 && pr.changedFiles.length > 0) {
      this.logger.info(
        `All ${pr.changedFiles.length} changed file(s) matched exclude patterns — skipping review`,
      );
      // Even when every source file is excluded, deterministic SCA findings on
      // the excluded lock files still surface (a lock-file-only PR is the
      // primary SCA use case).
      if (scaIssues.length > 0) {
        return this.mergeScaIssues(emptyResult(), scaIssues);
      }
      return emptyResult();
    }
    if (files.length < pr.changedFiles.length) {
      this.logger.info(
        `Excluded ${pr.changedFiles.length - files.length} file(s) from review by exclude patterns`,
      );
    }

    // Build a ref-keyed codebase index and extract cross-file context for the
    // changed files. Non-critical: indexing failures degrade gracefully to a
    // review without cross-file context. This runs only after the exclude /
    // skip early-returns so fully-excluded reviews never pay the indexing cost.
    // The index is rooted at the git repo top-level so index-relative file
    // paths match the repo-root-relative `ChangedFile.path` values even when
    // `workDir` is a package subdirectory of a monorepo.
    let codebaseIndex: CodebaseIndex | undefined;
    let codebaseIndexData: CodebaseIndexData | undefined;
    if (this.config.review.enableCodebaseIndex) {
      try {
        const indexRoot = await this.resolveCodebaseRoot(workDir);
        const indexEngine = new CodebaseIndex(
          new CodebaseIndexCache(this.codebaseIndexCacheDir(indexRoot)),
        );
        const cacheKey = await this.codebaseIndexCacheKey(pr.headSha, indexRoot);
        const startedAt = Date.now();
        codebaseIndexData = await indexEngine.buildOrLoad(indexRoot, cacheKey);
        const buildMs = Date.now() - startedAt;
        codebaseIndex = indexEngine;
        this.logger.info(
          `Codebase index ready: ${codebaseIndexData.symbols.length} symbols, ` +
            `${codebaseIndexData.imports.length} imports, ${codebaseIndexData.callGraph.length} call edges ` +
            `(built in ${buildMs}ms)`,
        );
        if (buildMs > 5000) {
          this.logger.warn(
            `Codebase index build took ${buildMs}ms (>5s) — consider excluding non-source directories`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Codebase index build skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Calculate total diff size for budget mode selection. Diff lines are derived
    // from the always-accurate additions/deletions counters (the patch field can
    // be null for binary files and truncated/omitted for very large files).
    // Incremental (delta) reviews re-check only new commits, so budget-mode
    // adaptation is skipped for them to avoid forcing summary/split on a small delta.
    const isIncremental = Boolean(previousHeadSha && previousHeadSha !== pr.headSha);
    let budgetMode: ReviewBudgetMode = 'full';
    let totalDiffLines: number | undefined;
    if (!isIncremental) {
      totalDiffLines = files.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
      budgetMode = this.determineBudgetMode(totalDiffLines);
      this.logger.info(`Review budget mode: ${budgetMode} (total diff: ~${totalDiffLines} lines)`);
    } else {
      this.logger.info('Skipping review budget adaptation for incremental (delta) review');
    }

    const tokenBudgetConfig = this.config.review.tokenBudget;

    // Fetch git blame annotations for the changed files so the model can tell
    // newly introduced lines from pre-existing code. Skipped entirely in
    // full-audit mode (`includePreExisting`) and degrades gracefully (fail open)
    // when git history is unavailable (e.g. shallow CI checkouts).
    const includePreExisting = this.config.review.includePreExisting ?? false;
    let blameData: Map<string, Map<number, BlameInfo>> | undefined;
    if (!includePreExisting) {
      try {
        blameData = await this.buildBlameData(pr, files, workDir);
        if (blameData.size > 0) {
          this.logger.info(`Git blame annotations fetched for ${blameData.size} file(s)`);
        }
      } catch (err) {
        this.logger.warn(
          `Git blame enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const { context: prContext, budgetMetrics } = this.buildPRContextString(
      pr,
      tokenBudgetConfig,
      false,
      blameData,
    );
    let openThreadsContext = '';
    try {
      openThreadsContext = await this.adapter.getOpenHumanThreads(pr.number);
    } catch (err) {
      this.logger.warn(
        `Failed to fetch open human threads: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let baseContext = mcpDocs ? prContext + '\n\n## Library Documentation\n' + mcpDocs : prContext;

    if (openThreadsContext) {
      baseContext += '\n\n' + openThreadsContext;
    }

    // Get relevant lessons and false-positive suppression rules from learning store (with caching)
    let lessons: string[] | undefined;
    let falsePositiveRules: string[] | undefined;
    if (this.learningStore) {
      const filePaths = pr.changedFiles
        .map((f) => f?.path)
        .filter((p): p is string => typeof p === 'string' && Boolean(p));
      try {
        lessons = await this.getRelevantLessons(filePaths);
      } catch (err) {
        this.logger.warn(
          `Failed to get learning store lessons: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        falsePositiveRules = await this.learningStore.getFalsePositiveRules(filePaths);
      } catch (err) {
        this.logger.warn(
          `Failed to get false-positive rules: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Run configured linters as pre-processing step
    const linterResults = await this.runLinters(files, workDir);

    // Test-gap detection: correlate changed source symbols with their test files
    // and surface structured gaps as prompt context. Non-critical: any failure
    // degrades gracefully to a review without test-gap context. Only runs when
    // the feature is enabled, after the exclude / skip early-returns.
    let testGapContext: string | undefined;
    if (this.config.review.enableTestGapDetection) {
      try {
        const detector = new TestGapDetector();
        const result = detector.analyze(pr.changedFiles, workDir);
        if (result.contextString) {
          this.logger.info(
            `Test-gap analysis flagged ${result.modifiedUnchangedTests.length} modified-unchanged, ` +
              `${result.newUntestedExports.length} new-untested, ` +
              `${result.missingErrorCaseTests.length} missing-error-case gap(s)`,
          );
          testGapContext = result.contextString;
        } else {
          this.logger.info('Test-gap analysis found no gaps');
        }
      } catch (err) {
        this.logger.warn(
          `Test gap detection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Multi-agent review path (opt-in): dispatch specialized agents (security,
    // performance, quality, logic) each with its own focused prompt, then
    // consolidate their findings through the synthesis agent. Falls back to the
    // legacy single-agent/batch path when multi-agent mode is disabled.
    if (this.getActiveAgentCategories().length > 0) {
      return await this.runMultiAgentReview(
        pr,
        files,
        baseContext,
        mcpDocs,
        openThreadsContext,
        workDir,
        promptFile,
        promptExtra,
        timeoutMinutes,
        tokenBudgetConfig,
        blameData,
        codebaseIndex,
        codebaseIndexData,
        linterResults,
        budgetMode,
        totalDiffLines,
        lessons,
        falsePositiveRules,
        deltaContext,
        previousFindings,
        previousBotComments,
        scaIssues,
      );
    }

    // If PR is small enough for a single batch, skip concurrent processing
    if (files.length <= batchSize) {
      const codebaseIndexContext = this.formatCodebaseContext(
        codebaseIndex,
        codebaseIndexData,
        files,
      );
      const prompt = buildReviewPrompt(
        {
          projectContext: this.config.projectContext.description || undefined,
          reviewPromptFile: promptFile,
          reviewPromptExtra: promptExtra,
        },
        baseContext,
        {
          lessons,
          previousFindings,
          falsePositiveRules,
          deltaContext,
          previousBotComments,
          linterResults,
          budgetMode,
          totalDiffLines,
          codebaseIndexContext,
          blameAware: blameData !== undefined && blameData.size > 0,
          testGapContext,
          languages: detectLanguages(
            files
              .map((f) => f?.path)
              .filter((p): p is string => typeof p === 'string' && Boolean(p)),
          ),
        },
      );

      const outputPath = path.join(workDir, 'review-output.jsonl');
      ensureOutputDir(outputPath);

      const runResult = await this.runLLM(prompt, {
        model: this.config.reviewModel,
        timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
        workingDirectory: workDir,
      });

      await this.recordTelemetry(
        pr.number,
        runResult.durationMs,
        runResult.tokensUsed,
        runResult,
        this.config.reviewModel,
        workDir,
      );

      if (!runResult.success) {
        this.logger.warn('OpenCode review execution failed, returning fallback empty result');
        const r = emptyResult();
        r.verdict.reasoning = 'Review execution failed';
        const withSca = scaIssues.length > 0 ? this.mergeScaIssues(r, scaIssues) : r;
        return this.applyBudgetModeBanner(withSca, budgetMode, totalDiffLines);
      }

      try {
        const parsed = await parseJsonlFile(outputPath);

        // Deduplicate against linter findings
        let finalResult = parsed;
        if (linterResults.length > 0) {
          const deduped = this.deduplicateAgainstLinters(parsed.issues, linterResults, workDir);
          if (deduped.length < parsed.issues.length) {
            finalResult = {
              ...parsed,
              issues: deduped,
              stats: {
                total: deduped.length,
                critical: deduped.filter((i) => i.severity === 'critical').length,
                important: deduped.filter((i) => i.severity === 'important').length,
                minor: deduped.filter((i) => i.severity === 'minor').length,
              },
            };
          }
        }

        this.logTokenSavings(budgetMetrics);

        return await this.verifyReviewResult(
          finalResult,
          baseContext,
          workDir,
          timeoutMinutes,
          pr.number,
          budgetMode,
          totalDiffLines,
          files,
          scaIssues,
        );
      } catch {
        this.logger.warn(`Failed to parse review output at ${outputPath}, returning empty result`);
        const r = emptyResult();
        r.verdict.reasoning = 'Failed to parse review output';
        const withSca = scaIssues.length > 0 ? this.mergeScaIssues(r, scaIssues) : r;
        return this.applyBudgetModeBanner(withSca, budgetMode, totalDiffLines);
      }
    }

    // Split files into batches for concurrent processing
    const fileBatches: Array<(typeof files)[number][]> = [];
    for (let i = 0; i < files.length; i += batchSize) {
      fileBatches.push(files.slice(i, i + batchSize));
    }

    let accumulatedTokensUsed = 0;
    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;
    const concurrencyLimit = Math.min(
      os.cpus().length || 4,
      fileBatches.length,
      MAX_BATCH_CONCURRENCY,
    );
    const batchResults: ReviewResult[] = [];
    let failedBatches = 0;
    const chunkCount = computeChunkDelays(fileBatches.length, concurrencyLimit) + 1;
    const batchLoopStart = Date.now();
    for (let chunk = 0; chunk < chunkCount; chunk++) {
      if (chunk > 0) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
      }
      const batchStart = chunk * concurrencyLimit;
      const chunkBatches = fileBatches.slice(batchStart, batchStart + concurrencyLimit);
      const chunkOutputs = await Promise.all(
        chunkBatches.map(async (batch, chunkOffset) => {
          const idx = batchStart + chunkOffset;
          const batchDir = path.join(workDir, `.opencode`, `batch-${idx}`);
          if (!existsSync(batchDir)) {
            mkdirSync(batchDir, { recursive: true });
          }
          const batchPR = { ...pr, changedFiles: batch };
          const batchBlameData: Map<string, Map<number, BlameInfo>> | undefined =
            blameData && blameData.size > 0
              ? new Map(
                  batch
                    .map((f) => f.path)
                    .filter((p): p is string => Boolean(p))
                    .flatMap((p) => {
                      const info = blameData.get(p);
                      return info !== undefined ? [[p, info] as const] : [];
                    }),
                )
              : undefined;
          const { context: batchContext } = this.buildPRContextString(
            batchPR,
            tokenBudgetConfig,
            true,
            batchBlameData,
          );
          const context = mcpDocs
            ? batchContext + '\n\n## Library Documentation\n' + mcpDocs
            : batchContext;

          const batchCodebaseContext = this.formatCodebaseContext(
            codebaseIndex,
            codebaseIndexData,
            batch,
          );

          const prompt = buildReviewPrompt(
            {
              projectContext: this.config.projectContext.description || undefined,
              reviewPromptFile: promptFile,
              reviewPromptExtra: promptExtra,
            },
            context,
            {
              lessons,
              previousFindings,
              falsePositiveRules,
              deltaContext,
              previousBotComments,
              linterResults,
              codebaseIndexContext: batchCodebaseContext,
              blameAware: batchBlameData !== undefined && batchBlameData.size > 0,
              testGapContext,
              languages: detectLanguages(
                batch
                  .map((f) => f?.path)
                  .filter((p): p is string => typeof p === 'string' && Boolean(p)),
              ),
            },
          );

          const outputPath = path.join(batchDir, 'review-output.jsonl');
          ensureOutputDir(outputPath);

          const runResult = await this.runLLM(prompt, {
            model: this.config.reviewModel,
            timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
            workingDirectory: batchDir,
          });

          if (!runResult.success) {
            this.logger.warn(`Batch ${idx} review execution failed, returning empty result`);
            return {
              durationMs: runResult.durationMs,
              tokensUsed: runResult.tokensUsed,
              promptTokens: runResult.promptTokens,
              completionTokens: runResult.completionTokens,
              failed: true,
              result: emptyResult(),
            };
          }

          try {
            const parsed = await parseJsonlFile(outputPath);
            return {
              durationMs: runResult.durationMs,
              tokensUsed: runResult.tokensUsed,
              promptTokens: runResult.promptTokens,
              completionTokens: runResult.completionTokens,
              failed: false,
              result: parsed,
            };
          } catch {
            this.logger.warn(`Failed to parse batch ${idx} review output, returning empty result`);
            return {
              durationMs: runResult.durationMs,
              tokensUsed: runResult.tokensUsed,
              promptTokens: runResult.promptTokens,
              completionTokens: runResult.completionTokens,
              failed: true,
              result: emptyResult(),
            };
          }
        }),
      );
      for (const item of chunkOutputs) {
        accumulatedTokensUsed += item.tokensUsed;
        accumulatedPromptTokens += item.promptTokens ?? 0;
        accumulatedCompletionTokens += item.completionTokens ?? 0;
        batchResults.push(item.result);
        if (item.failed) failedBatches++;
      }
    }

    // Record telemetry for the concurrent batch reviews as a single aggregated
    // entry. Batches overlap, so this uses true wall-clock time for the whole
    // batch loop (including output parsing and inter-chunk backoff) rather than
    // summing each batch's own duration — documented in writeCostLog's JSDoc.
    // Attribution is to the review model.
    const batchWallClockMs = Date.now() - batchLoopStart;
    await this.recordTelemetry(
      pr.number,
      batchWallClockMs,
      accumulatedTokensUsed,
      {
        promptTokens: accumulatedPromptTokens > 0 ? accumulatedPromptTokens : undefined,
        completionTokens: accumulatedCompletionTokens > 0 ? accumulatedCompletionTokens : undefined,
      },
      this.config.reviewModel,
      workDir,
    );

    // Collate findings from all batches
    const allIssues: ReviewIssue[] = [];
    const allStrengths: ReviewStrength[] = [];
    const allRawLines: string[] = [];
    let totalFailedLines = 0;

    for (const br of batchResults) {
      allIssues.push(...br.issues);
      allStrengths.push(...br.strengths);
      if (br.rawLines) allRawLines.push(...br.rawLines);
      totalFailedLines += br.failedLines || 0;
    }

    // Build synthesis payload from collated batch raw lines
    const findingsJsonl = allRawLines.join('\n');
    const synthesisPrompt = buildSynthesisPrompt(
      { projectContext: this.config.projectContext.description || undefined },
      findingsJsonl,
    );

    const finalOutputPath = path.join(workDir, 'review-output.jsonl');
    ensureOutputDir(finalOutputPath);

    const synthesisResult = await this.runLLM(synthesisPrompt, {
      model: this.resolveModel('synthesisModel'),
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
    });

    // Record the synthesis pass separately so its tokens are priced at the
    // synthesis model's own rate (not the review model's) in the JSONL log.
    await this.recordTelemetry(
      pr.number,
      synthesisResult.durationMs,
      synthesisResult.tokensUsed,
      synthesisResult,
      this.resolveModel('synthesisModel'),
      workDir,
    );

    const dedupIssues = (issues: ReviewIssue[]): ReviewIssue[] => {
      if (linterResults.length === 0) return issues;
      return this.deduplicateAgainstLinters(issues, linterResults, workDir);
    };

    if (!synthesisResult.success) {
      this.logger.warn('Synthesis pass failed, falling back to merged batch results');
      if (tokenBudgetConfig?.enabled) {
        this.logTokenSavings(
          this.computeTokenBudgetMetrics(files, tokenBudgetConfig, this.config.maxLinesPerFile),
        );
      }
      const fallback = this.buildFallbackResult(
        dedupIssues(allIssues),
        allStrengths,
        allRawLines,
        totalFailedLines,
        fileBatches,
        'Synthesis failed, using merged batch results',
        failedBatches,
      );
      return await this.verifyReviewResult(
        fallback,
        baseContext,
        workDir,
        timeoutMinutes,
        pr.number,
        budgetMode,
        totalDiffLines,
        files,
        scaIssues,
      );
    }

    try {
      const parsed = await parseJsonlFile(finalOutputPath);

      let finalResult = parsed;
      if (failedBatches > 0) {
        finalResult = { ...parsed, failedBatches };
      }
      if (linterResults.length > 0) {
        const deduped = this.deduplicateAgainstLinters(parsed.issues, linterResults, workDir);
        if (deduped.length < parsed.issues.length) {
          finalResult = {
            ...parsed,
            issues: deduped,
            stats: {
              total: deduped.length,
              critical: deduped.filter((i) => i.severity === 'critical').length,
              important: deduped.filter((i) => i.severity === 'important').length,
              minor: deduped.filter((i) => i.severity === 'minor').length,
            },
            ...(failedBatches > 0 ? { failedBatches } : {}),
          };
        }
      }

      if (tokenBudgetConfig?.enabled) {
        this.logTokenSavings(
          this.computeTokenBudgetMetrics(files, tokenBudgetConfig, this.config.maxLinesPerFile),
        );
      }

      return await this.verifyReviewResult(
        finalResult,
        baseContext,
        workDir,
        timeoutMinutes,
        pr.number,
        budgetMode,
        totalDiffLines,
        files,
        scaIssues,
      );
    } catch {
      this.logger.warn('Synthesis output parse failed, falling back to merged batch results');
      const fallback = this.buildFallbackResult(
        dedupIssues(allIssues),
        allStrengths,
        allRawLines,
        totalFailedLines,
        fileBatches,
        'Synthesis output parse failed, using merged batch results',
        failedBatches,
      );
      if (tokenBudgetConfig?.enabled) {
        this.logTokenSavings(
          this.computeTokenBudgetMetrics(files, tokenBudgetConfig, this.config.maxLinesPerFile),
        );
      }
      return await this.verifyReviewResult(
        fallback,
        baseContext,
        workDir,
        timeoutMinutes,
        undefined,
        budgetMode,
        totalDiffLines,
        files,
        scaIssues,
      );
    }
  }

  /**
   * Resolve the set of specialized agent categories that participate in a
   * multi-agent review. Agents listed in config with `enabled: false` are
   * excluded; unlisted categories default to enabled. Returns an empty array
   * when multi-agent mode is disabled — the legacy review path then runs.
   * @returns The active agent categories, or [] when multi-agent is disabled.
   */
  private getActiveAgentCategories(): AgentCategory[] {
    const multiAgent = this.config.multiAgent;
    if (!multiAgent?.enabled) return [];
    const agents = multiAgent.agents ?? {};
    return AGENT_ORDER.filter((category) => agents[category]?.enabled !== false);
  }

  /**
   * Resolve the effective model for a specialized agent, preferring the
   * per-agent override, then the review model. The per-agent override is
   * validated at dispatch time: a malformed override (e.g. 'gpt-4o' with no
   * provider prefix) degrades to `reviewModel` with a warning instead of
   * throwing from `runOpenCode` and aborting the whole review.
   * @param category - The agent category.
   * @returns The resolved model string.
   */
  private resolveAgentModel(category: AgentCategory): string {
    const override = this.config.multiAgent?.agents?.[category]?.model;
    if (override) {
      try {
        validateModelString(override);
        return override;
      } catch (err) {
        this.logger.warn(
          `Agent "${category}" model "${override}" is invalid, falling back to reviewModel: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return this.config.reviewModel;
  }

  /**
   * Orchestrate the multi-agent review path: dispatch every active specialized
   * agent over the changed files, collect their findings, then run the
   * synthesis agent to deduplicate, prioritize, and consolidate the final
   * review. Always returns through `verifyReviewResult` so reachability,
   * meta-verification, sensitivity filtering, and budget banners apply
   * identically to the legacy path.
   *
   * Active agents are dispatched concurrently (each agent runs its own file
   * batches under a bounded per-agent concurrency limit), so up to four
   * specialized agents review in parallel instead of serially — output files
   * are namespaced per agent/batch so no collisions occur.
   * @param pr - The PR context being reviewed.
   * @param files - Changed files (already filtered by exclude patterns).
   * @param baseContext - The assembled PR/base context string (MCP + open threads).
   * @param mcpDocs - MCP library documentation ('' when disabled/failed).
   * @param openThreadsContext - Open human-thread discussion context ('' when none/failed).
   * @param workDir - Working directory the review runs in.
   * @param promptFile - Optional custom review prompt file path.
   * @param promptExtra - Optional extra instructions appended to each agent prompt.
   * @param timeoutMinutes - Optional per-run timeout override.
   * @param tokenBudgetConfig - Optional token budget config for per-file context caps.
   * @param blameData - Optional git blame annotations keyed by file path.
   * @param codebaseIndex - Optional codebase index engine for cross-file context.
   * @param codebaseIndexData - Optional loaded index data.
   * @param linterResults - Results from configured linters.
   * @param budgetMode - Selected budget review mode.
   * @param totalDiffLines - Optional total diff line count.
   * @param lessons - Optional learning-store lessons.
   * @param falsePositiveRules - Optional false-positive suppression rules.
   * @param deltaContext - Optional incremental review context.
   * @param previousFindings - Optional findings from previous fix iterations.
   * @param previousBotComments - Optional previous bot review comments.
   * @param scaIssues - Optional SCA findings merged into the verified result.
   * @returns The consolidated, verified ReviewResult.
   */
  private async runMultiAgentReview(
    pr: PRContext,
    files: PRContext['changedFiles'],
    baseContext: string,
    mcpDocs: string,
    openThreadsContext: string,
    workDir: string,
    promptFile?: string,
    promptExtra?: string,
    timeoutMinutes?: number,
    tokenBudgetConfig?: TokenBudgetConfig,
    blameData?: Map<string, Map<number, BlameInfo>>,
    codebaseIndex?: CodebaseIndex,
    codebaseIndexData?: CodebaseIndexData,
    linterResults: LinterResult[] = [],
    budgetMode?: ReviewBudgetMode,
    totalDiffLines?: number,
    lessons?: string[],
    falsePositiveRules?: string[],
    deltaContext?: string,
    previousFindings?: PreviousFindingIteration[],
    previousBotComments?: Array<{
      file: string;
      line: number | null;
      body: string;
      commentId: number;
    }>,
    scaIssues?: ReviewIssue[],
  ): Promise<ReviewResult> {
    const categories = this.getActiveAgentCategories();
    this.logger.info(
      `Multi-agent review: dispatching ${categories.length} specialized agent(s): ${categories.join(', ')}`,
    );

    // Dispatch all active agents concurrently. Each agent writes to its own
    // `.opencode/agent-<category>/batch-<idx>` output directory, so the agents
    // cannot collide; concurrency is bounded inside each agent by a per-agent
    // batch limit that keeps the aggregate under MAX_BATCH_CONCURRENCY.
    const settled = await Promise.allSettled(
      categories.map((category) =>
        this.runAgentCategory(
          category,
          files,
          pr,
          mcpDocs,
          openThreadsContext,
          workDir,
          promptFile,
          promptExtra,
          timeoutMinutes,
          tokenBudgetConfig,
          blameData,
          codebaseIndex,
          codebaseIndexData,
          lessons,
          falsePositiveRules,
          deltaContext,
          previousFindings,
          previousBotComments,
          budgetMode,
          totalDiffLines,
        ),
      ),
    );
    const agentResults: AgentResult[] = settled.map((outcome, idx) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const category = categories[idx];
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      this.logger.warn(`Agent "${category}" rejected: ${message}`);
      return {
        agent: category,
        findings: [],
        strengths: [],
        rawOutput: '',
        durationMs: 0,
        tokensUsed: 0,
        success: false,
        error: message,
      };
    });
    for (const result of agentResults) {
      if (result.success) {
        this.logger.info(
          `Agent "${result.agent}" found ${result.findings.length} issue(s) and ${result.strengths.length} strength(s) in ${result.durationMs}ms`,
        );
      } else {
        this.logger.warn(`Agent "${result.agent}" failed: ${result.error ?? 'unknown error'}`);
      }
    }

    const result = await this.synthesizeAgentFindings(
      pr.number,
      agentResults,
      workDir,
      timeoutMinutes,
      linterResults,
      promptFile,
      promptExtra,
    );

    return await this.verifyReviewResult(
      result,
      baseContext,
      workDir,
      timeoutMinutes,
      pr.number,
      budgetMode,
      totalDiffLines,
      files,
      scaIssues,
    );
  }

  /**
   * Run a single specialized agent over the changed files. Files are split into
   * batches of `batchSize` (reusing the legacy batch infrastructure), each
   * batch is dispatched to `runOpenCode` with the agent's focused prompt in an
   * isolated working directory, and the accumulated output is parsed into one
   * AgentResult attributed to the agent's category.
   *
   * Batches run concurrently under a bounded limit that keeps the aggregate
   * across all active agents under `MAX_BATCH_CONCURRENCY`. A batch whose
   * `runOpenCode` invocation throws or reports failure is marked failed and the
   * remaining batches still run, so a per-agent model typo or CLI outage can
   * never abort the whole review.
   * @param category - The agent category to run.
   * @param files - Changed files the agent reviews.
   * @param pr - The PR context being reviewed.
   * @param mcpDocs - MCP library documentation ('' when disabled/failed).
   * @param openThreadsContext - Open human-thread discussion context ('' when none/failed).
   * @param workDir - Working directory the review runs in.
   * @param promptFile - Optional review-level custom prompt file path (the per-agent
   * `multiAgent.agents.<category>.promptFile` takes precedence when set).
   * @param promptExtra - Optional extra instructions appended to the agent prompt.
   * @param timeoutMinutes - Optional per-run timeout override.
   * @param tokenBudgetConfig - Optional token budget config.
   * @param blameData - Optional git blame annotations keyed by file path.
   * @param codebaseIndex - Optional codebase index engine.
   * @param codebaseIndexData - Optional loaded index data.
   * @param lessons - Optional learning-store lessons.
   * @param falsePositiveRules - Optional false-positive suppression rules.
   * @param deltaContext - Optional incremental review context.
   * @param previousFindings - Optional findings from previous fix iterations.
   * @param previousBotComments - Optional previous bot review comments.
   * @param budgetMode - Optional budget review mode forwarded into the agent prompt.
   * @param totalDiffLines - Optional total diff line count for the budget banner.
   * @returns The structured AgentResult for this category.
   */
  private async runAgentCategory(
    category: AgentCategory,
    files: PRContext['changedFiles'],
    pr: PRContext,
    mcpDocs: string,
    openThreadsContext: string,
    workDir: string,
    promptFile?: string,
    promptExtra?: string,
    timeoutMinutes?: number,
    tokenBudgetConfig?: TokenBudgetConfig,
    blameData?: Map<string, Map<number, BlameInfo>>,
    codebaseIndex?: CodebaseIndex,
    codebaseIndexData?: CodebaseIndexData,
    lessons?: string[],
    falsePositiveRules?: string[],
    deltaContext?: string,
    previousFindings?: PreviousFindingIteration[],
    previousBotComments?: Array<{
      file: string;
      line: number | null;
      body: string;
      commentId: number;
    }>,
    budgetMode?: ReviewBudgetMode,
    totalDiffLines?: number,
  ): Promise<AgentResult> {
    const agentConfig = this.config.multiAgent?.agents?.[category] as
      | MultiAgentAgentConfig
      | undefined;
    const model = this.resolveAgentModel(category);
    const agentPromptFile = agentConfig?.promptFile;
    const batchSize = this.config.batchSize || 3;

    const fileBatches: Array<(typeof files)[number][]> = [];
    for (let i = 0; i < files.length; i += batchSize) {
      fileBatches.push(files.slice(i, i + batchSize));
    }

    const agentStart = Date.now();
    let accumulatedTokensUsed = 0;
    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;
    const rawBatches: string[] = [];
    let success = true;
    let error: string | undefined;

    // Bound the per-agent batch concurrency so the aggregate across concurrently
    // running agents stays under MAX_BATCH_CONCURRENCY (mirroring the legacy
    // single-agent path's cap).
    const activeCategories = Math.max(1, this.getActiveAgentCategories().length);
    const concurrencyLimit = Math.min(
      os.cpus().length || 4,
      fileBatches.length,
      Math.max(1, Math.floor(MAX_BATCH_CONCURRENCY / activeCategories)),
    );

    const runBatch = async (
      batch: (typeof files)[number][],
      idx: number,
    ): Promise<{
      raw: string;
      tokensUsed: number;
      promptTokens?: number;
      completionTokens?: number;
      failed: boolean;
      error?: string;
    }> => {
      const batchDir = path.join(workDir, '.opencode', `agent-${category}`, `batch-${idx}`);
      if (!existsSync(batchDir)) {
        mkdirSync(batchDir, { recursive: true });
      }

      const batchPR = { ...pr, changedFiles: batch };
      const batchBlameData: Map<string, Map<number, BlameInfo>> | undefined =
        blameData && blameData.size > 0
          ? new Map(
              batch
                .map((f) => f.path)
                .filter((p): p is string => Boolean(p))
                .flatMap((p) => {
                  const info = blameData.get(p);
                  return info !== undefined ? [[p, info] as const] : [];
                }),
            )
          : undefined;
      const { context: batchContext } = this.buildPRContextString(
        batchPR,
        tokenBudgetConfig,
        true,
        batchBlameData,
      );
      const batchCodebaseContext = this.formatCodebaseContext(
        codebaseIndex,
        codebaseIndexData,
        batch,
      );
      const agentContext: AgentPromptContext = {
        inputs: {
          projectContext: this.config.projectContext.description || undefined,
          reviewPromptFile: agentPromptFile ?? promptFile,
          reviewPromptExtra: promptExtra,
        },
        prContext: this.buildAgentBatchContext(
          batchContext,
          mcpDocs,
          openThreadsContext,
          batchCodebaseContext,
          deltaContext,
          lessons,
          falsePositiveRules,
          previousFindings,
          previousBotComments,
        ),
        budgetMode,
        totalDiffLines,
      };

      const promptBuilder = AGENT_PROMPT_BUILDERS[category] ?? buildSecurityPrompt;
      const prompt = promptBuilder(agentContext);

      const outputPath = path.join(batchDir, 'review-output.jsonl');
      ensureOutputDir(outputPath);

      // runOpenCode throws synchronously on a malformed model string and can
      // reject on setup/health-check failures. Treat a thrown/rejected call as a
      // failed batch so a single bad batch never aborts the whole review.
      const runResult = await this.runLLM(prompt, {
        model,
        timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
        workingDirectory: batchDir,
      }).catch((err: unknown) => {
        this.logger.warn(
          `Agent ${category} batch ${idx} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          success: false,
          output: '',
          durationMs: 0,
          tokensUsed: 0,
          promptTokens: undefined,
          completionTokens: undefined,
        };
      });

      if (!runResult.success) {
        this.logger.warn(`Agent ${category} batch ${idx} execution failed`);
        return {
          raw: '',
          tokensUsed: runResult.tokensUsed,
          promptTokens: runResult.promptTokens,
          completionTokens: runResult.completionTokens,
          failed: true,
          error: `Agent batch ${idx} execution failed`,
        };
      }

      try {
        const content = await fs.readFile(outputPath, 'utf-8');
        return {
          raw: content.trim() ? content : '',
          tokensUsed: runResult.tokensUsed,
          promptTokens: runResult.promptTokens,
          completionTokens: runResult.completionTokens,
          failed: false,
        };
      } catch (err) {
        this.logger.warn(`Agent ${category} batch ${idx} output missing`);
        return {
          raw: '',
          tokensUsed: runResult.tokensUsed,
          promptTokens: runResult.promptTokens,
          completionTokens: runResult.completionTokens,
          failed: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const chunkCount = computeChunkDelays(fileBatches.length, concurrencyLimit) + 1;
    for (let chunk = 0; chunk < chunkCount; chunk++) {
      if (chunk > 0) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
      }
      const batchStart = chunk * concurrencyLimit;
      const chunkBatches = fileBatches.slice(batchStart, batchStart + concurrencyLimit);
      const chunkOutputs = await Promise.all(
        chunkBatches.map((batch, chunkOffset) => runBatch(batch, batchStart + chunkOffset)),
      );
      for (const batchResult of chunkOutputs) {
        accumulatedTokensUsed += batchResult.tokensUsed;
        accumulatedPromptTokens += batchResult.promptTokens ?? 0;
        accumulatedCompletionTokens += batchResult.completionTokens ?? 0;
        if (batchResult.raw) {
          rawBatches.push(batchResult.raw);
        }
        if (batchResult.failed) {
          success = false;
          error = error ?? batchResult.error;
        }
      }
    }

    // Record the agent's aggregated telemetry (all batches, one entry).
    await this.recordTelemetry(
      pr.number,
      Date.now() - agentStart,
      accumulatedTokensUsed,
      {
        promptTokens: accumulatedPromptTokens > 0 ? accumulatedPromptTokens : undefined,
        completionTokens: accumulatedCompletionTokens > 0 ? accumulatedCompletionTokens : undefined,
      },
      model,
      workDir,
    );

    const parsed = parseAgentJsonlString(rawBatches.join('\n'), category);
    const rawOutput = rawBatches.join('\n');

    if (success && rawOutput.trim().length === 0 && parsed.findings.length === 0) {
      success = false;
      error = 'Agent produced no output';
    }

    return {
      agent: category,
      findings: parsed.findings,
      strengths: parsed.strengths,
      rawOutput,
      failedLines: parsed.failedLines,
      durationMs: Date.now() - agentStart,
      tokensUsed: accumulatedTokensUsed,
      success,
      error,
    };
  }

  /**
   * Assemble the enriched context string injected into a specialized agent's
   * prompt for one file batch. Combines the batch PR context (with blame
   * annotations), MCP library docs, open human-thread context, codebase index
   * context, delta context, learning lessons, false-positive rules, and
   * previous iteration findings so the agent reviews with the same enrichment
   * the legacy path provides.
   * @param batchContext - The batch PR context string.
   * @param mcpDocs - MCP library documentation ('' when disabled/failed).
   * @param openThreadsContext - Open human-thread discussion context ('' when none/failed).
   * @param codebaseIndexContext - Cross-file codebase context ('' when unavailable).
   * @param deltaContext - Optional incremental review context.
   * @param lessons - Optional learning-store lessons.
   * @param falsePositiveRules - Optional false-positive suppression rules.
   * @param previousFindings - Optional findings from previous fix iterations.
   * @param previousBotComments - Optional previous bot review comments.
   * @returns The enriched context string.
   */
  private buildAgentBatchContext(
    batchContext: string,
    mcpDocs: string,
    openThreadsContext: string,
    codebaseIndexContext: string,
    deltaContext?: string,
    lessons?: string[],
    falsePositiveRules?: string[],
    previousFindings?: PreviousFindingIteration[],
    previousBotComments?: Array<{
      file: string;
      line: number | null;
      body: string;
      commentId: number;
    }>,
  ): string {
    const parts: string[] = [batchContext];

    if (mcpDocs) {
      parts.push('\n\n## Library Documentation\n\n' + mcpDocs);
    }
    if (openThreadsContext) {
      // Mirror the legacy baseContext assembly, which appends open human-thread
      // context verbatim so agents respect unresolved discussion threads.
      parts.push('\n\n' + openThreadsContext);
    }
    if (codebaseIndexContext) {
      parts.push('\n\n## Codebase Context (Cross-File Analysis)\n\n' + codebaseIndexContext);
    }
    if (deltaContext) {
      // Mirror the legacy buildReviewPrompt cap: truncate the delta diff to
      // 5000 chars on a hunk or newline boundary so a large diff cannot push
      // the later enrichment sections past the agent prompt length cap.
      let truncatedDelta = deltaContext;
      if (deltaContext.length > 5000) {
        const slice = deltaContext.slice(0, 5000);
        const lastHunk = slice.lastIndexOf('\n@@');
        const lastNewline = slice.lastIndexOf('\n');
        const boundary = lastHunk > 0 ? lastHunk : lastNewline > 0 ? lastNewline : 5000;
        truncatedDelta = `${slice.slice(0, boundary)}\n... (truncated)`;
      }
      parts.push(
        '\n\n## Incremental Review (Delta Changes)\n\n' +
          'This is a follow-up review for new commits pushed since the last review pass.\n\n' +
          '```diff\n' +
          truncatedDelta +
          '\n```',
      );
    }
    if (falsePositiveRules && falsePositiveRules.length > 0) {
      parts.push(
        '\n\n## False Positive Suppression Rules\n\nThe following patterns were previously flagged but dismissed by human reviewers as intentional or not actual issues. DO NOT flag these patterns again:',
      );
      for (const rule of falsePositiveRules) {
        parts.push(`- ${rule}`);
      }
    }
    if (lessons && lessons.length > 0) {
      parts.push(
        '\n\n## Historical Lessons\n\nThe following patterns were detected in similar code in past reviews:',
      );
      for (const lesson of lessons) {
        parts.push(`- ${lesson}`);
      }
    }
    if (previousFindings && previousFindings.length > 0) {
      parts.push(
        '\n\n## Previous Review Iterations\n\n' +
          'This is not the first review of this PR. Report only issues that are STILL present.',
      );
      for (const pf of previousFindings) {
        parts.push(`\n### Iteration ${pf.iteration}`);
        if (pf.fixSummary) parts.push(`Fix summary: ${pf.fixSummary}`);
        if (pf.filesChanged && pf.filesChanged.length > 0) {
          parts.push(`Files changed: \`${pf.filesChanged.join('`, `')}\``);
        }
        parts.push('Previously reported issues:');
        for (const issue of pf.issues) {
          const tag = issue.previouslyReported ? ' (previously reported — verify fixed)' : '';
          parts.push(
            `- **${issue.severity.toUpperCase()}:** ${issue.file}:${issue.line} — ${issue.message}${tag}`,
          );
        }
      }
    }
    if (previousBotComments && previousBotComments.length > 0) {
      parts.push(
        '\n\n## Previously Reported Issues (Auto-Tracking)\n\nThe following issues were reported in previous reviews on this PR. Do NOT re-report issues that have been fixed:',
      );
      for (const comment of previousBotComments) {
        const location = comment.line != null ? `${comment.file}:${comment.line}` : comment.file;
        const snippet = sanitizeString(comment.body.split('\n')[0].substring(0, 200));
        parts.push(`- **${location}** — ${snippet}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Consolidate findings from all specialized agents into a final ReviewResult.
   * Runs the synthesis agent (always, when enabled) with a JSONL payload of
   * per-agent findings; on synthesis failure or output-parse failure, falls back
   * to a deterministic merged + deduplicated result so a synthesis-model outage
   * can never fail the whole review.
   *
   * When every agent failed (model outage, timeout, malformed output), the
   * resulting review is forced to a failed verdict (`ready: false`) — a PR that
   * was never actually reviewed must never be reported as clean and merge-ready.
   * @param prNumber - PR number being reviewed.
   * @param agentResults - Findings from each specialized agent.
   * @param workDir - Working directory the review runs in.
   * @param timeoutMinutes - Optional per-run timeout override.
   * @param linterResults - Results from configured linters (deduped post-synthesis).
   * @param promptFile - Optional review-level custom prompt file path forwarded to the synthesis prompt.
   * @param promptExtra - Optional extra instructions forwarded to the synthesis prompt.
   * @returns The consolidated ReviewResult.
   */
  private async synthesizeAgentFindings(
    prNumber: number,
    agentResults: AgentResult[],
    workDir: string,
    timeoutMinutes?: number,
    linterResults: LinterResult[] = [],
    promptFile?: string,
    promptExtra?: string,
  ): Promise<ReviewResult> {
    const allFindings: AgentFinding[] = agentResults.flatMap((r) => r.findings);
    const allStrengths: ReviewStrength[] = agentResults.flatMap((r) => r.strengths);
    const allRawLines: string[] = agentResults
      .map((r) => r.rawOutput)
      .filter((raw) => typeof raw === 'string' && raw.length > 0);
    const failedAgents = agentResults.filter((r) => !r.success).length;
    const totalFailedLines = agentResults.reduce((sum, r) => sum + (r.failedLines ?? 0), 0);
    const allFailed = failedAgents === agentResults.length && agentResults.length > 0;

    const dedupIssues = (issues: ReviewIssue[]): ReviewIssue[] => {
      if (linterResults.length === 0) return issues;
      return this.deduplicateAgainstLinters(issues, linterResults, workDir);
    };

    // Force a failed verdict when every agent failed, regardless of which
    // consolidation path runs, so an unreviewed PR is never green-lit.
    const forceFailedVerdict = (result: ReviewResult): ReviewResult => {
      if (!allFailed) return result;
      return {
        ...result,
        verdict: { ...result.verdict, ready: false, autoFixable: false },
      };
    };

    const synthesisEnabled = this.config.multiAgent?.synthesis?.enabled !== false;
    if (!synthesisEnabled || allFindings.length === 0) {
      const reasoning = allFailed
        ? 'All review agents failed'
        : allFindings.length === 0
          ? 'No issues found'
          : 'Merged agent findings';
      return forceFailedVerdict(
        this.buildAgentFallbackResult(
          dedupIssues(this.deduplicateAgentFindings(allFindings)),
          allStrengths,
          allRawLines,
          totalFailedLines,
          reasoning,
          failedAgents,
        ),
      );
    }

    // Serialize per-agent findings (each issue carries its originating agent)
    // and hand them to the synthesis agent for dedup, prioritization, and
    // consolidated formatting.
    const findingsJsonl = allFindings
      .map((f) =>
        JSON.stringify({
          ...f,
          agent: f.agent,
          category: f.agent,
        }),
      )
      .join('\n');
    const synthesisPrompt = buildMultiAgentSynthesisPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        reviewPromptFile: promptFile,
        reviewPromptExtra: promptExtra,
      },
      findingsJsonl,
    );
    const synthesisModelOverride = this.config.multiAgent?.synthesis?.model;
    let synthesisModel = this.resolveModel('synthesisModel');
    if (synthesisModelOverride) {
      try {
        validateModelString(synthesisModelOverride);
        synthesisModel = synthesisModelOverride;
      } catch (err) {
        this.logger.warn(
          `Synthesis model "${synthesisModelOverride}" is invalid, falling back to the synthesis/review model: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const finalOutputPath = path.join(workDir, 'review-output.jsonl');
    ensureOutputDir(finalOutputPath);

    const synthesisResult = await this.runLLM(synthesisPrompt, {
      model: synthesisModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
    }).catch((err: unknown) => {
      this.logger.warn(
        `Multi-agent synthesis run threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        success: false,
        output: '',
        durationMs: 0,
        tokensUsed: 0,
        promptTokens: undefined,
        completionTokens: undefined,
      };
    });
    await this.recordTelemetry(
      prNumber,
      synthesisResult.durationMs,
      synthesisResult.tokensUsed,
      synthesisResult,
      synthesisModel,
      workDir,
    );

    if (!synthesisResult.success) {
      this.logger.warn('Multi-agent synthesis pass failed, falling back to merged agent results');
      return forceFailedVerdict(
        this.buildAgentFallbackResult(
          dedupIssues(this.deduplicateAgentFindings(allFindings)),
          allStrengths,
          allRawLines,
          totalFailedLines,
          'Synthesis failed, using merged agent results',
          failedAgents,
        ),
      );
    }

    try {
      const parsed = await parseJsonlFile(finalOutputPath);
      // Preserve per-agent strengths on the synthesis-success path by merging
      // them (deduplicated by message) so agent-reported strengths survive
      // regardless of which consolidation path runs.
      const mergedStrengths = [...parsed.strengths, ...allStrengths].filter(
        (s, i, arr) => arr.findIndex((x) => x.message === s.message) === i,
      );
      let finalResult: ReviewResult = {
        ...parsed,
        strengths: mergedStrengths,
        ...(failedAgents > 0 ? { failedAgents } : {}),
      };
      if (linterResults.length > 0) {
        const deduped = this.deduplicateAgainstLinters(parsed.issues, linterResults, workDir);
        if (deduped.length < parsed.issues.length) {
          finalResult = {
            ...finalResult,
            issues: deduped,
            stats: {
              total: deduped.length,
              critical: deduped.filter((i) => i.severity === 'critical').length,
              important: deduped.filter((i) => i.severity === 'important').length,
              minor: deduped.filter((i) => i.severity === 'minor').length,
            },
          };
        }
      }
      return forceFailedVerdict(finalResult);
    } catch (err) {
      this.logger.warn(
        `Multi-agent synthesis output parse failed, falling back to merged agent results: ${err instanceof Error ? err.message : String(err)}`,
      );
      return forceFailedVerdict(
        this.buildAgentFallbackResult(
          dedupIssues(this.deduplicateAgentFindings(allFindings)),
          allStrengths,
          allRawLines,
          totalFailedLines,
          'Synthesis output parse failed, using merged agent results',
          failedAgents,
        ),
      );
    }
  }

  /**
   * Deterministically deduplicate findings across agents. Two findings are
   * considered the same when they share file, line, and message (case
   * insensitive). When duplicates are found, the higher-confidence finding is
   * kept; ties resolve to the higher severity. This runs as a pre-merge pass for
   * fallback results and complements the synthesis agent's LLM dedup.
   * @param findings - Raw findings from all specialized agents.
   * @returns The deduplicated findings.
   */
  private deduplicateAgentFindings(findings: AgentFinding[]): AgentFinding[] {
    const confidenceRank: Record<'high' | 'medium' | 'low', number> = {
      high: 3,
      medium: 2,
      low: 1,
    };
    const seen = new Map<string, AgentFinding>();
    for (const finding of findings) {
      const messageKey = (finding.message || '').trim().toLowerCase();
      const key = `${finding.file}:${finding.line}:${messageKey}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, finding);
        continue;
      }
      const newConfidence = confidenceRank[finding.confidence ?? 'low'] ?? 1;
      const existingConfidence = confidenceRank[existing.confidence ?? 'low'] ?? 1;
      const newSeverity = severityRank(finding.severity);
      const existingSeverity = severityRank(existing.severity);
      if (
        newConfidence > existingConfidence ||
        (newConfidence === existingConfidence && newSeverity > existingSeverity)
      ) {
        seen.set(key, finding);
      }
    }
    return [...seen.values()];
  }

  /**
   * Build a fallback ReviewResult from merged agent findings when the synthesis
   * agent is disabled or fails. Mirrors `buildFallbackResult` but attributes
   * partial-failure counts to agents instead of batches, and reports the real
   * malformed-line count instead of hardcoding 0.
   * @param issues - Merged, deduplicated issues.
   * @param strengths - Merged strengths.
   * @param rawLines - Raw agent JSONL lines.
   * @param failedLines - Number of malformed/parse-failed JSONL lines across all agents.
   * @param reasoning - Verdict reasoning string.
   * @param failedAgents - Number of agents that failed.
   * @returns The fallback ReviewResult.
   */
  private buildAgentFallbackResult(
    issues: ReviewIssue[],
    strengths: ReviewStrength[],
    rawLines: string[],
    failedLines: number,
    reasoning: string,
    failedAgents = 0,
  ): ReviewResult {
    return {
      summary:
        issues.length > 0
          ? `Found ${issues.length} issues across specialized agents`
          : 'No issues found',
      verdict: {
        ready: issues.length === 0,
        reasoning,
        autoFixable: false,
        confidence: 'medium' as const,
      },
      strengths,
      issues,
      stats: {
        total: issues.length,
        critical: issues.filter((i) => i.severity === 'critical').length,
        important: issues.filter((i) => i.severity === 'important').length,
        minor: issues.filter((i) => i.severity === 'minor').length,
      },
      rawLines,
      failedLines,
      failedAgents,
    };
  }

  /**
   * Run the auto-fix workflow on a PR.
   * Builds a fix prompt enriched with MCP library docs, runs OpenCode CLI,
   * and reads results (git status, stuck marker, fix summary) from disk.
   *
   * @param prNumber - PR number being fixed.
   * @param iteration - Current fix iteration (0-indexed).
   * @param contextMarkdown - PR context as markdown string.
   * @param cachedPR - Optional pre-fetched PR context to avoid redundant API calls.
   * @param timeoutMinutes - Optional timeout override (defaults to config.timeoutMinutes).
   * @param issues - Optional review issues from previous fix iteration for context.
   * @param verificationError - Optional verification error message from previous iteration.
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
   * @returns Fix result indicating whether changes were made, files changed, and stuck/summary info.
   */
  async runFix(
    prNumber: number,
    iteration: number,
    contextMarkdown: string,
    cachedPR?: PRContext,
    timeoutMinutes?: number,
    issues?: ReviewIssue[],
    verificationError?: string,
    workingDirectory?: string,
  ): Promise<FixResult> {
    // Reset telemetry so the reported usage reflects only this fix invocation.
    this.telemetry = null;
    this.publishEvent(PIPELINE_EVENT_TYPES.FIX_STARTED, {
      prNumber,
      iteration,
      modelUsed: this.config.fixModel,
    });
    let mcpDocs = '';
    if (this.config.enableMCP && this.config.mcpServers.length > 0) {
      try {
        await this.mcp.connect();
        const pr = cachedPR ?? (await this.adapter.getMR(prNumber));
        const libraries = detectLibraries(
          pr.changedFiles.map((f) => f.path),
          workingDirectory,
        );
        if (libraries.length > 0) {
          mcpDocs = await this.getCachedMcpDocs(libraries);
        }
      } catch (err) {
        this.logger.warn(
          sanitizeString(
            `MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    const fixContext = mcpDocs
      ? contextMarkdown + '\n\n## Library Documentation\n' + mcpDocs
      : contextMarkdown;

    const prompt = buildFixPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        maxFixIterations: this.config.maxIterations,
      },
      fixContext,
      iteration,
      issues,
      verificationError,
    );

    const fixRunResult = await this.runLLM(prompt, {
      model: this.config.fixModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory,
    });
    await this.recordTelemetry(
      prNumber,
      fixRunResult.durationMs,
      fixRunResult.tokensUsed,
      fixRunResult,
      this.config.fixModel,
      workingDirectory,
    );
    if (!fixRunResult.success) {
      this.logger.warn(
        'OpenCode fix execution failed or timed out. Checking for partial changes on disk...',
      );
      // Give filesystem time to flush writes from the killed process
      await new Promise((r) => setTimeout(r, 500));
    }

    const workDir = workingDirectory || process.cwd();

    let changesMade = false;
    let filesChanged: string[] = [];
    let stuck = false;
    let stuckReason: string | undefined;
    let summary: string | undefined;

    try {
      const status = getGitStatus(workDir);
      changesMade = status.trim().length > 0;

      try {
        const stuckContent = await fs.readFile(path.join(workDir, '.fix-stuck.md'), 'utf-8');
        stuck = stuckContent.trim().length > 0;
        stuckReason = stuckContent;
        await fs.unlink(path.join(workDir, '.fix-stuck.md'));
      } catch {
        this.logger.debug('No .fix-stuck.md — proceeding normally');
      }

      try {
        summary = await fs.readFile(path.join(workDir, '.fix-summary.md'), 'utf-8');
        await fs.unlink(path.join(workDir, '.fix-summary.md'));
      } catch {
        this.logger.debug('No .fix-summary.md — proceeding normally');
      }

      if (changesMade) {
        try {
          const raw = cp
            .execFileSync('git', ['diff', '--name-only', 'HEAD'], {
              encoding: 'utf-8',
              cwd: workDir,
            })
            .toString()
            .trim();
          filesChanged = raw ? raw.split('\n') : [];
        } catch {
          this.logger.warn('Could not get git diff to determine changed files');
        }
      }
    } catch (err) {
      this.logger.warn(
        `Error reading fix results after OpenCode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const fixResult = { changesMade, filesChanged, stuck, stuckReason, summary };
    this.publishCompleted(PIPELINE_EVENT_TYPES.FIX_COMPLETED, {
      prNumber,
      iteration,
      changesMade,
      filesChanged,
      stuck,
      stuckReason,
      modelUsed: this.config.fixModel,
    });
    return fixResult;
  }

  /**
   * Run a codebase audit for a specific category.
   * Builds an audit prompt with MCP enrichment, runs OpenCode CLI,
   * and parses the output JSONL file.
   *
   * @param promptContent - Base audit prompt content.
   * @param targetDir - Directory to audit.
   * @param category - Audit category name (used for output file naming).
   * @param timeoutMinutes - Optional timeout override (defaults to config.timeoutMinutes).
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
   * @returns Parsed audit result with issues and verdict.
   */
  async runAudit(
    promptContent: string,
    targetDir: string,
    category: string,
    timeoutMinutes?: number,
    workingDirectory?: string,
  ): Promise<ReviewResult> {
    // Reset telemetry so the reported usage reflects only this audit invocation.
    this.telemetry = null;
    this.publishEvent(PIPELINE_EVENT_TYPES.AUDIT_STARTED, {
      category,
      targetDir,
      modelUsed: this.resolveModel('auditModel'),
    });
    let mcpDocs = '';
    if (this.config.enableMCP) {
      try {
        await this.mcp.connect();
        const libraries = detectLibrariesFromDir(targetDir, workingDirectory);
        if (libraries.length > 0) {
          mcpDocs = await this.getCachedMcpDocs(libraries);
        }
      } catch (err) {
        this.logger.warn(
          sanitizeString(
            `MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    const enrichedPrompt = mcpDocs
      ? promptContent + '\n\n## Library Documentation\n' + mcpDocs
      : promptContent;

    const prompt = buildAuditPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
      },
      enrichedPrompt,
      targetDir,
      category,
    );

    const auditRunResult = await this.runLLM(prompt, {
      model: this.resolveModel('auditModel'),
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory,
    });
    await this.recordTelemetry(
      0,
      auditRunResult.durationMs,
      auditRunResult.tokensUsed,
      auditRunResult,
      this.resolveModel('auditModel'),
      workingDirectory,
    );
    if (!auditRunResult.success) {
      this.logger.warn('OpenCode audit execution failed, returning fallback empty result');
      const r = emptyResult();
      r.verdict.reasoning = 'Audit execution failed';
      this.publishCompleted(PIPELINE_EVENT_TYPES.AUDIT_COMPLETED, {
        category,
        targetDir,
        issuesCount: 0,
        modelUsed: this.resolveModel('auditModel'),
      });
      return r;
    }

    const auditDir = workingDirectory || process.cwd();
    const outputPath = path.join(auditDir, `.opencode/audit-${category}.jsonl`);
    try {
      const auditResult = await parseJsonlFile(outputPath);
      // Apply per-repository sensitivity filters keyed off the audit category,
      // honoring the dormant `audit.issueSeverityThreshold` as an additional
      // global severity floor.
      const filteredResult = this.applySensitivityFilter(
        auditResult,
        category,
        severityRank(this.config.audit.issueSeverityThreshold),
      );
      // Deterministic hardcoded-secret scan over the audited tree. Merged after
      // the sensitivity filter so critical secret findings always surface
      // regardless of focus areas or finding caps configured for LLM findings.
      // Best-effort: a scan failure degrades to the filtered result.
      let finalResult = filteredResult;
      const secretConfig = this.config.secrets ?? DEFAULT_SECRET_DETECTOR_CONFIG;
      if (secretConfig.enabled) {
        try {
          const secretIssues = await this.scanDirectoryForSecrets(targetDir, workingDirectory);
          if (secretIssues.length > 0) {
            this.logger.info(
              `Secret detection flagged ${secretIssues.length} hardcoded secret(s) in audit target`,
            );
            finalResult = this.mergeSecretIssues(filteredResult, secretIssues);
          }
        } catch (err) {
          this.logger.warn(
            `Secret detection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.publishCompleted(PIPELINE_EVENT_TYPES.AUDIT_COMPLETED, {
        category,
        targetDir,
        issuesCount: finalResult.issues.length,
        modelUsed: this.resolveModel('auditModel'),
      });
      return finalResult;
    } catch {
      this.logger.warn(`Failed to parse audit output at ${outputPath}, returning empty result`);
      const r = emptyResult();
      r.verdict.reasoning = 'Failed to parse audit output';
      this.publishCompleted(PIPELINE_EVENT_TYPES.AUDIT_COMPLETED, {
        category,
        targetDir,
        issuesCount: 0,
        modelUsed: this.resolveModel('auditModel'),
      });
      return r;
    }
  }

  /**
   * Analyze a GitHub Issue against the codebase and generate an Implementation Plan.
   *
   * @param issueNumber - Issue number being analyzed.
   * @param issueContextMarkdown - Issue details (Title, body, labels, comments).
   * @param timeoutMinutes - Execution timeout in minutes.
   * @param workingDirectory - Optional working directory (tempDir).
   * @returns Markdown content of the generated implementation plan.
   */
  async runAnalyze(
    issueNumber: number,
    issueContextMarkdown: string,
    timeoutMinutes?: number,
    workingDirectory?: string,
  ): Promise<string> {
    // Reset telemetry so the reported usage reflects only this analysis invocation.
    this.telemetry = null;
    this.publishEvent(PIPELINE_EVENT_TYPES.ANALYZE_STARTED, {
      issueNumber,
      modelUsed: this.resolveModel('analysisModel'),
    });
    const workDir = workingDirectory || process.cwd();
    const planPath = path.join(workDir, '.opencode', 'analysis-plan.md');
    ensureOutputDir(planPath);

    const prompt = buildAnalyzePrompt(
      { projectContext: this.config.projectContext.description || undefined },
      issueContextMarkdown,
    );

    const runResult = await this.runLLM(prompt, {
      model: this.resolveModel('analysisModel'),
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
    });
    await this.recordTelemetry(
      issueNumber,
      runResult.durationMs,
      runResult.tokensUsed,
      runResult,
      this.resolveModel('analysisModel'),
      workDir,
    );

    if (!runResult.success) {
      this.logger.warn('OpenCode analyze execution failed or timed out.');
      this.publishCompleted(PIPELINE_EVENT_TYPES.ANALYZE_COMPLETED, {
        issueNumber,
        modelUsed: this.resolveModel('analysisModel'),
      });
      return '⚠️ **Analysis Failed**: OpenCode CLI was unable to complete the codebase analysis.';
    }

    try {
      const planMarkdown = await fs.readFile(planPath, 'utf-8');
      await fs.unlink(planPath).catch(() => {});
      this.publishCompleted(PIPELINE_EVENT_TYPES.ANALYZE_COMPLETED, {
        issueNumber,
        modelUsed: this.resolveModel('analysisModel'),
      });
      return planMarkdown.trim();
    } catch (err) {
      if (runResult.output && runResult.output.trim().length > 0) {
        this.publishCompleted(PIPELINE_EVENT_TYPES.ANALYZE_COMPLETED, {
          issueNumber,
          modelUsed: this.resolveModel('analysisModel'),
        });
        return runResult.output.trim();
      }
      this.logger.warn(`Could not read analysis plan from ${planPath}: ${String(err)}`);
      this.publishCompleted(PIPELINE_EVENT_TYPES.ANALYZE_COMPLETED, {
        issueNumber,
        modelUsed: this.resolveModel('analysisModel'),
      });
      return '⚠️ **Analysis Error**: Could not read generated `.opencode/analysis-plan.md` file.';
    }
  }

  /**
   * Run the self-heal workflow to diagnose and fix a CI failure.
   * Builds a diagnosis prompt from CI failure logs, runs OpenCode CLI to apply fixes,
   * and reads the diagnosis report and git status from disk.
   *
   * @param ciFailureLogs - The CI failure output/logs.
   * @param failedStep - Name of the CI step that failed.
   * @param failedWorkflow - Name of the workflow that failed.
   * @param timeoutMinutes - Optional timeout override.
   * @param previousAttemptError - Optional error from a previous heal attempt for retry.
   * @param workingDirectory - Optional working directory.
   * @returns SelfHealResult with diagnosis and change information.
   */
  async runSelfHeal(
    ciFailureLogs: string,
    failedStep?: string,
    failedWorkflow?: string,
    timeoutMinutes?: number,
    previousAttemptError?: string,
    workingDirectory?: string,
  ): Promise<SelfHealResult> {
    // Reset telemetry so the reported usage reflects only this heal invocation.
    this.telemetry = null;
    const prompt = buildSelfHealPrompt(
      {
        projectContext: this.config.projectContext.description || undefined,
        maxRetries: 3,
      },
      ciFailureLogs,
      failedStep,
      failedWorkflow,
      previousAttemptError,
    );

    const workDir = workingDirectory || process.cwd();
    const diagnosisPath = path.join(workDir, '.opencode', 'heal-diagnosis.md');
    ensureOutputDir(diagnosisPath);

    const runResult = await this.runLLM(prompt, {
      model: this.config.fixModel,
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
    });
    await this.recordTelemetry(
      0,
      runResult.durationMs,
      runResult.tokensUsed,
      runResult,
      this.config.fixModel,
      workDir,
    );

    if (!runResult.success) {
      this.logger.warn(
        'OpenCode self-heal execution failed or timed out. Checking for partial changes...',
      );
      await new Promise((r) => setTimeout(r, 500));
    }

    let changesMade = false;
    let filesChanged: string[] = [];
    let diagnosis: string | undefined;
    let diagnosticReport: string | undefined;
    let summary: string | undefined;

    try {
      const status = getGitStatus(workDir);
      changesMade = status.trim().length > 0;

      // Read diagnosis report
      try {
        diagnosticReport = await fs.readFile(diagnosisPath, 'utf-8');
        // Extract the failure classification from the report
        const classMatch = diagnosticReport.match(/## Failure Classification\s*\n+([^\n#]+)/i);
        if (classMatch) {
          diagnosis = classMatch[1].trim().toLowerCase();
        }
        await fs.unlink(diagnosisPath).catch(() => {});
      } catch {
        this.logger.debug('No heal-diagnosis.md found — proceeding without diagnosis');
      }

      // Read fix summary if present
      try {
        summary = await fs.readFile(path.join(workDir, '.fix-summary.md'), 'utf-8');
        await fs.unlink(path.join(workDir, '.fix-summary.md')).catch(() => {});
      } catch {
        // Use diagnostic report as summary if no fix-summary
        if (diagnosticReport) {
          summary = diagnosticReport;
        }
      }

      if (changesMade) {
        try {
          const raw = cp
            .execFileSync('git', ['diff', '--name-only', 'HEAD'], {
              encoding: 'utf-8',
              cwd: workDir,
            })
            .toString()
            .trim();
          filesChanged = raw ? raw.split('\n') : [];
        } catch {
          this.logger.warn('Could not get git diff to determine changed files');
        }
      }
    } catch (err) {
      this.logger.warn(
        `Error reading self-heal results: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { changesMade, filesChanged, diagnosis, diagnosticReport, summary };
  }

  /**
   * Explain a PR in plain English for the team.
   *
   * @param pr - The PR context object.
   * @param workingDirectory - Optional working directory (tempDir).
   * @param timeoutMinutes - Optional timeout override.
   * @returns Markdown content of the PR explanation.
   */
  async runExplain(
    pr: PRContext,
    workingDirectory?: string,
    timeoutMinutes?: number,
  ): Promise<string> {
    // Reset telemetry so the reported usage reflects only this explanation invocation.
    this.telemetry = null;
    this.publishEvent(PIPELINE_EVENT_TYPES.EXPLAIN_STARTED, {
      prNumber: pr.number,
      modelUsed: this.resolveModel('explanationModel'),
    });
    const workDir = workingDirectory || process.cwd();
    const outputPath = path.join(workDir, '.opencode', 'explain-output.md');
    ensureOutputDir(outputPath);

    const { context: prContext } = this.buildPRContextString(pr);
    const prompt = buildExplainPrompt(
      { projectContext: this.config.projectContext.description || undefined },
      prContext,
    );

    const runResult = await this.runLLM(prompt, {
      model: this.resolveModel('explanationModel'),
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
    });
    await this.recordTelemetry(
      pr.number,
      runResult.durationMs,
      runResult.tokensUsed,
      runResult,
      this.resolveModel('explanationModel'),
      workDir,
    );

    if (!runResult.success) {
      this.publishCompleted(PIPELINE_EVENT_TYPES.EXPLAIN_COMPLETED, {
        prNumber: pr.number,
        modelUsed: this.resolveModel('explanationModel'),
      });
      return '⚠️ **Explanation Failed**: OpenCode CLI was unable to generate the PR explanation.';
    }

    try {
      const content = await fs.readFile(outputPath, 'utf-8');
      this.publishCompleted(PIPELINE_EVENT_TYPES.EXPLAIN_COMPLETED, {
        prNumber: pr.number,
        modelUsed: this.resolveModel('explanationModel'),
      });
      return content.trim();
    } catch {
      this.publishCompleted(PIPELINE_EVENT_TYPES.EXPLAIN_COMPLETED, {
        prNumber: pr.number,
        modelUsed: this.resolveModel('explanationModel'),
      });
      return '⚠️ **Explanation Failed**: Could not read explanation from `.opencode/explain-output.md`.';
    }
  }

  /**
   * Run the documentation-generation workflow for a PR.
   * Builds a docs prompt from the PR context, runs OpenCode CLI to add
   * documentation comments to changed code, and detects changes on disk.
   *
   * @param pr - The PR context object.
   * @param contextMarkdown - PR context as markdown string (description, comments, diffs).
   * @param workingDirectory - Optional working directory for cloned repo (tempDir).
   * @param timeoutMinutes - Optional timeout override (defaults to config.timeoutMinutes).
   * @param docStyle - Optional doc style override (defaults to config.docs?.style or 'auto').
   * @returns FixResult indicating whether documentation changes were made.
   */
  async runDocs(
    pr: PRContext,
    contextMarkdown: string,
    workingDirectory?: string,
    timeoutMinutes?: number,
    docStyle?: DocStyle,
  ): Promise<FixResult> {
    // Enforce the docs.enabled flag here so every caller (Action docs mode and
    // the App /docs handler) is blocked before resetting telemetry, publishing
    // DOCS_STARTED, or invoking the model when documentation is disabled.
    if (this.config.docs?.enabled === false) {
      this.logger.info('Docs generation is disabled (docs.enabled: false) — skipping');
      return { changesMade: false, filesChanged: [], summary: undefined };
    }
    // Reset telemetry so the reported usage reflects only this docs invocation.
    this.telemetry = null;
    const effectiveDocStyle = docStyle ?? this.config.docs?.style ?? 'auto';
    this.publishEvent(PIPELINE_EVENT_TYPES.DOCS_STARTED, {
      prNumber: pr.number,
      docStyle: effectiveDocStyle,
      modelUsed: this.resolveModel('docsModel'),
    });

    // Enrich the gathered context with the PR diff so the agent can identify
    // exactly which functions/methods/classes were changed.
    let docsContext = contextMarkdown;
    try {
      const { context: prDiffContext } = this.buildPRContextString(pr);
      if (prDiffContext.trim().length > 0) {
        docsContext = `${contextMarkdown}\n\n## PR Diff & Changed Files\n\n${prDiffContext}`;
      }
    } catch (err) {
      this.logger.warn(
        `Could not build PR context for docs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const prompt = buildDocsPrompt(
      { projectContext: this.config.projectContext.description || undefined },
      docsContext,
      effectiveDocStyle,
    );

    // runOpenCode reports timeouts and mid-run failures as `success: false`
    // rather than throwing, so retrying is idempotency-safe: withRetry only
    // re-invokes on thrown (pre-spawn) failures such as a transient binary
    // download or health probe, never after a run that may have left partial
    // documentation changes on disk.
    const runResult = await withRetry(
      () =>
        this.runLLM(prompt, {
          model: this.resolveModel('docsModel'),
          timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
          workingDirectory,
        }),
      { operationName: 'docs' },
    );
    await this.recordTelemetry(
      pr.number,
      runResult.durationMs,
      runResult.tokensUsed,
      runResult,
      this.resolveModel('docsModel'),
      workingDirectory,
    );
    if (!runResult.success) {
      this.logger.warn(
        'OpenCode docs execution failed or timed out. Checking for partial changes on disk...',
      );
      // Give filesystem time to flush writes from the killed process
      await new Promise((r) => setTimeout(r, 500));
    }

    const workDir = workingDirectory || process.cwd();

    let changesMade = false;
    let filesChanged: string[] = [];
    let summary: string | undefined;

    try {
      // Consume the summary marker file before inspecting git status so a
      // workspace where the agent only wrote `.docs-summary.md` (no real doc
      // changes) does not register as a documentation change and trigger a
      // commit with nothing but the summary file.
      try {
        summary = await fs.readFile(path.join(workDir, '.docs-summary.md'), 'utf-8');
        await fs.unlink(path.join(workDir, '.docs-summary.md'));
      } catch {
        this.logger.debug('No .docs-summary.md — proceeding normally');
      }

      const status = getGitStatus(workDir);
      changesMade = status.trim().length > 0;

      if (changesMade) {
        try {
          const raw = cp
            .execFileSync('git', ['diff', '--name-only', 'HEAD'], {
              encoding: 'utf-8',
              cwd: workDir,
            })
            .toString()
            .trim();
          filesChanged = raw ? raw.split('\n') : [];
        } catch {
          this.logger.warn('Could not get git diff to determine changed files');
        }
      }
    } catch (err) {
      this.logger.warn(
        `Error reading docs results after OpenCode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const docsResult = { changesMade, filesChanged, summary };
    this.publishCompleted(PIPELINE_EVENT_TYPES.DOCS_COMPLETED, {
      prNumber: pr.number,
      changesMade,
      filesChanged,
      docStyle: effectiveDocStyle,
      modelUsed: this.resolveModel('docsModel'),
    });
    return docsResult;
  }

  /**
   * Read a file from disk and run secret detection on it, skipping binary
   * content (NUL-byte probe on the first 8KB) and capping the scanned size.
   *
   * @param fullPath - Absolute path of the file to scan.
   * @param options - Tuning options forwarded to {@link detectSecrets}.
   * @returns Findings, or `[]` for empty/binary/missing content.
   */
  private async detectSecretsFromFile(
    fullPath: string,
    options: SecretDetectOptions,
  ): Promise<SecretFinding[]> {
    const buffer = await fs.readFile(fullPath);
    if (buffer.length === 0) return [];
    if (buffer.subarray(0, 8192).includes(0)) return [];
    return detectSecrets(buffer.subarray(0, MAX_SECRET_SCAN_BYTES).toString('utf-8'), options);
  }

  /**
   * Scan the given changed files for hardcoded secrets and return blocking
   * review issues. Files matched by `secrets.excludePatterns` are skipped, and
   * missing files (e.g. deleted or not checked out) degrade gracefully. This is
   * a best-effort static pass — per-file failures never abort the scan.
   *
   * @param files - Changed files (already filtered by review exclude patterns).
   * @param workDir - Working directory the files are checked out under.
   * @returns Review issues for any detected secrets (empty when none).
   */
  private async scanFilesForSecrets(
    files: PRContext['changedFiles'],
    workDir: string,
  ): Promise<ReviewIssue[]> {
    const secretConfig = this.config.secrets ?? DEFAULT_SECRET_DETECTOR_CONFIG;
    const options: SecretDetectOptions = {
      minEntropy: secretConfig.entropyThreshold,
      minLength: secretConfig.minLength,
      allowlist: secretConfig.allowlist,
    };
    const excludePatterns = secretConfig.excludePatterns ?? [];
    const issues: ReviewIssue[] = [];
    for (const file of files) {
      if (!file?.path) continue;
      if (excludePatterns.some((pattern) => minimatch(file.path, pattern))) continue;
      try {
        const findings = await this.detectSecretsFromFile(path.join(workDir, file.path), options);
        if (findings.length > 0) {
          issues.push(...mergeSecretFindings(file.path, findings));
        }
      } catch (err) {
        this.logger.warn(
          `Secret scan skipped for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return issues;
  }

  /**
   * Recursively walk a directory tree, scanning each text file for hardcoded
   * secrets. Honors the review `excludePatterns` plus `secrets.excludePatterns`,
   * skips common VCS/dependency directories and binary files, and caps each
   * scanned file's size. Best-effort — walk errors degrade gracefully.
   *
   * @param targetDir - Directory to walk (repo-relative or absolute).
   * @param workingDirectory - Repo working directory (defaults to cwd).
   * @returns Review issues for any detected secrets (empty when none).
   */
  private async scanDirectoryForSecrets(
    targetDir: string,
    workingDirectory?: string,
  ): Promise<ReviewIssue[]> {
    const secretConfig = this.config.secrets ?? DEFAULT_SECRET_DETECTOR_CONFIG;
    const options: SecretDetectOptions = {
      minEntropy: secretConfig.entropyThreshold,
      minLength: secretConfig.minLength,
      allowlist: secretConfig.allowlist,
    };
    const repoRoot = workingDirectory || process.cwd();
    const root = path.resolve(repoRoot, targetDir || '.');
    const excludePatterns = [
      ...(this.config.review.excludePatterns ?? []),
      ...(secretConfig.excludePatterns ?? []),
    ];
    const issues: ReviewIssue[] = [];
    const queue: string[] = [root];
    while (queue.length > 0) {
      const dir = queue.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name === '.git' ||
            entry.name === 'node_modules' ||
            entry.name === '.opencode'
          ) {
            continue;
          }
          queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(repoRoot, full);
        if (excludePatterns.some((pattern) => minimatch(rel, pattern))) continue;
        try {
          const findings = await this.detectSecretsFromFile(full, options);
          if (findings.length > 0) {
            issues.push(...mergeSecretFindings(rel, findings));
          }
        } catch (err) {
          this.logger.warn(
            `Secret scan skipped for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return issues;
  }

  /**
   * Merge hardcoded-secret issues into a result, recomputing severity stats so
   * the severity-based CI gate and count outputs reflect the secrets.
   *
   * @param result - Result to merge into.
   * @param secretIssues - Secret review issues to append.
   * @returns The merged result (unchanged when `secretIssues` is empty).
   */
  private mergeSecretIssues(result: ReviewResult, secretIssues: ReviewIssue[]): ReviewResult {
    if (secretIssues.length === 0) return result;
    const allIssues = [...result.issues, ...secretIssues];
    return { ...result, issues: allIssues, stats: computeReviewStats(allIssues) };
  }

  /**
   * Merge Software Composition Analysis (SCA) issues into a result, recomputing
   * severity stats so the severity-based CI gate and count outputs reflect the
   * vulnerable dependency findings. Mirrors {@link mergeSecretIssues}.
   *
   * @param result - Result to merge into.
   * @param scaIssues - SCA review issues to append.
   * @returns The merged result (unchanged when `scaIssues` is empty).
   */
  private mergeScaIssues(result: ReviewResult, scaIssues: ReviewIssue[]): ReviewResult {
    if (scaIssues.length === 0) return result;
    const allIssues = [...result.issues, ...scaIssues];
    return {
      ...result,
      issues: allIssues,
      stats: computeReviewStats(allIssues),
      // A vulnerable dependency is a blocking finding: the result is never
      // "ready to merge" while SCA issues are present, even when the LLM pass
      // otherwise returned a clean verdict.
      verdict: { ...result.verdict, ready: false },
    };
  }

  /**
   * Apply the sensitivity filter to a review result, dropping findings that
   * fall below the configured severity, confidence, or count thresholds.
   *
   * @param result - Review result containing candidate issues.
   * @param defaultCategory - Default category assigned to findings without one.
   * @param extraMinSeverityRank - Optional extra minimum severity rank applied on top of the configured floor.
   * @returns ReviewResult with the filtered issues and recomputed stats.
   */
  private applySensitivityFilter(
    result: ReviewResult,
    defaultCategory = 'general',
    extraMinSeverityRank?: number,
  ): ReviewResult {
    const sensitivity = this.config.review.sensitivity ?? {};
    const { issues, dropped } = filterFindings(result.issues, {
      minSeverity: sensitivity.minSeverity,
      minSeverityRankValue: extraMinSeverityRank,
      confidenceThreshold: sensitivity.confidenceThreshold,
      maxFindingsPerCategory: sensitivity.maxFindingsPerCategory,
      maxTotalFindings: sensitivity.maxTotalFindings,
      focusAreas: sensitivity.focusAreas,
      ignorePatterns: sensitivity.ignorePatterns,
      categories: this.config.review.categories,
      defaultCategory,
    });
    if (dropped > 0) {
      this.logger.info(`Sensitivity filter dropped ${dropped} finding(s) (kept ${issues.length})`);
    }
    // Always apply the filter output so `category` normalization and severity
    // ordering are consistent regardless of whether any finding was dropped.
    return {
      ...result,
      issues,
      stats: computeReviewStats(issues),
    };
  }

  private async verifyReviewResult(
    result: ReviewResult,
    prContext: string,
    workDir: string,
    timeoutMinutes?: number,
    prNumber?: number,
    budgetMode?: ReviewBudgetMode,
    totalDiffLines?: number,
    files?: PRContext['changedFiles'],
    scaIssues?: ReviewIssue[],
  ): Promise<ReviewResult> {
    let enrichedResult = result;

    // Lightweight reachability analysis — tag findings with theoreticalRisk and entryPointPath
    if (this.config.review.enableReachability && result.issues.length > 0) {
      try {
        const reachabilityResults = await analyzeBatchReachability(result.issues, workDir);
        const enrichedIssues = result.issues.map((issue, idx) => {
          const r = reachabilityResults[idx];
          if (!r) return issue;
          let severity = issue.severity;
          // Downgrade theoretical-risk findings
          if (
            r.theoreticalRisk &&
            (issue.severity === 'critical' || issue.severity === 'important')
          ) {
            severity = 'minor';
          }
          return {
            ...issue,
            theoreticalRisk: r.theoreticalRisk || undefined,
            entryPointPath: r.entryPointPath,
            entryPointFile: r.entryPointFile,
            severity,
          };
        });

        const theoreticalCount = enrichedIssues.filter((i) => i.theoreticalRisk).length;
        if (theoreticalCount > 0) {
          this.logger.info(
            `Reachability analysis: ${theoreticalCount} finding(s) tagged as theoretical risk (not reachable from user input)`,
          );
        }

        enrichedResult = {
          ...result,
          issues: enrichedIssues,
          stats: {
            total: enrichedIssues.length,
            critical: enrichedIssues.filter((i) => i.severity === 'critical').length,
            important: enrichedIssues.filter((i) => i.severity === 'important').length,
            minor: enrichedIssues.filter((i) => i.severity === 'minor').length,
          },
        };
      } catch (err) {
        this.logger.warn(
          `Reachability analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (this.config.review.enableMetaVerification && enrichedResult.issues.length > 0) {
      try {
        const prompt = buildVerificationPrompt(
          { projectContext: this.config.projectContext.description || undefined },
          prContext,
          enrichedResult.issues,
        );

        const runResult = await this.runLLM(prompt, {
          model: this.resolveModel('verificationModel'),
          timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
          workingDirectory: workDir,
        });
        if (prNumber) {
          await this.recordTelemetry(
            prNumber,
            runResult.durationMs,
            runResult.tokensUsed,
            runResult,
            this.resolveModel('verificationModel'),
            workDir,
          );
        }

        if (runResult.success) {
          const outputPath = path.join(workDir, '.opencode', 'verification-output.jsonl');
          if (!existsSync(outputPath)) {
            this.logger.warn('Meta-verification output file not found, retaining enriched result');
          } else {
            const content = await fs.readFile(outputPath, 'utf-8');
            const lines = content.split('\n').filter((l) => l.trim());

            const validIndices = new Set<number>();
            let parsedCount = 0;
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line.trim());
                if (
                  parsed.type === 'verification' &&
                  typeof parsed.issueIndex === 'number' &&
                  Number.isInteger(parsed.issueIndex) &&
                  parsed.issueIndex >= 0 &&
                  parsed.issueIndex < enrichedResult.issues.length
                ) {
                  parsedCount++;
                  if (parsed.valid === true) {
                    validIndices.add(parsed.issueIndex);
                  }
                }
              } catch {
                // ignore malformed verification lines
              }
            }

            if (parsedCount === 0) {
              this.logger.warn(
                'Meta-verification produced no usable verification output, retaining enriched result',
              );
            } else {
              const keptCount = validIndices.size;
              const agreementRate = (keptCount / enrichedResult.issues.length) * 100;
              this.logger.info(
                `Verification agreement rate: ${agreementRate.toFixed(1)}% ` +
                  `(${keptCount}/${enrichedResult.issues.length} issues kept by verification model)`,
              );

              if (validIndices.size > 0) {
                const verifiedIssues = enrichedResult.issues.filter((_, idx) =>
                  validIndices.has(idx),
                );
                const droppedCount = enrichedResult.issues.length - verifiedIssues.length;

                if (droppedCount > 0) {
                  this.logger.info(
                    `Meta-verification dropped ${droppedCount} false-positive finding(s) (kept ${verifiedIssues.length})`,
                  );
                }

                const counts = verifiedIssues.reduce(
                  (acc, i) => {
                    if (i.severity === 'critical') acc.critical++;
                    else if (i.severity === 'important') acc.important++;
                    else if (i.severity === 'minor') acc.minor++;
                    return acc;
                  },
                  { critical: 0, important: 0, minor: 0 },
                );

                enrichedResult = {
                  ...enrichedResult,
                  issues: verifiedIssues,
                  stats: {
                    total: verifiedIssues.length,
                    critical: counts.critical,
                    important: counts.important,
                    minor: counts.minor,
                  },
                };
              } else {
                this.logger.info(
                  'Meta-verification produced no valid verification entries — retaining enriched result',
                );
              }
            }
          }
        } else {
          this.logger.warn('Meta-verification pass failed, returning enriched result');
        }
      } catch (err) {
        this.logger.warn(
          `Meta-verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Suppress low-confidence findings if configured
    if (this.config.review.suppressLowConfidence) {
      const beforeCount = enrichedResult.issues.length;
      const filteredIssues = enrichedResult.issues.filter((i) => i.confidence !== 'low');
      if (filteredIssues.length < beforeCount) {
        const droppedLowConfidence = beforeCount - filteredIssues.length;
        this.logger.info(
          `Low-confidence suppression dropped ${droppedLowConfidence} finding(s) (kept ${filteredIssues.length})`,
        );
        const counts = filteredIssues.reduce(
          (acc, i) => {
            if (i.severity === 'critical') acc.critical++;
            else if (i.severity === 'important') acc.important++;
            else if (i.severity === 'minor') acc.minor++;
            return acc;
          },
          { critical: 0, important: 0, minor: 0 },
        );
        enrichedResult = {
          ...enrichedResult,
          issues: filteredIssues,
          stats: {
            total: filteredIssues.length,
            critical: counts.critical,
            important: counts.important,
            minor: counts.minor,
          },
        };
      }
    }

    // Apply per-repository sensitivity filters (severity/confidence floors,
    // focus areas, ignore patterns, finding caps). Runs after verification and
    // low-confidence suppression so the filters see final severities.
    enrichedResult = this.applySensitivityFilter(enrichedResult);

    // Deterministic hardcoded-secret scan. Runs after all LLM-based passes so a
    // secret finding can never be downgraded by reachability, dropped by
    // meta-verification, or filtered by sensitivity settings — it is a verified
    // static finding. Critical issues merge in and drive the severity-based CI
    // gate through the recomputed stats. Best-effort: a scan failure degrades
    // gracefully to the already-processed result.
    if (files && files.length > 0) {
      const secretConfig = this.config.secrets ?? DEFAULT_SECRET_DETECTOR_CONFIG;
      if (secretConfig.enabled) {
        try {
          const secretIssues = await this.scanFilesForSecrets(files, workDir);
          if (secretIssues.length > 0) {
            this.logger.info(
              `Secret detection flagged ${secretIssues.length} hardcoded secret(s) in the changed files`,
            );
            enrichedResult = this.mergeSecretIssues(enrichedResult, secretIssues);
          }
        } catch (err) {
          this.logger.warn(
            `Secret detection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Deterministic SCA findings merge after every LLM-based pass and the
    // sensitivity filter, mirroring the secret scan above, so a known
    // vulnerable dependency can never be downgraded or dropped by reachability,
    // meta-verification, or per-repository sensitivity settings.
    if (scaIssues && scaIssues.length > 0) {
      enrichedResult = this.mergeScaIssues(enrichedResult, scaIssues);
    }

    if (budgetMode && totalDiffLines !== undefined) {
      enrichedResult = this.applyBudgetModeBanner(enrichedResult, budgetMode, totalDiffLines);
    }

    return enrichedResult;
  }

  /**
   * Run an interactive conversation in response to an @mention in a PR comment.
   * Builds a conversation prompt from the provided context and runs it through OpenCode CLI.
   *
   * When a `stateManager` is provided, conversation state is tracked across
   * turns: the thread is auto-closed once it reaches `maxTurns`, and older
   * messages beyond the sliding window are condensed into a summary snapshot so
   * the prompt stays within the configured context budget. Turns on the same
   * thread are serialized with a per-thread lock so concurrent webhooks cannot
   * interleave state transitions.
   *
   * @param context - Full conversation context (thread, file, diff, intent).
   * @param timeoutMinutes - Optional timeout override.
   * @param workingDirectory - Optional working directory for OpenCode execution.
   * @param stateManager - Optional state manager for turn/window/summary tracking.
   * @returns The raw response text for posting as a GitHub comment ('' when the
   * thread is already closed and should be silently skipped).
   */
  async runConversation(
    context: ConversationContext,
    timeoutMinutes?: number,
    workingDirectory?: string,
    stateManager?: ConversationStateManager,
  ): Promise<string> {
    // Reset telemetry so the reported usage reflects only this conversation invocation.
    this.telemetry = null;
    const conversationConfig = normalizeConversationConfig(this.config.conversation);

    const threadId = conversationThreadId(context);
    const state = stateManager?.getOrCreateState(threadId);
    this.publishEvent(PIPELINE_EVENT_TYPES.CONVERSATION_STARTED, {
      prNumber: context.prContext.number,
      threadId,
      modelUsed: this.resolveModel('conversationModel'),
    });

    // Real auto-close reason captured from the decision this turn (e.g.
    // 'max_turns'); stays undefined when the thread was already closed or no
    // close decision fired, so the completed event is not mislabeled.
    let autoCloseReason: string | undefined;

    const runTurn = async (): Promise<string> => {
      // Auto-close check: once the turn limit is reached, answer with the close
      // message directly instead of spending a model call. The message is posted
      // only once — later @mentions on the closed thread return '' so the handler
      // can skip posting a duplicate comment.
      if (state && stateManager) {
        if (state.alreadyClosed) {
          this.logger.info(`Conversation ${threadId} already closed — skipping turn`);
          return '';
        }
        const decision = stateManager.shouldAutoClose(state, conversationConfig);
        if (decision.shouldClose) {
          state.alreadyClosed = true;
          autoCloseReason = decision.reason ?? 'max_turns';
          this.logger.info(
            `Conversation ${threadId} auto-closed (${autoCloseReason}) after ${state.turnCount} turns`,
          );
          return decision.message ?? '';
        }
      }

      const workDir = workingDirectory || process.cwd();
      const outputPath = path.join(workDir, '.opencode', 'conversation-output.txt');
      ensureOutputDir(outputPath);

      const prompt = buildConversationPrompt(context, conversationConfig, state);

      const runResult = await this.runLLM(prompt, {
        model: this.resolveModel('conversationModel'),
        timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
        workingDirectory: workDir,
      });
      await this.recordTelemetry(
        context.prContext.number,
        runResult.durationMs,
        runResult.tokensUsed,
        runResult,
        this.resolveModel('conversationModel'),
        workDir,
      );

      if (!runResult.success) {
        return 'I encountered an error processing your request. Please try again or rephrase your question.';
      }

      // Read the response from the output file before any summarization pass so
      // the secondary summarization run cannot overwrite the main reply.
      let responseText: string;
      try {
        const output = await fs.readFile(outputPath, 'utf-8');
        responseText = output.trim();
      } catch {
        return 'I encountered an error reading the conversation reply from `.opencode/conversation-output.txt`.';
      }

      // A failed/empty generation must not consume a turn or trigger a
      // summarization pass — return before touching the tracked state.
      if (!responseText) {
        return 'I encountered an error generating the conversation response (output was empty).';
      }

      // Sliding-window summarization: when the thread overflows the window and the
      // older chunk has grown, condense the newer older messages synchronously so
      // the next turn sees a summary instead of dropping context.
      if (state && stateManager) {
        const threadLength = context.thread.length;
        try {
          if (stateManager.shouldSummarize(state, threadLength, conversationConfig)) {
            const result = await this.summarizeOlderMessages(
              context,
              state,
              conversationConfig,
              workDir,
              timeoutMinutes,
            );
            if (result.fresh) {
              stateManager.updateState(
                state,
                result.text,
                Math.max(0, threadLength - conversationConfig.slidingWindowSize),
              );
            } else {
              // Summarization failed or produced no fresh snapshot — keep the
              // previous coverage so shouldSummarize re-triggers next turn and
              // the rolled-out messages are not dropped from context.
              stateManager.updateState(state);
            }
          } else {
            stateManager.updateState(state);
          }
        } catch (err) {
          this.logger.warn(
            `Conversation state update failed for ${threadId}: ${err instanceof Error ? err.message : err}`,
          );
          // State bookkeeping must never fail the conversation turn.
          stateManager.updateState(state);
        }
      }

      return responseText;
    };

    // Serialize turns on the same thread so concurrent webhooks cannot drop a
    // turn increment or clobber a summary snapshot.
    const finalizeConversation = async (): Promise<string> => {
      const reply =
        stateManager && state
          ? await stateManager.withThreadLock(threadId, runTurn)
          : await runTurn();
      this.publishCompleted(PIPELINE_EVENT_TYPES.CONVERSATION_COMPLETED, {
        prNumber: context.prContext.number,
        threadId,
        turnCount: state?.turnCount,
        autoCloseReason,
        modelUsed: this.resolveModel('conversationModel'),
      });
      return reply;
    };
    return finalizeConversation();
  }

  /**
   * Generate (or refresh) a condensed summary of the older messages that fell
   * out of the conversation sliding window. Runs synchronously only when
   * `shouldSummarize` fires (the older chunk doubles), so the added latency is
   * a single extra OpenCode run on those turns. Summarization is incremental —
   * only the messages added since the last snapshot are sent, merged into the
   * existing summary — so the summary prompt stays bounded.
   *
   * The summary output file is unlinked before the run so a failed/empty write
   * yields an empty read and the previous snapshot is kept (never reused stale).
   *
   * @param context - Full conversation context.
   * @param state - Tracked conversation state (for previous summary fallback).
   * @param config - Conversation configuration (window size, summarization model).
   * @param workDir - Working directory for the summarization OpenCode run.
   * @param timeoutMinutes - Optional timeout override (defaults to config timeout).
   * @returns The summary text and whether a genuinely fresh snapshot was produced.
   */
  private async summarizeOlderMessages(
    context: ConversationContext,
    state: ConversationState,
    config: ConversationConfig,
    workDir: string,
    timeoutMinutes?: number,
  ): Promise<{ text: string; fresh: boolean }> {
    const splitAt = context.thread.length - config.slidingWindowSize;
    const olderMessages = context.thread.slice(0, Math.max(0, splitAt));
    if (olderMessages.length === 0) {
      return { text: state.summarySnapshot ?? '', fresh: false };
    }

    const summaryPath = path.join(workDir, '.opencode', 'conversation-summary.txt');
    ensureOutputDir(summaryPath);
    // Unlink any stale summary from a previous turn so a run that writes nothing
    // cannot silently reuse old content as a "fresh" snapshot.
    try {
      await fs.unlink(summaryPath);
    } catch {
      // File does not exist yet — nothing to unlink.
    }

    // Only the messages added since the last snapshot need to be merged into
    // the existing summary, bounding the summary prompt to O(window).
    const covered = state.summarizedCount ?? 0;
    const newMessages = olderMessages.slice(covered);

    const summaryPrompt = buildConversationSummaryPrompt(
      newMessages.length > 0 ? newMessages : olderMessages,
      config,
      state.turnCount + 1,
      state.summarySnapshot,
    );

    this.logger.info(
      `Summarizing ${newMessages.length} new older conversation messages (${context.prContext.number})`,
    );
    const runResult = await this.runLLM(summaryPrompt, {
      model: config.summarizationModel ?? this.resolveModel('conversationModel'),
      timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
      workingDirectory: workDir,
      quiet: true,
    });

    await this.recordTelemetry(
      context.prContext.number,
      runResult.durationMs,
      runResult.tokensUsed,
      runResult,
      config.summarizationModel ?? this.resolveModel('conversationModel'),
      workDir,
    );

    if (!runResult.success) {
      this.logger.warn('Conversation summarization run failed — keeping previous summary');
      return { text: state.summarySnapshot ?? '', fresh: false };
    }

    try {
      const summary = (await fs.readFile(summaryPath, 'utf-8')).trim();
      if (summary) return { text: summary, fresh: true };
    } catch {
      this.logger.warn('Failed to read conversation summary output — keeping previous summary');
    }
    return { text: state.summarySnapshot ?? '', fresh: false };
  }

  /**
   * Gracefully shut down MCP connections and learning store.
   * Has a hard timeout of 15 seconds — remaining resources are left to clean up
   * in the background if the deadline is exceeded.
   */
  async cleanup(): Promise<void> {
    const timeoutMs = 15_000;
    const start = Date.now();

    const mcpTask = this.mcp
      .disconnect()
      .catch(() => this.logger.warn('MCP disconnect failed during cleanup'));

    const storeTask = this.learningStore
      ?.close()
      .catch(() => this.logger.warn('LearningStore close failed during cleanup'));

    const tasks = [mcpTask];
    if (storeTask) tasks.push(storeTask);

    const result = await Promise.race([
      Promise.allSettled(tasks).then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);

    if (result === 'timeout') {
      const elapsed = Date.now() - start;
      this.logger.warn(
        `Cleanup did not finish within ${timeoutMs}ms (took ${elapsed}ms) — MCP/learning store may still be shutting down in background`,
      );
    }
  }

  private async recordTelemetry(
    prNumber: number,
    durationMs: number,
    tokensUsed: number,
    breakdown?: { promptTokens?: number; completionTokens?: number },
    model?: string,
    workingDirectory?: string,
  ): Promise<void> {
    const costTracking = this.config.review.costTracking;

    // Accumulate token usage / cost telemetry independently of the learning
    // store so cost exposure works even when the store is unavailable.
    const exposureEnabled = costTracking?.enabled === true && costTracking.verbosity !== 'off';
    const computedCost = exposureEnabled
      ? this.estimateCost(breakdown?.promptTokens, breakdown?.completionTokens, model, tokensUsed)
      : undefined;
    const prev = this.telemetry;
    const hasCost = computedCost !== undefined || prev?.estimatedCost !== undefined;
    // Keep prompt/completion undefined when no breakdown was ever observed so
    // downstream renderers omit those rows instead of showing a misleading 0.
    const hasPrompt = breakdown?.promptTokens !== undefined || prev?.promptTokens !== undefined;
    const hasCompletion =
      breakdown?.completionTokens !== undefined || prev?.completionTokens !== undefined;
    this.telemetry = {
      totalTokens: (prev?.totalTokens ?? 0) + tokensUsed,
      promptTokens: hasPrompt
        ? (prev?.promptTokens ?? 0) + (breakdown?.promptTokens ?? 0)
        : undefined,
      completionTokens: hasCompletion
        ? (prev?.completionTokens ?? 0) + (breakdown?.completionTokens ?? 0)
        : undefined,
      durationMs: (prev?.durationMs ?? 0) + durationMs,
      estimatedCost: hasCost ? (prev?.estimatedCost ?? 0) + (computedCost ?? 0) : undefined,
    };

    if (exposureEnabled) {
      // Write one entry per model call using this call's delta (not the
      // accumulated snapshot) so every JSONL line is independently summable
      // and carries the model that actually produced the tokens.
      await this.writeCostLog(
        prNumber,
        model,
        {
          totalTokens: tokensUsed,
          promptTokens: breakdown?.promptTokens,
          completionTokens: breakdown?.completionTokens,
          durationMs,
          estimatedCost: computedCost,
        },
        workingDirectory,
      );
    }

    // When no event bus is attached there is no TelemetrySubscriber to persist
    // duration/token telemetry, so write the quality row directly to keep
    // /metrics working regardless of wiring. With a bus attached the subscriber
    // handles this write instead (see telemetry-subscriber.ts).
    if (!this.eventBus && this.learningStore) {
      try {
        await this.learningStore.recordQuality({
          prNumber,
          actionabilityScore: 0,
          accuracyScore: 0,
          coverageScore: 0,
          consistencyScore: 0,
          durationMs,
          tokensUsed,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to record telemetry: ${err instanceof Error ? err.message : String(err)}`,
          {
            prNumber,
            durationMs,
            tokensUsed,
            model,
          },
        );
      }
    }
  }

  /**
   * Estimate the USD cost of a run from prompt/completion token counts.
   * Uses config-supplied per-1K rates when available, otherwise falls back to
   * a small known-model table. Returns undefined when no rate applies.
   * @param promptTokens - Prompt (input) tokens, if known.
   * @param completionTokens - Completion (output) tokens, if known.
   * @param model - Model identifier used for the known-model fallback.
   * @param totalTokens - Total tokens, used for a heuristic estimate when the
   * prompt/completion breakdown is unavailable.
   * @returns Estimated cost in USD, or undefined when not computable.
   */
  private estimateCost(
    promptTokens: number | undefined,
    completionTokens: number | undefined,
    model?: string,
    totalTokens?: number,
  ): number | undefined {
    const costTracking = this.config.review.costTracking;
    let inputCost = costTracking?.inputCostPer1K;
    let outputCost = costTracking?.outputCostPer1K;
    if (inputCost === undefined || outputCost === undefined) {
      // Match on the exact last path segment (e.g. "claude-3-5-sonnet" from
      // "anthropic/claude-3-5-sonnet") so provider prefixes, fine-tunes, and
      // proxy identifiers like "org/gpt-4o-finetuned-v2" never match a base
      // model's rate. Whole-segment matching also keeps "gpt-4o-mini" from
      // being priced as "gpt-4o".
      const modelKey = (model ?? '').toLowerCase();
      const lastSegment = modelKey.split('/').pop() ?? modelKey;
      const known = Object.keys(KNOWN_MODEL_RATES).find((key) => lastSegment === key);
      if (known) {
        inputCost = inputCost ?? KNOWN_MODEL_RATES[known].inputCostPer1K;
        outputCost = outputCost ?? KNOWN_MODEL_RATES[known].outputCostPer1K;
      }
    }
    if (inputCost === undefined || outputCost === undefined) return undefined;
    const prompt = promptTokens;
    const completion = completionTokens;
    const pricedTokens = (prompt ?? 0) + (completion ?? 0);
    // When totalTokens exceeds the priced prompt+completion sum, the CLI
    // reported a total but only one (or neither) side of the breakdown parsed.
    const remainder =
      totalTokens !== undefined && totalTokens > pricedTokens ? totalTokens - pricedTokens : 0;
    if (prompt !== undefined && completion !== undefined) {
      if (prompt === 0 && completion === 0) {
        // Both sides parsed as zero but a total was reported — fall through to
        // the total-as-input heuristic below.
        if (totalTokens !== undefined && totalTokens > 0) {
          return (totalTokens / 1000) * inputCost;
        }
        return undefined;
      }
      return (prompt / 1000) * inputCost + (completion / 1000) * outputCost;
    }
    // Only one side of the breakdown parsed — price the uncovered remainder at
    // the known side's rate so partial parsing does not silently drop tokens.
    if (completion !== undefined) {
      return ((completion + remainder) / 1000) * outputCost;
    }
    if (prompt !== undefined) {
      return ((prompt + remainder) / 1000) * inputCost;
    }
    // No prompt/completion breakdown was parsed (e.g. OpenAI-style output that
    // only reports total_tokens). Fall back to a documented heuristic: price
    // the full total as input tokens. This is conservative (input rates are
    // typically lower) and never yields a misleading $0.0000.
    if (totalTokens !== undefined && totalTokens > 0) {
      return (totalTokens / 1000) * inputCost;
    }
    return undefined;
  }

  /**
   * Append a structured JSONL entry to `.opencode/review-costs.jsonl` for
   * external aggregation and dashboarding. Each entry records ONE pipeline
   * stage's token delta (not the running cumulative total), so consumers can
   * sum `totalTokens` across lines without double-counting. A stage is a single
   * model call for single-batch/verification runs, or one aggregated entry for
   * the multi-batch review loop. For the aggregated batch entry, `durationMs`
   * is end-to-end wall-clock (including output parsing and inter-chunk
   * backoff), so it is not directly comparable to single-call entries.
   * Non-critical — failures are logged and swallowed so telemetry never breaks
   * the pipeline.
   * @param prNumber - PR (or issue) number associated with the run.
   * @param model - Model identifier used for the run.
   * @param telemetry - Per-call token usage data to log.
   * @param workingDirectory - Directory the run was executed in (the log is
   * co-located with the review output it describes). Defaults to cwd.
   */
  private async writeCostLog(
    prNumber: number,
    model: string | undefined,
    telemetry: TokenUsage,
    workingDirectory?: string,
  ): Promise<void> {
    try {
      const outputPath = path.join(
        workingDirectory || process.cwd(),
        '.opencode',
        'review-costs.jsonl',
      );
      ensureOutputDir(outputPath);
      const entry = {
        prNumber,
        timestamp: new Date().toISOString(),
        totalTokens: telemetry.totalTokens,
        promptTokens: telemetry.promptTokens,
        completionTokens: telemetry.completionTokens,
        durationMs: telemetry.durationMs,
        estimatedCost: telemetry.estimatedCost,
        model,
      };
      await fs.appendFile(outputPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      this.logger.warn('Failed to write review-costs.jsonl', err);
    }
  }

  /**
   * Attach accumulated token usage to a review result when cost tracking is
   * enabled. The verbosity level controls how much detail is exposed:
   * 'summary' keeps totals only, 'detailed' includes the prompt/completion
   * breakdown and estimated cost. Returns the result unchanged otherwise.
   * @param result - Review result to decorate.
   * @returns The result with an optional usage section.
   */
  private attachUsage(result: ReviewResult): ReviewResult {
    const costTracking = this.config.review.costTracking;
    if (!costTracking?.enabled || costTracking.verbosity === 'off') return result;
    const telemetry = this.getLastTelemetry();
    if (!telemetry) return result;
    // Nothing meaningful was measured (no tokens parsed and no cost computed) —
    // don't surface a misleading zero-token usage section.
    if (telemetry.totalTokens === 0 && telemetry.estimatedCost === undefined) return result;
    if (costTracking.verbosity === 'summary') {
      return {
        ...result,
        usage: {
          totalTokens: telemetry.totalTokens,
          durationMs: telemetry.durationMs,
          estimatedCost: telemetry.estimatedCost,
        },
      };
    }
    return { ...result, usage: telemetry };
  }

  private async getRelevantLessons(filePaths: string[]): Promise<string[]> {
    const now = Date.now();
    const key = [...new Set(filePaths)].sort().join(',');
    if (
      this.lessonsCache &&
      this.lessonsCache.filePaths === key &&
      now - this.lessonsCache.timestamp < ReviewEngine.LESSONS_CACHE_TTL
    ) {
      return this.lessonsCache.lessons;
    }
    if (!this.learningStore) return [];
    const lessons = await this.learningStore.getRelevantLessons(filePaths);
    this.lessonsCache = { lessons, filePaths: key, timestamp: now };
    return lessons;
  }

  private async getCachedMcpDocs(libraries: string[]): Promise<string> {
    const now = Date.now();
    const key = [...new Set(libraries)].sort().join(',');
    if (
      this.mcpDocsCache &&
      this.mcpDocsCache.libraries === key &&
      now - this.mcpDocsCache.timestamp < ReviewEngine.MCP_DOCS_CACHE_TTL
    ) {
      return this.mcpDocsCache.docs;
    }
    const docs = await this.mcp.getLibraryDocs(libraries);
    this.mcpDocsCache = { docs, libraries: key, timestamp: now };
    return docs;
  }

  /**
   * Run configured linters against changed files.
   * @param changedFiles - Array of changed file paths.
   * @param workDir - Working directory for running linters.
   * @returns Array of linter results.
   */
  private runLinters(changedFiles: Array<{ path: string }>, workDir: string): LinterResult[] {
    if (!this.config.linters?.length) return [];

    const results: LinterResult[] = [];

    for (const linterConfig of this.config.linters) {
      try {
        const matchedFiles = changedFiles
          .map((f) => f.path)
          .filter((p): p is string => typeof p === 'string' && Boolean(p))
          .filter((p) => minimatch(p, linterConfig.pattern));

        if (matchedFiles.length === 0) continue;

        const linterDir = linterConfig.workingDirectory
          ? path.resolve(workDir, linterConfig.workingDirectory)
          : workDir;

        const args = [...(linterConfig.args || []), ...matchedFiles];
        const start = Date.now();

        const {
          stdout,
          stderr,
          status,
          error: spawnError,
        } = cp.spawnSync(linterConfig.command, args, {
          cwd: linterDir,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024,
          timeout: linterConfig.timeout ?? 60_000,
        });

        const duration = Date.now() - start;

        const result: LinterResult = {
          tool: linterConfig.command.split('/').pop() || linterConfig.command,
          command: `${linterConfig.command} ${args.join(' ')}`,
          exitCode: status ?? -1,
          stdout: stdout || '',
          stderr: stderr || '',
          findings:
            status !== null
              ? this.parseLinterOutput(linterConfig.parseFormat || 'generic', stdout || '')
              : [],
          success: status !== null && (status ?? 0) <= 1,
        };

        if (spawnError) {
          this.logger.debug(`Linter "${result.tool}" spawn error: ${spawnError.message}`);
        }
        if (stderr) {
          const truncated = stderr.length > 500 ? stderr.slice(0, 500) + '...' : stderr;
          this.logger.debug(`Linter "${result.tool}" stderr: ${truncated}`);
        }

        this.logger.info(
          `Linter "${result.tool}" finished in ${duration}ms with exit code ${status} (${result.findings.length} findings)`,
        );

        results.push(result);
      } catch (err) {
        this.logger.warn(
          `Linter "${linterConfig.command}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return results;
  }

  /**
   * Parse linter stdout into structured findings.
   * @param format - Linter output format (e.g. 'ruff', 'eslint').
   * @param output - Raw linter stdout.
   * @returns Array of parsed linter findings.
   */
  private parseLinterOutput(format: string, output: string): LinterFinding[] {
    if (!output.trim()) return [];

    if (format === 'ruff') {
      try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) {
          return parsed.flatMap((entry: Record<string, unknown>) => {
            const file = String(entry.filename || '');
            const loc =
              entry.location != null
                ? (entry.location as { row?: number; column?: number })
                : undefined;
            const cell = entry.cell != null ? (entry.cell as { row?: number }) : undefined;
            const line = loc?.row ?? cell?.row ?? 0;
            if (line <= 0) return [];
            const code = String(entry.code || '');
            const sev = entry.severity ? String(entry.severity) : mapRuffSeverity(code);
            return {
              file,
              line,
              column: loc != null ? loc.column : undefined,
              severity: sev,
              ruleId: code || undefined,
              message: String(entry.message || ''),
              raw: JSON.stringify(entry),
            };
          });
        }
      } catch {
        // fall through to generic parser
      }
    } else if (format === 'eslint') {
      try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) {
          return parsed.flatMap((entry: Record<string, unknown>) => {
            const filePath = String(entry.filePath || '');
            const rawMessages = entry.messages as unknown;
            const messages = Array.isArray(rawMessages) ? rawMessages : [entry];
            return (messages as Array<Record<string, unknown>>)
              .map((msg) => {
                const line = Number(msg.line) || 0;
                if (line <= 0) return null;
                const sev =
                  msg.severity === 2
                    ? 'error'
                    : msg.severity === 1
                      ? 'warning'
                      : String(msg.severity || 'warning');
                const col = Number(msg.column) || undefined;
                const result: LinterFinding = {
                  file: filePath,
                  line,
                  severity: sev,
                  ruleId: String(msg.ruleId || msg.code || '') || undefined,
                  message: String(msg.message || ''),
                  raw: JSON.stringify(msg),
                };
                if (col !== undefined) result.column = col;
                return result;
              })
              .filter((f): f is LinterFinding => f !== null);
          });
        }
      } catch {
        // fall through to generic parser
      }
    }

    const findings: LinterFinding[] = [];
    const GENERIC_RE = /^([^:]+):(\d+):(\d+):\s*(error|warning|info|note|help)?:?\s*(.*)$/m;
    for (const line of output.split('\n')) {
      const match = line.match(GENERIC_RE);
      if (match) {
        const lineNum = Number.parseInt(match[2], 10) || 0;
        if (lineNum <= 0) continue;
        findings.push({
          file: match[1],
          line: lineNum,
          column: Number.parseInt(match[3], 10) || undefined,
          severity: match[4] || 'warning',
          message: match[5] || '',
          raw: line,
        });
      }
    }

    return findings;
  }

  /**
   * Filter AI-generated findings that duplicate linter findings.
   * @param issues - AI-generated review issues.
   * @param linterResults - Results from configured linters.
   * @param workDir - Optional working directory for path normalization.
   * @returns Filtered review issues with duplicates removed.
   */
  private deduplicateAgainstLinters(
    issues: ReviewIssue[],
    linterResults: LinterResult[],
    workDir?: string,
  ): ReviewIssue[] {
    if (!linterResults.length || !issues.length) return issues;

    const linterFindings: { key: string; message: string }[] = [];
    for (const result of linterResults) {
      for (const finding of result.findings) {
        const normalized = workDir
          ? path.relative(workDir, path.resolve(workDir, finding.file))
          : finding.file;
        linterFindings.push({ key: `${normalized}:${finding.line}`, message: finding.message });
      }
    }

    const filtered = issues.filter((issue) => {
      const normalized = workDir
        ? path.relative(workDir, path.resolve(workDir, issue.file))
        : issue.file;
      const key = `${normalized}:${issue.line}`;
      const match = linterFindings.find((lf) => lf.key === key);
      if (match) {
        const msgOverlap =
          match.message &&
          issue.message.toLowerCase().includes(match.message.toLowerCase().slice(0, 20));
        if (msgOverlap) {
          this.logger.debug(`Suppressing AI finding at ${key} — matches linter output`);
          return false;
        }
      }
      return true;
    });

    const dropped = issues.length - filtered.length;
    if (dropped > 0) {
      this.logger.info(
        `Hybrid analysis suppressed ${dropped} finding(s) that overlap with configured linters`,
      );
    }

    return filtered;
  }

  private buildFallbackResult(
    allIssues: ReviewIssue[],
    allStrengths: ReviewStrength[],
    allRawLines: string[],
    totalFailedLines: number,
    fileBatches: Array<PRContext['changedFiles']>,
    reasoning: string,
    failedBatches = 0,
  ): ReviewResult {
    return {
      summary:
        allIssues.length > 0
          ? `Found ${allIssues.length} issues across ${fileBatches.length} batches`
          : 'No issues found',
      verdict: {
        ready: allIssues.length === 0,
        reasoning,
        autoFixable: false,
        confidence: 'medium' as const,
      },
      strengths: allStrengths,
      issues: allIssues,
      stats: {
        total: allIssues.length,
        critical: allIssues.filter((i) => i.severity === 'critical').length,
        important: allIssues.filter((i) => i.severity === 'important').length,
        minor: allIssues.filter((i) => i.severity === 'minor').length,
      },
      rawLines: allRawLines,
      failedLines: totalFailedLines,
      failedBatches,
    };
  }

  private logTokenSavings(metrics?: TokenBudgetMetrics): void {
    if (!metrics || metrics.baselineLines <= 0) return;
    const savedLines = metrics.baselineLines - metrics.budgetedLines;
    const savedPercent =
      savedLines > 0 ? ((savedLines / metrics.baselineLines) * 100).toFixed(1) : '0.0';
    this.logger.info(
      `Token savings: ~${savedLines} lines (${savedPercent}%) — ${metrics.simpleCount} simple, ${metrics.mediumCount} medium, ${metrics.complexCount} complex`,
    );
  }

  private computeTokenBudgetMetrics(
    files: PRContext['changedFiles'],
    tokenBudgetConfig: TokenBudgetConfig,
    globalMaxLines: number,
  ): TokenBudgetMetrics {
    let totalBaselineLines = 0;
    let totalBudgetedLines = 0;
    let simpleCount = 0;
    let mediumCount = 0;
    let complexCount = 0;

    for (const f of files) {
      if (!f.patch) continue;
      const patchLineCount = f.patch.split('\n').length;
      const baseline =
        globalMaxLines > 0 ? Math.min(patchLineCount, globalMaxLines) : patchLineCount;
      totalBaselineLines += baseline;

      const score = this.computeFileComplexity(f);
      const { effectiveCap, category } = this.computeEffectiveCap(
        score,
        tokenBudgetConfig,
        globalMaxLines,
      );

      if (category === 'simple') simpleCount++;
      else if (category === 'medium') mediumCount++;
      else complexCount++;

      totalBudgetedLines +=
        effectiveCap > 0 ? Math.min(patchLineCount, effectiveCap) : patchLineCount;
    }

    return {
      baselineLines: totalBaselineLines,
      budgetedLines: totalBudgetedLines,
      simpleCount,
      mediumCount,
      complexCount,
    };
  }

  private computeEffectiveCap(
    score: number,
    tokenBudgetConfig: TokenBudgetConfig,
    globalMaxLines: number,
  ): { effectiveCap: number; category: 'simple' | 'medium' | 'complex' } {
    let effectiveCap = globalMaxLines;
    let category: 'simple' | 'medium' | 'complex';

    if (score >= tokenBudgetConfig.complexityThreshold) {
      effectiveCap = Math.min(
        tokenBudgetConfig.maxLinesComplex,
        globalMaxLines > 0 ? globalMaxLines : Number.POSITIVE_INFINITY,
      );
      category = 'complex';
    } else if (score <= tokenBudgetConfig.simpleThreshold) {
      effectiveCap = Math.min(
        tokenBudgetConfig.maxLinesSimple,
        globalMaxLines > 0 ? globalMaxLines : Number.POSITIVE_INFINITY,
      );
      category = 'simple';
    } else {
      const range = tokenBudgetConfig.complexityThreshold - tokenBudgetConfig.simpleThreshold;
      const t = range > 0 ? (score - tokenBudgetConfig.simpleThreshold) / range : 0.5;
      const interpolated = Math.round(
        tokenBudgetConfig.maxLinesSimple +
          t * (tokenBudgetConfig.maxLinesComplex - tokenBudgetConfig.maxLinesSimple),
      );
      effectiveCap = Math.min(
        interpolated,
        globalMaxLines > 0 ? globalMaxLines : Number.POSITIVE_INFINITY,
      );
      category = 'medium';
    }

    return { effectiveCap, category };
  }

  private computeFileComplexity(file: {
    additions: number;
    deletions: number;
    patch?: string;
  }): number {
    if (!file.patch) return 0;

    const diffContentLines = file.patch
      .split('\n')
      .filter((line) => line.startsWith('+') || line.startsWith('-'));
    const diffContent = diffContentLines.join('\n');

    const controlFlowRegex = /\b(if|else if|switch|case|for|while|catch)\b|\?\:|\&\&|\|\||\?\?/g;
    const controlFlowMatches = (diffContent.match(controlFlowRegex) || []).length;

    let maxDepth = 0;
    let currentDepth = 0;
    for (const char of diffContent) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return file.additions * 0.05 + file.deletions * 0.02 + controlFlowMatches * 3 + maxDepth * 2;
  }

  /**
   * Build a markdown context string describing a pull request, its changed
   * files, and their diffs (optionally honoring a token budget). Exposed as a
   * pure computation so performance benchmarks can measure context gathering
   * time in isolation.
   * @param pr - Pull request context with changed files.
   * @param tokenBudgetConfig - Optional token budget configuration for per-file caps.
   * @param skipMetricsTracking - When true, skips collecting budget metrics.
   * @param blameData - Optional git blame annotations keyed by file path, rendered
   * as a per-file `### Git Blame Annotations` block after each diff.
   * @returns The markdown context string and optional token budget metrics.
   */
  buildPRContextString(
    pr: PRContext,
    tokenBudgetConfig?: TokenBudgetConfig,
    skipMetricsTracking = false,
    blameData?: Map<string, Map<number, BlameInfo>>,
  ): { context: string; budgetMetrics?: TokenBudgetMetrics } {
    const parts: string[] = [];
    const maxLines = this.config.maxLinesPerFile;

    let totalBaselineLines = 0;
    let totalBudgetedLines = 0;
    let simpleCount = 0;
    let mediumCount = 0;
    let complexCount = 0;

    parts.push(`## PR #${pr.number}: ${pr.title}`);
    parts.push('');
    const authorStr = pr.author.endsWith('[bot]')
      ? `${pr.author} (automated/bot PR)`
      : `@${pr.author}`;
    parts.push(`**Author:** ${authorStr}`);
    parts.push(`**Branch:** \`${pr.headRef}\` → \`${pr.baseRef}\``);
    if (pr.labels.length > 0) {
      parts.push(`**Labels:** ${pr.labels.join(', ')}`);
    }
    parts.push('');

    if (pr.body) {
      parts.push('### Description');
      parts.push('');
      parts.push(pr.body);
      parts.push('');
    }

    parts.push('### Changed Files');
    parts.push('');
    for (const f of pr.changedFiles) {
      const stats = `${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
      parts.push(`- \`${stats}\``);
    }
    parts.push('');
    const totalDiffLines = pr.changedFiles.reduce(
      (s, f) => s + (f.patch ? f.patch.split('\n').length : 0),
      0,
    );
    if (totalDiffLines > maxLines && maxLines > 0) {
      parts.push(
        `> Total diff: ~${totalDiffLines} lines across ${pr.changedFiles.length} files. For large changes, read each file individually using the \`read\` tool.`,
      );
    }

    parts.push('');
    parts.push('### File Diffs');
    parts.push('');
    for (const f of pr.changedFiles) {
      if (!f.patch) continue;
      const patchLines = f.patch.split('\n');
      const patchLineCount = patchLines.length;

      let effectiveCap = maxLines;
      let complexityScore = 0;
      let budgetSummaryLine = '';

      if (tokenBudgetConfig?.enabled) {
        complexityScore = this.computeFileComplexity(f);
        const { effectiveCap: cap, category } = this.computeEffectiveCap(
          complexityScore,
          tokenBudgetConfig,
          maxLines,
        );
        effectiveCap = cap;

        if (!skipMetricsTracking) {
          if (category === 'simple') simpleCount++;
          else if (category === 'medium') mediumCount++;
          else complexCount++;
        }

        budgetSummaryLine = `> Token budget: ${effectiveCap} lines (complexity score: ${complexityScore.toFixed(1)})`;
      }

      const baselineForFile = maxLines > 0 ? Math.min(patchLineCount, maxLines) : patchLineCount;
      const budgetedForFile =
        effectiveCap > 0 ? Math.min(patchLineCount, effectiveCap) : patchLineCount;
      totalBaselineLines += baselineForFile;
      totalBudgetedLines += budgetedForFile;

      const patchTruncated = effectiveCap > 0 && patchLineCount > effectiveCap;
      if (patchTruncated) {
        const truncated = patchLines.slice(0, effectiveCap).join('\n');
        const remaining = patchLineCount - effectiveCap;
        parts.push(`**${f.path}** (${patchLineCount} lines, showing first ${effectiveCap}):`);
        parts.push('');
        parts.push('```diff');
        parts.push(truncated);
        parts.push('```');
        parts.push(
          `> ... [Patch truncated: ${remaining} remaining lines omitted. Use the 'read' tool to inspect the full file at ${f.path}]`,
        );
      } else {
        parts.push(`**${f.path}** (${patchLineCount} lines):`);
        parts.push('');
        parts.push('```diff');
        parts.push(f.patch);
        parts.push('```');
      }
      if (budgetSummaryLine) {
        parts.push(budgetSummaryLine);
      }
      const fileBlame = blameData?.get(f.path);
      if (fileBlame && fileBlame.size > 0) {
        // Cap annotations to the lines actually shown in the diff so a
        // truncated patch never cites ranges the model cannot see.
        const displayedPatch = patchTruncated ? patchLines.slice(0, effectiveCap).join('\n') : '';
        const { blame: visibleBlame, dropped } = patchTruncated
          ? filterBlameToPatch(fileBlame, displayedPatch)
          : { blame: fileBlame, dropped: 0 };
        const annotations = this.formatBlameAnnotations(visibleBlame);
        if (annotations) {
          parts.push('');
          parts.push('### Git Blame Annotations');
          parts.push(annotations);
          if (dropped > 0) {
            parts.push(
              `> Note: blame annotations for ${dropped} line(s) past the truncated diff are omitted.`,
            );
          }
        }
      }
      parts.push('');
    }

    const result: { context: string; budgetMetrics?: TokenBudgetMetrics } = {
      context: parts.join('\n'),
    };

    if (tokenBudgetConfig?.enabled && !skipMetricsTracking) {
      result.budgetMetrics = {
        baselineLines: totalBaselineLines,
        budgetedLines: totalBudgetedLines,
        simpleCount,
        mediumCount,
        complexCount,
      };
    }

    return result;
  }
}

// ---- Linter helpers ----

/**
 * Escape markdown-significant characters so user-controlled values (e.g. git
 * author names) cannot corrupt rendered bullets or inject markup.
 * @param text - Raw value to escape.
 * @returns The value with markdown-significant characters backslash-escaped.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]|<>]/g, (m) => `\\${m}`);
}

/**
 * Map Ruff rule code prefix to a readable severity string.
 * Ruff codes: F (pyflakes), E (pycodestyle error) → error;
 * W (pycodestyle warning), D (pydocstyle) → warning.
 * @param code - Ruff rule code string.
 * @returns Mapped severity string.
 */
function mapRuffSeverity(code: string): string {
  if (!code) return 'warning';
  const prefix = code[0];
  if (prefix === 'F' || prefix === 'E') return 'error';
  return 'warning';
}

// ---- Manifest-based library detection helpers ----

const PACKAGE_JSON_MAP: Record<string, string> = {
  next: 'next.js',
  react: 'react',
  '@tanstack/react-query': '@tanstack/react-query',
  express: 'express',
  prisma: 'prisma',
  zod: 'zod',
  tailwindcss: 'tailwindcss',
  vue: 'vue',
  svelte: 'svelte',
  '@nestjs/core': 'express',
  vitest: 'vitest',
  graphql: 'graphql',
};

function detectLibrariesFromDeps(
  deps: Record<string, string>,
  map: Record<string, string>,
): string[] {
  const libs: string[] = [];
  for (const [pkgName, libName] of Object.entries(map)) {
    if (pkgName in deps) {
      libs.push(libName);
    }
  }
  return libs;
}

function detectLibrariesFromManifests(rootDir: string): string[] | null {
  const libs = new Set<string>();

  // package.json — JS/TS
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    if (existsSync(pkgPath)) {
      const content = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const lib of detectLibrariesFromDeps(deps, PACKAGE_JSON_MAP)) {
        libs.add(lib);
      }
    }
  } catch {
    // fall through
  }

  // composer.json — PHP
  try {
    const composerPath = path.join(rootDir, 'composer.json');
    if (existsSync(composerPath)) {
      const content = readFileSync(composerPath, 'utf-8');
      const composer = JSON.parse(content);
      const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
      if ('laravel/framework' in deps) libs.add('laravel');
      if ('symfony/symfony' in deps) libs.add('symfony');
      if ('symfony/framework-bundle' in deps) libs.add('symfony');
      if ('illuminate/support' in deps) libs.add('laravel');
    }
  } catch {
    // fall through
  }

  // Cargo.toml — Rust
  try {
    const cargoPath = path.join(rootDir, 'Cargo.toml');
    if (existsSync(cargoPath)) {
      const content = readFileSync(cargoPath, 'utf-8');
      const depMatch = content.match(/\[dependencies\]([^[]*)/);
      if (depMatch) {
        const depsText = depMatch[1];
        for (const line of depsText.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
          const depName = trimmed.split('=')[0]?.trim().replace(/["']/g, '');
          if (depName === 'actix-web') libs.add('actix-web');
          if (depName === 'axum') libs.add('axum');
          if (depName === 'rocket') libs.add('rocket');
          if (depName === 'tokio') libs.add('tokio');
          if (depName === 'serde') libs.add('serde');
          if (depName === 'diesel') libs.add('diesel');
          if (depName === 'sqlx') libs.add('sqlx');
        }
      }
    }
  } catch {
    // fall through
  }

  // go.mod — Go
  try {
    const goModPath = path.join(rootDir, 'go.mod');
    if (existsSync(goModPath)) {
      const content = readFileSync(goModPath, 'utf-8');
      const lines = content.split('\n');
      let inRequireBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('require (') || trimmed.startsWith('require\t')) {
          inRequireBlock = trimmed.endsWith('(');
          continue;
        }
        if (inRequireBlock) {
          if (trimmed === ')') {
            inRequireBlock = false;
            continue;
          }
        } else if (!trimmed.startsWith('require')) {
          continue;
        }
        const parts = trimmed.split(/\s+/);
        const pkg = parts[0];
        if (pkg === 'github.com/gin-gonic/gin') libs.add('gin');
        if (pkg === 'github.com/labstack/echo' || pkg === 'github.com/labstack/echo/v4')
          libs.add('echo');
        if (pkg === 'github.com/gorilla/mux') libs.add('gorilla/mux');
        if (pkg === 'github.com/jackc/pgx') libs.add('pgx');
        if (pkg === 'github.com/jmoiron/sqlx') libs.add('sqlx');
      }
    }
  } catch {
    // fall through
  }

  // Python
  for (const lib of detectPythonLibraries(rootDir)) libs.add(lib);

  // Java/Kotlin
  for (const lib of detectJavaLibraries(rootDir)) libs.add(lib);

  // Ruby
  for (const lib of detectRubyLibraries(rootDir)) libs.add(lib);

  // C#
  for (const lib of detectDotnetLibraries(rootDir)) libs.add(lib);

  return libs.size > 0 ? [...libs] : null;
}

/**
 * Detect libraries from a list of changed files.
 * First tries manifest-based detection (package.json, composer.json, etc.)
 * if rootDir is provided. Falls back to path/file-extension heuristics.
 * @param files - List of changed file paths.
 * @param rootDir - Optional root directory for manifest-based detection.
 * @returns Array of detected library names.
 */
function detectLibraries(files: string[], rootDir?: string): string[] {
  // Prefer manifest-based detection when rootDir is available
  if (rootDir) {
    const manifestLibs = detectLibrariesFromManifests(rootDir);
    if (manifestLibs) {
      return manifestLibs;
    }
  }

  const libraries = new Set<string>();

  for (const file of files) {
    if (!file || typeof file !== 'string') continue;
    if (file.includes('package.json') || file.endsWith('.lock')) continue;

    // React / Next.js detection
    if (file.endsWith('.tsx') || file.endsWith('.jsx')) {
      libraries.add('react');
    }
    if (
      file.includes('/pages/') ||
      file.includes('/app/') ||
      file.endsWith('next.config.js') ||
      file.endsWith('next.config.ts')
    ) {
      libraries.add('next.js');
    }

    // React Query detection
    if (
      file.includes('useQuery') ||
      file.includes('useMutation') ||
      file.includes('query-client') ||
      file.endsWith('queries.ts') ||
      file.endsWith('queries.tsx')
    ) {
      libraries.add('@tanstack/react-query');
    }

    // Express / NestJS detection
    if (
      file.includes('/routes/') ||
      file.includes('/middleware/') ||
      file.endsWith('router.ts') ||
      file.endsWith('router.js')
    ) {
      libraries.add('express');
    }
    if (
      file.includes('/controllers/') ||
      file.includes('/modules/') ||
      file.endsWith('.module.ts')
    ) {
      libraries.add('express');
    }

    // Prisma detection
    if (file.includes('prisma/') || file.includes('.prisma') || file.endsWith('schema.prisma')) {
      libraries.add('prisma');
    }

    // Zod detection
    if (
      file.endsWith('.schema.ts') ||
      file.includes('/schemas/') ||
      file.includes('/validators/') ||
      file.endsWith('validation.ts')
    ) {
      libraries.add('zod');
    }

    // Tailwind CSS detection
    if (
      file.includes('tailwind') ||
      file.endsWith('tailwind.config.js') ||
      file.endsWith('tailwind.config.ts')
    ) {
      libraries.add('tailwindcss');
    }

    // Additional library detection
    if (file.endsWith('.vue')) {
      libraries.add('vue');
    }
    if (file.endsWith('.svelte')) {
      libraries.add('svelte');
    }
    if (file.includes('/graphql/') || file.endsWith('.graphql') || file.endsWith('.gql')) {
      libraries.add('graphql');
    }
    if (file.includes('/__tests__/') || file.includes('.test.') || file.includes('.spec.')) {
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        libraries.add('vitest');
      }
    }
  }

  return [...libraries];
}

/**
 * Detect libraries from a target directory.
 * First tries manifest-based detection if rootDir is provided.
 * Falls back to directory-name heuristics.
 * @param dir - Target directory path.
 * @param rootDir - Optional root directory for manifest-based detection.
 * @returns Array of detected library names.
 */
function detectLibrariesFromDir(dir: string, rootDir?: string): string[] {
  // Prefer manifest-based detection when rootDir is available
  if (rootDir) {
    const manifestLibs = detectLibrariesFromManifests(rootDir);
    if (manifestLibs) {
      return manifestLibs;
    }
  }

  const libs = new Set<string>();

  // PHP-only directories in WordPress plugins — no JS libraries apply.
  const phpOnlyPatterns = ['includes', 'templates', 'vendor', 'admin', 'languages'];
  if (phpOnlyPatterns.some((p) => dir.includes(p))) {
    return [];
  }

  // JS/React source directories
  if (dir.includes('frontend') || dir.includes('app') || dir.includes('components')) {
    libs.add('next.js');
    libs.add('react');
    libs.add('@tanstack/react-query');
  }

  // Generic `src` directory
  if (dir === 'src' || dir.endsWith('/src')) {
    const projectRoot = rootDir || process.cwd();
    const hasPackageJson = existsSync(path.join(projectRoot, 'package.json'));
    const hasComposerJson = existsSync(path.join(projectRoot, 'composer.json'));

    if (hasPackageJson) {
      libs.add('react');
    }
    if (!hasComposerJson) {
      libs.add('express');
      libs.add('prisma');
      libs.add('zod');
    }
  }

  // Pure backend directories
  if (dir.includes('backend') || dir.includes('api') || dir.includes('server')) {
    libs.add('express');
    libs.add('prisma');
    libs.add('zod');
  }

  return [...libs];
}
