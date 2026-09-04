/**
 * Roles and permissions.
 *
 * Authorization is deny-by-default: a route declares the permission it needs,
 * and nothing is reachable without an explicit grant. This file is the single
 * catalogue - the seed writes exactly these rows, and the guards check against
 * exactly these keys, so a typo cannot silently open an endpoint.
 *
 * The six roles are fixed by the SOP (section 3) and must not be renamed
 * without a business decision; the Admin Panel renders them by key.
 */

/**
 * Permission keys, as `resource.action`.
 *
 * Read and write are deliberately separate everywhere: a Catalog Manager who
 * can view orders must not thereby be able to refund one.
 */
export const Permission = {
  // --- Business configuration ---
  SETTINGS_READ: 'settings.read',
  SETTINGS_WRITE: 'settings.write',
  FEATURE_FLAG_WRITE: 'feature_flag.write',

  // --- Staff and access ---
  STAFF_READ: 'staff.read',
  STAFF_WRITE: 'staff.write',
  ROLE_ASSIGN: 'role.assign',

  // --- Catalog ---
  CATEGORY_READ: 'category.read',
  CATEGORY_WRITE: 'category.write',
  CATEGORY_ARCHIVE: 'category.archive',
  PRODUCT_READ: 'product.read',
  PRODUCT_WRITE: 'product.write',
  /// Separate from product.write: publishing makes an item publicly buyable.
  PRODUCT_PUBLISH: 'product.publish',
  PRODUCT_ARCHIVE: 'product.archive',
  PRODUCT_IMPORT: 'product.import',
  MEDIA_UPLOAD: 'media.upload',

  // --- Coupons ---
  COUPON_READ: 'coupon.read',
  COUPON_WRITE: 'coupon.write',
  /// Archiving retires a live discount, so it is granted separately from
  /// authoring one that is still a draft.
  COUPON_ARCHIVE: 'coupon.archive',

  // --- Inventory ---
  INVENTORY_READ: 'inventory.read',
  INVENTORY_RECEIVE: 'inventory.receive',
  /// Adjustments can conjure or destroy stock, so they are their own grant.
  INVENTORY_ADJUST: 'inventory.adjust',

  // --- Customers ---
  CUSTOMER_READ: 'customer.read',
  CUSTOMER_WRITE: 'customer.write',
  CUSTOMER_INVITE: 'customer.invite',
  CUSTOMER_LIMITS_WRITE: 'customer.limits.write',
  CUSTOMER_STATUS_WRITE: 'customer.status.write',
  /// Chat enquiries from the storefront widget: the visitor's name, mobile
  /// number and email, and the transcript. Separate from customer.read because
  /// these people are leads, not accounts, and reading a stranger's
  /// conversation is a distinct thing to be trusted with.
  ASSISTANT_CHAT_READ: 'assistant_chat.read',

  // --- Orders ---
  ORDER_READ: 'order.read',
  ORDER_APPROVE: 'order.approve',
  ORDER_FULFIL: 'order.fulfil',
  ORDER_CANCEL: 'order.cancel',
  ORDER_RETURN: 'order.return',
  ORDER_NOTE_WRITE: 'order.note.write',

  // --- Payments ---
  PAYMENT_READ: 'payment.read',
  PAYMENT_LINK_CREATE: 'payment_link.create',
  PAYMENT_GATEWAY_WRITE: 'payment_gateway.write',
  REFUND_CREATE: 'refund.create',

  // --- Recurring ---
  SCHEDULE_READ: 'schedule.read',
  SCHEDULE_WRITE: 'schedule.write',

  // --- Integrations, reports, audit ---
  INTEGRATION_READ: 'integration.read',
  INTEGRATION_WRITE: 'integration.write',
  REPORT_READ: 'report.read',
  EXPORT_CREATE: 'export.create',
  AUDIT_READ: 'audit.read',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly PermissionKey[] = Object.freeze(Object.values(Permission));

/** Role keys. Stored in `roles.key`; the Admin Panel maps these to labels. */
export const Role = {
  BUSINESS_OWNER: 'business_owner',
  CATALOG_MANAGER: 'catalog_manager',
  INVENTORY_MANAGER: 'inventory_manager',
  ORDER_MANAGER: 'order_manager',
  FINANCE_APPROVER: 'finance_approver',
  CUSTOMER: 'customer',
} as const;

export type RoleKey = (typeof Role)[keyof typeof Role];

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
}

