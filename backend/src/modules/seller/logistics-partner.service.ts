/**
 * A seller's carriers, and handing a parcel to one.
 *
 * The seller half of the fulfilment split. The carrier half - accepting an
 * offer, putting a driver on it, moving it through its states - already
 * existed and is untouched; what was missing was any record of WHICH carriers
 * a given seller was entitled to offer work to, and therefore any way for a
 * seller to offer it at all.
 *
 * TWO RULES, AND EVERY FUNCTION HERE IS ONE OF THEM
 *
 *   1. **Ownership comes from the session, never from the request.** Every
 *      function takes the authenticated seller's account id as its first
 *      argument and filters by it in the same query that loads the row. There
 *      is deliberately no function here that takes a shipment id alone and
 *      trusts a `sellerAccountId` from a body - that shape is how a tenant
 *      boundary gets crossed, and it is not available.
 *
 *   2. **Eligibility is decided by `domain/seller-logistics.ts`.** One pure
 *      function, used both by the endpoint that lists carriers and by the
 *      endpoint that accepts a choice, so the list a seller is shown and the
 *      list the server will accept cannot drift apart. A seller who posts a
 *      carrier id that was not in their list gets the same refusal, with the
 *      same reason, as if they had somehow seen it greyed out.
 *
 * WHAT A SELLER STILL CANNOT DO, BY CONSTRUCTION
 *
 * Create, edit, activate, deactivate or assign a driver. None of those
 * functions exist in this file, the seller routes do not import the driver
 * service, and `logistics-permissions.ts` refuses a caller who is not a
 * member of the owning carrier. The seller sees the assigned driver's
 * operational identity on their own consignment - a name and a phone number
 * masked by `logistics-masking.ts` - and nothing else about the fleet.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { LogisticsCapabilityKind } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  canSellerOfferToCarrier,
  canTransitionLink,
  explainSellerCarrierRefusal,
  transitionRequiresReason,
  type SellerCarrierLink,
  type SellerCarrierRefusal,
} from '../../domain/seller-logistics.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import { assignPartnerToConsignment } from './consignment-logistics.service.js';
import { recordRelationshipEvent } from './logistics-organisation.service.js';
import { notifySellerCarrierArrangement } from './carrier-notification.service.js';

/**
 * What a consignment needs a carrier to be approved for.
 *
 * The same derivation `assignment.service.ts` uses for the operator's picker.
 * Duplicated as a small pure function rather than exported from there because
 * exporting it would make the operator's module depend on the seller's for no
 * reason; if a third caller appears it moves to `domain/`.
 */
function requiredCapabilities(shipment: {
  requiresColdChain: boolean;
  requiresTemperatureRange: boolean;
  requiresSterileHandling: boolean;
  isDangerousGoods: boolean;
  originCountry: string;
  destinationCountry: string;
}): LogisticsCapabilityKind[] {
  const needed: LogisticsCapabilityKind[] = [];

  if (shipment.requiresColdChain) needed.push('COLD_CHAIN_2_8');
  if (shipment.requiresTemperatureRange) needed.push('TEMPERATURE_CONTROLLED');
  if (shipment.requiresSterileHandling) needed.push('STERILE_HANDLING');
  if (shipment.isDangerousGoods) needed.push('DANGEROUS_GOODS');
  if (shipment.originCountry !== shipment.destinationCountry) needed.push('INTERNATIONAL');

  return needed;
}

/** A JSON column that should hold a list of short codes, read defensively. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === 0 ? null : entries;
}

function toDomainLink(row: {
  status: SellerCarrierLink['status'];
  effectiveFrom: Date;
  effectiveTo: Date | null;
  archivedAt: Date | null;
  serviceCountriesJson: unknown;
  approvedCapabilitiesJson: unknown;
}): SellerCarrierLink {
  return {
    status: row.status,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    archivedAt: row.archivedAt,
    serviceCountries: stringList(row.serviceCountriesJson),
    approvedCapabilities: stringList(row.approvedCapabilitiesJson),
  };
}

// ---------------------------------------------------------------------------
// The seller's carrier list
// ---------------------------------------------------------------------------

export interface SellerCarrierView {
  linkId: string;
  logisticsPartnerId: string;
  displayName: string;
  partnerCode: string;
  relationshipType: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  serviceCountries: string[] | null;
  approvedCapabilities: string[] | null;
  sellerReference: string | null;
  statusReason: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

/**
 * Every carrier arrangement this seller has, whatever its state.
 *
 * Rejected and ended ones included. A seller who cannot see that their request
 * was refused three weeks ago simply requests again, and the approvals queue
 * fills with duplicates of a decision somebody already made.
 */
