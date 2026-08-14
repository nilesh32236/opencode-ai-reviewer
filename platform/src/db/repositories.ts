/**
 * Task persistence helpers built on {@link PlatformDb}. The queue/worker
 * (Chunk 4+) reads and writes tasks through these typed functions instead of
 * raw SQL, so status transitions and result storage stay consistent.
 */

import type { PlatformDb, TaskRow } from './client.js';

/** Fields for creating a new task. */
export interface CreateTaskInput {
  repoId: string | null;
  repo?: string | null;
  type: string;
  prNumber?: number | null;
  prTitle?: string | null;
  headSha?: string | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  priority?: number;
  triggerSource?: string;
  triggeredBy?: string | null;
}

/** Fields for updating a task's mutable state. */
export interface UpdateTaskInput {
  status?: string;
  workspacePath?: string | null;
  opencodePort?: number | null;
  opencodePid?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  resultSummary?: string | null;
  resultData?: unknown;
  errorMessage?: string | null;
}

/**
 * Create a task row.
 * @param db - The platform database.
 * @param input - Task creation fields.
 * @returns The created task row.
 */
export async function createTask(db: PlatformDb, input: CreateTaskInput): Promise<TaskRow> {
  const rows = await db.query<TaskRow>(
    `INSERT INTO tasks (
       repo_id, repo, type, priority, pr_number, pr_title, head_sha,
       base_branch, head_branch, trigger_source, triggered_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.repoId,
      input.repo ?? null,
      input.type,
      input.priority ?? 0,
      input.prNumber ?? null,
      input.prTitle ?? null,
      input.headSha ?? null,
      input.baseBranch ?? null,
      input.headBranch ?? null,
      input.triggerSource ?? 'webhook',
      input.triggeredBy ?? null,
    ],
  );
  return rows[0];
}

/**
 * Load a task by id.
 * @param db - The platform database.
 * @param id - Task id.
 * @returns The task row, or undefined.
 */
export async function getTask(db: PlatformDb, id: string): Promise<TaskRow | undefined> {
  return db.queryOne<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]);
}

/**
 * Update a task's mutable fields.
 * @param db - The platform database.
 * @param id - Task id.
 * @param updates - Fields to update.
 * @returns The updated task row, or undefined when the task does not exist.
 */
export async function updateTask(
  db: PlatformDb,
  id: string,
  updates: UpdateTaskInput,
): Promise<TaskRow | undefined> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const cols: Array<{ column: string; inputKey: keyof UpdateTaskInput }> = [
    { column: 'status', inputKey: 'status' },
    { column: 'workspace_path', inputKey: 'workspacePath' },
    { column: 'opencode_port', inputKey: 'opencodePort' },
    { column: 'opencode_pid', inputKey: 'opencodePid' },
    { column: 'started_at', inputKey: 'startedAt' },
    { column: 'completed_at', inputKey: 'completedAt' },
    { column: 'result_summary', inputKey: 'resultSummary' },
    { column: 'result_data', inputKey: 'resultData' },
    { column: 'error_message', inputKey: 'errorMessage' },
  ];
  for (const { column, inputKey } of cols) {
    const value = updates[inputKey];
    if (value !== undefined) {
      values.push(value ?? null);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return getTask(db, id);
  values.push(id);
  sets.push(`updated_at = NOW()`);
  const rows = await db.query<TaskRow>(
    `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0];
}

/**
 * List tasks, optionally filtered by status and/or type.
 * @param db - The platform database.
 * @param filter - Optional filters.
 * @param filter.status - Filter by status (e.g. 'running').
 * @param filter.type - Filter by type (e.g. 'review').
 * @param filter.limit - Maximum rows (default 100).
 * @returns Matching task rows, most recent first.
 */
export async function listTasks(
  db: PlatformDb,
  filter: { status?: string; type?: string; limit?: number } = {},
): Promise<TaskRow[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filter.type) {
    values.push(filter.type);
    clauses.push(`type = $${values.length}`);
  }
  values.push(filter.limit ?? 100);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.query<TaskRow>(
    `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );
}

/**
 * Record a lifecycle event for a task.
 * @param db - The platform database.
 * @param taskId - Task id.
 * @param eventType - Event type (status_change | log | error | finding).
 * @param payload - Optional structured event payload.
 */
export async function addTaskEvent(
  db: PlatformDb,
  taskId: string,
  eventType: string,
  payload?: unknown,
): Promise<void> {
  await db.execute('INSERT INTO task_events (task_id, event_type, payload) VALUES ($1, $2, $3)', [
    taskId,
    eventType,
    payload ? JSON.stringify(payload) : null,
  ]);
}
