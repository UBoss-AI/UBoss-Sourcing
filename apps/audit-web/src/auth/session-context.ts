/**
 * The session context and its hook.
 *
 * Separate from the provider so that file exports only components - React Fast
 * Refresh cannot preserve state across an edit to a file that mixes the two,
 * and a provider that remounts on every save signs an inspector out mid-job.
 */
import { createContext, useContext } from 'react';
import type { PermissionKey } from '@/lib/permissions';
import type { ConsoleSession } from '@/lib/types';

/**
 * What the console is waiting for before it can show anything useful.
 *
 *   - `LOADING`   - the boot request is in flight.
 *   - `SIGNED_OUT`- no session. The sign-in screen.
 *   - `MFA_SETUP` - signed in, and this role needs a second factor it has not
 *                   enrolled. The setup wizard, and nothing else.
 *   - `MFA_CHALLENGE` - enrolled, and this browser has not proved it. The
 *                   six-digit box, and nothing else.
 *   - `READY`     - everything is open.
 *
 * The two MFA states are what the backend's guard is already enforcing: every
 * audit-console role must pass a TOTP challenge (`AUDIT_MFA_SETUP_REQUIRED`,
 * `AUDIT_MFA_CHALLENGE_REQUIRED`). This mirrors that so a person sees the
 * right screen rather than a page of 403s.
 */
export type SessionStage = 'LOADING' | 'SIGNED_OUT' | 'MFA_SETUP' | 'MFA_CHALLENGE' | 'READY';

export interface SessionState {
  stage: SessionStage;
  session: ConsoleSession | null;

  /**
   * Why the console could not be opened, where the server gave a reason.
   *
   * Null for the ordinary "not signed in". Set when the credentials were
   * accepted and the console still refused - an account with no active
   * membership (`AUDIT_MEMBER_REQUIRED`), an agency that was suspended. That
   * person types the right password, lands back on the sign-in screen and,
   * with nothing on it, concludes the password is wrong.
   */
  notice: string | null;

  /** Sign in, then re-read the boot response. Throws on a bad password. */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read `/audit/auth/me`. Called after enrolling or answering a challenge. */
  refresh: () => Promise<void>;

  /** Does this person hold every one of these keys? */
  can: (...permissions: PermissionKey[]) => boolean;
  /** At least one. An empty list is true - "any member". */
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
export function useCurrentUser(): ConsoleSession {
  const { session } = useSession();

  if (session === null) {
    throw new Error('useCurrentUser was called before the session was ready.');
  }

  return session;
}
