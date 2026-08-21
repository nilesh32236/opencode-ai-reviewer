import { useCallback, useEffect, useState } from 'react';

/** User role for RBAC. */
export type UserRole = 'admin' | 'reviewer' | 'viewer';

/** Authenticated user returned from /auth/me. */
export interface AuthUser {
  id: string;
  login: string;
  avatar: string | null;
  role: UserRole;
}

function isAuthUser(data: unknown): data is AuthUser {
  return (
    !!data &&
    typeof (data as AuthUser).id === 'string' &&
    typeof (data as AuthUser).login === 'string' &&
    ['admin', 'reviewer', 'viewer'].includes((data as AuthUser).role)
  );
}

/**
 * Hook for platform auth state (fetches /auth/me, provides login/logout).
 * @returns Auth state and actions.
 */
export function useAuth(): {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/auth/me', { credentials: 'include' });
      if (!res.ok) {
        if (res.status !== 401 && res.status !== 501) setError(`Auth check failed: ${res.status}`);
        setUser(null);
        return;
      }
      const data: unknown = await res.json();
      if (isAuthUser(data)) setUser(data);
      else setUser(null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetch('/auth/me', { credentials: 'include', signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return null;
        if (!res.ok) {
          if (res.status !== 401 && res.status !== 501)
            setError(`Auth check failed: ${res.status}`);
          return null;
        }
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        if (ac.signal.aborted) return;
        if (isAuthUser(data)) setUser(data);
        else setUser(null);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        if ((e as Error).name !== 'AbortError') setUser(null);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  const login = (): void => {
    window.location.href = '/auth/login';
  };

  const logout = async (): Promise<void> => {
    const res = await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error('Logout failed');
    setUser(null);
  };

  return { user, loading, error, login, logout, refresh };
}
