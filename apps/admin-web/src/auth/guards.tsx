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
import { Spinner } from '@/components/ui';
import type { PermissionKey } from '@/lib/permissions';

export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          Checking your session
        </span>
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: PermissionKey[];
  children: ReactNode;
}): React.JSX.Element {
  const { canAny } = useSession();

  if (anyOf.length > 0 && !canAny(...anyOf)) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-lg font-semibold text-ink">You do not have access to this page</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Your account does not include the permissions this screen needs. A Business Owner can
          change that from Staff.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