export async function listSellerCarriers(
  sellerAccountId: string,
): Promise<SellerCarrierView[]> {
  const rows = await prisma.sellerLogisticsPartner.findMany({
    where: { sellerAccountId, archivedAt: null },
    include: {
      logisticsPartner: { select: { displayName: true, partnerCode: true } },
    },
    orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
  });

  return rows.map((row) => ({
    linkId: row.id,
    logisticsPartnerId: row.logisticsPartnerId,
    displayName: row.logisticsPartner.displayName,
    partnerCode: row.logisticsPartner.partnerCode,
    relationshipType: row.relationshipType,
    status: row.status,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    serviceCountries: stringList(row.serviceCountriesJson),
    approvedCapabilities: stringList(row.approvedCapabilitiesJson),
    sellerReference: row.sellerReference,
    statusReason: row.statusReason,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  }));
}

export interface CarrierChoice {
  logisticsPartnerId: string;
  displayName: string;
  partnerCode: string;
  isEligible: boolean;
  /** Why not, in the seller's own terms. Null when eligible. */
  reason: string | null;
  refusal: SellerCarrierRefusal | null;
}

/**
 * Which of this seller's carriers may take THIS consignment, and which may not.
 *
 * Returns the ineligible ones with their reasons, exactly as the operator's
 * own picker does. A seller looking at an empty dropdown has no idea whether
 * they have no carriers at all, or their one carrier is suspended, or it does
 * not reach the destination - and those lead to three different next actions.
 *
 * The shipment is loaded filtered by `sellerAccountId`, so asking about
 * somebody else's consignment is a 404 rather than a disclosure.
 */
export async function carrierChoicesForShipment(
  sellerAccountId: string,
  shipmentId: string,
  now: Date = new Date(),
): Promise<CarrierChoice[]> {
  const shipment = await prisma.logisticsShipment.findFirst({
    where: { id: shipmentId, sellerAccountId },
    select: {
      id: true,
      originCountry: true,
      destinationCountry: true,
      requiresColdChain: true,
      requiresTemperatureRange: true,
      requiresSterileHandling: true,
      isDangerousGoods: true,
    },
  });

  if (shipment === null) throw notFound('Shipment');

  const facts = {
    originCountry: shipment.originCountry,
    destinationCountry: shipment.destinationCountry,
    requiredCapabilities: requiredCapabilities(shipment),
  };

  const links = await prisma.sellerLogisticsPartner.findMany({
    where: { sellerAccountId, archivedAt: null },
    include: {
      logisticsPartner: {
        select: { id: true, displayName: true, partnerCode: true, status: true, archivedAt: true },
      },
    },
  });

  return links.map((link) => {
    const verdict = canSellerOfferToCarrier(
      toDomainLink(link),
      { status: link.logisticsPartner.status, archivedAt: link.logisticsPartner.archivedAt },
      facts,
      now,
    );

    return {
      logisticsPartnerId: link.logisticsPartnerId,
      displayName: link.logisticsPartner.displayName,
      partnerCode: link.logisticsPartner.partnerCode,
      isEligible: verdict.allowed,
      reason: verdict.allowed
        ? null
        : explainSellerCarrierRefusal(verdict.refusal, link.logisticsPartner.displayName),
      refusal: verdict.allowed ? null : verdict.refusal,
    };
  });
}

// ---------------------------------------------------------------------------
// Offering a consignment
// ---------------------------------------------------------------------------

export interface SellerAssignInput {
  sellerAccountId: string;
  shipmentId: string;
  logisticsPartnerId: string;
  /** The seller team member acting. Recorded, never used for authorisation. */
  sellerMemberId: string | null;
  actorEmail: string;
  /** Required when this replaces a carrier already chosen. */
  reason?: string | null;
  correlationId?: string | null;
}

