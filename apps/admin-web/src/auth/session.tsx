/**
 * Session state.
 *
 * The session lives in httpOnly cookies the browser manages; this provider
 * holds only the *description* of the signed-in user - id, email, roles,
 * permissions - which the API returns from `/admin/auth/me`.
 *
 * Nothing here is persisted to localStorage. A cached user would survive a
 * revoked session and show a full navigation to someone who has been signed
 * out, which is exactly the impression an admin panel must not give. The one
 * source of truth is what `/me` answers right now.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api, onSessionEnded } from '@/lib/api';
import { SessionContext } from './session-context';
import type { AdminUser, SessionState } from './session-context';

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUser = useCallback(async (): Promise<void> => {
    try {
      setUser(await api.get<AdminUser>('/admin/auth/me'));
    } catch (error) {
      // A 401 here is the ordinary "not signed in" case, not a fault.
      if (error instanceof ApiError && error.isAuthError) {
        setUser(null);
        return;
      }
      // Anything else - a network failure, a 500 - must not be mistaken for a
      // sign-out, or a brief outage logs everybody out.
      throw error;
    }
  }, []);

  // A ref rather than a local flag: StrictMode mounts effects twice in
  // development, and the first cleanup must be able to silence the first run
  // without the second one seeing a stale value.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    void (async () => {
      try {
        await loadUser();
      } catch {
        if (isMountedRef.current) setUser(null);
      } finally {
        if (isMountedRef.current) setIsLoading(false);
      }
    })();

    return () => {
      isMountedRef.current = false;
    };
  }, [loadUser]);

  // The API client announces a session it could not refresh. Clearing the user
  // here is what turns a dead session into a login screen rather than a page
  // of failing panels.
  useEffect(
    () =>
      onSessionEnded(() => {
        setUser(null);
      }),
    [],
  );

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const result = await api.post<{ user: AdminUser }>('/admin/auth/login', { email, password });
    setUser(result.user);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post('/admin/auth/logout');
    } finally {
      // Clear locally even if the call failed. The cookies may already be gone,
      // and leaving a signed-out user looking at the panel is worse than
      // dropping a server-side session that will expire on its own.
      setUser(null);
    }
  }, []);

  const value = useMemo<SessionState>(() => {
    const granted = new Set(user?.permissions ?? []);

    return {
      user,
      isLoading,
      login,
      logout,
      refreshUser: loadUser,
      can: (permission) => granted.has(permission),
      canAny: (...permissions) => permissions.some((permission) => granted.has(permission)),
    };
  }, [user, isLoading, login, logout, loadUser]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
