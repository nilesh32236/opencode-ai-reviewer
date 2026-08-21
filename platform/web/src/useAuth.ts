import { useEffect, useState } from 'react';

export interface AuthUser {
  id: string;
  login: string;
  avatar: string | null;
  role: string;
}

export function useAuth(): {
  user: AuthUser | null;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
} {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) return null;
        return res.json() as Promise<AuthUser>;
      })
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = (): void => {
    window.location.href = '/auth/login';
  };

  const logout = async (): Promise<void> => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
  };

  return { user, loading, login, logout };
}
