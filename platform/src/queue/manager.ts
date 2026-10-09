/**
 * BullMQ queue wrapper for platform tasks. Provides typed enqueueing with a
 * deterministic job id so the same (repo, type, pr/issue, headSha) never
 * creates duplicate jobs — a re-delivered webhook replaces rather than queues
 * a second review.
 */

import { Logger } from '@opencode-pr-agent/lib';
import { type Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { TaskJobData } from './types.js';
import { jobIdFor } from './types.js';

const logger = new Logger('TaskQueue');

/** Name of the platform task queue. */
export const TASK_QUEUE_NAME = 'platform-tasks';

/**
 * Thin typed wrapper around a BullMQ {@link Queue}.
 */
export class TaskQueue {
  private readonly queue: Queue<TaskJobData>;

  /**
   * @param connection - A BullMQ-compatible Redis connection (ioredis instance
   * or connection options).
   */
  constructor(connection: Redis | { host: string; port: number }) {
    this.queue = new Queue<TaskJobData>(TASK_QUEUE_NAME, { connection });
  }

  /**
   * Enqueue a task job, replacing any existing job with the same deterministic
   * id (so re-delivered webhooks never double-enqueue a review).
   * @param data - The task job payload.
   * @returns The created job.
   */
  /**
   * Enqueue a task job.
   *
   * `jobId` is derived from the payload, so re-enqueuing the same
   * (repo, type, pr/issue, headSha) replaces rather than duplicates the job.
   * That is right for the webhook path, where a re-delivery of the same event
   * should not stack up duplicate work.
   *
   * It is wrong for a RETRY: the retry route passes the same repo/type/pr/sha
   * as the original, so it derives the same id, and BullMQ's `add()` with an
   * existing id RESOLVES WITHOUT ADDING A NEW JOB. The route then reported
   * `202 queued` for work that was never enqueued. `uniqueSuffix` breaks the
   * collision so a retry is a genuinely new job.
   *
   * @param data - The task job payload.
   * @param uniqueSuffix - Optional suffix that makes the id unique, for a retry
   *   of a task that would otherwise collide with the original.
   * @returns The created job.
   */
  async enqueue(data: TaskJobData, uniqueSuffix?: string): Promise<Job<TaskJobData>> {
    const id = uniqueSuffix ? `${jobIdFor(data)}#${uniqueSuffix}` : jobIdFor(data);
    const job = await this.queue.add(data.type, data, {
      jobId: id,
      removeOnComplete: { age: 7 * 24 * 3600 }, // keep 7 days for audit
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    logger.info(`Enqueued ${data.type} job for ${data.repo} (id ${job.id})`);
    return job;
  }

  /**
   * Close the queue (for graceful shutdown).
   */
  async close(): Promise<void> {
    await this.queue.close();
  }
}
