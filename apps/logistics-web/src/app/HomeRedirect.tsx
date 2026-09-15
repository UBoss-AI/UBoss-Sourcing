/**
 * Where `/` goes.
 *
 * A driver has one screen; everybody else has a dashboard. Deciding it by ROLE
 * rather than with a fixed redirect is what stops a driver's first sign-in
 * landing on the one screen they hold no permission for.
 *
 * Its own file rather than a second export from `router.tsx`, because a module
 * that exports both a component and the router cannot be hot-reloaded in
 * place: every save would remount the whole application.
 */
import { Navigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Permission } from '@/lib/permissions';

export function HomeRedirect(): React.JSX.Element {
  const { canAny } = useSession();

  if (canAny(Permission.SHIPMENT_READ)) return <Navigate to="/dashboard" replace />;
  if (canAny(Permission.DRIVER_TASK_READ)) return <Navigate to="/driver/tasks" replace />;

  return <Navigate to="/company" replace />;
}
