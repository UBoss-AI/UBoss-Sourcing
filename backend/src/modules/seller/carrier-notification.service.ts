/**
 * Telling a seller what their carrier did.
 *
 * THE LOOP THIS CLOSES
 *
 * A seller can hand a consignment to a carrier. Until this existed they then
 * heard nothing: no acceptance, no refusal, no word when the offer lapsed
 * unanswered. The parcel sat in a state only the marketplace could see, and
 * the seller found out when a buyer asked where their order was.
 *
 * WHY TWO OF THESE ARE ALERTS AND ONE IS NOT
 *
 * "Your carrier accepted" is news: it is over the moment it is read, and
 * nothing is owed by anybody. "Your carrier refused" and "the offer lapsed"
 * are not - the parcel now has NOBODY, and that stays true however many
 * people glance at the list. So they are alerts, keyed on the consignment
 * rather than on the refusal, and handing it to somebody else closes them.
 *
 * One key per consignment, not per refusal, is what makes a parcel that has
 * been turned down twice read as one problem with two entries rather than two
 * problems.
 *
 * WHERE THIS LIVES, AND WHY NOT IN THE LOGISTICS MODULE
 *
 * The carrier's own feed is `logistics/notification.service.ts` and knows
 * nothing about sellers. This is the other side of the same events, and
 * keeping it here means the logistics services stay free of seller concerns -
 * they call one function and do not learn what a seller is.
 *
 * NOTHING HERE THROWS INTO ITS CALLER. A notification is a consequence of work
 * that has already happened; failing a carrier's "accept" because a seller's
 * feed could not be written would be reporting a failure that did not occur.
 */
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import {
  consignmentUnassignedKey,
  notifySeller,
  resolveSellerNotifications,
} from './notification.service.js';

/**
 * The seller behind a consignment, or null.
 *
 * Null is the ordinary case for the operator's own goods: a consignment raised
 * from the operator's warehouse has no seller, and there is nobody to tell.
 * That is a no-op rather than an error.
 */
async function sellerFor(shipmentId: string): Promise<{
  sellerAccountId: string;
  reference: string;
} | null> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { sellerAccountId: true, shipmentReference: true },
  });

  if (shipment === null || shipment.sellerAccountId === null) return null;

  return {
    sellerAccountId: shipment.sellerAccountId,
    reference: shipment.shipmentReference,
  };
}

/**
 * A carrier took the job.
 *
 * News, and it closes the alert if the consignment had been sitting unassigned
 * after an earlier refusal — the problem is over, so the badge should stop
 * counting it while the history keeps it.
 */
export async function notifySellerCarrierAccepted(params: {
  shipmentId: string;
  carrierName: string;
}): Promise<void> {
  try {
    const seller = await sellerFor(params.shipmentId);
    if (seller === null) return;

    await notifySeller({
      sellerAccountId: seller.sellerAccountId,
      kind: 'CARRIER_ACCEPTED',
      title: `${params.carrierName} accepted ${seller.reference}`,
      body: `${params.carrierName} has taken on consignment ${seller.reference}. They will arrange collection and put one of their own drivers on it.`,
      linkPath: '/seller/orders',
      severity: 'SUCCESS',
      subjectType: 'logistics_shipment',
      subjectId: params.shipmentId,
      // The consignment, not the acceptance: a carrier that somehow accepts
      // twice announces it once.
      dedupeKey: `accepted:${params.shipmentId}`,
    });

    await resolveSellerNotifications({
      resolutionKey: consignmentUnassignedKey(params.shipmentId),
      source: 'DOMAIN_EVENT',
      note: `${params.carrierName} accepted it.`,
    });
  } catch (error) {
    logger.warn({ err: error, shipmentId: params.shipmentId }, 'could not tell the seller their carrier accepted');
  }
}

/**
 * A carrier turned the job down, or never answered.
 *
 * An ALERT either way, because the outcome is the same and it is the outcome
 * that matters: the parcel has nobody. The two are kept as different KINDS
 * because the seller's next move differs — a refusal comes with a reason they
 * can act on, and a lapse means the carrier is not reading their queue.
 */
