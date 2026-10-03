/**
 * Notification families, priority, deep links and mute preferences
 * (checklist JOURNEY-056).
 *
 * FAMILIES
 *
 * Every event key belongs to one family, matched on the longest prefix. A
 * person mutes a FAMILY on a CHANNEL - "no shipment emails" - never a single
 * event, because nobody can be expected to know there are a dozen scheduled-
 * order events.
 *
 * MANDATORY
 *
 * Security, order, payment and data-rights messages cannot be muted. A
 * password reset swallowed by a setting is a locked-out customer; a payment
 * receipt swallowed by one is a dispute; an erasure confirmation is a legal
 * duty. `setPreferences` refuses to store a mute for them, and
 * `mutedChannelsFor` ignores one even if a row were ever written by hand. A
 * handful of events in otherwise optional families are mandatory on their own
 * (the delivery code, a payment the bank wants confirmed).
 *
 * PRIORITY
 *
 * Derived from the event key, never stored: HIGH for something the person must
 * act on now or that is about their account's safety, LOW for news they asked
 * for (saved-search matches, reminders), NORMAL for the rest.
 */
import type { NotificationChannel, Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit, type AuditActorType } from '../audit/audit.service.js';

export interface NotificationFamily {
  key: string;
  prefixes: readonly string[];
  mandatory: boolean;
}

/** Longest prefix wins, so `order.message` lands in messages, not orders. */
export const NOTIFICATION_FAMILIES: readonly NotificationFamily[] = Object.freeze([
  { key: 'account', prefixes: ['user.', 'customer.', 'staff.', 'organization.invitation', 'seller.team_invitation', 'buyer_company.email_code', 'buyer_company.invitation'], mandatory: true },
  { key: 'orders', prefixes: ['order.', 'seller_invoice.'], mandatory: true },
  { key: 'payments', prefixes: ['payment.', 'refund.', 'autopay.'], mandatory: true },
  { key: 'yourData', prefixes: ['data_request.'], mandatory: true },
  { key: 'messages', prefixes: ['order.message', 'preorder_chat.'], mandatory: false },
  { key: 'shipments', prefixes: ['shipment.'], mandatory: false },
  { key: 'quotes', prefixes: ['rfq.'], mandatory: false },
  { key: 'preorders', prefixes: ['preorder.'], mandatory: false },
  { key: 'returns', prefixes: ['return.'], mandatory: false },
  { key: 'disputes', prefixes: ['dispute.'], mandatory: false },
  { key: 'inspection', prefixes: ['inspection.'], mandatory: false },
  { key: 'scheduled', prefixes: ['schedule.'], mandatory: false },
  { key: 'company', prefixes: ['buyer_company.'], mandatory: false },
  { key: 'savedSearches', prefixes: ['saved_search.'], mandatory: false },
  { key: 'support', prefixes: ['support_ticket.'], mandatory: false },
  { key: 'integrations', prefixes: ['customer_erp.', 'erp.'], mandatory: false },
]);

/**
 * Seller Hub's own in-app families, by notification kind. Muted per member on
 * the IN_APP channel; an ALERT (a problem still open) is never hidden, and the
 * mandatory families - the application, security, payouts, new orders, claims,
 * dispatch deadlines and expiring documents - cannot be muted at all.
 */
export interface SellerNotificationFamily {
  key: string;
  kinds: readonly string[];
  mandatory: boolean;
}

