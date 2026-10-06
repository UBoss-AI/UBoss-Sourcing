/**
 * The navigation map.
 *
 * One list, grouped, each item naming the permission that makes it useful. An
 * item whose permission the signed-in user lacks is not rendered - not
 * disabled, not greyed out. A visible-but-dead control invites a support
 * ticket; an absent one says the job is not theirs.
 *
 * This is presentation only. Every route behind these links is enforced by the
 * backend regardless of what the sidebar shows.
 */
import {
  AlertTriangleIcon,
  AuditIcon,
  BrandRequestIcon,
  CarrierIcon,
  CategoriesIcon,
  ChatIcon,
  CompaniesIcon,
  BuyerVerificationIcon,
  CouponsIcon,
  QuantityDiscountIcon,
  CustomersIcon,
  DashboardIcon,
  DataProtectionIcon,
  HeadsetIcon,
  ManufacturerIcon,
  IntegrationsIcon,
  InventoryIcon,
  ListingReviewIcon,
  LogisticsIcon,
  OrdersIcon,
  PaymentsIcon,
  CommissionInvoiceIcon,
  LegalDocumentIcon,
  ProductsIcon,
  PreordersIcon,
  RecurringIcon,
  ReportsIcon,
  ReviewStarIcon,
  SellerIcon,
  SettingsIcon,
  StaffIcon,
  WarehouseIcon,
} from '@/components/icons';
import { Permission } from '@/lib/permissions';
import type { ParseKeys } from 'i18next';
import type { IconComponent } from '@/components/icons';
import type { PermissionKey } from '@/lib/permissions';
import type { AttentionKey } from '@/lib/attention';

/**
 * A row in the sidebar.
 *
 * The label is a message key, not a string: this module is plain data with no
 * hooks in it, and resolving the text here would mean either freezing it in
 * one language at import time or turning the navigation map into a component.
 * The shell translates each key as it renders the row.
 */
export interface NavItem {
  labelKey: ParseKeys;
  to: string;
  /**
   * The row's silhouette. Decoration in the strict sense — every icon here is
   * `aria-hidden` and the label carries the meaning — but in a fourteen-row
   * column it is what lets a daily user aim at "Payments" without reading.
   */
  icon: IconComponent;
  /** Any one of these grants visibility. */
  permissions: PermissionKey[];
  /** Matches child routes too, so /products/:id keeps Products highlighted. */
  matchPrefix?: boolean;
  /**
   * The queue whose backlog this row is badged with, if any.
   *
   * Presentation again: the count comes from `/admin/attention`, which decides
   * for itself whether the caller may see it. A row keyed here for a queue the
   * user has no grant for simply gets no badge - the key is absent from the
   * response rather than zero, so nothing has to be hidden afterwards.
   *
   * Several rows may share a key and one row may draw more than one, which is
   * why `attentionKeys` is a list: the Sellers row carries both undecided
   * applications and undecided certificates, because both are worked from the
   * same screen and two badges on one row is two badges too many.
   */
  attentionKeys?: AttentionKey[];
}

