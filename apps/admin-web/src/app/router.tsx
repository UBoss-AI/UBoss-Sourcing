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
        // Its own path rather than `inventory/warehouses`, so it gets its own
        // highlighted row in the sidebar - `locateRoute` resolves the longest
        // match, and a nested path would keep Inventory lit instead.
        path: 'warehouses',
        ...lazyRoute(() => import('@/pages/WarehousesPage').then((m) => m.WarehousesPage), [
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
      /*
       * Companies - the three audiences grouped by the business they belong to.
       *
       * Declared before Customers because it is the way in: an operator asking
       * "who is this company" starts here and opens the customer, the seller or
       * the carrier from inside it. Guarded by CUSTOMER_READ or LOGISTICS_READ -
       * either one is enough to be shown the part of the tree it covers, and the
       * server decides which part that is.
       */
      {
        path: 'companies',
        ...lazyRoute(() => import('@/pages/CompaniesPage').then((m) => m.CompaniesPage), [
          Permission.CUSTOMER_READ,
          Permission.LOGISTICS_READ,
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
      /*
       * The marketplace's sellers.
       *
       * Guarded by CUSTOMER_READ and CUSTOMER_STATUS_WRITE rather than new
       * keys of their own: reviewing a business that wants to sell here is the
       * same kind of authority as activating or suspending an account, and the
       * role matrix an operator has already configured stays meaningful.
       */
      {
        path: 'sellers',
        ...lazyRoute(() => import('@/pages/SellersPage').then((m) => m.SellersPage), [
          Permission.CUSTOMER_READ,
        ]),
      },
      {
        // The approvals queue for which sellers may use which carriers.
        // Same permission as the seller screens next door: it is the same
        // kind of authority over the same businesses.
        path: 'seller-carriers',
        ...lazyRoute(
          () => import('@/pages/SellerCarriersPage').then((m) => m.SellerCarriersPage),
          [Permission.CUSTOMER_READ],
        ),
      },
      {
        path: 'sellers/:id',
        ...lazyRoute(() => import('@/pages/SellerDetailPage').then((m) => m.SellerDetailPage), [
          Permission.CUSTOMER_READ,
        ]),
      },
      /*
       * Brand requests.
       *
       * Catalogue work rather than seller work, and guarded as such: reading
       * the queue is PRODUCT_READ, and deciding one is PRODUCT_PUBLISH —
       * approving a name is what lets a product be sold under it, the same
       * authority as publishing the operator's own. Deliberately not
       * PRODUCT_WRITE, which a catalogue assistant may hold.
       */
      /*
       * Quality review of what sellers submit.
       *
       * Reading is PRODUCT_READ; the decision route behind it is
       * PRODUCT_PUBLISH, because approving a seller's listing is what puts it
       * on sale — the same authority as publishing the operator's own product.
       * The detail page is guarded at the same level as the queue: somebody who
       * may triage may also read what they are triaging.
       */
      {
        path: 'listing-review',
        ...lazyRoute(
          () => import('@/pages/ListingReviewQueuePage').then((m) => m.ListingReviewQueuePage),
          [Permission.PRODUCT_READ],
        ),
      },
      {
        path: 'listing-review/:id',
        ...lazyRoute(
          () => import('@/pages/ListingReviewPage').then((m) => m.ListingReviewPage),
          [Permission.PRODUCT_READ],
        ),
      },
      {
        path: 'brand-requests',
        ...lazyRoute(
          () => import('@/pages/BrandRequestsPage').then((m) => m.BrandRequestsPage),
          [Permission.PRODUCT_READ],
        ),
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
        path: 'data-requests',
        ...lazyRoute(
          () => import('@/pages/DataRequestsPage').then((m) => m.DataRequestsPage),
          [Permission.DATA_REQUEST_READ],
        ),
      },
      {
        path: 'manufacturers',
        ...lazyRoute(
          () => import('@/pages/ManufacturersPage').then((m) => m.ManufacturersPage),
          [Permission.PRODUCT_READ],
        ),
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

      /*
       * Logistics. Five screens, all behind LOGISTICS_READ at the least - the
       * narrower permissions (assigning work, changing a contract, touching a
       * carrier credential) are checked inside each page and again on every
       * request the backend serves.
       *
       * Static before dynamic here as elsewhere: nothing below would read
       * "partners" as an id, but keeping the order consistent is what stops
       * the next addition doing so.
       */
      {
        path: 'logistics/partners',
        ...lazyRoute(
          () => import('@/pages/logistics/PartnersPage').then((m) => m.LogisticsPartnersPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        path: 'logistics/partners/:id',
        ...lazyRoute(
          () =>
            import('@/pages/logistics/PartnerDetailPage').then(
              (m) => m.LogisticsPartnerDetailPage,
            ),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        path: 'logistics/shipments',
        ...lazyRoute(
          () => import('@/pages/logistics/ShipmentsPage').then((m) => m.LogisticsShipmentsPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        // Where the exception bell links to.
        path: 'logistics/shipments/:id',
        ...lazyRoute(
          () =>
            import('@/pages/logistics/ShipmentDetailPage').then(
              (m) => m.LogisticsShipmentDetailPage,
            ),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        path: 'logistics/exceptions',
        ...lazyRoute(
          () => import('@/pages/logistics/ExceptionsPage').then((m) => m.LogisticsExceptionsPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        path: 'logistics/integrations',
        ...lazyRoute(
          () =>
            import('@/pages/logistics/IntegrationsPage').then((m) => m.LogisticsIntegrationsPage),
          [Permission.LOGISTICS_READ],
        ),
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
      {
        path: 'settings/erp',
        ...lazyRoute(() => import('@/pages/ErpSettingsPage').then((m) => m.ErpSettingsPage), [
          Permission.INTEGRATION_READ,
        ]),
      },
      {
        // Support monitoring for CUSTOMERS' own ERP connections. A different
        // feature from `settings/erp` above, which is this installation's own
        // warehouse system - see that page's header for the distinction, and
        // this one's for what support deliberately cannot see or do.
        path: 'customer-erp',
        ...lazyRoute(() => import('@/pages/CustomerErpPage').then((m) => m.CustomerErpPage), [
          Permission.INTEGRATION_READ,
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
