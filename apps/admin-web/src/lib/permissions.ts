/**
 * Permission keys, mirrored from the backend's `src/domain/permissions.ts`.
 *
 * This list decides what the UI *shows*. It decides nothing about what the UI
 * is *allowed* to do - every route is gated server-side, and hiding a button
 * is a courtesy, not a control. If the two lists ever disagree, the backend
 * wins and the user sees a PERMISSION_DENIED they could have been spared.
 */
export const Permission = {
  SETTINGS_READ: 'settings.read',
  SETTINGS_WRITE: 'settings.write',
  FEATURE_FLAG_WRITE: 'feature_flag.write',

  STAFF_READ: 'staff.read',
  STAFF_WRITE: 'staff.write',
  ROLE_ASSIGN: 'role.assign',

  CATEGORY_READ: 'category.read',
  CATEGORY_WRITE: 'category.write',
  CATEGORY_ARCHIVE: 'category.archive',

  PRODUCT_READ: 'product.read',
  PRODUCT_WRITE: 'product.write',
  PRODUCT_PUBLISH: 'product.publish',
  PRODUCT_ARCHIVE: 'product.archive',
  PRODUCT_IMPORT: 'product.import',
  MEDIA_UPLOAD: 'media.upload',

  COUPON_READ: 'coupon.read',
  COUPON_WRITE: 'coupon.write',
  COUPON_ARCHIVE: 'coupon.archive',

  INVENTORY_READ: 'inventory.read',
  INVENTORY_RECEIVE: 'inventory.receive',
  INVENTORY_ADJUST: 'inventory.adjust',

  CUSTOMER_READ: 'customer.read',
  CUSTOMER_WRITE: 'customer.write',
  CUSTOMER_INVITE: 'customer.invite',
  CUSTOMER_LIMITS_WRITE: 'customer.limits.write',
  CUSTOMER_STATUS_WRITE: 'customer.status.write',
  ASSISTANT_CHAT_READ: 'assistant_chat.read',

  ORDER_READ: 'order.read',
  ORDER_APPROVE: 'order.approve',
  ORDER_FULFIL: 'order.fulfil',
  ORDER_CANCEL: 'order.cancel',
  ORDER_RETURN: 'order.return',
  ORDER_NOTE_WRITE: 'order.note.write',

  PAYMENT_READ: 'payment.read',
  PAYMENT_LINK_CREATE: 'payment_link.create',
  PAYMENT_GATEWAY_WRITE: 'payment_gateway.write',
  REFUND_CREATE: 'refund.create',

  SCHEDULE_READ: 'schedule.read',
  SCHEDULE_WRITE: 'schedule.write',

  INTEGRATION_READ: 'integration.read',
  INTEGRATION_WRITE: 'integration.write',

  REPORT_READ: 'report.read',
  EXPORT_CREATE: 'export.create',
  AUDIT_READ: 'audit.read',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

/** Human labels for the six roles, for the staff screen and the profile menu. */
export const ROLE_LABELS: Record<string, string> = {
  business_owner: 'Business Owner',
  catalog_manager: 'Catalog Manager',
  inventory_manager: 'Inventory Manager',
  order_manager: 'Order Manager',
  finance_approver: 'Finance Approver',
  customer: 'Customer',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
