import { promises as fs, existsSync, mkdirSync, readFileSync } from 'fs';
import * as cp from 'node:child_process';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import { emptyResult, parseJsonlFile } from './jsonl-parser.js';
import type { LearningStore } from './learning/store.js';
import { MCPManager } from './mcp/client.js';
import { ensureOutputDir, getGitStatus, runOpenCode } from './opencode.js';
import type { PlatformAdapter } from './platform/adapter.js';
import {
  buildAnalyzePrompt,
  buildAuditPrompt,
  buildExplainPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildSynthesisPrompt,
} from './prompts/builder.js';
import { buildConversationPrompt } from './prompts/conversation.js';
import { buildSelfHealPrompt } from './prompts/heal.js';
import { buildVerificationPrompt } from './prompts/verify.js';
import type {
  AgentConfig,
  ConversationContext,
  FixResult,
  LinterConfig,
  LinterFinding,
  LinterResult,
  PRContext,
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
import { Logger } from './utils/logger.js';
import {
  detectDotnetLibraries,
  detectJavaLibraries,
  detectPythonLibraries,
  detectRubyLibraries,
} from './utils/manifest-detector.js';
import { analyzeBatchReachability } from './utils/reachability.js';

/** Maximum number of batch chunks processed concurrently by `reviewPR`. */
export const MAX_BATCH_CONCURRENCY = 8;

/** Fixed inter-chunk backoff delay in milliseconds between concurrent chunks. */
export const INTER_CHUNK_DELAY_MS = 150;

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
   */
  constructor(
    config: AgentConfig,
    adapter: PlatformAdapter,
    private learningStore?: LearningStore,
  ) {
    this.config = config;
    this.adapter = adapter;
    this.mcp = new MCPManager(config.mcpServers);
    this.logger = new Logger('ReviewEngine');
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
   * Resolve the model for a specific pipeline stage, falling back to reviewModel.
   * @param stageField - Optional per-stage model field name from AgentConfig.
   * @returns The resolved model string.
   */
  private resolveModel(
    stageField: keyof Pick<
      AgentConfig,
      | 'auditModel'
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
    return this.attachUsage(result);
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
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
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
        core.warning(
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

    if (files.length === 0 && pr.changedFiles.length > 0) {
      core.info(
        `All ${pr.changedFiles.length} changed file(s) matched exclude patterns — skipping review`,
      );
      return emptyResult();
    }
    if (files.length < pr.changedFiles.length) {
      core.info(
        `Excluded ${pr.changedFiles.length - files.length} file(s) from review by exclude patterns`,
      );
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
      core.info(`Review budget mode: ${budgetMode} (total diff: ~${totalDiffLines} lines)`);
    } else {
      core.info('Skipping review budget adaptation for incremental (delta) review');
    }

    const tokenBudgetConfig = this.config.review.tokenBudget;
    const { context: prContext, budgetMetrics } = this.buildPRContextString(pr, tokenBudgetConfig);
    let openThreadsContext = '';
    try {
      openThreadsContext = await this.adapter.getOpenHumanThreads(pr.number);
    } catch (err) {
      core.warning(
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
        core.warning(
          `Failed to get learning store lessons: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        falsePositiveRules = await this.learningStore.getFalsePositiveRules(filePaths);
      } catch (err) {
        core.warning(
          `Failed to get false-positive rules: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Run configured linters as pre-processing step
    const linterResults = await this.runLinters(files, workDir);

    // If PR is small enough for a single batch, skip concurrent processing
    if (files.length <= batchSize) {
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
        },
      );

      const outputPath = path.join(workDir, 'review-output.jsonl');
      ensureOutputDir(outputPath);

      const runResult = await runOpenCode(prompt, {
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
        core.warning('OpenCode review execution failed, returning fallback empty result');
        const r = emptyResult();
        r.verdict.reasoning = 'Review execution failed';
        return this.applyBudgetModeBanner(r, budgetMode, totalDiffLines);
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
        );
      } catch {
        core.warning(`Failed to parse review output at ${outputPath}, returning empty result`);
        const r = emptyResult();
        r.verdict.reasoning = 'Failed to parse review output';
        return this.applyBudgetModeBanner(r, budgetMode, totalDiffLines);
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
          const { context: batchContext } = this.buildPRContextString(
            batchPR,
            tokenBudgetConfig,
            true,
          );
          const context = mcpDocs
            ? batchContext + '\n\n## Library Documentation\n' + mcpDocs
            : batchContext;

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
            },
          );

          const outputPath = path.join(batchDir, 'review-output.jsonl');
          ensureOutputDir(outputPath);

          const runResult = await runOpenCode(prompt, {
            model: this.config.reviewModel,
            timeoutMinutes: timeoutMinutes ?? this.config.timeoutMinutes,
            workingDirectory: batchDir,
          });

          if (!runResult.success) {
            core.warning(`Batch ${idx} review execution failed, returning empty result`);
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
            core.warning(`Failed to parse batch ${idx} review output, returning empty result`);
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

    // Record telemetry for the concurrent batch reviews. Batches overlap, so
    // use true wall-clock time for the batch loop rather than summing each
    // batch's own duration. Attribution is to the review model.
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

    const synthesisResult = await runOpenCode(synthesisPrompt, {
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
      core.warning('Synthesis pass failed, falling back to merged batch results');
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
      );
    } catch {
      core.warning('Synthesis output parse failed, falling back to merged batch results');
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
      );
    }
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
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
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

    const fixRunResult = await runOpenCode(prompt, {
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
      core.warning(
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
        core.debug('No .fix-stuck.md — proceeding normally');
      }

      try {
        summary = await fs.readFile(path.join(workDir, '.fix-summary.md'), 'utf-8');
        await fs.unlink(path.join(workDir, '.fix-summary.md'));
      } catch {
        core.debug('No .fix-summary.md — proceeding normally');
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
          core.warning('Could not get git diff to determine changed files');
        }
      }
    } catch (err) {
      core.warning(
        `Error reading fix results after OpenCode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { changesMade, filesChanged, stuck, stuckReason, summary };
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
    let mcpDocs = '';
    if (this.config.enableMCP) {
      try {
        await this.mcp.connect();
        const libraries = detectLibrariesFromDir(targetDir, workingDirectory);
        if (libraries.length > 0) {
          mcpDocs = await this.getCachedMcpDocs(libraries);
        }
      } catch (err) {
        core.warning(`MCP enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
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

    const auditRunResult = await runOpenCode(prompt, {
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
      core.warning('OpenCode audit execution failed, returning fallback empty result');
      const r = emptyResult();
      r.verdict.reasoning = 'Audit execution failed';
      return r;
    }

    const auditDir = workingDirectory || process.cwd();
    const outputPath = path.join(auditDir, `.opencode/audit-${category}.jsonl`);
    try {
      return await parseJsonlFile(outputPath);
    } catch {
      core.warning(`Failed to parse audit output at ${outputPath}, returning empty result`);
      const r = emptyResult();
      r.verdict.reasoning = 'Failed to parse audit output';
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
    const workDir = workingDirectory || process.cwd();
    const planPath = path.join(workDir, '.opencode', 'analysis-plan.md');
    ensureOutputDir(planPath);

    const prompt = buildAnalyzePrompt(
      { projectContext: this.config.projectContext.description || undefined },
      issueContextMarkdown,
    );

    const runResult = await runOpenCode(prompt, {
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
      core.warning('OpenCode analyze execution failed or timed out.');
      return '⚠️ **Analysis Failed**: OpenCode CLI was unable to complete the codebase analysis.';
    }

    try {
      const planMarkdown = await fs.readFile(planPath, 'utf-8');
      await fs.unlink(planPath).catch(() => {});
      return planMarkdown.trim();
    } catch (err) {
      if (runResult.output && runResult.output.trim().length > 0) {
        return runResult.output.trim();
      }
      core.warning(`Could not read analysis plan from ${planPath}: ${String(err)}`);
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

    const runResult = await runOpenCode(prompt, {
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
    const workDir = workingDirectory || process.cwd();
    const outputPath = path.join(workDir, '.opencode', 'explain-output.md');
    ensureOutputDir(outputPath);

    const { context: prContext } = this.buildPRContextString(pr);
    const prompt = buildExplainPrompt(
      { projectContext: this.config.projectContext.description || undefined },
      prContext,
    );

    const runResult = await runOpenCode(prompt, {
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
      return '⚠️ **Explanation Failed**: OpenCode CLI was unable to generate the PR explanation.';
    }

    try {
      const content = await fs.readFile(outputPath, 'utf-8');
      return content.trim();
    } catch {
      return '⚠️ **Explanation Failed**: Could not read explanation from `.opencode/explain-output.md`.';
    }
  }

  /**
   * Perform an optional meta-verification pass to filter out false positives.
   * If enableMetaVerification is enabled, runs an LLM verification pass over
   * proposed issues and drops findings marked invalid.
   *
   * @param result - Review result containing candidate issues.
   * @param prContext - Assembled PR context string.
   * @param workDir - Working directory for the workspace.
   * @param timeoutMinutes - Optional timeout in minutes for verification.
   * @param prNumber - Optional PR number for logging context.
   * @param budgetMode - Optional budget review mode selected from PR diff size (used to prepend the split banner).
   * @param totalDiffLines - Optional total diff line count reported in the split banner.
   * @returns Filtered ReviewResult with verified issues.
   */
  private async verifyReviewResult(
    result: ReviewResult,
    prContext: string,
    workDir: string,
    timeoutMinutes?: number,
    prNumber?: number,
    budgetMode?: ReviewBudgetMode,
    totalDiffLines?: number,
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
          core.info(
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
        core.warning(
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

        const runResult = await runOpenCode(prompt, {
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
          if (existsSync(outputPath)) {
            const content = await fs.readFile(outputPath, 'utf-8');
            const lines = content.split('\n').filter((l) => l.trim());

            const validIndices = new Set<number>();
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
                  if (parsed.valid === true) {
                    validIndices.add(parsed.issueIndex);
                  }
                }
              } catch {
                // ignore malformed verification lines
              }
            }

            if (validIndices.size > 0) {
              const verifiedIssues = enrichedResult.issues.filter((_, idx) =>
                validIndices.has(idx),
              );
              const droppedCount = enrichedResult.issues.length - verifiedIssues.length;

              if (droppedCount > 0) {
                core.info(
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
              core.info(
                'Meta-verification produced no valid verification entries — retaining enriched result',
              );
            }
          }
        } else {
          core.warning('Meta-verification pass failed, returning enriched result');
        }
      } catch (err) {
        core.warning(
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
        core.info(
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

    if (budgetMode && totalDiffLines !== undefined) {
      enrichedResult = this.applyBudgetModeBanner(enrichedResult, budgetMode, totalDiffLines);
    }

    return enrichedResult;
  }

  /**
   * Run an interactive conversation in response to an @mention in a PR comment.
   * Builds a conversation prompt from the provided context and runs it through OpenCode CLI.
   *
   * @param context - Full conversation context (thread, file, diff, intent).
   * @param timeoutMinutes - Optional timeout override.
   * @param workingDirectory - Optional working directory for OpenCode execution.
   * @returns The raw response text for posting as a GitHub comment.
   */
  async runConversation(
    context: ConversationContext,
    timeoutMinutes?: number,
    workingDirectory?: string,
  ): Promise<string> {
    // Reset telemetry so the reported usage reflects only this conversation invocation.
    this.telemetry = null;
    const workDir = workingDirectory || process.cwd();
    const outputPath = path.join(workDir, '.opencode', 'conversation-output.txt');
    ensureOutputDir(outputPath);

    const prompt = buildConversationPrompt(context);

    const runResult = await runOpenCode(prompt, {
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

    // Read the response from the output file
    try {
      const output = await fs.readFile(outputPath, 'utf-8');
      if (output.trim()) return output.trim();
      return 'I encountered an error generating the conversation response (output was empty).';
    } catch {
      return 'I encountered an error reading the conversation reply from `.opencode/conversation-output.txt`.';
    }
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
      .catch(() => core.warning('MCP disconnect failed during cleanup'));

    const storeTask = this.learningStore
      ?.close()
      .catch(() => core.warning('LearningStore close failed during cleanup'));

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
      core.warning(
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

    if (!this.learningStore) return;
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
      new Logger('ReviewEngine').warn('Failed to record telemetry', err);
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
    const prompt = promptTokens ?? 0;
    const completion = completionTokens ?? 0;
    if (prompt === 0 && completion === 0) {
      // No prompt/completion breakdown was parsed (e.g. OpenAI-style output
      // that only reports total_tokens). Fall back to a documented heuristic:
      // price the full total as input tokens. This is conservative (input
      // rates are typically lower) and never yields a misleading $0.0000.
      if (totalTokens !== undefined && totalTokens > 0) {
        return (totalTokens / 1000) * inputCost;
      }
      return undefined;
    }
    return (prompt / 1000) * inputCost + (completion / 1000) * outputCost;
  }

  /**
   * Append a structured JSONL entry to `.opencode/review-costs.jsonl` for
   * external aggregation and dashboarding. Each entry describes a single model
   * call (the per-call token delta), so consumers can sum totalTokens across
   * lines without double-counting. Non-critical — failures are logged and
   * swallowed so telemetry never breaks the pipeline.
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
          core.debug(`Linter "${result.tool}" spawn error: ${spawnError.message}`);
        }
        if (stderr) {
          const truncated = stderr.length > 500 ? stderr.slice(0, 500) + '...' : stderr;
          core.debug(`Linter "${result.tool}" stderr: ${truncated}`);
        }

        core.info(
          `Linter "${result.tool}" finished in ${duration}ms with exit code ${status} (${result.findings.length} findings)`,
        );

        results.push(result);
      } catch (err) {
        core.warning(
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
          core.debug(`Suppressing AI finding at ${key} — matches linter output`);
          return false;
        }
      }
      return true;
    });

    const dropped = issues.length - filtered.length;
    if (dropped > 0) {
      core.info(
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
    core.info(
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
   * @returns The markdown context string and optional token budget metrics.
   */
  buildPRContextString(
    pr: PRContext,
    tokenBudgetConfig?: TokenBudgetConfig,
    skipMetricsTracking = false,
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

      if (effectiveCap > 0 && patchLineCount > effectiveCap) {
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