/**
 * The seller chooses a carrier for their own consignment.
 *
 * FIVE GATES, IN THIS ORDER, AND EACH ONE MATTERS
 *
 *   1. The consignment is loaded `WHERE sellerAccountId = <session>`. A seller
 *      asking about somebody else's parcel gets a 404 and learns nothing -
 *      not even that it exists.
 *   2. It is not already finished. Offering a delivered parcel to a carrier is
 *      not a mistake worth absorbing.
 *   3. The carrier is one this seller is entitled to use, decided by the same
 *      pure function that built their dropdown.
 *   4. A carrier already holding it must be displaced explicitly, with a
 *      reason, and the displacement is a real withdrawal rather than an
 *      overwrite - `offerAssignment` refuses outright while another carrier
 *      holds the consignment, which is the correct behaviour and is why this
 *      calls `withdrawAssignment` first. The carrier that loses the work is
 *      told, and both rows survive.
 *   5. `offerAssignment` applies the operator-side rules on top - the carrier
 *      must still be ACTIVE at this instant, and the write is transactional
 *      with the denormalised `assignedPartnerId`.
 *
 * Note gate 5. This does not reimplement offering; it authorises and delegates.
 * A second implementation of "give this parcel to that carrier" would be a
 * second set of rules to keep in step, and the one that got missed would be
 * the one a seller could reach.
 */
export async function sellerAssignCarrier(input: SellerAssignInput): Promise<{
  assignmentId: string;
  respondBy: Date | null;
  replacedPartnerId: string | null;
}> {
  // One implementation of "give this parcel to that carrier", with every
  // gate: ownership, the seller's confirmation, not yet collected, the
  // arrangement AND the carrier's own reach and approvals, one live carrier,
  // an atomic swap and an idempotent repeat. See consignment-logistics.service.
  const result = await assignPartnerToConsignment({
    actor: {
      sellerAccountId: input.sellerAccountId,
      memberId: input.sellerMemberId,
      label: input.actorEmail,
    },
    shipmentId: input.shipmentId,
    logisticsPartnerId: input.logisticsPartnerId,
    reason: input.reason ?? null,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });

  return {
    assignmentId: result.assignmentId,
    respondBy: result.respondBy,
    replacedPartnerId: result.replacedPartnerId,
  };
}

// ---------------------------------------------------------------------------
// Requesting and deciding a relationship
// ---------------------------------------------------------------------------

/**
 * A seller asks to be able to use a carrier.
 *
 * Creates the row in REQUESTED, or moves an existing REJECTED/ENDED row back
 * to it. One row per pair is a database constraint, so re-requesting cannot
 * produce a second arrangement that disagrees with the first.
 *
 * A seller cannot approve their own request - `decidedByUserId` is written
 * only by `decideSellerCarrier`, which is behind an operator permission.
 */
export async function requestSellerCarrier(input: {
  sellerAccountId: string;
  logisticsPartnerId: string;
  sellerMemberId: string | null;
  actorEmail: string;
  sellerReference?: string | null;
  correlationId?: string | null;
}): Promise<{ linkId: string; status: string }> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: input.logisticsPartnerId, archivedAt: null },
    select: { id: true, displayName: true, status: true },
  });

  if (partner === null) throw notFound('Logistics partner');

  const existing = await prisma.sellerLogisticsPartner.findUnique({
    where: {
      sellerAccountId_logisticsPartnerId: {
        sellerAccountId: input.sellerAccountId,
        logisticsPartnerId: input.logisticsPartnerId,
      },
    },
    select: { id: true, status: true },
  });

  if (existing !== null) {
    if (existing.status === 'APPROVED' || existing.status === 'REQUESTED') {
      throw conflict(
        ErrorCode.CONFLICT,
        `You already have a request or an arrangement with ${partner.displayName}.`,
      );
    }

    if (!canTransitionLink(existing.status, 'REQUESTED')) {
      throw conflict(
        ErrorCode.CONFLICT,
        `Your arrangement with ${partner.displayName} cannot be requested again from here.`,
      );
    }

    const row = await prisma.sellerLogisticsPartner.update({
      where: { id: existing.id },
      data: {
        status: 'REQUESTED',
        requestedAt: new Date(),
        requestedBySellerMemberId: input.sellerMemberId,
        decidedByUserId: null,
        decidedAt: null,
        statusReason: null,
        archivedAt: null,
        ...(input.sellerReference === undefined
          ? {}
          : { sellerReference: input.sellerReference }),
      },
      select: { id: true, status: true },
    });

    await auditLink(input, partner.displayName, 'seller.carrier.requested', row.id);
    return { linkId: row.id, status: row.status };
  }

  const row = await prisma.sellerLogisticsPartner.create({
    data: {
      id: newId(),
      sellerAccountId: input.sellerAccountId,
      logisticsPartnerId: input.logisticsPartnerId,
      status: 'REQUESTED',
      requestedBySellerMemberId: input.sellerMemberId,
      sellerReference: input.sellerReference ?? null,
    },
    select: { id: true, status: true },
  });

  await auditLink(input, partner.displayName, 'seller.carrier.requested', row.id);
  return { linkId: row.id, status: row.status };
}