/**
 * Role -> permission grants, transcribed from SOP section 3.
 *
 * Two restrictions from that table are worth calling out because they look like
 * omissions and are not:
 *   - Catalog Manager gets no payment permission ("No payment configuration
 *     unless granted").
 *   - Finance/Approver gets no catalog delete ("No catalog deletion by
 *     default"), and Order Manager gets no refund.create ("Refund action may
 *     require Finance permission").
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = Object.freeze([
  {
    key: Role.BUSINESS_OWNER,
    name: 'Business Owner / Super Admin',
    description:
      'Full access to business settings, gateway setup, roles, catalog, orders and reports.',
    // The only role holding every permission, including role.assign.
    permissions: ALL_PERMISSIONS,
  },

  {
    key: Role.CATALOG_MANAGER,
    name: 'Catalog Manager',
    description: 'Categories, products, media, pricing and publication.',
    permissions: Object.freeze([
      Permission.SETTINGS_READ,
      Permission.CATEGORY_READ,
      Permission.CATEGORY_WRITE,
      Permission.CATEGORY_ARCHIVE,
      Permission.PRODUCT_READ,
      Permission.PRODUCT_WRITE,
      Permission.PRODUCT_PUBLISH,
      Permission.PRODUCT_ARCHIVE,
      Permission.PRODUCT_IMPORT,
      Permission.MEDIA_UPLOAD,
      // Coupons are pricing, which is this role's remit.
      Permission.COUPON_READ,
      Permission.COUPON_WRITE,
      Permission.COUPON_ARCHIVE,
      Permission.INVENTORY_READ,
      Permission.REPORT_READ,
    ]),
  },

  {
    key: Role.INVENTORY_MANAGER,
    name: 'Inventory Manager',
    description: 'Stock receipts, adjustments, reservations and alerts.',
    permissions: Object.freeze([
      Permission.SETTINGS_READ,
      Permission.CATEGORY_READ,
      Permission.PRODUCT_READ,
      Permission.INVENTORY_READ,
      Permission.INVENTORY_RECEIVE,
      Permission.INVENTORY_ADJUST,
      Permission.ORDER_READ,
      Permission.REPORT_READ,
      Permission.EXPORT_CREATE,
    ]),
  },

  {
    key: Role.ORDER_MANAGER,
    name: 'Order Manager',
    description: 'Orders, fulfilment, cancellation and return handling.',
    permissions: Object.freeze([
      Permission.SETTINGS_READ,
      Permission.CATEGORY_READ,
      Permission.PRODUCT_READ,
      Permission.INVENTORY_READ,
      Permission.CUSTOMER_READ,
      // Enquiries from the chat widget are unqualified leads, and following
      // one up is order work.
      Permission.ASSISTANT_CHAT_READ,
      Permission.ORDER_READ,
      Permission.ORDER_FULFIL,
      Permission.ORDER_CANCEL,
      Permission.ORDER_RETURN,
      Permission.ORDER_NOTE_WRITE,
      Permission.PAYMENT_READ,
      Permission.SCHEDULE_READ,
      Permission.REPORT_READ,
      Permission.EXPORT_CREATE,
    ]),
  },

  {
    key: Role.FINANCE_APPROVER,
    name: 'Finance / Approver',
    description: 'Payment review, payment links, refunds and high-value approvals.',
    permissions: Object.freeze([
      Permission.SETTINGS_READ,
      Permission.PRODUCT_READ,
      Permission.CUSTOMER_READ,
      Permission.CUSTOMER_LIMITS_WRITE,
      Permission.ASSISTANT_CHAT_READ,
      Permission.ORDER_READ,
      Permission.ORDER_APPROVE,
      Permission.ORDER_CANCEL,
      Permission.ORDER_NOTE_WRITE,
      Permission.PAYMENT_READ,
      Permission.PAYMENT_LINK_CREATE,
      Permission.PAYMENT_GATEWAY_WRITE,
      Permission.REFUND_CREATE,
      Permission.SCHEDULE_READ,
      Permission.SCHEDULE_WRITE,
      Permission.REPORT_READ,
      Permission.EXPORT_CREATE,
      Permission.AUDIT_READ,
    ]),
  },

  {
    key: Role.CUSTOMER,
    name: 'Customer',
    description: 'Website account, cart, checkout, schedules, orders and profile.',
    // Intentionally empty. Customers hold NO admin permission; their access is
    // resource ownership on their own records, checked separately. Granting a
    // customer even one key from this catalogue would expose an admin route.
    permissions: Object.freeze([]),
  },
]);

const ROLE_BY_KEY = new Map<string, RoleDefinition>(
  ROLE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function roleDefinition(key: string): RoleDefinition | undefined {
  return ROLE_BY_KEY.get(key);
}

export const ADMIN_ROLE_KEYS: readonly RoleKey[] = Object.freeze(
  ROLE_DEFINITIONS.filter((definition) => definition.key !== Role.CUSTOMER).map(
    (definition) => definition.key,
  ),
);

/** Union of the permissions granted by the supplied roles. */
export function permissionsForRoles(roleKeys: readonly string[]): Set<PermissionKey> {
  const granted = new Set<PermissionKey>();
  for (const key of roleKeys) {
    for (const permission of ROLE_BY_KEY.get(key)?.permissions ?? []) {
      granted.add(permission);
    }
  }
  return granted;
}

/**
 * An administrator may only grant permissions they themselves hold.
 *
 * Without this, an Order Manager with `role.assign` could mint a Business Owner
 * and escalate to everything. Called on every role assignment.
 */
export function canGrantRole(
  granterPermissions: ReadonlySet<PermissionKey>,
  targetRoleKey: string,
): boolean {
  const target = ROLE_BY_KEY.get(targetRoleKey);
  if (target === undefined) return false;
  if (!granterPermissions.has(Permission.ROLE_ASSIGN)) return false;

  return target.permissions.every((permission) => granterPermissions.has(permission));
}
