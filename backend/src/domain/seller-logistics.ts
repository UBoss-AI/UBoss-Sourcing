/**
 * Who may hand which parcel to whom.
 *
 * Pure decision logic for the seller half of the fulfilment split. No Prisma,
 * no HTTP - it takes the facts and returns a verdict with a reason, so every
 * one of these rules can be tested without a database and so the answer cannot
 * differ between the screen that lists carriers and the endpoint that accepts
 * the choice.
 *
 * THE SPLIT THIS FILE EXISTS TO ENFORCE
 *
 *   A seller chooses a CARRIER for their own paid shipment.
 *   A carrier chooses a DRIVER for the shipments it has accepted.
 *
 * Neither reaches into the other. A seller has no business knowing who is on a
 * carrier's payroll - the drivers are the carrier's staff, their availability
 * is the carrier's operational problem, and a seller who could assign one
 * could strand a van. A carrier has no business seeing a seller's other
 * consignments. Everything here is about the first half; the second half is
 * enforced in `logistics-permissions.ts` and by the database constraint on
 * `LogisticsDriverAssignment.activeShipmentId`.
 *
 * WHY THE VERDICT CARRIES A REASON RATHER THAN BEING A BOOLEAN
 *
 * A seller looking at an empty carrier list needs to know whether nobody is
 * approved for them, or their one approved carrier is suspended, or it does
 * not reach Portugal. Those lead to three different next actions, and a bare
 * `false` leads to a support ticket.
 */
import type {
  LogisticsPartnerStatus,
  SellerLogisticsRelationshipStatus,
} from '../generated/prisma/enums.js';

/** Why a seller may not offer a given shipment to a given carrier. */
export type SellerCarrierRefusal =
  /** No row at all: this seller has never been linked to this carrier. */
  | 'NOT_LINKED'
  /** A link exists but is not approved - requested, rejected or ended. */
  | 'LINK_NOT_APPROVED'
  /** Approved, but suspended. May finish existing work, may not take new. */
  | 'LINK_SUSPENDED'
  /** Approved, but outside its effective dates. */
  | 'LINK_NOT_IN_EFFECT'
  /** The carrier itself is suspended or archived, whatever the link says. */
  | 'PARTNER_NOT_ACTIVE'
  /** The link narrows this seller to countries that do not include this run. */
  | 'OUTSIDE_AGREED_COUNTRIES'
  /** The link narrows this seller to capabilities this shipment needs more than. */
  | 'CAPABILITY_NOT_AGREED';

export interface SellerCarrierLink {
  status: SellerLogisticsRelationshipStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  archivedAt: Date | null;
  /** Null means "wherever the carrier itself serves". Never widens. */
  serviceCountries: readonly string[] | null;
  /** Null means "all of the carrier's own". Never widens. */
  approvedCapabilities: readonly string[] | null;
}

export interface CarrierFacts {
  status: LogisticsPartnerStatus;
  archivedAt: Date | null;
}

export interface ShipmentFacts {
  originCountry: string;
  destinationCountry: string;
  /** Capability names this consignment requires, e.g. COLD_CHAIN. */
  requiredCapabilities: readonly string[];
}

export type SellerCarrierVerdict =
  | { allowed: true }
  | { allowed: false; refusal: SellerCarrierRefusal };

/**
 * May this seller offer this shipment to this carrier?
 *
 * The checks are ordered from "nothing to do with this shipment" to "this
 * shipment specifically", so the reason a seller is shown is the most general
 * true one. Telling somebody their carrier does not cover Portugal, when the
 * real problem is that the carrier is suspended entirely, sends them to fix
 * the wrong thing.
 *
 * Note what is NOT checked here: whether the shipment belongs to this seller.
 * That is ownership, not eligibility, and it is checked in the service against
 * the session - never against anything a browser sent. Mixing the two would
 * make it possible to satisfy an authorisation check with a request body.
 */
export function canSellerOfferToCarrier(
  link: SellerCarrierLink | null,
  carrier: CarrierFacts,
  shipment: ShipmentFacts,
  now: Date = new Date(),
): SellerCarrierVerdict {
  if (link === null || link.archivedAt !== null) {
    return { allowed: false, refusal: 'NOT_LINKED' };
  }

  if (link.status === 'SUSPENDED') {
    return { allowed: false, refusal: 'LINK_SUSPENDED' };
  }

  if (link.status !== 'APPROVED') {
    return { allowed: false, refusal: 'LINK_NOT_APPROVED' };
  }

  if (link.effectiveFrom.getTime() > now.getTime()) {
    return { allowed: false, refusal: 'LINK_NOT_IN_EFFECT' };
  }

  if (link.effectiveTo !== null && link.effectiveTo.getTime() <= now.getTime()) {
    return { allowed: false, refusal: 'LINK_NOT_IN_EFFECT' };
  }

  // The carrier's own state overrides anything the link says. A suspended
  // carrier may finish what it holds and may not be given more, and a link
  // approved last year cannot grant an exception to that.
  if (carrier.archivedAt !== null || carrier.status !== 'ACTIVE') {
    return { allowed: false, refusal: 'PARTNER_NOT_ACTIVE' };
  }

  if (link.serviceCountries !== null) {
    const agreed = new Set(link.serviceCountries.map((code) => code.toUpperCase()));

    // BOTH ends. A carrier agreed for collections in Poland and deliveries in
    // Poland has not agreed to take a parcel from Poland to Portugal, and
    // checking only the destination would let exactly that through.
    if (
      !agreed.has(shipment.originCountry.toUpperCase()) ||
      !agreed.has(shipment.destinationCountry.toUpperCase())
    ) {
      return { allowed: false, refusal: 'OUTSIDE_AGREED_COUNTRIES' };
    }
  }

  if (link.approvedCapabilities !== null) {
    const agreed = new Set(link.approvedCapabilities.map((name) => name.toUpperCase()));

    const missing = shipment.requiredCapabilities.filter(
      (name) => !agreed.has(name.toUpperCase()),
    );

    if (missing.length > 0) {
      return { allowed: false, refusal: 'CAPABILITY_NOT_AGREED' };
    }
  }

  return { allowed: true };
}

