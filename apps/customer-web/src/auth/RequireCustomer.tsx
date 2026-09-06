/**
 * Guards the pages that need an activated customer.
 *
 * The attempted location is kept, so someone who followed a link to their
 * order and had to sign in first lands back on that order rather than the home
 * page — the most common way a storefront wastes a returning customer's time.
 *
 * This is a courtesy, not a control. Every route behind it is enforced by the
 * backend, which checks the surface twice: an admin token cannot reach a
 * customer route even if it were somehow presented here.
 */
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from './session-context';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';

export function RequireCustomer({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n();

  const { isCustomer, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          {t('requireCustomer.checkingYourSession')}
        </span>
      </div>
    );
  }

  if (!isCustomer) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}
