/**
 * Routes.
 *
 * Every route below `/` sits inside `RequireAuth`, and each is wrapped again
 * with the permission that makes it useful. The guard is a courtesy — the
 * backend enforces the same rule on every request — but it turns a screen of
 * failed panels into an honest "you do not have access to this".
 *
 * Screens are loaded lazily. Shipping the whole panel in one bundle means
 * someone signing in to check an order downloads the product editor, the
 * import wizard and the reports engine first. Each route becomes its own
 * chunk, fetched when it is first visited.
 *
 * Order matters in one place: `products/import` is declared before
 * `products/:id`, so "import" is not read as a product id.
 */
import { Suspense } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import { RequireAuth, RequirePermission } from '@/auth/guards';
import { AppShell } from '@/layout/AppShell';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { LoginPage } from '@/pages/LoginPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { RouteFallback } from './RouteFallback';
import { Permission } from '@/lib/permissions';
import type { PermissionKey } from '@/lib/permissions';

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
  // The screens that work while signed out. Password recovery has to live here
  // by definition: somebody who cannot sign in cannot pass RequireAuth.
  { path: '/login', element: <LoginPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        ...lazyRoute(() => import('@/pages/DashboardPage').then((m) => m.DashboardPage), []),
      },
      {
        path: 'categories',
        ...lazyRoute(() => import('@/pages/CategoriesPage').then((m) => m.CategoriesPage), [
          Permission.CATEGORY_READ,
        ]),
      },
      {
        path: 'products',
        ...lazyRoute(() => import('@/pages/ProductsPage').then((m) => m.ProductsPage), [Permission.PRODUCT_READ]),
      },
      {
        // Static before dynamic: "import" must not be read as a product id.
        path: 'products/import',
        ...lazyRoute(() => import('@/pages/ProductImportPage').then((m) => m.ProductImportPage), [
          Permission.PRODUCT_IMPORT,
        ]),
      },
      {
        path: 'products/:id',
        ...lazyRoute(() => import('@/pages/ProductDetailPage').then((m) => m.ProductDetailPage), [
          Permission.PRODUCT_READ,
        ]),
      },
      {
        path: 'coupons',
        ...lazyRoute(() => import('@/pages/CouponsPage').then((m) => m.CouponsPage), [
          Permission.COUPON_READ,
        ]),
      },
      {
        path: 'inventory',
        ...lazyRoute(() => import('@/pages/InventoryPage').then((m) => m.InventoryPage), [
          Permission.INVENTORY_READ,
        ]),
      },
      {
        path: 'orders',
        ...lazyRoute(() => import('@/pages/OrdersPage').then((m) => m.OrdersPage), [Permission.ORDER_READ]),
      },
      {
        path: 'orders/:id',
        ...lazyRoute(() => import('@/pages/OrderDetailPage').then((m) => m.OrderDetailPage), [
          Permission.ORDER_READ,
        ]),
      },
      {
        path: 'payments',
        ...lazyRoute(() => import('@/pages/PaymentsPage').then((m) => m.PaymentsPage), [Permission.PAYMENT_READ]),
      },
      {
        path: 'recurring',
        ...lazyRoute(() => import('@/pages/RecurringPage').then((m) => m.RecurringPage), [
          Permission.SCHEDULE_READ,
        ]),
      },
      {
        path: 'customers',
        ...lazyRoute(() => import('@/pages/CustomersPage').then((m) => m.CustomersPage), [
          Permission.CUSTOMER_READ,
        ]),
      },
      {
        path: 'customers/:id',
        ...lazyRoute(() => import('@/pages/CustomerDetailPage').then((m) => m.CustomerDetailPage), [
          Permission.CUSTOMER_READ,
        ]),
      },
      {
        path: 'chat-enquiries',
        ...lazyRoute(() => import('@/pages/ChatEnquiriesPage').then((m) => m.ChatEnquiriesPage), [
          Permission.ASSISTANT_CHAT_READ,
        ]),
      },
      {
        path: 'reports',
        ...lazyRoute(() => import('@/pages/ReportsPage').then((m) => m.ReportsPage), [Permission.REPORT_READ]),
      },
      {
        path: 'audit',
        ...lazyRoute(() => import('@/pages/AuditPage').then((m) => m.AuditPage), [Permission.AUDIT_READ]),
      },
      {
        path: 'integrations',
        ...lazyRoute(() => import('@/pages/IntegrationsPage').then((m) => m.IntegrationsPage), [
          Permission.INTEGRATION_READ,
          Permission.PAYMENT_GATEWAY_WRITE,
        ]),
      },
      {
        path: 'staff',
        ...lazyRoute(() => import('@/pages/StaffPage').then((m) => m.StaffPage), [Permission.STAFF_READ]),
      },
      {
        path: 'settings',
        ...lazyRoute(() => import('@/pages/SettingsPage').then((m) => m.SettingsPage), [
          Permission.SETTINGS_READ,
        ]),
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
], {
  // Vite sets BASE_URL from `base` in vite.config.ts: "/" normally, and
  // "/admin/" when this panel is served under a path - which is how both
  // apps share one hostname through a single tunnel.
  basename: import.meta.env.BASE_URL,
});
