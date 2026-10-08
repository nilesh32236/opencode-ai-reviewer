/**
 * Task queue job payload types shared by the enqueue side (webhook/api) and
 * the worker (Chunk 6). These map to the `tasks` table rows.
 */

import type { CreateTaskInput } from '../db/repositories.js';

/** Union of task types the queue can carry. */
export type PlatformTaskType = 'review' | 'fix' | 'audit' | 'analyze' | 'docs' | 'conversation';

/**
 * Task types the worker can actually dispatch today.
 *
 * `PlatformTaskType` is what the queue can CARRY; this is what the worker can
 * RUN. The two differ while `audit`, `docs`, `fix` and `conversation` land in
 * later chunks, and the difference matters at the enqueue boundary: a job of an
 * unsupported type is accepted, the repo is cloned, and only then does
 * `dispatchTask` reject it — so the caller is told `200 queued` for work that
 * cannot run, and the clone is wasted.
 *
 * Kept next to the union so the two cannot drift apart silently, and asserted
 * against `dispatchTask`'s own branches by a test.
 */
export const DISPATCHABLE_TASK_TYPES = ['review', 'analyze'] as const;

/**
 * Whether the worker can dispatch this task type.
 *
 * @param type - Candidate task type.
 * @returns True when `dispatchTask` handles it.
 */
export function isDispatchableTaskType(type: unknown): type is PlatformTaskType {
  return typeof type === 'string' && (DISPATCHABLE_TASK_TYPES as readonly string[]).includes(type);
}

/** Payload for a queued task job. */
export interface TaskJobData {
  /** Repository in "owner/repo" form. */
  repo: string;
  /** Task type. */
  type: PlatformTaskType;
  /** Optional tasks-table row id linked to this job (set by the enqueue side). */
  taskId?: string;
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
