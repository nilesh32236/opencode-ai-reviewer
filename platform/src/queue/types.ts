/**
 * Task queue job payload types shared by the enqueue side (webhook/api) and
 * the worker (Chunk 6). These map to the `tasks` table rows.
 */

import type { CreateTaskInput } from '../db/repositories.js';

/** Union of task types the queue can carry. */
export type PlatformTaskType = 'review' | 'fix' | 'audit' | 'analyze' | 'docs' | 'conversation';

/** Payload for a queued task job. */
export interface TaskJobData {
  /** Repository in "owner/repo" form. */
  repo: string;
  /** Task type. */
  type: PlatformTaskType;
  /** GitHub installation id used to mint an installation token. */
  installationId?: number;
  /** PR number (for PR-scoped tasks). */
  prNumber?: number;
  /** PR title (for PR-scoped tasks). */
  prTitle?: string;
  /** Issue number (for issue-scoped tasks like /analyze). */
  issueNumber?: number;
  /** Head SHA to check out. */
  headSha?: string;
  /** Base branch for PR context. */
  baseBranch?: string;
  /** Head branch. */
  headBranch?: string;
  /** Trigger source (webhook | manual | schedule). */
  triggerSource?: string;
  /** Extra context passed to the worker (e.g. command flags). */
  context?: Record<string, unknown>;
}

/**
 * Build the deterministic BullMQ job id for a task so re-enqueuing the same
 * (repo, type, pr/issue, headSha) replaces rather than duplicates the job.
 * @param data - The task job payload.
 * @returns The deterministic job id.
 */
export function jobIdFor(data: TaskJobData): string {
  const prOrIssue = data.prNumber ?? data.issueNumber ?? 'none';
  const sha = data.headSha ?? 'no-sha';
  return `${data.repo}|${data.type}|${prOrIssue}|${sha}`;
}

/**
 * Map a queued task to its DB create input (for the tasks table).
 * @param data - The task job payload.
 * @returns A CreateTaskInput derived from the job data.
 */
export function toCreateTaskInput(data: TaskJobData): CreateTaskInput {
  return {
    repoId: null,
    type: data.type,
    prNumber: data.prNumber ?? null,
    headSha: data.headSha ?? null,
    baseBranch: data.baseBranch ?? null,
    headBranch: data.headBranch ?? null,
    triggerSource: data.triggerSource ?? 'webhook',
  };
}
