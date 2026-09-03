/**
 * Session state.
 *
 * The session lives in httpOnly cookies the browser manages; this provider
 * holds only the *description* of the signed-in customer, from `/auth/me`.
 *
 * Nothing is persisted to localStorage. A cached user would outlive a revoked
 * or suspended account and let someone reach a checkout they can no longer
 * complete. The one source of truth is what `/me` answers right now.
 *
 * `isCustomer` is the gate the whole storefront uses. An ADMIN token reaching
 * this app is *not* a customer: the backend checks the surface twice and would
 * reject every cart call, so treating one as a shopper would produce a page
 * full of 401s instead of an honest sign-in prompt.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api, onSessionEnded } from '@/lib/api';
import { SessionContext } from './session-context';
import type { CustomerUser, SessionState } from './session-context';

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<CustomerUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUser = useCallback(async (): Promise<void> => {
    try {
      setUser(await api.get<CustomerUser>('/auth/me'));
    } catch (error) {
      // A 401 is the ordinary "browsing as a guest" case, not a fault. Guest
      // browsing is the default state of a storefront.
      if (error instanceof ApiError && error.isAuthError) {
        setUser(null);
        return;
      }
      // Anything else — a network failure, a 500 — must not be mistaken for a
      // sign-out, or a brief outage empties everybody's session.
      throw error;
    }
  }, []);

  // A ref rather than a local flag: StrictMode mounts effects twice in
  // development, and the first cleanup must silence the first run without the
  // second observing a stale value.
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
  // here turns a dead session into a sign-in prompt rather than a wall of 401s.
  useEffect(
    () =>
      onSessionEnded(() => {
        setUser(null);
      }),
    [],
  );

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const result = await api.post<{ user: CustomerUser }>('/auth/login', { email, password });
    setUser(result.user);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Clear locally even if the call failed. The cookies may already be gone,
      // and leaving a signed-out customer looking at their account is worse
      // than dropping a server-side session that will expire on its own.
      setUser(null);
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      user,
      isLoading,
      // An activated customer has a profile id. Without one the account exists
      // but has never accepted its invitation, and no cart call will succeed.
      isCustomer: user !== null && user.type === 'CUSTOMER' && user.customerProfileId !== null,
      login,
      logout,
      refreshUser: loadUser,
    }),
    [user, isLoading, login, logout, loadUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
