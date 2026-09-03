/**
 * The session context and its hook.
 *
 * Separate from the provider so that file exports only components — React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two,
 * and a provider that remounts on every save signs you out mid-checkout.
 */
import { createContext, useContext } from 'react';

export interface CustomerUser {
  id: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  roles: string[];
  permissions: string[];
  customerProfileId: string | null;
  mfaEnabled: boolean;
}

export interface SessionState {
  user: CustomerUser | null;
  /** True until the first `/auth/me` call settles, so routes do not flash. */
  isLoading: boolean;
  /** Signed in AND activated — the only state that may reach checkout. */
  isCustomer: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const context = useContext(SessionContext);

  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }

  return context;
}
