/** Task shape as returned by the platform API. */
export interface Task {
  id: string;
  repo_id: string | null;
  repo: string | null;
  type: string;
  status: string;
  priority: number;
  pr_number: number | null;
  head_sha: string | null;
  workspace_path: string | null;
  result_data: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** SSE event shape streamed from /api/events. */
export interface TaskEvent {
  id: string;
  taskId: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}
