/**
 * BullMQ worker that executes platform tasks using the shared lib ReviewEngine.
 *
 * For each job it creates an isolated workspace (shallow clone), constructs a
 * GitHubHelper + ReviewEngine exactly as the Probot app does, runs the
 * requested command (review/fix/audit/...), posts results to GitHub, and
 * records task status/result in Postgres.
 */

import { DEFAULT_CONFIG, GitHubHelper, Logger, ReviewEngine } from '@opencode-pr-agent/lib';
import type { AgentConfig, PlatformAdapter, ReviewResult } from '@opencode-pr-agent/lib';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PlatformDb } from '../db/client.js';
import { createTask, updateTask } from '../db/repositories.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { TASK_QUEUE_NAME } from './manager.js';
import type { TaskJobData } from './types.js';

const logger = new Logger('PlatformWorker');

/** Worker runtime options. */
export interface WorkerOptions {
  /** Redis connection shared with the queue. */
  connection: Redis;
  /** The platform database (task status/result persistence). */
  db: PlatformDb;
  /** Workspace root for clones. */
  workspaceDir: string;
  /** GitHub token used to authenticate API calls. */
  githubToken: string;
  /** Base agent config (models, providers). */
  config?: AgentConfig;
  /** Maximum concurrent jobs (default: 1). */
  concurrency?: number;
}

/** Public API surface for a worker instance. */
export interface PlatformWorkerHandle {
  close: () => Promise<void>;
}

/**
 * Build an AgentConfig for a task from a base config or env overrides.
 * Mirrors the app's buildConfig env handling for the key model fields so the
 * worker honours the same REVIEW_MODEL / FIX_MODEL / etc. overrides.
 * @param config - Optional pre-built config; when absent, builds from env.
 * @returns The agent config.
 */
export function resolveConfig(config?: AgentConfig): AgentConfig {
  if (config) return config;
  return {
    ...DEFAULT_CONFIG,
    reviewModel: process.env.REVIEW_MODEL || DEFAULT_CONFIG.reviewModel,
    fixModel: process.env.FIX_MODEL || DEFAULT_CONFIG.fixModel,
    auditModel: process.env.AUDIT_MODEL || undefined,
    analysisModel: process.env.ANALYSIS_MODEL || undefined,
  };
}

/**
 * Run a review task end-to-end.
 * @param engine - The review engine.
 * @param gh - The GitHub platform adapter.
 * @param prNumber - PR number.
 * @param workspace - The workspace path the clone lives in.
 * @param inline - Whether to post inline comments (default true).
 * @returns The review result.
 */
async function runReview(
  engine: ReviewEngine,
  gh: PlatformAdapter,
  prNumber: number,
  workspace: string,
  inline: boolean,
): Promise<ReviewResult> {
  const pr = await gh.getMR(prNumber);
  const result = await engine.reviewPR(
    pr,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workspace,
  );
  if (!result.skipped) {
    await gh.postReview(prNumber, pr.headSha, result, inline);
  }
  return result;
}

/**
 * Dispatch a job to the matching command runner.
 * @param data - The task job data.
 * @param engine - The review engine.
 * @param gh - The GitHub platform adapter.
 * @param workspace - The workspace path.
 */
async function dispatchTask(
  data: TaskJobData,
  engine: ReviewEngine,
  gh: PlatformAdapter,
  workspace: string,
): Promise<void> {
  if (data.type === 'review') {
    if (!data.prNumber) throw new Error('Review task missing prNumber');
    await runReview(engine, gh, data.prNumber, workspace, true);
    return;
  }
  if (data.type === 'analyze') {
    if (!data.issueNumber) throw new Error('Analyze task missing issueNumber');
    const issueContext = await gh.gatherContext({ issueNumber: data.issueNumber });
    const plan = await engine.runAnalyze(data.issueNumber, issueContext, undefined, workspace);
    await gh.postOrUpdateComment(data.issueNumber, '<!-- issue-analysis-plan -->', plan);
    return;
  }
  // audit/docs/fix/conversation land in later chunks.
  throw new Error(`Task type not yet supported by the worker: ${data.type}`);
}

/**
 * Start the platform worker.
 * @param options - Worker runtime options.
 * @returns A handle to close the worker.
 */
export function startWorker(options: WorkerOptions): PlatformWorkerHandle {
  const { connection, db, workspaceDir, githubToken, config, concurrency = 1 } = options;
  const baseConfig = resolveConfig(config);
  const workspaces = new WorkspaceManager(workspaceDir);

  const worker = new Worker<TaskJobData>(
    TASK_QUEUE_NAME,
    async (job) => {
      const { repo, type, prNumber, issueNumber, headSha } = job.data;
      const id: string | number = prNumber ?? issueNumber ?? String(job.id ?? 'task');
      const correlationId = job.id;
      const jobLogger = new Logger('Worker', {
        repo,
        prNumber: typeof id === 'number' ? id : undefined,
        correlationId,
      });
      jobLogger.info(`Processing ${type} task for ${repo}#${id}`);

      try {
        // Link to a tasks-table row: reuse the id from the job when set,
        // otherwise create one (and persist it back so later updates target it).
        let taskId = job.data.taskId;
        if (!taskId) {
          const created = await createTask(db, {
            repoId: null,
            type,
            prNumber: job.data.prNumber ?? null,
            headSha: job.data.headSha ?? null,
            baseBranch: job.data.baseBranch ?? null,
            headBranch: job.data.headBranch ?? null,
            triggerSource: job.data.triggerSource ?? 'webhook',
          });
          taskId = created.id;
          await job.updateData({ ...job.data, taskId });
        }

        // Mark running in the DB.
        await updateTask(db, taskId, { status: 'running', startedAt: new Date() });

        // Clone into an isolated workspace.
        const ws = await workspaces.create(repo, id, `https://github.com/${repo}.git`, headSha);

        const gh: PlatformAdapter = new GitHubHelper(githubToken, repo);
        const engine = new ReviewEngine(baseConfig, gh, undefined, undefined, repo, correlationId);

        await dispatchTask(job.data, engine, gh, ws.path);

        await updateTask(db, taskId, {
          status: 'completed',
          completedAt: new Date(),
          resultSummary: `${type} completed`,
        });
        jobLogger.info(`${type} task completed for ${repo}#${id}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        jobLogger.error(`${type} task failed for ${repo}#${id}: ${message}`);
        const taskId = job.data.taskId;
        if (taskId) {
          await updateTask(db, taskId, {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: message,
          });
        }
        throw err;
      }
    },
    { connection, concurrency },
  );

  worker.on('failed', (job, err) => {
    logger.warn(`Job ${job?.id} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  worker.on('error', (err) => {
    logger.error(`Worker error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    close: () => worker.close(),
  };
}
