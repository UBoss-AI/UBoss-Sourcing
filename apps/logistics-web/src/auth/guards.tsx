/**
 * Route guards.
 *
 * `RequireSession` keeps the attempted location so somebody who followed a
 * deep link lands back on it after signing in, rather than on the dashboard.
 * It also renders the two second-factor screens IN PLACE rather than
 * redirecting to them, for the same reason the console renders its
 * change-password gate in place: a redirect can be navigated away from, and
 * these must not be skippable.
 *
 * `RequirePermission` is a courtesy, not a control - the backend refuses the
 * request either way. What it buys is an honest "you do not have access to
 * this" instead of a screen of failed panels.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { PermissionKey } from '@/lib/permissions';
import { MfaChallengePage, MfaSetupPage } from '@/pages/MfaPage';
import { useSession } from './session-context';

export function RequireSession({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  const { stage } = useSession();
  const location = useLocation();

  if (stage === 'LOADING') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          {t('common.loading')}
        </span>
      </div>
    );
  }

  if (stage === 'SIGNED_OUT') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  /*
   * The two second-factor gates, in the order the backend applies them.
   *
   * Setup first: somebody who has not enrolled cannot answer a challenge, and
   * asking them to would be asking for a code from an app they have not set
   * up yet.
   */
  if (stage === 'MFA_SETUP') return <MfaSetupPage />;
  if (stage === 'MFA_CHALLENGE') return <MfaChallengePage />;

  return <>{children}</>;
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
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-lg font-semibold text-ink">{t('common.noAccessTitle')}</h1>
        <p className="mt-2 text-sm text-ink-muted">{t('common.noAccessBody')}</p>
      </div>
    );
  }

  return <>{children}</>;
}