export interface NavGroup {
  labelKey: ParseKeys;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    labelKey: 'nav.group.overview',
    items: [{ labelKey: 'nav.dashboard', to: '/', icon: DashboardIcon, permissions: [] }],
  },
  {
    labelKey: 'nav.group.catalogue',
    items: [
      {
        labelKey: 'nav.categories',
        to: '/categories',
        icon: CategoriesIcon,
        permissions: [Permission.CATEGORY_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.products',
        to: '/products',
        icon: ProductsIcon,
        permissions: [Permission.PRODUCT_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.inventory',
        to: '/inventory',
        icon: InventoryIcon,
        permissions: [Permission.INVENTORY_READ],
        matchPrefix: true,
      },
      {
        // Directly under Inventory, because the two are read together: the
        // stock figures on that screen are per warehouse, and this is where
        // the warehouses themselves come from.
        labelKey: 'nav.warehouses',
        to: '/warehouses',
        icon: WarehouseIcon,
        permissions: [Permission.INVENTORY_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.coupons',
        to: '/coupons',
        icon: CouponsIcon,
        permissions: [Permission.COUPON_READ],
        matchPrefix: true,
      },
      {
        // Beside Coupons: both are discounts the store funds, decided by the
        // same people under the same permission.
        labelKey: 'nav.quantityDiscounts',
        to: '/quantity-discounts',
        icon: QuantityDiscountIcon,
        permissions: [Permission.COUPON_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.manufacturers',
        to: '/manufacturers',
        icon: ManufacturerIcon,
        permissions: [Permission.PRODUCT_READ],
        matchPrefix: true,
      },
      {
        // In Catalogue, not beside Sellers. What arrives in this queue is a
        // product somebody is offering the marketplace, and approving one puts
        // it on the shelf — it is the same work as publishing, done for
        // somebody else's goods.
        labelKey: 'nav.listingReview',
        to: '/listing-review',
        icon: ListingReviewIcon,
        permissions: [Permission.PRODUCT_READ],
        matchPrefix: true,
        attentionKeys: ['listingReview'],
      },
      {
        // Directly under it, because the two are worked together: a listing is
        // often sent back for the brand, and a brand is often approved because
        // of the listing waiting on it.
        labelKey: 'nav.brandRequests',
        to: '/brand-requests',
        icon: BrandRequestIcon,
        permissions: [Permission.PRODUCT_READ],
        matchPrefix: true,
        attentionKeys: ['brandRequests'],
      },
      {
        // What buyers said about products they received. In Catalogue because
        // hiding a review changes how a product is presented, the same remit
        // as publishing it.
        labelKey: 'nav.productReviews',
        to: '/product-reviews',
        icon: ReviewStarIcon,
        permissions: [Permission.REVIEW_READ],
        matchPrefix: true,
      },
      {
        // Messages buyers and sellers reported as abusive. Beside reviews:
        // the same moderation remit and the same grant.
        labelKey: 'nav.messageReports',
        to: '/message-reports',
        icon: ReviewStarIcon,
        permissions: [Permission.REVIEW_READ],
        matchPrefix: true,
      },
    ],
  },
  {
    labelKey: 'nav.group.sales',
    items: [
      {
        labelKey: 'nav.orders',
        to: '/orders',
        icon: OrdersIcon,
        permissions: [Permission.ORDER_READ],
        matchPrefix: true,
        attentionKeys: ['orderApprovals'],
      },
      {
        labelKey: 'nav.payments',
        to: '/payments',
        icon: PaymentsIcon,
        permissions: [Permission.PAYMENT_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.recurring',
        to: '/recurring',
        icon: RecurringIcon,
        permissions: [Permission.SCHEDULE_READ],
        matchPrefix: true,
      },
      {
        // Read-only: support and audit of bulk negotiations between buyers
        // and sellers. Gated on the same permission that reads orders.
        labelKey: 'nav.preorders',
        to: '/preorders',
        icon: PreordersIcon,
        permissions: [Permission.ORDER_READ],
        matchPrefix: true,
      },
      {
        /*
         * Above Customers and Sellers rather than beside them, because it is
         * the way into both: an operator asking "who is this business" starts
         * here and opens the buying account, the seller application or the
         * carrier from inside the company it belongs to.
         */
        labelKey: 'nav.companies',
        to: '/companies',
        icon: CompaniesIcon,
        permissions: [Permission.CUSTOMER_READ, Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.customers',
        to: '/customers',
        icon: CustomersIcon,
        permissions: [Permission.CUSTOMER_READ],
        matchPrefix: true,
        attentionKeys: ['customerApprovals'],
      },
      {
        /*
         * Businesses applying to buy in their own name. Directly under
         * Customers, because a verified company is a kind of customer, and
         * beside Sellers, whose review is the same kind of work done for the
         * other side of the marketplace. Its own grant: verifying a buyer is
         * credit work, not general account admin.
         */
        labelKey: 'nav.buyerCompanies',
        to: '/buyer-companies',
        icon: BuyerVerificationIcon,
        permissions: [Permission.BUYER_COMPANY_READ],
        matchPrefix: true,
      },
      {
        // Directly under Customers, because the two are the same kind of work:
        // both are businesses with accounts here, and the person who reviews
        // one usually reviews the other.
        labelKey: 'nav.sellers',
        to: '/sellers',
        icon: SellerIcon,
        permissions: [Permission.CUSTOMER_READ],
        matchPrefix: true,
        // Both, because both are decided on the seller's own screen: an
        // application nobody has ruled on, and a certificate nobody has
        // accepted.
        attentionKeys: ['sellerApplications', 'sellerDocuments'],
      },
      {
        // Changes to verified company details sellers asked for after approval.
        labelKey: 'nav.sellerCompanyChanges',
        to: '/seller-company-changes',
        icon: SellerIcon,
        permissions: [Permission.CUSTOMER_READ],
        matchPrefix: true,
      },
      {
        // Beside Sellers, because it is a decision about a seller.
        labelKey: 'nav.sellerCarriers',
        to: '/seller-carriers',
        icon: SellerIcon,
        permissions: [Permission.CUSTOMER_READ],
        matchPrefix: true,
      },
      {
        /*
         * Customers asking the team about a preorder, from a product page. Not
         * the AI widget's enquiries below it: these are signed-in buyers with
         * a product in hand, answered by a person, live. Badged with the
         * conversations still waiting for an answer.
         */
        labelKey: 'nav.preorderChats',
        to: '/preorder-chats',
        icon: ChatIcon,
        permissions: [Permission.PREORDER_CHAT_VIEW],
        matchPrefix: true,
        attentionKeys: ['preorderChats'],
      },
      {
        labelKey: 'nav.chatEnquiries',
        to: '/chat-enquiries',
        icon: ChatIcon,
        permissions: [Permission.ASSISTANT_CHAT_READ],
        matchPrefix: true,
      },
    ],
  },
  {
    /*
     * Support tickets raised from the Support page by buyers, sellers and
     * logistics partners. Its own group, because answering them is a desk of
     * its own rather than one more row under Sales.
     */
    labelKey: 'nav.group.support',
    items: [
      {
        labelKey: 'nav.supportTickets',
        to: '/support',
        icon: HeadsetIcon,
        permissions: [Permission.SUPPORT_TICKET_VIEW],
        matchPrefix: true,
      },
    ],
  },
  {
    /*
     * Its own group rather than three more rows under Sales. Carriage is a
     * separate operation with its own desk: the person chasing a stuck parcel
     * is rarely the person chasing a payment, and burying the exception queue
     * eleven rows down a "Sales" column is how it stops being looked at.
     */
    labelKey: 'nav.group.logistics',
    items: [
      {
        labelKey: 'nav.logisticsShipments',
        to: '/logistics/shipments',
        icon: LogisticsIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.logisticsExceptions',
        to: '/logistics/exceptions',
        icon: AlertTriangleIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
        attentionKeys: ['logisticsExceptions'],
      },
      {
        /*
         * Above the carrier register on purpose.
         *
         * This is the whole picture - every provider, every delivery company
         * across every seller, and what is waiting for a decision. The
         * register below it is one slice. An operator who meets the narrow
         * screen first has to work out that the wide one exists.
         */
        labelKey: 'nav.deliveryCatalogue',
        to: '/logistics/delivery-catalogue',
        icon: CarrierIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        // The operator's own rate cards (Master row 71).
        labelKey: 'nav.rateCards',
        to: '/logistics/rate-cards',
        icon: CarrierIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.logisticsPartners',
        to: '/logistics/partners',
        icon: CarrierIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        // Beside the carriers rather than under Administration: a connection
        // here is one carrier's API, not a deployment-wide setting, and the
        // person configuring it has the carrier's record open already.
        labelKey: 'nav.logisticsIntegrations',
        to: '/logistics/integrations',
        icon: IntegrationsIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        // Who controls L1-L4 for each seller, and the prices UBOSS sets.
        labelKey: 'nav.managedLevels',
        to: '/logistics/managed-levels',
        icon: LogisticsIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.deliveryLegs',
        to: '/logistics/legs',
        icon: LogisticsIcon,
        permissions: [Permission.LOGISTICS_READ],
        matchPrefix: true,
      },
    ],
  },
  {
    /*
     * Finance is its own group because its authority is its own: a general
     * administrator does not hold `finance.policy.*` and does not see it.
     */
    labelKey: 'nav.group.finance',
    items: [
      {
        labelKey: 'nav.platformFees',
        to: '/finance/platform-fees',
        icon: PaymentsIcon,
        permissions: [Permission.FINANCE_POLICY_READ],
        matchPrefix: true,
      },
      {
        // Bands, tiers and promotions on top of the platform fee.
        labelKey: 'nav.feeRules',
        to: '/finance/fee-rules',
        icon: PaymentsIcon,
        permissions: [Permission.FINANCE_POLICY_READ],
        matchPrefix: true,
      },
      {
        // The operator's own invoices to sellers for the platform commission.
        labelKey: 'nav.commissionInvoices',
        to: '/finance/commission-invoices',
        icon: CommissionInvoiceIcon,
        permissions: [Permission.COMMISSION_INVOICE_VIEW],
        matchPrefix: true,
      },
      {
        // Where every order's money is: held, released, refunded, paid out.
        labelKey: 'nav.ledger',
        to: '/finance/ledger',
        icon: CommissionInvoiceIcon,
        permissions: [Permission.PAYMENT_READ],
        matchPrefix: true,
      },
    ],
  },
  {
    labelKey: 'nav.group.insight',
    items: [
      {
        labelKey: 'nav.reports',
        to: '/reports',
        icon: ReportsIcon,
        permissions: [Permission.REPORT_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.auditLog',
        to: '/audit',
        icon: AuditIcon,
        permissions: [Permission.AUDIT_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.inspection',
        to: '/inspection',
        icon: DataProtectionIcon,
        permissions: [Permission.INSPECTION_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.auditConsole',
        to: '/audit-console',
        icon: AuditIcon,
        permissions: [Permission.AUDIT_CONSOLE_MANAGE],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.disputes',
        to: '/disputes',
        icon: DataProtectionIcon,
        permissions: [Permission.DISPUTE_VIEW],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.dataRequests',
        to: '/data-requests',
        icon: DataProtectionIcon,
        permissions: [Permission.DATA_REQUEST_READ],
        matchPrefix: true,
        attentionKeys: ['dataRequests'],
      },
      {
        labelKey: 'nav.risk',
        to: '/risk',
        icon: DataProtectionIcon,
        permissions: [Permission.RISK_READ],
        matchPrefix: true,
      },
    ],
  },
  {
    labelKey: 'nav.group.administration',
    items: [
      {
        labelKey: 'nav.integrations',
        to: '/integrations',
        icon: IntegrationsIcon,
        permissions: [Permission.INTEGRATION_READ, Permission.PAYMENT_GATEWAY_WRITE],
        matchPrefix: true,
      },
      {
        // Customers' own ERP connections, for support. Its own entry rather
        // than a tab inside Integrations because the two answer different
        // questions - "is our gateway configured" against "is that customer's
        // SAP reachable" - and somebody looking for the second would not think
        // to open the first.
        labelKey: 'nav.customerErp',
        to: '/customer-erp',
        icon: IntegrationsIcon,
        permissions: [Permission.INTEGRATION_READ],
        matchPrefix: true,
      },
      {
        // Every exception queue with its SLA and owner role (LIVE-011). Each
        // queue on the page is filtered by its own grant, so any member of
        // staff may open it.
        labelKey: 'nav.exceptionQueues',
        to: '/operations/exception-queues',
        icon: AlertTriangleIcon,
        permissions: [],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.staff',
        to: '/staff',
        icon: StaffIcon,
        permissions: [Permission.STAFF_READ],
        matchPrefix: true,
      },
      {
        // Country / compliance rules (Master row 69). Before Settings so the
        // longer path is its own entry.
        labelKey: 'nav.countryRules',
        to: '/settings/country-rules',
        icon: SettingsIcon,
        permissions: [Permission.SETTINGS_READ],
        matchPrefix: true,
      },
      {
        // Trade rules, HS code verification and cargo insurance (JOURNEY-046, 049).
        labelKey: 'nav.tradeCompliance',
        to: '/settings/trade-compliance',
        icon: SettingsIcon,
        permissions: [Permission.SETTINGS_READ],
        matchPrefix: true,
      },
      {
        // Storefront banners and category blocks (Master row 72).
        labelKey: 'nav.storefrontContent',
        to: '/settings/content',
        icon: CouponsIcon,
        permissions: [Permission.SETTINGS_READ],
        matchPrefix: true,
      },
      {
        // The Terms and Conditions new accounts agree to. Before Settings so
        // the longer path is its own entry rather than a child of /settings.
        labelKey: 'nav.legalDocuments',
        to: '/settings/legal-documents',
        icon: LegalDocumentIcon,
        permissions: [Permission.LEGAL_DOCUMENT_READ],
        matchPrefix: true,
      },
      {
        // Before Settings, like legal documents, so each is its own entry.
        labelKey: 'nav.masterData',
        to: '/settings/master-data',
        icon: SettingsIcon,
        permissions: [Permission.SETTINGS_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.notificationTemplates',
        to: '/settings/notification-templates',
        icon: SettingsIcon,
        permissions: [Permission.SETTINGS_READ],
        matchPrefix: true,
      },
      {
        labelKey: 'nav.settings',
        to: '/settings',
        icon: SettingsIcon,
        permissions: [Permission.SETTINGS_READ],
        matchPrefix: true,
      },
    ],
  },
];

/** Groups with at least one visible item, for the signed-in user. */
export function visibleNavigation(can: (permission: PermissionKey) => boolean): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        item.permissions.length === 0 || item.permissions.some((permission) => can(permission)),
    ),
  })).filter((group) => group.items.length > 0);
}

export interface RouteLocation {
  group: NavGroup;
  item: NavItem;
  /** True on a child route — /orders/abc rather than /orders. */
  isChild: boolean;
}

/**
 * Which navigation entry a path belongs to.
 *
 * The longest matching `to` wins, so /products/import resolves to Products and
 * not to Dashboard, whose `to` is "/" and would otherwise prefix everything.
 *
 * This reads the full map rather than the filtered one on purpose: it answers
 * "where am I", and the guard has already decided whether the user may be
 * here. Filtering it by permission would blank the label on a page the user is
 * legitimately looking at.
 */
export function locateRoute(pathname: string): RouteLocation | null {
  let best: RouteLocation | null = null;

  for (const group of NAVIGATION) {
    for (const item of group.items) {
      const isExact = pathname === item.to;
      const isUnder = item.to !== '/' && pathname.startsWith(`${item.to}/`);

      if (!isExact && !isUnder) continue;
      if (best !== null && best.item.to.length >= item.to.length) continue;

      best = { group, item, isChild: !isExact };
    }
  }

  return best;
}
