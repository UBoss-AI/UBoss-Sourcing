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
import { Permission } from '@/lib/permissions';
import type { PermissionKey } from '@/lib/permissions';

export interface NavItem {
  label: string;
  to: string;
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
    items: [{ label: 'Dashboard', to: '/', permissions: [] }],
  },
  {
    label: 'Catalogue',
    items: [
      { label: 'Categories', to: '/categories', permissions: [Permission.CATEGORY_READ], matchPrefix: true },
      { label: 'Products', to: '/products', permissions: [Permission.PRODUCT_READ], matchPrefix: true },
      { label: 'Inventory', to: '/inventory', permissions: [Permission.INVENTORY_READ], matchPrefix: true },
      { label: 'Coupons', to: '/coupons', permissions: [Permission.COUPON_READ], matchPrefix: true },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Orders', to: '/orders', permissions: [Permission.ORDER_READ], matchPrefix: true },
      { label: 'Payments', to: '/payments', permissions: [Permission.PAYMENT_READ], matchPrefix: true },
      {
        label: 'Recurring',
        to: '/recurring',
        permissions: [Permission.SCHEDULE_READ],
        matchPrefix: true,
      },
      { label: 'Customers', to: '/customers', permissions: [Permission.CUSTOMER_READ], matchPrefix: true },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Reports', to: '/reports', permissions: [Permission.REPORT_READ], matchPrefix: true },
      { label: 'Audit log', to: '/audit', permissions: [Permission.AUDIT_READ], matchPrefix: true },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'Integrations',
        to: '/integrations',
        permissions: [Permission.INTEGRATION_READ, Permission.PAYMENT_GATEWAY_WRITE],
        matchPrefix: true,
      },
      { label: 'Staff', to: '/staff', permissions: [Permission.STAFF_READ], matchPrefix: true },
      { label: 'Settings', to: '/settings', permissions: [Permission.SETTINGS_READ], matchPrefix: true },
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
