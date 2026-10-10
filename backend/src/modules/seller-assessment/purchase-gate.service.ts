/**
 * The one answer to "may this seller's product be bought, here, by this kind
 * of buyer, right now?" under the Seller Assessment policy.
 *
 * Purchasable only when ALL hold at the moment of the request:
 *   - an ACTIVE trading approval for the seller, not past its validity;
 *   - a scope row for this exact offer, this destination country and this
 *     channel (B2B/B2C), ACTIVE and not past its own validity (which an
 *     earlier licence or authorisation expiry cuts short);
 *   - the independent certificate that approval rests on is AUTHENTICATED and
 *     not expired - read live from its row, so a withdrawal by the issuer
 *     blocks at once.
 *
 * Every date is compared here, at request time. The surveillance sweep sends
 * reminders and marks things expired for people to see; if it never runs,
 * nothing becomes buyable that should not be.
 *
 * Mode (`SELLER_ASSESSMENT_PURCHASE_GATE`): 'off' answers "allowed" without
 * looking; 'report' looks, logs and allows; 'enforce' refuses. There is no
 * commercial or badge override anywhere in this file.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict } from '../../domain/errors.js';
import type { SalesChannel } from '../../domain/seller-assessment.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { assertCheckoutDeliveryRules } from '../commercial-policy/order-controls.service.js';
import { offersBlockedByEvidence } from '../commercial-policy/evidence-launch.service.js';
import type { Client } from './context.js';

export interface GateLine {
  sellerAccountId: string;
  /** Null for an operator-sold line (the marketplace's own stock): not a seller listing, outside this policy. */
  offerId: string | null;
}

export type ScopeBlock = 'NO_APPROVAL' | 'NOT_IN_SCOPE' | 'APPROVAL_EXPIRED' | 'CERTIFICATE_NOT_CURRENT' | 'EVIDENCE_NOT_CURRENT';

export function gateMode(): 'off' | 'report' | 'enforce' {
  return env.SELLER_ASSESSMENT_PURCHASE_GATE;
}

export function channelFor(isCompanyBuyer: boolean): SalesChannel {
  return isCompanyBuyer ? 'B2B' : 'B2C';
}

/**
 * The reason each line is blocked, keyed by offer id (absent = allowed).
 * Pure lookup, no mode: callers that must report regardless use this.
 */
export async function evaluateScope(client: Client, lines: readonly GateLine[], countryCode: string, channel: SalesChannel, now = new Date()): Promise<Map<string, ScopeBlock>> {
  const seller = lines.filter((l): l is GateLine & { offerId: string } => l.offerId !== null);
  const out = new Map<string, ScopeBlock>();
  if (seller.length === 0) return out;
  const sellerIds = [...new Set(seller.map((l) => l.sellerAccountId))];
  const approvals = await client.sellerTradingApproval.findMany({
    where: { sellerAccountId: { in: sellerIds }, status: 'ACTIVE' },
    select: { id: true, sellerAccountId: true, validUntil: true, externalCertificationId: true },
  });
  const certIds = [...new Set(approvals.map((a) => a.externalCertificationId))];
  const certs = certIds.length === 0 ? [] : await client.sellerExternalCertification.findMany({ where: { id: { in: certIds } }, select: { id: true, status: true, expiresOn: true } });
  const certOk = (id: string) => {
    const c = certs.find((x) => x.id === id);
    return c !== undefined && c.status === 'AUTHENTICATED' && c.expiresOn !== null && c.expiresOn.getTime() > now.getTime();
  };
  const scopes = await client.sellerTradingApprovalScope.findMany({
    where: { approvalId: { in: approvals.map((a) => a.id) }, offerId: { in: seller.map((l) => l.offerId) }, countryCode, channel, status: 'ACTIVE' },
    select: { approvalId: true, offerId: true, validUntil: true },
  });
  for (const line of seller) {
    const own = approvals.filter((a) => a.sellerAccountId === line.sellerAccountId);
    if (own.length === 0) {
      out.set(line.offerId, 'NO_APPROVAL');
      continue;
    }
    const matching = scopes.filter((s) => s.offerId === line.offerId && own.some((a) => a.id === s.approvalId));
    if (matching.length === 0) {
      out.set(line.offerId, 'NOT_IN_SCOPE');
      continue;
    }
    const live = matching.filter((s) => {
      const a = own.find((x) => x.id === s.approvalId);
      return a !== undefined && a.validUntil.getTime() > now.getTime() && s.validUntil.getTime() > now.getTime();
    });
    if (live.length === 0) {
      out.set(line.offerId, 'APPROVAL_EXPIRED');
      continue;
    }
    if (!live.some((s) => certOk(own.find((a) => a.id === s.approvalId)?.externalCertificationId ?? ''))) out.set(line.offerId, 'CERTIFICATE_NOT_CURRENT');
  }
  // Doc 08 s9: product evidence required for this SKU and country that is withdrawn,
  // suspended or past its issuer-set expiry blocks at once - no grace period.
  const evidenceBlocked = await offersBlockedByEvidence(client, seller.map((l) => l.offerId).filter((id) => !out.has(id)), countryCode, now);
  for (const offerId of evidenceBlocked) out.set(offerId, 'EVIDENCE_NOT_CURRENT');
  return out;
}

