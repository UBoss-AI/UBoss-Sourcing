/**
 * Routes.
 *
 * Every route below `/` sits inside `RequireSession`, and each is wrapped
 * again with the permissions that make it useful. Both guards are a courtesy -
 * the backend enforces the same rules on every request - but they turn a
 * screen of failed panels into an honest "you do not have access to this".
 *
 * Screens are loaded lazily: each route becomes its own chunk, fetched when it
 * is first visited, so an inspector signing in on a tablet downloads the job
 * list and not the rule editor.
 *
 * `/` redirects by ROLE rather than always to the dashboard: an inspector
 * holds no permission the dashboard needs. See `HomeRedirect`.
 */
import { Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { RequirePermission, RequireSession } from '@/auth/guards';
import { AppShell } from '@/layout/AppShell';
import { ActivatePage } from '@/pages/ActivatePage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { LoginPage } from '@/pages/LoginPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { Permission, type PermissionKey } from '@/lib/permissions';
import { HomeRedirect } from './HomeRedirect';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';
import { RouteFallback } from './RouteFallback';

type PageComponent = () => React.JSX.Element;

/**
 * A lazily-loaded, permission-guarded route.
 *
 * The loader resolves the component itself, so pages keep their named exports
 * while the dynamic import stays statically analysable, which is what lets
 * Vite split it into its own chunk.
 */
function lazyRoute(
  load: () => Promise<PageComponent>,
  anyOf: PermissionKey[],
): { errorElement: React.JSX.Element; lazy: () => Promise<{ element: React.JSX.Element }> } {
  return {
    // In place before the screen's file is fetched: a file that cannot be
    // fetched is one of the things it catches. Renders inside the shell.
    errorElement: <RouteErrorPage />,
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

const JOB_SCREENS: PermissionKey[] = [Permission.JOB_READ, Permission.JOB_OVERSEE];

export const router = createBrowserRouter(
  [
    // The screens that work while signed out. Activation and password reset
    // have to live here by definition: the person has no session yet.
    { path: '/login', element: <LoginPage />, errorElement: <RouteErrorPage fullScreen /> },
    { path: '/activate', element: <ActivatePage />, errorElement: <RouteErrorPage fullScreen /> },
    {
      path: '/forgot-password',
      element: <ForgotPasswordPage />,
      errorElement: <RouteErrorPage fullScreen />,
    },
    {
      path: '/reset-password',
      element: <ResetPasswordPage />,
      errorElement: <RouteErrorPage fullScreen />,
    },

    {
      path: '/',
      element: (
        <RequireSession>
          <AppShell />
        </RequireSession>
      ),
      // Fills the screen: this one only renders when the shell itself failed.
      errorElement: <RouteErrorPage fullScreen />,
      children: [
        { index: true, element: <HomeRedirect /> },

        {
          path: 'dashboard',
          ...lazyRoute(
            () => import('@/pages/DashboardPage').then((m) => m.DashboardPage),
            [Permission.DASHBOARD_READ],
          ),
        },

        // --- Verification ------------------------------------------------
        {
          path: 'seller-verification',
          ...lazyRoute(
            () => import('@/pages/seller-verification/SellerVerificationQueuePage').then((m) => m.SellerVerificationQueuePage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'seller-verification/:id',
          ...lazyRoute(
            () => import('@/pages/seller-verification/SellerVerificationDetailPage').then((m) => m.SellerVerificationDetailPage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'sellers',
          ...lazyRoute(
            () => import('@/pages/SellersPage').then((m) => m.SellersPage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'sellers/:id',
          ...lazyRoute(
            () => import('@/pages/SellersPage').then((m) => m.SellerDetailPage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'products',
          ...lazyRoute(
            () => import('@/pages/ProductsPage').then((m) => m.ProductsPage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'products/:caseId',
          ...lazyRoute(
            () => import('@/pages/ProductsPage').then((m) => m.ProductCasePage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'cases/:id',
          ...lazyRoute(
            () => import('@/pages/CasePage').then((m) => m.CasePage),
            [Permission.SELLER_READ],
          ),
        },
        {
          path: 'documents',
          ...lazyRoute(
            () => import('@/pages/DocumentsPage').then((m) => m.DocumentsPage),
            [Permission.DOCUMENT_READ],
          ),
        },

        // --- Inspection --------------------------------------------------
        {
          path: 'jobs',
          ...lazyRoute(() => import('@/pages/JobsPage').then((m) => m.JobsPage), JOB_SCREENS),
        },
        {
          path: 'jobs/:id',
          ...lazyRoute(() => import('@/pages/JobDetailPage').then((m) => m.JobDetailPage), JOB_SCREENS),
        },
        {
          path: 'calendar',
          ...lazyRoute(
            () => import('@/pages/CalendarPage').then((m) => m.CalendarPage),
            [Permission.JOB_READ],
          ),
        },
        {
          path: 'reports',
          ...lazyRoute(() => import('@/pages/ReportsPage').then((m) => m.ReportsPage), JOB_SCREENS),
        },
        {
          path: 'insights',
          ...lazyRoute(() => import('@/pages/InsightsPage').then((m) => m.InsightsPage), [Permission.JOB_OVERSEE]),
        },
        {
          path: 'corrective-actions',
          ...lazyRoute(
            () => import('@/pages/CorrectiveActionsPage').then((m) => m.CorrectiveActionsPage),
            JOB_SCREENS,
          ),
        },

        // --- Standards ---------------------------------------------------
        {
          path: 'rules',
          ...lazyRoute(
            () => import('@/pages/RulesPage').then((m) => m.RulesPage),
            [Permission.RULE_READ],
          ),
        },
        {
          path: 'checklists',
          ...lazyRoute(
            () => import('@/pages/ChecklistsPage').then((m) => m.ChecklistsPage),
            [Permission.CHECKLIST_MANAGE],
          ),
        },

        // --- People ------------------------------------------------------
        {
          path: 'team',
          ...lazyRoute(
            () => import('@/pages/TeamPage').then((m) => m.TeamPage),
            [Permission.MEMBER_WRITE, Permission.TEAM_READ],
          ),
        },
        // Every member, so no permission is listed.
        {
          path: 'profile',
          ...lazyRoute(() => import('@/pages/ProfilePage').then((m) => m.ProfilePage), []),
        },

        // Anything else inside the console is a 404 in the console's own frame.
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  {
    // Vite sets BASE_URL from `base` in vite.config.ts: "/" normally, and
    // "/audit/" when the console is served under a path.
    basename: import.meta.env.BASE_URL,
  },
);
