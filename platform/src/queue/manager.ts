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
  async enqueue(data: TaskJobData): Promise<Job<TaskJobData>> {
    const id = jobIdFor(data);
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