/** What the gate says under the configured mode: the blocks it enforces (empty when off or reporting). */
export async function enforcedBlocks(client: Client, lines: readonly GateLine[], countryCode: string, channel: SalesChannel, where: string): Promise<Map<string, ScopeBlock>> {
  const mode = gateMode();
  if (mode === 'off') return new Map();
  const blocks = await evaluateScope(client, lines, countryCode, channel);
  if (blocks.size > 0 && mode === 'report') {
    logger.warn({ where, countryCode, channel, blocked: [...blocks.entries()].slice(0, 20) }, 'seller assessment gate would block (report mode)');
    return new Map();
  }
  return blocks;
}

/** Refuse a purchase step. The message is for the buyer; it names no assessment evidence. */
export async function assertScopeEligible(client: Client, lines: readonly GateLine[], countryCode: string, channel: SalesChannel, where: string): Promise<void> {
  const blocks = await enforcedBlocks(client, lines, countryCode, channel, where);
  if (blocks.size === 0) return;
  throw conflict(
    ErrorCode.SELLER_SCOPE_NOT_APPROVED,
    `This product is not currently approved for sale to ${countryCode} ${channel === 'B2B' ? 'business' : 'consumer'} buyers. Remove it to continue.`,
    [...blocks.entries()].map(([offerId, reason]) => ({ field: 'offerId', code: reason, meta: { offerId } })),
  );
}

/**
 * A seller order already placed is re-checked at consequential steps
 * (capture, dispatch). A block never ships, cancels or refunds it: it opens a
 * disposition for a person to decide. Idempotent per trigger.
 */
export async function holdForDisposition(client: Client, input: { sellerOrderGroupId: string; orderId: string; sellerAccountId: string; trigger: 'CAPTURE_RECHECK' | 'DISPATCH_RECHECK' | 'SUSPENSION'; triggerKey: string; reason: string; noticeId?: string | null }): Promise<void> {
  await client.sellerOrderDisposition.upsert({
    where: { sellerOrderGroupId_triggerKey: { sellerOrderGroupId: input.sellerOrderGroupId, triggerKey: input.triggerKey } },
    create: { id: newId(), sellerOrderGroupId: input.sellerOrderGroupId, orderId: input.orderId, sellerAccountId: input.sellerAccountId, noticeId: input.noticeId ?? null, trigger: input.trigger, triggerKey: input.triggerKey, reason: input.reason.slice(0, 4000) },
    update: {},
  });
}

/** Facts about a placed seller order the gate needs. */
async function groupFacts(client: Client, sellerOrderGroupId: string) {
  const group = await client.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: { id: true, orderId: true, sellerAccountId: true, order: { select: { shippingAddressJson: true, buyerContextKind: true } }, lines: { select: { offerId: true } } },
  });
  if (group === null) return null;
  const address = (group.order.shippingAddressJson ?? {}) as { country?: string };
  return { group, country: (address.country ?? '').toUpperCase(), channel: channelFor(group.order.buyerContextKind === 'COMPANY') };
}

/**
 * Called after a capture has confirmed an order (money is kept and reconciled
 * exactly as before). Any seller order whose scope no longer holds is held.
 */
export async function recheckOrderAfterCapture(client: Client, orderId: string): Promise<void> {
  if (gateMode() === 'off') return;
  const groups = await client.sellerOrderGroup.findMany({ where: { orderId }, select: { id: true } });
  for (const { id } of groups) {
    const facts = await groupFacts(client, id);
    if (facts === null) continue;
    const blocks = await evaluateScope(client, facts.group.lines.map((l) => ({ sellerAccountId: facts.group.sellerAccountId, offerId: l.offerId })), facts.country, facts.channel);
    if (blocks.size === 0) continue;
    if (gateMode() === 'report') {
      logger.warn({ orderId, sellerOrderGroupId: id }, 'seller assessment gate would hold after capture (report mode)');
      continue;
    }
    await holdForDisposition(client, { sellerOrderGroupId: id, orderId: facts.group.orderId, sellerAccountId: facts.group.sellerAccountId, trigger: 'CAPTURE_RECHECK', triggerKey: `capture:${orderId}`, reason: `Scope no longer approved at payment capture: ${[...new Set(blocks.values())].join(', ')}` });
  }
}

/**
 * The dispatch gate: refuse READY_FOR_DISPATCH / SHIPPED / carrier departure
 * while a disposition is open, or when the scope no longer holds. In the
 * second case the disposition is recorded outside the refused transaction so
 * the Audit queue sees it.
 */
