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
import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth, RequirePermission } from '@/auth/guards';
import { AppShell } from '@/layout/AppShell';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { LoginPage } from '@/pages/LoginPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';
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
): { errorElement: React.JSX.Element; lazy: () => Promise<{ element: React.JSX.Element }> } {
  return {
    // Declared beside `lazy` rather than returned by it, so it is in place
    // before the screen's file is fetched: a file that cannot be fetched is
    // one of the things it catches. Renders inside the shell.
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

export const router = createBrowserRouter([
  // The screens that work while signed out. Password recovery has to live here
  // by definition: somebody who cannot sign in cannot pass RequireAuth.
  { path: '/login', element: <LoginPage />, errorElement: <RouteErrorPage fullScreen /> },
  { path: '/forgot-password', element: <ForgotPasswordPage />, errorElement: <RouteErrorPage fullScreen /> },
  { path: '/reset-password', element: <ResetPasswordPage />, errorElement: <RouteErrorPage fullScreen /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    // Fills the screen: this one only renders when the shell itself failed.
    errorElement: <RouteErrorPage fullScreen />,
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
        path: 'quantity-discounts',
        ...lazyRoute(
          () => import('@/pages/QuantityDiscountsPage').then((m) => m.QuantityDiscountsPage),
          [Permission.COUPON_READ],
        ),
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
        path: 'preorders',
        ...lazyRoute(() => import('@/pages/PreordersPage').then((m) => m.PreordersPage), [Permission.ORDER_READ]),
      },
      {
        path: 'preorders/:id',
        ...lazyRoute(() => import('@/pages/PreorderDetailPage').then((m) => m.PreorderDetailPage), [
          Permission.ORDER_READ,
        ]),
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
       * Buyer-company verification: the review queue, and one application.
       * `:id` is what the "submitted" and "responded" notifications link to.
       */
      {
        path: 'buyer-companies',
        ...lazyRoute(
          () => import('@/pages/buyer-companies/BuyerCompaniesPage').then((m) => m.BuyerCompaniesPage),
          [Permission.BUYER_COMPANY_READ],
        ),
      },
      {
        path: 'buyer-companies/:id',
        ...lazyRoute(
          () =>
            import('@/pages/buyer-companies/BuyerCompanyDetailPage').then((m) => m.BuyerCompanyDetailPage),
          [Permission.BUYER_COMPANY_READ],
        ),
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
        // Buyers' product reviews, and hiding one that breaks the rules.
        path: 'product-reviews',
        ...lazyRoute(
          () => import('@/pages/ProductReviewsPage').then((m) => m.ProductReviewsPage),
          [Permission.REVIEW_READ],
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
        path: 'preorder-chats',
        ...lazyRoute(() => import('@/pages/preorder-chat/PreorderChatsPage').then((m) => m.PreorderChatsPage), [
          Permission.PREORDER_CHAT_VIEW,
        ]),
      },
      {
        // The notification bell and the assignment email link here.
        path: 'preorder-chats/:id',
        ...lazyRoute(() => import('@/pages/preorder-chat/PreorderChatsPage').then((m) => m.PreorderChatsPage), [
          Permission.PREORDER_CHAT_VIEW,
        ]),
      },
      {
        // Support -> Tickets. The bell and the new-ticket email link to :id.
        path: 'support',
        ...lazyRoute(() => import('@/pages/support/SupportTicketsPage').then((m) => m.SupportTicketsPage), [
          Permission.SUPPORT_TICKET_VIEW,
        ]),
      },
      {
        path: 'support/:id',
        ...lazyRoute(() => import('@/pages/support/SupportTicketsPage').then((m) => m.SupportTicketDetailPage), [
          Permission.SUPPORT_TICKET_VIEW,
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
      // The inspection console (checklist Master rows 55, 70, 94).
      {
        path: 'inspection',
        ...lazyRoute(() => import('@/pages/inspection/InspectionConsolePages').then((m) => m.InspectionQueuePage), [Permission.INSPECTION_READ]),
      },
      {
        path: 'inspection/:id',
        ...lazyRoute(() => import('@/pages/inspection/InspectionConsolePages').then((m) => m.InspectionRequirementPage), [Permission.INSPECTION_READ]),
      },
      {
        path: 'inspection-setup',
        ...lazyRoute(() => import('@/pages/inspection/InspectionConsolePages').then((m) => m.InspectionSetupPage), [Permission.INSPECTION_READ]),
      },
      // The dispute resolution console (checklist Master row 64).
      {
        path: 'disputes',
        ...lazyRoute(() => import('@/pages/disputes/DisputeConsolePages').then((m) => m.DisputeQueuePage), [Permission.DISPUTE_VIEW]),
      },
      {
        path: 'disputes/:id',
        ...lazyRoute(() => import('@/pages/disputes/DisputeConsolePages').then((m) => m.DisputeCasePage), [Permission.DISPUTE_VIEW]),
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
        // Above the carrier register, because this is the wider question -
        // every way anything gets delivered - and the register is one answer
        // to it.
        path: 'logistics/delivery-catalogue',
        ...lazyRoute(
          () =>
            import('@/pages/logistics/DeliveryCataloguePage').then(
              (m) => m.DeliveryCataloguePage,
            ),
          [Permission.LOGISTICS_READ],
        ),
      },
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
        // Every seller's L1-L4 ownership, and the UBOSS-managed prices.
        path: 'logistics/managed-levels',
        ...lazyRoute(
          () => import('@/pages/logistics/ManagedLevelsPage').then((m) => m.ManagedLevelsPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        path: 'logistics/managed-levels/:sellerAccountId',
        ...lazyRoute(
          () => import('@/pages/logistics/ManagedLevelSellerPage').then((m) => m.ManagedLevelSellerPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        // The four legs of confirmed seller orders.
        path: 'logistics/legs',
        ...lazyRoute(
          () => import('@/pages/logistics/LegsPage').then((m) => m.LegsPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        path: 'logistics/legs/:legId',
        ...lazyRoute(
          () => import('@/pages/logistics/LegsPage').then((m) => m.LegDetailPage),
          [Permission.LOGISTICS_READ],
        ),
      },
      {
        // What sellers are charged and the tax on it. Finance only.
        path: 'finance/platform-fees',
        ...lazyRoute(
          () => import('@/pages/finance/PlatformFeesPage').then((m) => m.PlatformFeesPage),
          [Permission.FINANCE_POLICY_READ],
        ),
      },
      {
        // Value bands, volume tiers, seller tiers and promotions on top of the fee policy.
        // Drafted by one person, approved by another. Finance only.
        path: 'finance/fee-rules',
        ...lazyRoute(
          () => import('@/pages/finance/FeeRulesPage').then((m) => m.FeeRulesPage),
          [Permission.FINANCE_POLICY_READ],
        ),
      },
      {
        // The operator's commission invoices to sellers, their credit notes and settings.
        path: 'finance/commission-invoices',
        ...lazyRoute(
          () => import('@/pages/finance/CommissionInvoicesPage').then((m) => m.CommissionInvoicesPage),
          [Permission.COMMISSION_INVOICE_VIEW],
        ),
      },
      {
        path: 'finance/commission-invoices/:id',
        ...lazyRoute(
          () => import('@/pages/finance/CommissionInvoiceDetailPage').then((m) => m.CommissionInvoiceDetailPage),
          [Permission.COMMISSION_INVOICE_VIEW],
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
        // The dead-letter queues the dashboard counts. settings.read, the grant
        // the dashboard queue itself uses; retrying needs settings.write.
        path: 'operations/dead-jobs',
        ...lazyRoute(() => import('@/pages/DeadLetterPage').then((m) => m.DeadJobsPage), [
          Permission.SETTINGS_READ,
        ]),
      },
      {
        path: 'operations/failed-notifications',
        ...lazyRoute(() => import('@/pages/DeadLetterPage').then((m) => m.FailedNotificationsPage), [
          Permission.SETTINGS_READ,
        ]),
      },
      {
        // The Terms and Conditions every new account agrees to: drafts, publishing, history.
        path: 'settings/legal-documents',
        ...lazyRoute(
          () => import('@/pages/settings/LegalDocumentsPage').then((m) => m.LegalDocumentsPage),
          [Permission.LEGAL_DOCUMENT_READ],
        ),
      },
      {
        path: 'settings/legal-documents/new',
        ...lazyRoute(
          () => import('@/pages/settings/LegalDocumentsPage').then((m) => m.LegalDocumentEditorPage),
          [Permission.LEGAL_DOCUMENT_WRITE],
        ),
      },
      {
        path: 'settings/legal-documents/:id',
        ...lazyRoute(
          () => import('@/pages/settings/LegalDocumentsPage').then((m) => m.LegalDocumentEditorPage),
          [Permission.LEGAL_DOCUMENT_READ],
        ),
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
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  // Vite sets BASE_URL from `base` in vite.config.ts: "/" normally, and
  // "/admin/" when this panel is served under a path - which is how both
  // apps share one hostname through a single tunnel.
  basename: import.meta.env.BASE_URL,
});
