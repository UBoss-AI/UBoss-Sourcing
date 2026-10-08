/**
 * Route guards.
 *
 * `RequireAuth` keeps the attempted location so a signed-out user who followed
 * a deep link lands back on it after signing in, rather than on the dashboard.
 *
 * `RequirePermission` is a courtesy, not a control - the backend rejects the
 * request either way. What it buys is an honest "you do not have access to
 * this" instead of a screen of failed panels.
 */
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from './session-context';
import { LocationGate } from './LocationGate';
import { AdminMfaGate } from './AdminMfaGate';
import { PortalAgreementGate } from './PortalAgreementGate';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { Spinner } from '@/components/ui';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import type { PermissionKey } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n();

  const { user, isLoading, logout } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          {t('guards.checkingYourSession')}
        </span>
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  /**
   * Signed in on the emailed temporary password. Every admin route would answer
   * PASSWORD_CHANGE_REQUIRED, so the panel is replaced wholesale rather than
   * rendered into a wall of failures.
   *
   * Rendered in place, not redirected to: a route could be navigated away from,
   * and this must not be skippable. The backend refuses either way - this only
   * decides whether the person is shown something useful.
   */
  if (user.mustChangePassword) {
    return <ChangePasswordPage />;
  }

  if (user.mfaRequired && (!user.mfaEnabled || !user.mfaSessionVerified)) {
    return <AdminMfaGate />;
  }

  /**
   * Signed in, but the browser has not yet said where from. Same shape as the
   * line above and for the same reasons: every admin route answers
   * LOCATION_REQUIRED until it has, and rendering in place rather than
   * redirecting keeps it unskippable by navigation.
   *
   * Ordered after the password check on purpose. Somebody still on a temporary
   * password has a more urgent thing to do, and stacking two gates in the other
   * order would ask them for a location before telling them their credential is
   * not really theirs yet.
   */
  if (user.locationRequired && !user.locationGranted) {
    return <LocationGate />;
  }

  /**
   * Last, the staff terms and the Privacy Policy - the same order the server
   * applies its gates in. Accepted once and recorded, not ticked on every
   * sign-in: asked again only when a new version requires it.
   */
  return <PortalAgreementGate signOut={logout}>{children}</PortalAgreementGate>;
}

export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: PermissionKey[];
  children: ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();

  const { canAny } = useSession();

  if (anyOf.length > 0 && !canAny(...anyOf)) {
    // The same 403 page as everywhere else, inside the shell. It names no
    // screen and no permission: a refusal that describes the thing refused is
    // a directory of what exists.
    return (
      <ErrorPage
        kind="forbidden"
        t={t}
        actions={errorActions('forbidden', { t, home: { to: '/' }, homeIsDashboard: true })}
      />
    );
  }

  return <>{children}</>;
}