export const SELLER_NOTIFICATION_FAMILIES: readonly SellerNotificationFamily[] = Object.freeze([
  { key: 'seller.essential', kinds: ['APPLICATION_STATUS', 'SECURITY_EVENT', 'PAYOUT_RESULT', 'NEW_ORDER', 'RETURN_OR_DISPUTE', 'DISPATCH_SLA_WARNING', 'DOCUMENT_EXPIRING', 'SETTLEMENT_CALCULATED', 'INVOICE_CREDIT_NOTE_REQUIRED', 'BULK_ORDER_RECEIVED'], mandatory: true },
  { key: 'seller.listings', kinds: ['LISTING_DECISION', 'BRAND_REQUEST_DECISION', 'PACKAGING_VALIDATION_FAILED'], mandatory: false },
  { key: 'seller.stock', kinds: ['LOW_STOCK'], mandatory: false },
  { key: 'seller.logistics', kinds: ['CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE'], mandatory: false },
  { key: 'seller.integrations', kinds: ['ERP_SYNC_FAILURE', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE'], mandatory: false },
  { key: 'seller.preorders', kinds: ['PREORDER_REQUEST_RECEIVED', 'PREORDER_BUYER_RESPONSE', 'PREORDER_CONFIRMED', 'PREORDER_CLOSED', 'PREORDER_DELIVERY_RISK'], mandatory: false },
  { key: 'seller.quotes', kinds: ['RFQ_INVITATION', 'RFQ_UPDATE'], mandatory: false },
  { key: 'seller.messages', kinds: ['ORDER_MESSAGE'], mandatory: false },
  { key: 'seller.inspection', kinds: ['INSPECTION_UPDATE'], mandatory: false },
]);

export function sellerFamilyOf(kind: string): SellerNotificationFamily | null {
  return SELLER_NOTIFICATION_FAMILIES.find((family) => family.kinds.includes(kind)) ?? null;
}

/** Seller in-app priority from the row's own severity. */
export function sellerPriorityOf(severity: string): NotificationPriority {
  if (severity === 'CRITICAL' || severity === 'WARNING') return 'HIGH';
  if (severity === 'SUCCESS') return 'LOW';
  return 'NORMAL';
}

/** Events that cannot be muted although their family can. */
const MANDATORY_EVENTS: ReadonlySet<string> = new Set([
  'shipment.delivery_code',
  'schedule.payment_action_required',
  'schedule.price_changed',
  'dispute.decided',
]);

/** The channels a person may mute. WhatsApp has no provider, so nothing to mute. */
export const PREFERENCE_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const satisfies readonly NotificationChannel[];
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

export function familyOf(eventKey: string): NotificationFamily | null {
  let best: NotificationFamily | null = null;
  let bestLength = -1;
  for (const family of NOTIFICATION_FAMILIES) {
    for (const prefix of family.prefixes) {
      if (eventKey.startsWith(prefix) && prefix.length > bestLength) {
        best = family;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** True when nothing a person sets may stop this event. Unknown events are mandatory. */
export function isMandatoryEvent(eventKey: string): boolean {
  if (MANDATORY_EVENTS.has(eventKey)) return true;
  return familyOf(eventKey)?.mandatory ?? true;
}

export type NotificationPriority = 'HIGH' | 'NORMAL' | 'LOW';

const HIGH_EVENTS: ReadonlySet<string> = new Set([
  'user.password_reset',
  'user.new_sign_in',
  'user.mfa_disabled',
  'user.email_change_requested',
  'user.account_deactivated',
  'payment.failed',
  'payment.link',
  'autopay.failed',
  'autopay.approval_needed',
  'schedule.payment_action_required',
  'schedule.failed',
  'schedule.price_changed',
  'schedule.stock_unavailable',
  'shipment.exception',
  'shipment.delivery_code',
  'order.cancelled',
  'dispute.decided',
  'return.rejected',
  'preorder.payment_required',
  'preorder.delivery_risk',
  'customer_erp.action_required',
  'customer_erp.suspended',
]);

const LOW_PREFIXES: readonly string[] = ['saved_search.', 'schedule.reminder', 'rfq.invitation', 'preorder_chat.resolved'];

export type Escalation = 'INSPECTION_FAIL' | 'PAYMENT_RISK' | 'SHIPPING_DELAY' | 'RFQ_EXPIRY';

/**
 * The four kinds of alert that are never bundled (ENH-020): a failed
 * inspection, a payment at risk, a delayed shipment and an RFQ about to
 * expire. Matched on the event key's own words, so a new key of the same
 * kind escalates without a list to keep in step.
 */
export function escalationOf(eventKey: string): Escalation | null {
  const key = eventKey.toLowerCase();
  if (key.startsWith('inspection.') && /fail|reject|ncr|nonconform/.test(key)) return 'INSPECTION_FAIL';
  if (/^(payment|autopay|chargeback|preorder\.payment|schedule\.payment)/.test(key) && /fail|risk|action_required|chargeback|dispute|required/.test(key)) return 'PAYMENT_RISK';
  if (/^(shipment|logistics|preorder|consignment)\./.test(key) && /exception|delay|late|delivery_failed|delivery_risk/.test(key)) return 'SHIPPING_DELAY';
  if (key.startsWith('rfq.') && /expir|deadline/.test(key)) return 'RFQ_EXPIRY';
  return null;
}

export function priorityOf(eventKey: string): NotificationPriority {
  if (HIGH_EVENTS.has(eventKey) || escalationOf(eventKey) !== null) return 'HIGH';
  if (LOW_PREFIXES.some((prefix) => eventKey.startsWith(prefix))) return 'LOW';
  return 'NORMAL';
}

/**
 * Where a buyer's notification leads in the storefront, from what it is about.
 * `references` maps a dispute id to its reference, the one id the claim page
 * is addressed by. Null when there is no screen for it.
 */
export function buyerDeepLink(
  relatedType: string | null,
  relatedId: string | null,
  references: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (relatedType === null || relatedId === null) return null;
  switch (relatedType) {
    case 'order':
      return `/account/orders/${relatedId}`;
    case 'dispute': {
      const reference = references.get(relatedId);
      return reference === undefined ? '/account/disputes' : `/account/disputes/${reference}`;
    }
    case 'return_request':
      return `/account/returns/${relatedId}`;
    case 'rfq_request':
      return `/account/rfqs/${relatedId}`;
    case 'preorder_request':
      return `/account/preorders/${relatedId}`;
    case 'preorder_chat':
      return `/account/messages/${relatedId}`;
    case 'recurring_schedule':
      return `/account/schedules/${relatedId}`;
    case 'support_ticket':
      return '/account/support';
    case 'data_request':
      return '/account/profile';
    case 'buyer_company':
      return '/account/company';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

type Client = Pick<typeof prisma, 'user' | 'notificationPreference'>;

/**
 * The channels this event must not go out on for this recipient. Empty for a
 * mandatory event, for an address with no account, and for a person who has
 * muted nothing - which is everyone until they choose otherwise.
 */
export async function mutedChannelsFor(
  client: Client,
  recipientEmail: string,
  eventKey: string,
): Promise<Set<NotificationChannel>> {
  if (isMandatoryEvent(eventKey)) return new Set();
  const family = familyOf(eventKey);
  if (family === null) return new Set();
  const user = await client.user.findUnique({
    where: { emailNormalized: recipientEmail.trim().toLowerCase() },
    select: { notificationPreferences: { where: { family: family.key }, select: { channel: true } } },
  });
  return new Set((user?.notificationPreferences ?? []).map((row) => row.channel));
}

export type PreferenceScope = 'buyer' | 'seller';

export interface PreferenceView {
  families: {
    key: string;
    mandatory: boolean;
    /**
     * true = on (delivered), false = muted, per channel the scope offers: all
     * three for a buyer, IN_APP only for Seller Hub. A mandatory family is
     * always on.
     */
    channels: Partial<Record<PreferenceChannel, boolean>>;
  }[];
}

function scopeFamilies(scope: PreferenceScope): { key: string; mandatory: boolean; channels: readonly PreferenceChannel[] }[] {
  return scope === 'buyer'
    ? NOTIFICATION_FAMILIES.map((family) => ({ key: family.key, mandatory: family.mandatory, channels: PREFERENCE_CHANNELS }))
    : SELLER_NOTIFICATION_FAMILIES.map((family) => ({ key: family.key, mandatory: family.mandatory, channels: ['IN_APP'] as const }));
}

export async function readPreferences(userId: string, scope: PreferenceScope = 'buyer'): Promise<PreferenceView> {
  const families = scopeFamilies(scope);
  const rows = await prisma.notificationPreference.findMany({
    where: { userId, family: { in: families.map((family) => family.key) } },
    select: { family: true, channel: true },
  });
  const muted = new Set(rows.map((row) => `${row.family}:${row.channel}`));
  return {
    families: families.map((family) => ({
      key: family.key,
      mandatory: family.mandatory,
      channels: Object.fromEntries(
        family.channels.map((channel) => [channel, family.mandatory || !muted.has(`${family.key}:${channel}`)]),
      ),
    })),
  };
}

/** The seller families this member muted in their Seller Hub feed. */
export async function mutedSellerFamilies(userId: string): Promise<Set<string>> {
  const rows = await prisma.notificationPreference.findMany({
    where: { userId, channel: 'IN_APP', family: { startsWith: 'seller.' } },
    select: { family: true },
  });
  return new Set(rows.map((row) => row.family));
}

export interface PreferenceActor {
  userId: string;
  email: string | null;
  actorType: AuditActorType;
}

/**
 * Replace this person's mutes in one scope with `muted`. Refuses a mandatory
 * family, an unknown one, or a channel the scope does not offer, rather than
 * storing a choice the system would then ignore. The other scope's choices
 * are left alone. Audited with the before and after sets.
 */
export async function savePreferences(
  actor: PreferenceActor,
  muted: readonly { family: string; channel: PreferenceChannel }[],
  scope: PreferenceScope = 'buyer',
): Promise<PreferenceView> {
  const families = scopeFamilies(scope);
  const known = new Map(families.map((family) => [family.key, family]));
  const refused = muted.filter((entry) => {
    const family = known.get(entry.family);
    return family === undefined || family.mandatory || !family.channels.includes(entry.channel);
  });
  if (refused.length > 0) {
    throw badRequest(
      ErrorCode.NOTIFICATION_PREFERENCE_MANDATORY,
      'Security, order, payment and data-rights notifications cannot be switched off.',
      refused.map((entry) => ({ field: entry.family, code: ErrorCode.NOTIFICATION_PREFERENCE_MANDATORY })),
    );
  }
  const wanted = [...new Map(muted.map((entry) => [`${entry.family}:${entry.channel}`, entry])).values()];
  const scopeKeys = families.map((family) => family.key);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const before = await tx.notificationPreference.findMany({
      where: { userId: actor.userId, family: { in: scopeKeys } },
      select: { family: true, channel: true },
    });
    await tx.notificationPreference.deleteMany({ where: { userId: actor.userId, family: { in: scopeKeys } } });
    if (wanted.length > 0) {
      await tx.notificationPreference.createMany({
        data: wanted.map((entry) => ({ id: newId(), userId: actor.userId, family: entry.family, channel: entry.channel })),
      });
    }
    await recordAudit(
      {
        action: AuditAction.NOTIFICATION_PREFERENCES_CHANGED,
        resourceType: 'user',
        resourceId: actor.userId,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { scope, muted: before.map((row) => `${row.family}:${row.channel}`) },
        after: { scope, muted: wanted.map((entry) => `${entry.family}:${entry.channel}`) },
      },
      tx,
    );
  });

  return readPreferences(actor.userId, scope);
}