/**
 * The refusal in words a seller can act on.
 *
 * Deliberately says nothing about the carrier's internal state beyond "cannot
 * take work right now". Why a carrier is suspended is between the carrier and
 * the marketplace, and a seller learning it from a dropdown is a disclosure
 * nobody authorised.
 */
export function explainSellerCarrierRefusal(
  refusal: SellerCarrierRefusal,
  carrierName: string,
): string {
  switch (refusal) {
    case 'NOT_LINKED':
      return `You are not set up to use ${carrierName}. Request them from your carriers page first.`;
    case 'LINK_NOT_APPROVED':
      return `Your request to use ${carrierName} has not been approved yet.`;
    case 'LINK_SUSPENDED':
      return `Your arrangement with ${carrierName} is suspended, so they cannot take new consignments.`;
    case 'LINK_NOT_IN_EFFECT':
      return `Your arrangement with ${carrierName} is not in effect on this date.`;
    case 'PARTNER_NOT_ACTIVE':
      return `${carrierName} cannot take on new work right now.`;
    case 'OUTSIDE_AGREED_COUNTRIES':
      return `Your arrangement with ${carrierName} does not cover this collection or delivery country.`;
    case 'CAPABILITY_NOT_AGREED':
      return `Your arrangement with ${carrierName} does not cover the handling this consignment needs.`;
  }
}

/**
 * Whether a link may still be used for work already offered.
 *
 * The distinction SUSPENDED exists for. A suspended arrangement stops new
 * offers and leaves the parcels already on a van alone - ending it the other
 * way would strand them, which is worse than the problem suspension is
 * usually reaching for.
 */
export function linkAllowsExistingWork(status: SellerLogisticsRelationshipStatus): boolean {
  return status === 'APPROVED' || status === 'SUSPENDED';
}

/**
 * The statuses a link may move to from where it is.
 *
 * The same shape as the order and schedule state machines, and for the same
 * reason: a status that can be set to anything from anywhere is a status that
 * eventually is. Note that ENDED is terminal in one direction only - a seller
 * may request a carrier again, which moves the single row back to REQUESTED
 * rather than creating a second one.
 */
const TRANSITIONS: Readonly<
  Record<SellerLogisticsRelationshipStatus, readonly SellerLogisticsRelationshipStatus[]>
> = Object.freeze({
  // --- A seller introducing a company that is not here yet ------------------
  //
  // The four states before REQUESTED exist because a seller-introduced carrier
  // has to agree before the marketplace is asked anything. A seller cannot
  // volunteer another company for an obligation, and a marketplace approving a
  // relationship the carrier has not accepted approves one side of a contract.
  DRAFT: ['INVITED', 'ENDED'],
  // The invitation has gone out. REJECTED where the company declined it;
  // ENDED where the seller withdrew it or it expired.
  INVITED: ['PARTNER_ACCEPTANCE_PENDING', 'REJECTED', 'ENDED'],
  // They have an account and are deciding. Their yes moves it to REQUESTED,
  // which is where the marketplace picks it up.
  PARTNER_ACCEPTANCE_PENDING: ['REQUESTED', 'REJECTED', 'ENDED'],

  // --- With the marketplace -------------------------------------------------
  REQUESTED: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
  // Back with the seller, and recoverable without starting again - which is
  // the whole difference between this and REJECTED.
  CHANGES_REQUESTED: ['REQUESTED', 'ENDED'],

  // --- Live, and after ------------------------------------------------------
  APPROVED: ['SUSPENDED', 'ENDED'],
  // Not terminal. A seller may fix what was wrong and ask again, and that
  // moves this single row rather than creating a second one - so "may this
  // seller use this carrier" is always answered by exactly one row.
  REJECTED: ['REQUESTED', 'DRAFT'],
  SUSPENDED: ['APPROVED', 'ENDED'],
  ENDED: ['REQUESTED', 'DRAFT'],
});

export function canTransitionLink(
  from: SellerLogisticsRelationshipStatus,
  to: SellerLogisticsRelationshipStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses whose change must carry a reason, because somebody will ask. */
export function transitionRequiresReason(to: SellerLogisticsRelationshipStatus): boolean {
  return (
    to === 'REJECTED' ||
    to === 'SUSPENDED' ||
    to === 'ENDED' ||
    // "We need something changed" with nothing after it is the least useful
    // message a marketplace can send: it stops the seller and tells them
    // nothing to do.
    to === 'CHANGES_REQUESTED'
  );
}
