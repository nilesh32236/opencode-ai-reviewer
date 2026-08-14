import { useCallback, useEffect, useState } from 'react';
import type { Task, TaskEvent } from './types.js';

/**
 * Live task list: fetches from the REST API and subscribes to the SSE event
 * stream so new task events trigger a refresh.
 * @returns The task list, a loading flag, and any fetch error.
 */
export function useTasks(): { tasks: Task[]; loading: boolean; error: string | null } {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks((await res.json()) as Task[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    // SSE stream: reconnect on close/error.
    let events: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = (): void => {
      events = new EventSource('/api/events');
      events.onmessage = (msg: MessageEvent) => {
        try {
          const evt = JSON.parse(msg.data as string) as TaskEvent;
          if (evt.eventType === 'status_change') void refresh();
        } catch {
          /* ignore malformed frames */
        }
      };
      events.onerror = () => {
        events?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();

    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      clearInterval(poll);
      events?.close();
      if (retry) clearTimeout(retry);
    };
  }, [refresh]);

  return { tasks, loading, error };
}