export async function notifySellerCarrierDeclined(params: {
  shipmentId: string;
  carrierName: string;
  kind: 'CARRIER_REJECTED' | 'CARRIER_OFFER_EXPIRED';
  /** The carrier's own words, on a refusal. Absent on a lapse. */
  reason?: string | null;
}): Promise<void> {
  try {
    const seller = await sellerFor(params.shipmentId);
    if (seller === null) return;

    const isRefusal = params.kind === 'CARRIER_REJECTED';

    await notifySeller({
      sellerAccountId: seller.sellerAccountId,
      kind: params.kind,
      title: isRefusal
        ? `${params.carrierName} turned down ${seller.reference}`
        : `${params.carrierName} did not answer for ${seller.reference}`,
      body: isRefusal
        ? `${params.carrierName} will not carry consignment ${seller.reference}. ${
            params.reason ?? ''
          } Choose another carrier from the order.`.trim()
        : `The offer of consignment ${seller.reference} to ${params.carrierName} lapsed unanswered. Nobody is carrying it. Choose another carrier from the order.`,
      linkPath: '/seller/orders',
      severity: 'WARNING',
      subjectType: 'logistics_shipment',
      subjectId: params.shipmentId,
      // The carrier is in the key, so a second carrier refusing the same
      // parcel is a second entry rather than a silent duplicate.
      dedupeKey: `${params.kind}:${params.shipmentId}:${params.carrierName}`.slice(0, 120),
      class: 'ALERT',
      // ...but the PROBLEM is the parcel, so one assignment closes both.
      resolutionKey: consignmentUnassignedKey(params.shipmentId),
    });
  } catch (error) {
    logger.warn(
      { err: error, shipmentId: params.shipmentId },
      'could not tell the seller their carrier declined',
    );
  }
}

/**
 * The seller handed it to somebody, so it is no longer nobody's.
 *
 * Called when a carrier is offered the work rather than when they accept.
 * That is deliberate: the seller has acted, the parcel is moving through the
 * process again, and leaving the alert up until an acceptance arrives would
 * make it read as "you still have to do something" when they do not.
 */
export async function resolveConsignmentUnassigned(params: {
  shipmentId: string;
  carrierName: string;
}): Promise<void> {
  try {
    await resolveSellerNotifications({
      resolutionKey: consignmentUnassignedKey(params.shipmentId),
      source: 'DOMAIN_EVENT',
      note: `Offered to ${params.carrierName}.`,
    });
  } catch (error) {
    logger.warn(
      { err: error, shipmentId: params.shipmentId },
      'could not clear the unassigned-consignment alert',
    );
  }
}

/**
 * The marketplace decided a seller's request to use a carrier.
 *
 * News rather than an alert, including the refusals. A refused arrangement is
 * not an ongoing problem with a consignment — it is a decision the seller
 * reads once and acts on, and the reason is in the body because "no" without
 * "why" is a support ticket.
 */
export async function notifySellerCarrierArrangement(params: {
  sellerAccountId: string;
  linkId: string;
  carrierName: string;
  status: 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'ENDED';
  reason?: string | null;
}): Promise<void> {
  const HEADLINE: Record<typeof params.status, string> = {
    APPROVED: `You can now use ${params.carrierName}`,
    REJECTED: `${params.carrierName} was not approved for you`,
    SUSPENDED: `Your arrangement with ${params.carrierName} is paused`,
    ENDED: `Your arrangement with ${params.carrierName} has ended`,
  };

  const BODY: Record<typeof params.status, string> = {
    APPROVED: `You can offer your own consignments to ${params.carrierName} from an order.`,
    REJECTED: `The marketplace did not approve this arrangement.`,
    SUSPENDED: `${params.carrierName} will finish the consignments they already hold and cannot be given new ones.`,
    ENDED: `${params.carrierName} can no longer be chosen for your consignments.`,
  };

  try {
    await notifySeller({
      sellerAccountId: params.sellerAccountId,
      kind: 'CARRIER_ARRANGEMENT_DECISION',
      title: HEADLINE[params.status],
      body: `${BODY[params.status]} ${params.reason ?? ''}`.trim(),
      linkPath: '/seller/carriers',
      severity: params.status === 'APPROVED' ? 'SUCCESS' : 'WARNING',
      subjectType: 'seller_logistics_partner',
      subjectId: params.linkId,
      // The decision, not the arrangement: approving, then pausing, then
      // approving again is three things the seller has to read.
      dedupeKey: `arrangement:${params.linkId}:${params.status}`,
    });
  } catch (error) {
    logger.warn(
      { err: error, linkId: params.linkId },
      'could not tell the seller about their carrier arrangement',
    );
  }
}
