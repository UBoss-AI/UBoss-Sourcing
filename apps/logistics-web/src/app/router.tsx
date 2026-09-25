/**
 * Routes.
 *
 * Every route below `/` sits inside `RequireSession`, and each is wrapped
 * again with the permissions that make it useful. Both guards are a courtesy -
 * the backend enforces the same rules on every request - but they turn a
 * screen of failed panels into an honest "you do not have access to this".
 *
 * Screens are loaded lazily. A driver signing in on a phone in a yard should
 * download their task list, not the exception queue and the fleet register
 * first; each route becomes its own chunk, fetched when it is first visited.
 *
 * `/` redirects by ROLE rather than always to the dashboard: a driver holds no
 * permission the dashboard needs, so sending them there would land them on the
 * one screen they cannot open.
 */
import { Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { RequirePermission, RequireSession } from '@/auth/guards';
import { AppShell } from '@/layout/AppShell';
import { ActivatePage } from '@/pages/ActivatePage';
import { LoginPage } from '@/pages/LoginPage';
import { Permission, type PermissionKey } from '@/lib/permissions';
import { HomeRedirect } from './HomeRedirect';
import { RouteFallback } from './RouteFallback';

type PageComponent = () => React.JSX.Element;

/**
 * A lazily-loaded, permission-guarded route.
 *
 * The loader resolves the component itself, so pages keep their named exports
 * - no default-export shim per screen - while the dynamic import stays
 * statically analysable, which is what lets Vite split it into its own chunk.
 */
function lazyRoute(
  load: () => Promise<PageComponent>,
  anyOf: PermissionKey[],
): { lazy: () => Promise<{ element: React.JSX.Element }> } {
  return {
    lazy: async () => {
      const Component = await load();

      return {
        element: (
          <RequirePermission anyOf={anyOf}>
            <Suspense fallback={<RouteFallback />}>
              <Component />
            </Suspense>
          </RequirePermission>
        ),
      };
    },
  };
}

export const router = createBrowserRouter([
  // The two screens that work while signed out. Activation has to live here by
  // definition: somebody redeeming an invitation has no session yet.
  { path: '/login', element: <LoginPage /> },
  { path: '/activate', element: <ActivatePage /> },

  {
    path: '/',
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <HomeRedirect /> },

      {
        path: 'dashboard',
        ...lazyRoute(
          () => import('@/pages/DashboardPage').then((m) => m.DashboardPage),
          [Permission.SHIPMENT_READ],
        ),
      },
      {
        path: 'shipments',
        ...lazyRoute(
          () => import('@/pages/ShipmentsPage').then((m) => m.ShipmentsPage),
          [Permission.SHIPMENT_READ],
        ),
      },
      {
        path: 'shipments/:id',
        ...lazyRoute(
          () => import('@/pages/ShipmentDetailPage').then((m) => m.ShipmentDetailPage),
          /*
           * A DRIVER may open a shipment page for a stop on their own round,
           * so this accepts either key. The server narrows it the rest of the
           * way: `assertShipmentAccess` refuses a consignment that is not on
           * this driver's task list with a 404.
           */
          [Permission.SHIPMENT_READ, Permission.DRIVER_TASK_READ],
        ),
      },
      {
        // The legs of four-level journeys given to this company. Its own, only.
        path: 'legs',
        ...lazyRoute(() => import('@/pages/LegsPage').then((m) => m.LegsPage), [Permission.SHIPMENT_READ]),
      },
      {
        path: 'pickups',
        ...lazyRoute(
          () => import('@/pages/OperationsPages').then((m) => m.PickupsPage),
          [Permission.PICKUP_READ],
        ),
      },
      {
        path: 'dispatch',
        ...lazyRoute(
          () => import('@/pages/OperationsPages').then((m) => m.DispatchPage),
          [Permission.DISPATCH_READ],
        ),
      },
      {
        path: 'exceptions',
        ...lazyRoute(
          () => import('@/pages/OperationsPages').then((m) => m.ExceptionsPage),
          [Permission.SHIPMENT_READ],
        ),
      },
      {
        path: 'companies',
        ...lazyRoute(
          () => import('@/pages/CompaniesPage').then((m) => m.CompaniesPage),
          [Permission.COMPANY_READ],
        ),
      },
      {
        path: 'drivers',
        ...lazyRoute(
          () => import('@/pages/CompanyPages').then((m) => m.DriversPage),
          [Permission.DRIVER_READ, Permission.VEHICLE_READ],
        ),
      },
      {
        path: 'integration',
        ...lazyRoute(
          () => import('@/pages/IntegrationPage').then((m) => m.IntegrationPage),
          [Permission.INTEGRATION_READ],
        ),
      },
      {
        path: 'profile',
        ...lazyRoute(
          () => import('@/pages/ProfilePage').then((m) => m.ProfilePage),
          [Permission.ORGANISATION_READ],
        ),
      },
      {
        path: 'company',
        ...lazyRoute(
          () => import('@/pages/CompanyPages').then((m) => m.CompanyPage),
          [Permission.ORGANISATION_READ],
        ),
      },
      {
        path: 'driver/tasks',
        ...lazyRoute(
          () => import('@/pages/DriverTasksPage').then((m) => m.DriverTasksPage),
          [Permission.DRIVER_TASK_READ],
        ),
      },

      // Anything else inside the portal goes home rather than to a blank
      // screen. A 404 inside an application somebody is signed into is almost
      // always a stale link rather than a wrong address.
      { path: '*', element: <HomeRedirect /> },
    ],
  },
], {
  // Vite sets BASE_URL from `base` in vite.config.ts: "/" normally, and
  // "/logistics/" when the portal is served under a path - which is how all
  // three apps share one hostname through a single tunnel in development.
  basename: import.meta.env.BASE_URL,
});
