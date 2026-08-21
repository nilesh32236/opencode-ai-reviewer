import { useState } from 'react';
import { useAuth } from './useAuth.js';
import { useTasks } from './useTasks.js';

const STATUS_COLORS: Record<string, string> = {
  queued: '#f0ad4e',
  running: '#5bc0de',
  completed: '#5cb85c',
  failed: '#d9534f',
  cancelled: '#777',
  archiving: '#f0ad4e',
  archived: '#999',
};

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 12,
        color: '#fff',
        background: STATUS_COLORS[status] ?? '#555',
      }}
    >
      {status}
    </span>
  );
}

export function App(): React.JSX.Element {
  const { tasks, loading, error } = useTasks();
  const { user, loading: authLoading, error: authError, login, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async (): Promise<void> => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // keep user logged in on failure
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <main
      style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto', padding: 24 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1 style={{ fontSize: 22 }}>OpenCode Platform</h1>
          <StatusBadge status={loading ? 'running' : 'queued'} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 140,
            justifyContent: 'flex-end',
          }}
        >
          {authLoading ? (
            <span style={{ fontSize: 12, opacity: 0.6 }}>Checking session…</span>
          ) : authError ? (
            <span style={{ fontSize: 12, color: '#d9534f' }}>{authError}</span>
          ) : user ? (
            <>
              <span style={{ fontSize: 13 }}>
                {user.login} (
                {['admin', 'reviewer', 'viewer'].includes(user.role) ? user.role : 'reviewer'})
              </span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid #ccc',
                  cursor: loggingOut ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  opacity: loggingOut ? 0.6 : 1,
                }}
              >
                {loggingOut ? '...' : 'Logout'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={login}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                background: '#24292f',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Login with GitHub
            </button>
          )}
        </div>
      </header>

      {error ? (
        <p style={{ color: '#d9534f' }}>Failed to load tasks: {error}</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              <th>Task</th>
              <th>Repo</th>
              <th>PR</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid #eee' }}>
                <td>{t.type}</td>
                <td>{t.repo ?? '—'}</td>
                <td>{t.pr_number ?? '—'}</td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td style={{ color: '#888', fontSize: 13 }}>
                  {new Date(t.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {tasks.length === 0 && !loading && (
              <tr>
                <td colSpan={5} style={{ color: '#999', padding: 16 }}>
                  No tasks yet — open a PR or run /review to enqueue one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
