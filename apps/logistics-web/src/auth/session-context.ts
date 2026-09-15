/**
 * The session context and its hook.
 *
 * Separate from the provider so that file exports only components - React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two,
 * and a provider that remounts on every save signs a dispatcher out mid-task.
 */
import { createContext, useContext } from 'react';
import type { PermissionKey } from '@/lib/permissions';
import type { PortalSession } from '@/lib/types';

/**
 * What the portal is waiting for before it can show anything useful.
 *
 * Four states rather than a boolean, because each sends the person somewhere
 * different and a boolean would collapse three of them into "not signed in":
 *
 *   - `LOADING`   - the boot request is in flight.
 *   - `SIGNED_OUT`- no session. The sign-in screen.
 *   - `MFA_SETUP` - signed in, and this role needs a second factor it has not
 *                   enrolled. The setup wizard, and nothing else.
 *   - `MFA_CHALLENGE` - enrolled, and this browser has not proved it. The
 *                   six-digit box, and nothing else.
 *   - `READY`     - everything is open.
 *
 * The two MFA states are what the backend's guard is already enforcing: it
 * refuses every route but `/auth/me`, `/auth/mfa/*` and `/auth/logout` until
 * the challenge is passed. This mirrors that so a person sees the right screen
 * rather than a page of 403s.
 */
export type SessionStage = 'LOADING' | 'SIGNED_OUT' | 'MFA_SETUP' | 'MFA_CHALLENGE' | 'READY';

export interface SessionState {
  stage: SessionStage;
  session: PortalSession | null;

  /** Sign in, then re-read the boot response. Throws on a bad password. */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read `/auth/me`. Called after enrolling or answering a challenge. */
  refresh: () => Promise<void>;

  /** Does this person hold every one of these keys? */
  can: (...permissions: PermissionKey[]) => boolean;
  /** At least one. An empty list is true - "any member of the company". */
  canAny: (...permissions: PermissionKey[]) => boolean;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const value = useContext(SessionContext);

  if (value === null) {
    // A programming error: a component read the session outside the provider.
    throw new Error('useSession was called outside SessionProvider.');
  }

  return value;
}

/**
 * The signed-in person, or a throw.
 *
 * For screens that are already behind `RequireSession` and would otherwise
 * have to narrow a nullable on every line.
 */
export function useCurrentUser(): PortalSession {
  const { session } = useSession();

  if (session === null) {
    throw new Error('useCurrentUser was called before the session was ready.');
  }

  return session;
}
