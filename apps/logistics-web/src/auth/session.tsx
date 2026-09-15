/**
 * Who is signed in, and what the portal may show them.
 *
 * One request decides everything: `GET /logistics/auth/me`. It answers with
 * the person, their company, their permissions and the state of their second
 * factor, and the four possible answers map onto the four screens the portal
 * can be in - see `SessionStage`.
 *
 * WHY THE SECOND FACTOR IS A STAGE RATHER THAN A PAGE
 *
 * The backend's guard refuses every route but three until the challenge is
 * passed. A portal that routed to a setup page and then let a person navigate
 * away would show them a wall of 403s; making it a stage means there is
 * nowhere else to navigate to, which is the honest rendering of what the
 * server is already doing.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, onSessionEnded } from '@/lib/api';
import { fetchSession, signIn as signInRequest, signOut as signOutRequest } from '@/lib/logistics';
import { holdsAll, holdsAny, type PermissionKey } from '@/lib/permissions';
import type { PortalSession } from '@/lib/types';
import { SessionContext, type SessionStage, type SessionState } from './session-context';

/**
 * Which screen the boot response asks for.
 *
 * `required && !enrolled` is the setup wizard; `required && !sessionVerified`
 * is the six-digit box; anything else is the portal. A role that does not
 * require a factor skips both, which is how a driver on a phone is not asked
 * to scan a QR code at a loading bay.
 */
function stageFor(session: PortalSession): SessionStage {
  if (!session.mfa.required) return 'READY';
  if (!session.mfa.enrolled) return 'MFA_SETUP';
  if (!session.mfa.sessionVerified) return 'MFA_CHALLENGE';
  return 'READY';
}

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<PortalSession | null>(null);
  const [stage, setStage] = useState<SessionStage>('LOADING');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchSession();
      setSession(next);
      setStage(stageFor(next));
      setNotice(null);
    } catch (error) {
      /*
       * Every failure is "signed out", deliberately.
       *
       * A 401 is the ordinary case. A 403 - no membership, a disabled member,
       * a company the marketplace has not activated - is also a portal this
       * person cannot use, and distinguishing them by STAGE would mean a
       * half-open portal with no session behind it.
       *
       * The two are distinguished by the MESSAGE instead, which is what the
       * sign-in screen shows. Without it, somebody whose password was accepted
       * and whose company is not active yet is returned to an empty sign-in
       * form and told nothing at all - so they try the password again, and
       * again, and then ring somebody.
       */
      setSession(null);
      setStage('SIGNED_OUT');
      setNotice(
        error instanceof ApiError && error.status !== 401 && error.message.length > 0
          ? error.message
          : null,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The API client announces a session that could not be refreshed.
   *
   * Without this a dead session leaves the portal on a page whose panels all
   * fail one by one, which reads as the software being broken rather than as
   * having been signed out.
   */
  useEffect(
    () =>
      onSessionEnded(() => {
        setSession(null);
        setStage('SIGNED_OUT');
      }),
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      await signInRequest(email, password);
      await load();
    },
    [load],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await signOutRequest();
    } finally {
      // Whatever the server said. A sign-out that failed still means the
      // person asked to leave, and leaving them on a working portal is worse
      // than clearing a session the server may still hold.
      setSession(null);
      setStage('SIGNED_OUT');
    }
  }, []);

  const value = useMemo<SessionState>(() => {
    const held = session?.user.permissions ?? [];

    return {
      stage,
      session,
      notice,
      signIn,
      signOut,
      refresh: load,
      can: (...permissions: PermissionKey[]) => holdsAll(held, permissions),
      canAny: (...permissions: PermissionKey[]) => holdsAny(held, permissions),
    };
  }, [stage, session, notice, signIn, signOut, load]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
