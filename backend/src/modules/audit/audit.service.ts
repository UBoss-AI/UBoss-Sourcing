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
  /// Where an admin session said it was opened from. Recorded separately from
  /// `user.login` because it arrives on a later request - the position is only
  /// asked for once the password has been accepted.
  USER_SESSION_LOCATION: 'user.session_location',
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
  /// Somebody created their own account from the storefront. Kept apart from
  /// `customer.created`, which is a member of staff opening one for them - the
  /// two answer different questions when the trail is read back.
  CUSTOMER_REGISTERED: 'customer.registered',
  CUSTOMER_EMAIL_VERIFIED: 'customer.email_verified',
  /// A member of staff let a self-registered account in.
  CUSTOMER_APPROVED: 'customer.approved',
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
  PRODUCT_PRICES_BULK_SET: 'product.prices_bulk_set',
  PRODUCT_ARCHIVED: 'product.archived',

  // Coupons
  COUPON_CREATED: 'coupon.created',
  COUPON_UPDATED: 'coupon.updated',
  COUPON_ARCHIVED: 'coupon.archived',

  // Inventory
  INVENTORY_RECEIVED: 'inventory.received',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  /// A warehouse was opened, or its details changed. Separate from the two
  /// above because it is master data, not stock: the trail has to be able to
  /// answer "when did this place move, and who moved it" without that
  /// question being buried under every receipt booked against it.
  INVENTORY_LOCATION_CREATED: 'inventory_location.created',
  INVENTORY_LOCATION_UPDATED: 'inventory_location.updated',
  /// A warehouse row was deleted outright. Only possible while nothing had
  /// ever been booked against it, which is exactly why this entry matters: it
  /// is the only remaining trace that the place existed, so it carries the
  /// whole record in `before` rather than an id somebody can no longer look
  /// up.
  INVENTORY_LOCATION_DELETED: 'inventory_location.deleted',
  /// A connector reported where a warehouse stands with the ERP. Its own
  /// action rather than an `updated`, because these rows are written by
  /// machinery on a schedule and would otherwise bury the handful of entries
  /// where a person actually changed something about the place.
  INVENTORY_LOCATION_ERP_SYNCED: 'inventory_location.erp_synced',

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

  // Stored payment instruments
  //
  // Auditing enrolment and removal, never the references themselves. An audit
  // log is read by more people than the payment-method table is, and a
  // chargeable token does not belong in one.
  PAYMENT_METHOD_SETUP_STARTED: 'payment_method.setup_started',
  PAYMENT_METHOD_SAVED: 'payment_method.saved',
  PAYMENT_METHOD_UPDATED: 'payment_method.updated',
  PAYMENT_METHOD_REMOVED: 'payment_method.removed',
  /// An off-session charge against a stored instrument. Recorded separately
  /// from PAYMENT_CREATED because nobody was present to authorise it, which is
  /// the first thing anyone investigating a disputed charge needs to know.
  PAYMENT_OFF_SESSION_CHARGED: 'payment.off_session_charged',
  PAYMENT_ACTION_REQUIRED: 'payment.action_required',

  // Recurring
  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_PAUSED: 'schedule.paused',
  SCHEDULE_RESUMED: 'schedule.resumed',
  SCHEDULE_CANCELLED: 'schedule.cancelled',
  /// A draft became a live authority to charge. The moment consent took
  /// effect, and the one a dispute is measured from.
  SCHEDULE_ACTIVATED: 'schedule.activated',
  SCHEDULE_COMPLETED: 'schedule.completed',
  /// One cycle, and what became of it.
  OCCURRENCE_SKIPPED: 'occurrence.skipped',
  OCCURRENCE_CANCELLED: 'occurrence.cancelled',
  OCCURRENCE_HELD: 'occurrence.held',
  OCCURRENCE_COMPLETED: 'occurrence.completed',

  // ERP hand-off
  //
  // ERP_ORDER_PUSH_DEFERRED is the audit trail for the state where money has
  // moved and the ERP has not taken the order. It is recorded every time, not
  // only on the final failure, because the sequence of attempts is what
  // reconstructs the incident afterwards.
  ERP_ORDER_PUSHED: 'erp_order.pushed',
  ERP_ORDER_PUSH_DEFERRED: 'erp_order.push_deferred',
  ERP_ORDER_PUSH_ABANDONED: 'erp_order.push_abandoned',

  // Product safety
  //
  // An economic operator is a legal identity printed on a public listing and
  // written to by a market surveillance authority. Who changed one, and when,
  // is the kind of thing that gets asked after a recall.
  ECONOMIC_OPERATOR_CREATED: 'economic_operator.created',
  ECONOMIC_OPERATOR_UPDATED: 'economic_operator.updated',
  ECONOMIC_OPERATOR_ARCHIVED: 'economic_operator.archived',
  /// A product's medical-device record. On the trail because a class or a
  /// notified body number changing is the kind of edit somebody asks about
  /// after a recall.
  DEVICE_INFO_UPDATED: 'device_info.updated',

  // Invoicing
  //
  // An invoice sequence with an unexplained gap is a problem at a VAT audit,
  // so both the issue and the credit note that reverses one are on the record.
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_CREDITED: 'invoice.credited',
  /// A VAT number was checked against VIES. Recorded because the answer is
  /// what justifies zero-rating a supply, and "we checked" needs to be a fact
  /// somebody can point at rather than a claim.
  VAT_NUMBER_CHECKED: 'vat_number.checked',
  VAT_RATE_UPDATED: 'vat_rate.updated',

  // Configuration
  SETTINGS_UPDATED: 'settings.updated',
  FEATURE_FLAG_CHANGED: 'feature_flag.changed',
  CONNECTOR_CREATED: 'connector.created',
  CONNECTOR_UPDATED: 'connector.updated',
  DATA_EXPORTED: 'data.exported',

  // The ERP connection under Settings -> ERP
  //
  // Written with actorType ADMIN and the staff user's own id: this is a change
  // to how the installation runs, and it belongs on the staff trail beside the
  // tax classes and the payment gateways. The trail matters here for a specific
  // reason: these rows record somebody pointing this server at an outbound
  // address and giving it a credential, and "who set that up, and when" is the
  // first question asked if the address turns out to be wrong.
  ERP_CONNECTION_CREATED: 'erp_connection.created',
  ERP_CONNECTION_UPDATED: 'erp_connection.updated',
  /// Credentials replaced. Its own action rather than an `updated`, because a
  /// rotated secret is the change most worth being able to find. The secret
  /// itself never reaches the row - see REDACTED_FIELDS.
  ERP_CREDENTIALS_ROTATED: 'erp_connection.credentials_rotated',
  ERP_CONNECTION_TESTED: 'erp_connection.tested',
  /// The moment a connection started carrying real orders.
  ERP_CONNECTION_ACTIVATED: 'erp_connection.activated',
  ERP_CONNECTION_PAUSED: 'erp_connection.paused',
  ERP_CONNECTION_RESUMED: 'erp_connection.resumed',
  /// Taken out of service by the machinery after repeated failures. Written by
  /// SYSTEM, and the only status change in this group that nobody chose.
  ERP_CONNECTION_SUSPENDED: 'erp_connection.suspended',
  ERP_CONNECTION_DELETED: 'erp_connection.deleted',
  /// A field mapping was saved or verified against a real response.
  ERP_MAPPING_UPDATED: 'erp_connection.mapping_updated',
  /// A synchronisation ran. Recorded for manual and scheduled runs alike, so
  /// "who changed my stock figures" has an answer that does not depend on
  /// reading application logs.
  ERP_INVENTORY_SYNCED: 'erp_connection.inventory_synced',
  /// An inbound webhook was refused: bad signature, no secret, or a connection
  /// that is not accepting them. Worth a row of its own - a run of these is
  /// either a misconfigured ERP or somebody probing the endpoint.
  ERP_WEBHOOK_REJECTED: 'erp_connection.webhook_rejected',

  // Auto-pay
  //
  // Consent to charge, and its withdrawal. These are the rows that answer "did
  // this customer agree to this" when a charge is disputed, which is why they
  // record the version of the wording agreed to and are written even when the
  // change is a customer switching their own setting off.
  AUTOPAY_ENABLED: 'autopay.enabled',
  AUTOPAY_DISABLED: 'autopay.disabled',
  AUTOPAY_PAUSED: 'autopay.paused',
  AUTOPAY_RESUMED: 'autopay.resumed',
  AUTOPAY_SETTINGS_UPDATED: 'autopay.settings_updated',
  /// A charge was NOT made because it exceeded a limit the customer set, or
  /// crossed the threshold at which they asked to be consulted. On the trail
  /// because a delivery that did not happen needs an explanation as much as one
  /// that did.
  AUTOPAY_CHARGE_WITHHELD: 'autopay.charge_withheld',

  // Data protection
  //
  // These rows are the Art. 5(2) accountability record. "We honour erasure
  // requests" is a claim; this is what makes it a demonstrable fact, which is
  // why the trail keeps them even after the account they refer to is gone.
  DATA_REQUEST_CREATED: 'data_request.created',
  DATA_REQUEST_FULFILLED: 'data_request.fulfilled',
  DATA_REQUEST_REJECTED: 'data_request.rejected',
  DATA_REQUEST_DOWNLOADED: 'data_request.downloaded',
  /// The erasure itself, recorded separately from the request that asked for
  /// it: one is a decision, the other is the thing that actually rewrote rows.
  DATA_ERASURE_EXECUTED: 'data_erasure.executed',
  /// A retention sweep that deleted something. Not written when a sweep finds
  /// nothing - an empty pass is not an event.
  RETENTION_PURGED: 'retention.purged',
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
  // ERP credentials, in every spelling the connection service and its API
  // schema use for them. The key survives, so "the API key was
  // rotated" stays visible on the trail; only the value is replaced.
  'apiKey',
  'clientSecret',
  'credentials',
  'extraSecretHeaders',
  'oauthTokenEnc',
  'accessToken',
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

