/**
 * The session context and its hook.
 *
 * Separate from the provider so that file exports only components - React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two,
 * and a provider that remounts on every save logs you out mid-task.
 */
import { createContext, useContext } from 'react';
import type { PermissionKey } from '@/lib/permissions';

export interface AdminUser {
  id: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
  /**
   * Signed in on the temporary password that was emailed when the account was
   * created. The backend refuses every admin route while this is true, so the
   * panel shows the change-password screen and nothing else.
   */
  mustChangePassword: boolean;
  /**
   * This deployment asks where each sign-in happened. True unless the operator
   * set FEATURE_ADMIN_LOGIN_LOCATION=false, which a panel served over plain
   * HTTP has to, because the browser offers no Geolocation API there.
   */
  locationRequired: boolean;
  /**
   * The browser has told this session where it is. False on every fresh
   * sign-in; while it is false and `locationRequired` is true the backend
   * refuses every admin route, so the panel shows the location screen and
   * nothing else. Survives a token refresh - it is asked once per sign-in.
   */
  locationGranted: boolean;
}

export interface SessionState {
  user: AdminUser | null;
  /** True until the first `/me` call settles, so routes do not flash. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (permission: PermissionKey) => boolean;
  canAny: (...permissions: PermissionKey[]) => boolean;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const context = useContext(SessionContext);

  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }

  return context;
}