async function auditLink(
  input: {
    sellerAccountId: string;
    sellerMemberId: string | null;
    actorEmail: string;
    correlationId?: string | null;
  },
  partnerName: string,
  action: string,
  linkId: string,
): Promise<void> {
  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action,
    actor: { type: 'CUSTOMER', label: input.actorEmail },
    resourceType: 'seller_logistics_partner',
    resourceId: linkId,
    summary: `Asked to use ${partnerName} as a carrier.`,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
}

/**
 * The marketplace decides a request, or changes an existing arrangement.
 *
 * Operator-side, behind a permission the routes enforce. The transition is
 * checked against `canTransitionLink` rather than written freely, on the same
 * reasoning as the order and schedule state machines: a status that can be set
 * to anything from anywhere eventually is.
 */
export async function decideSellerCarrier(input: {
  linkId: string;
  to: 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'ENDED';
  decidedByUserId: string;
  reason?: string | null;
  relationshipType?: 'DIRECT_CONTRACT' | 'MARKETPLACE_BROKERED' | 'PREFERRED';
  serviceCountries?: string[] | null;
  approvedCapabilities?: string[] | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}): Promise<{ linkId: string; status: string }> {
  const existing = await prisma.sellerLogisticsPartner.findUnique({
    where: { id: input.linkId },
    select: {
      id: true,
      status: true,
      sellerAccountId: true,
      // Named in the notice the seller reads, so it says which carrier
      // rather than "your arrangement".
      logisticsPartner: { select: { displayName: true } },
    },
  });

  if (existing === null) throw notFound('Carrier arrangement');

  if (!canTransitionLink(existing.status, input.to)) {
    throw conflict(
      ErrorCode.CONFLICT,
      `A ${existing.status.toLowerCase()} arrangement cannot become ${input.to.toLowerCase()}.`,
    );
  }

  const reason = input.reason?.trim() ?? '';

  if (transitionRequiresReason(input.to) && reason.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why. A refusal or a suspension with no reason is one the seller cannot act on.',
      [{ field: 'reason', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const row = await prisma.sellerLogisticsPartner.update({
    where: { id: input.linkId },
    data: {
      status: input.to,
      decidedByUserId: input.decidedByUserId,
      decidedAt: new Date(),
      statusReason: reason.length === 0 ? null : reason.slice(0, 512),
      ...(input.relationshipType === undefined
        ? {}
        : { relationshipType: input.relationshipType }),
      ...(input.serviceCountries === undefined
        ? {}
        : { serviceCountriesJson: input.serviceCountries ?? Prisma.DbNull }),
      ...(input.approvedCapabilities === undefined
        ? {}
        : { approvedCapabilitiesJson: input.approvedCapabilities ?? Prisma.DbNull }),
      ...(input.effectiveFrom === undefined ? {} : { effectiveFrom: input.effectiveFrom }),
      ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
    },
    select: { id: true, status: true },
  });

  /*
   * The history line, beside the status it describes.
   *
   * Every move of this column goes through this function, so recording it here
   * means the trail cannot be incomplete - which matters because the question
   * it answers ("how did this arrangement get here?") is asked during a
   * dispute, months later, after the row has been suspended and restored.
   *
   * `actorLabel` is "Marketplace" rather than the member of staff's name. Who
   * on the operator's side decided is the operator's business; the seller
   * learns that it was decided, when, and why. That is the same posture
   * `SellerAuditLog` already takes.
   */
  await recordRelationshipEvent({
    sellerLogisticsPartnerId: row.id,
    fromStatus: existing.status,
    toStatus: input.to,
    reason: reason.length === 0 ? null : reason,
    actorUserId: input.decidedByUserId,
    actorLabel: 'Marketplace',
  });

  await notifySellerCarrierArrangement({
    sellerAccountId: existing.sellerAccountId,
    linkId: row.id,
    carrierName: existing.logisticsPartner.displayName,
    status: input.to,
    reason: reason.length === 0 ? null : reason,
  });

  return { linkId: row.id, status: row.status };
}