export async function assertDispatchAllowed(client: Client, sellerOrderGroupId: string): Promise<void> {
  if (gateMode() !== 'enforce') return;
  const open = await client.sellerOrderDisposition.findMany({ where: { sellerOrderGroupId }, select: { status: true } });
  const approvedRelease = open.length > 0 && open.every((d) => d.status === 'RELEASE_APPROVED');
  if (open.some((d) => d.status !== 'RELEASE_APPROVED')) {
    throw conflict(ErrorCode.SELLER_ORDER_DISPOSITION_REQUIRED, 'This seller order is held for a safety and legal review. It cannot be dispatched until the review is recorded.');
  }
  if (approvedRelease) return;
  const facts = await groupFacts(client, sellerOrderGroupId);
  if (facts === null) return;
  const blocks = await evaluateScope(client, facts.group.lines.map((l) => ({ sellerAccountId: facts.group.sellerAccountId, offerId: l.offerId })), facts.country, facts.channel);
  if (blocks.size === 0) return;
  await holdForDisposition(prisma, { sellerOrderGroupId, orderId: facts.group.orderId, sellerAccountId: facts.group.sellerAccountId, trigger: 'DISPATCH_RECHECK', triggerKey: 'dispatch', reason: `Scope not approved at dispatch: ${[...new Set(blocks.values())].join(', ')}` });
  throw conflict(ErrorCode.SELLER_ORDER_DISPOSITION_REQUIRED, 'This seller order is held for a safety and legal review: the product is no longer approved for this destination.');
}

/** The same refusal for callers that hold only offer ids (checkout, preorder, payment start). */
export async function assertOffersEligible(client: Client, offerIds: readonly (string | null)[], countryCode: string, channel: SalesChannel, where: string): Promise<void> {
  if (gateMode() === 'off') return;
  const ids = [...new Set(offerIds.filter((v): v is string => v !== null))];
  if (ids.length === 0) return;
  const offers = await client.sellerOffer.findMany({ where: { id: { in: ids } }, select: { id: true, sellerAccountId: true } });
  await assertScopeEligible(client, offers.map((o) => ({ sellerAccountId: o.sellerAccountId, offerId: o.id })), countryCode.toUpperCase(), channel, where);
}

/**
 * An RFQ purchase order names no catalogue offer (conversion creates a private
 * one), so the exact product cannot be matched. The seller must at least hold
 * a current approval with live scope for this country and channel, on a
 * current certificate. The RFQ product itself is reviewed by Audit as an
 * extension if it is not already in scope - see docs/PRD.md.
 */
export async function assertSellerCountryScope(client: Client, sellerAccountId: string, countryCode: string, channel: SalesChannel, where: string): Promise<void> {
  const mode = gateMode();
  if (mode === 'off') return;
  const now = new Date();
  const approvals = await client.sellerTradingApproval.findMany({
    where: { sellerAccountId, status: 'ACTIVE', validUntil: { gt: now }, scopes: { some: { countryCode: countryCode.toUpperCase(), channel, status: 'ACTIVE', validUntil: { gt: now } } } },
    select: { externalCertificationId: true },
  });
  const certs = approvals.length === 0 ? 0 : await client.sellerExternalCertification.count({ where: { id: { in: approvals.map((a) => a.externalCertificationId) }, status: 'AUTHENTICATED', expiresOn: { gt: now } } });
  if (certs > 0) return;
  if (mode === 'report') {
    logger.warn({ where, sellerAccountId, countryCode, channel }, 'seller assessment gate would block (report mode)');
    return;
  }
  throw conflict(ErrorCode.SELLER_SCOPE_NOT_APPROVED, `This supplier is not currently approved to sell to ${countryCode} ${channel === 'B2B' ? 'business' : 'consumer'} buyers.`, [{ field: 'sellerAccountId', code: 'NOT_IN_SCOPE' }]);
}

/** Before money is asked for on a placed order (pay now, pay link, AutoPay charge): its seller lines must still be in scope. */
export async function assertOrderEligible(client: Client, orderId: string, where: string): Promise<void> {
  const order = await client.order.findUnique({ where: { id: orderId }, select: { shippingAddressJson: true, buyerContextKind: true, items: { select: { sellerOfferId: true, productId: true } } } });
  if (order === null) return;
  const country = ((order.shippingAddressJson ?? {}) as { country?: string }).country ?? '';
  const channel = channelFor(order.buyerContextKind === 'COMPANY');
  // Doc 07 / Doc 08: country launched, no safety hold, a lawful import route.
  // Each rule carries its own switch; a repeat order is revalidated exactly as a new one.
  await assertCheckoutDeliveryRules(client, { countryCode: country, channel, items: order.items, purpose: where === 'autopay-charge' ? 'RECURRING' : 'PURCHASE' });
  if (gateMode() === 'off') return;
  await assertOffersEligible(client, order.items.map((i) => i.sellerOfferId), country, channel, where);
}
