/**
 * Audit trail.
 *
 * Every privileged, catalog-publication, inventory, order, payment, refund,
 * connector and schedule change writes a row here. Two rules make the trail
 * worth having:
 *
 *   1. It is written INSIDE the caller's transaction. An action that rolls back
 *      leaves no audit row claiming it happened, and an action that commits can
 *      never lack one.
 *   2. Values are redacted before they are written. The trail must record that
 *      a gateway credential changed, never what it changed to.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

export const AuditAction = {
  // Identity
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_SESSIONS_REVOKED: 'user.sessions_revoked',
  /// Presenting a refresh token that was already rotated away. Either a stolen
  /// token or a broken client, and both are worth an alert.
  USER_REFRESH_REUSE_DETECTED: 'user.refresh_reuse_detected',
  ROLE_ASSIGNED: 'role.assigned',
  ROLE_REVOKED: 'role.revoked',

  // Customers
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CUSTOMER_INVITED: 'customer.invited',
  CUSTOMER_ACTIVATED: 'customer.activated',
  CUSTOMER_STATUS_CHANGED: 'customer.status_changed',
  CUSTOMER_LIMITS_CHANGED: 'customer.limits_changed',

  // Catalog
  CATEGORY_CREATED: 'category.created',
  CATEGORY_UPDATED: 'category.updated',
  CATEGORY_ARCHIVED: 'category.archived',
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_PUBLISHED: 'product.published',
  PRODUCT_UNPUBLISHED: 'product.unpublished',
  PRODUCT_PRICE_CHANGED: 'product.price_changed',
  PRODUCT_ARCHIVED: 'product.archived',

  // Coupons
  COUPON_CREATED: 'coupon.created',
  COUPON_UPDATED: 'coupon.updated',
  COUPON_ARCHIVED: 'coupon.archived',

  // Inventory
  INVENTORY_RECEIVED: 'inventory.received',
  INVENTORY_ADJUSTED: 'inventory.adjusted',

  // Orders
  ORDER_CREATED: 'order.created',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_APPROVED: 'order.approved',
  ORDER_REJECTED: 'order.rejected',
  ORDER_CANCELLED: 'order.cancelled',

  // Payments
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_LINK_CREATED: 'payment_link.created',
  PAYMENT_LINK_REVOKED: 'payment_link.revoked',
  PAYMENT_GATEWAY_CONFIGURED: 'payment_gateway.configured',
  PAYMENT_GATEWAY_ACTIVATED: 'payment_gateway.activated',
  WEBHOOK_REJECTED: 'webhook.rejected',
  REFUND_CREATED: 'refund.created',
  REFUND_COMPLETED: 'refund.completed',

  // Recurring
  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_PAUSED: 'schedule.paused',
  SCHEDULE_RESUMED: 'schedule.resumed',
  SCHEDULE_CANCELLED: 'schedule.cancelled',

  // Configuration
  SETTINGS_UPDATED: 'settings.updated',
  FEATURE_FLAG_CHANGED: 'feature_flag.changed',
  CONNECTOR_CREATED: 'connector.created',
  CONNECTOR_UPDATED: 'connector.updated',
  DATA_EXPORTED: 'data.exported',
} as const;

export type AuditActionKey = (typeof AuditAction)[keyof typeof AuditAction];

export type AuditActorType = 'SYSTEM' | 'ADMIN' | 'CUSTOMER' | 'PROVIDER';

export interface AuditEntry {
  action: AuditActionKey;
  resourceType: string;
  resourceId?: string | null;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorEmail?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/**
 * Field names whose VALUES never reach the audit trail.
 *
 * The key is still recorded, so "the webhook secret was rotated" remains
 * visible; only the secret itself is replaced.
 */
const REDACTED_FIELDS = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'refreshTokenHash',
  'mfaSecret',
  'mfaSecretEnc',
  'credentialsEnc',
  'webhookSecretEnc',
  'keySecret',
  'apiSecret',
  'webhookSecret',
  'signature',
  'rawPayload',
  'cardNumber',
  'cvv',
]);

const MAX_AUDIT_VALUE_BYTES = 16_384;

/**
 * Recursively strip secret values and normalise types JSON cannot carry.
 * BigInt is the important one: every money column is a BigInt, and
 * JSON.stringify throws on it rather than degrading gracefully.
 */
function redact(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (depth > 8) return '[TRUNCATED_DEPTH]';

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => redact(entry, depth + 1) ?? null);
  }

  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = REDACTED_FIELDS.has(key) ? '[REDACTED]' : redact(entryValue, depth + 1);
    }
    return result;
  }

  // Anything left is a type JSON cannot carry (function, symbol). Record the
  // type rather than String()-ing it into a useless "[object Object]".
  return `[UNSERIALISABLE:${typeof value}]`;
}

/** Guard against a huge payload bloating the table. */
function bounded(value: Prisma.InputJsonValue | null): Prisma.InputJsonValue | null {
  if (value === null) return null;
  const serialised = JSON.stringify(value);
  if (serialised !== undefined && serialised.length > MAX_AUDIT_VALUE_BYTES) {
    return { truncated: true, bytes: serialised.length };
  }
  return value;
}

type AuditClient = Pick<typeof prisma, 'auditLog'>;

/**
 * Write an audit row.
 *
 * Pass `tx` whenever the audited change is itself transactional - which is
 * nearly always. Without it the audit row commits independently and can survive
 * a rolled-back action, recording something that never happened.
 */
export async function recordAudit(entry: AuditEntry, tx?: unknown): Promise<void> {
  const client = (tx as AuditClient | undefined) ?? prisma;

  const data: Prisma.AuditLogUncheckedCreateInput = {
    id: newId(),
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    actorType: entry.actorType,
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    beforeJson: bounded(redact(entry.before)) ?? Prisma.JsonNull,
    afterJson: bounded(redact(entry.after)) ?? Prisma.JsonNull,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent?.slice(0, 512) ?? null,
    correlationId: entry.correlationId ?? null,
  };

  if (tx !== undefined) {
    // Inside a caller's transaction: let a failure abort the whole operation.
    // An action that cannot be audited must not be allowed to commit.
    await client.auditLog.create({ data });
    return;
  }

  // Standalone (login attempts, webhook rejections). Here the audit write is
  // best-effort: failing to log a rejected webhook must not turn into a 500
  // that makes the provider retry a request we already refused.
  try {
    await client.auditLog.create({ data });
  } catch (error) {
    logger.error(
      { err: error, action: entry.action, resourceType: entry.resourceType },
      'failed to write audit log',
    );
  }
}

