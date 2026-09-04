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
  AuditIcon,
  CategoriesIcon,
  ChatIcon,
  CouponsIcon,
  CustomersIcon,
  DashboardIcon,
  IntegrationsIcon,
  InventoryIcon,
  OrdersIcon,
  PaymentsIcon,
  ProductsIcon,
  RecurringIcon,
  ReportsIcon,
  SettingsIcon,
  StaffIcon,
} from '@/components/icons';
import { Permission } from '@/lib/permissions';
import type { IconComponent } from '@/components/icons';
import type { PermissionKey } from '@/lib/permissions';

export interface NavItem {
  label: string;
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
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', to: '/', icon: DashboardIcon, permissions: [] }],
  },
  {
    label: 'Catalogue',
    items: [
      { label: 'Categories', to: '/categories', icon: CategoriesIcon, permissions: [Permission.CATEGORY_READ], matchPrefix: true },
      { label: 'Products', to: '/products', icon: ProductsIcon, permissions: [Permission.PRODUCT_READ], matchPrefix: true },
      { label: 'Inventory', to: '/inventory', icon: InventoryIcon, permissions: [Permission.INVENTORY_READ], matchPrefix: true },
      { label: 'Coupons', to: '/coupons', icon: CouponsIcon, permissions: [Permission.COUPON_READ], matchPrefix: true },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Orders', to: '/orders', icon: OrdersIcon, permissions: [Permission.ORDER_READ], matchPrefix: true },
      { label: 'Payments', to: '/payments', icon: PaymentsIcon, permissions: [Permission.PAYMENT_READ], matchPrefix: true },
      {
        label: 'Recurring',
        to: '/recurring',
        icon: RecurringIcon,
        permissions: [Permission.SCHEDULE_READ],
        matchPrefix: true,
      },
      { label: 'Customers', to: '/customers', icon: CustomersIcon, permissions: [Permission.CUSTOMER_READ], matchPrefix: true },
      {
        label: 'Chat enquiries',
        to: '/chat-enquiries',
        icon: ChatIcon,
        permissions: [Permission.ASSISTANT_CHAT_READ],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Reports', to: '/reports', icon: ReportsIcon, permissions: [Permission.REPORT_READ], matchPrefix: true },
      { label: 'Audit log', to: '/audit', icon: AuditIcon, permissions: [Permission.AUDIT_READ], matchPrefix: true },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'Integrations',
        to: '/integrations',
        icon: IntegrationsIcon,
        permissions: [Permission.INTEGRATION_READ, Permission.PAYMENT_GATEWAY_WRITE],
        matchPrefix: true,
      },
      { label: 'Staff', to: '/staff', icon: StaffIcon, permissions: [Permission.STAFF_READ], matchPrefix: true },
      { label: 'Settings', to: '/settings', icon: SettingsIcon, permissions: [Permission.SETTINGS_READ], matchPrefix: true },
    ],
  },
];

/** Groups with at least one visible item, for the signed-in user. */
export function visibleNavigation(can: (permission: PermissionKey) => boolean): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => item.permissions.length === 0 || item.permissions.some((permission) => can(permission)),
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
