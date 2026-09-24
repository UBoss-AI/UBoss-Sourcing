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
  /// Adding or editing a warehouse - its code, its name, where it is, whether
  /// it is the default. Held apart from receiving and adjusting because it is
  /// master data rather than stock: the code appears on every movement ever
  /// recorded against the place, and retiring the default location is what
  /// stops the next receipt finding anywhere to go.
  INVENTORY_LOCATION_WRITE: 'inventory.location.write',

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

  // --- Logistics ---
  //
  // The marketplace's own authority over third-party carriers. This is the
  // role the brief calls UBOSS_LOGISTICS_ADMIN, and it lives HERE rather than
  // in `logistics-permissions.ts` on purpose: that catalogue grants authority
  // over ONE carrier's rows, this one grants authority over every carrier.
  // A route that accepted either would eventually be reached by both.
  /// Read partners, their shipments, their exceptions and their integrations.
  LOGISTICS_READ: 'logistics.read',
  /// Create a partner, approve its capabilities, set its regions and SLA,
  /// invite its first owner, suspend it. Everything that decides who may carry
  /// this marketplace's goods.
  LOGISTICS_WRITE: 'logistics.write',
  /// Put a consignment on a carrier, take it off one, and correct a status
  /// that is wrong. Separate from LOGISTICS_WRITE because it is the operations
  /// desk's daily work rather than a contract decision, and because a status
  /// correction rewrites what a customer was told.
  LOGISTICS_ASSIGN: 'logistics.assign',
  /// Configure a carrier API connection and rotate its credentials. Its own
  /// key, and the narrowest one here: it is the only permission in this block
  /// that touches a secret.
  LOGISTICS_INTEGRATION_WRITE: 'logistics.integration.write',

  // --- Finance policy ---
  //
  // The platform fee a seller pays and the tax charged on it. Kept out of
  // SETTINGS_WRITE on purpose: a general administrator who can change the
  // shop's address must not be able to change what every seller is charged,
  // or what that charge is called on a tax document.
  /// Read platform-fee policies, their versions and the orders on each.
  FINANCE_POLICY_READ: 'finance.policy.read',
  /// Draft, publish and retire platform-fee policies.
  FINANCE_POLICY_WRITE: 'finance.policy.write',
  /// Mark a policy's tax rule as verified - the step that lets a document
  /// call it GST. Its own key because it is a legal statement, not a setting.
  FINANCE_TAX_VERIFY: 'finance.tax.verify',
  REPORT_READ: 'report.read',
  EXPORT_CREATE: 'export.create',
  AUDIT_READ: 'audit.read',

  // --- Invoicing ---
  /// Reading invoices and credit notes.
  INVOICE_READ: 'invoice.read',
  /// Raising one, and raising the credit note that cancels one. Held apart
  /// from reading because an invoice enters a VAT return: a number issued in
  /// error cannot be deleted, only reversed, and both documents stay on the
  /// record forever.
  INVOICE_ISSUE: 'invoice.issue',

  // --- Data protection ---
  /// Reading the data-subject request queue: who has asked for a copy of what
  /// is held about them or for it to be erased, and when each one falls due.
  DATA_REQUEST_READ: 'data_request.read',
  /// Deciding one. Held apart from reading it because an erasure cannot be
  /// undone and a refusal is a decision the subject may take to a supervisory
  /// authority - neither is something everyone who can watch the queue should
  /// be able to do. Business Owner only by default; a deployment with a named
  /// data protection officer grants it to them explicitly.
  DATA_REQUEST_ACTION: 'data_request.action',
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
    description: 'Stock receipts, adjustments, reservations, warehouses and alerts.',
    permissions: Object.freeze([
      Permission.SETTINGS_READ,
      Permission.CATEGORY_READ,
      Permission.PRODUCT_READ,
      Permission.INVENTORY_READ,
      Permission.INVENTORY_RECEIVE,
      Permission.INVENTORY_ADJUST,
      // Opening a second warehouse is this role's job, not the business
      // owner's - it is the person receiving the stock who knows a new one
      // exists, and who is standing in it when they find out.
      Permission.INVENTORY_LOCATION_WRITE,
      Permission.ORDER_READ,
      // Reads the consignments leaving their warehouse - a pickup window is a
      // fact about their loading bay. Changes none of it.
      Permission.LOGISTICS_READ,
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
      // Getting a parcel to a customer is this role's job, so it reads the
      // carriers and puts consignments on them. It deliberately gets neither
      // LOGISTICS_WRITE - contracting with a haulier is not an order clerk's
      // decision - nor LOGISTICS_INTEGRATION_WRITE, which holds a credential.
      Permission.LOGISTICS_READ,
      Permission.LOGISTICS_ASSIGN,
      Permission.PAYMENT_READ,
      // Reads an invoice to answer a customer asking for a copy; does not
      // raise one, the same split the SOP draws between fulfilling an order
      // and refunding it.
      Permission.INVOICE_READ,
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
      // Raising an invoice puts a number into a VAT return, which is finance's
      // work rather than the order desk's.
      Permission.INVOICE_READ,
      Permission.INVOICE_ISSUE,
      // What sellers are charged and the tax on it: finance's decision, and
      // nobody else's below the business owner.
      Permission.FINANCE_POLICY_READ,
      Permission.FINANCE_POLICY_WRITE,
      Permission.FINANCE_TAX_VERIFY,
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
