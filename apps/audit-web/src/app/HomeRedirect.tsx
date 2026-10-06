/**
 * Where `/` goes.
 *
 * By ROLE, because each role starts its day on a different screen and some
 * hold no permission the dashboard needs:
 *
 *   - an INSPECTOR starts at their jobs;
 *   - a QA_REVIEWER starts at the reports waiting for them;
 *   - an agency administrator or coordinator, and marketplace staff, start at
 *     the dashboard.
 *
 * The permission check after the role is the safety net: a role whose
 * dashboard permission was withdrawn lands on a screen it can open rather
 * than on a 403.
 *
 * Its own file rather than a second export from `router.tsx`, because a module
 * that exports both a component and the router cannot be hot-reloaded.
 */
import { Navigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Permission } from '@/lib/permissions';
import type { AuditRole } from '@/lib/types';

const ROLE_HOME: Record<AuditRole, string> = {
  INSPECTOR: '/jobs',
  QA_REVIEWER: '/reports',
  AGENCY_ADMIN: '/dashboard',
  COORDINATOR: '/dashboard',
  SUPERVISOR: '/dashboard',
  COMPLIANCE_REVIEWER: '/dashboard',
};

export function HomeRedirect(): React.JSX.Element {
  const { session, canAny } = useSession();

  const preferred = session === null ? '/profile' : ROLE_HOME[session.member.role];

  if (preferred === '/dashboard' && !canAny(Permission.DASHBOARD_READ)) {
    if (canAny(Permission.JOB_READ, Permission.JOB_OVERSEE)) return <Navigate to="/jobs" replace />;
    return <Navigate to="/profile" replace />;
  }

  return <Navigate to={preferred} replace />;
}
