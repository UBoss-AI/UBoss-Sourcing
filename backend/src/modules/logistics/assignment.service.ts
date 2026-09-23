/**
 * Putting a consignment on a carrier, and taking it off one.
 *
 * An assignment is an OFFER with an answer, not a column. That is the decision
 * this file rests on, and it is worth stating why: reassignment has to leave a
 * trail. "Who was asked, when, what they said and why" is the question a
 * disputed delivery turns into three weeks later, and a column that is
 * overwritten answers none of it.
 *
 * THE DENORMALISED COLUMN
 *
 * `LogisticsShipment.assignedPartnerId` names the carrier currently holding
 * the parcel. It is written ONLY here, and only inside the same transaction
 * that writes the assignment row, so the two cannot disagree. Every read that
 * decides AUTHORISATION uses the assignment table rather than the column - see
 * `assertShipmentAccess` - because the column names the current carrier and a
 * carrier that carried something last month must still find it in its own
 * history. The column exists for the index the busiest list query runs on.
 */
import type {
  LogisticsCapabilityKind,
  LogisticsPartnerStatus,
} from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { dueAtFrom } from '../../domain/logistics-sla.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { Permission } from '../../domain/permissions.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { recordLogisticsAudit, OPERATOR_LABEL } from './audit.service.js';
import {
  createLogisticsNotification,
  driverNeededKey,
  resolveLogisticsNotifications,
} from './notification.service.js';
import {
  notifySellerCarrierAccepted,
  notifySellerCarrierDeclined,
} from '../seller/carrier-notification.service.js';
import { appendEventInTransaction } from './shipment-event.service.js';
import {
  assertLogisticsPermission,
  assertPartnerCanAcceptWork,
  type LogisticsMembership,
} from './partner.service.js';

// ---------------------------------------------------------------------------
// Matching: which carriers could carry this?
// ---------------------------------------------------------------------------

/**
 * What a consignment needs a carrier to be approved for.
 *
 * Derived from the consignment's own handling flags, and it is the whole
 * reason `LogisticsCapability` is an approval rather than a claim: a carrier
 * that has not shown the marketplace its cold-chain equipment is not offered
 * reagents, whatever its sales team says.
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

export interface EligiblePartner {
  id: string;
  displayName: string;
  partnerCode: string;
  status: LogisticsPartnerStatus;
  /** Consignments currently open with this carrier. */
  openShipments: number;
  /** Null where the carrier has no ceiling configured. */
  maxOpenShipments: number | null;
  /** Deliveries completed on time, as a percentage. Null with no history. */
  onTimePercentage: number | null;
  /** Why this carrier is or is not offerable, for the operator's screen. */
  reasons: string[];
  isEligible: boolean;
}

/**
 * Which carriers could carry this consignment, and which could not and why.
 *
 * Returns the ineligible ones too, with their reasons. An operator staring at
 * an empty list has no idea whether nobody covers Portugal or whether
 * everybody who does is over capacity, and the difference decides what they do
 * next.
 */
export async function findEligiblePartners(shipmentId: string): Promise<EligiblePartner[]> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      originCountry: true,
      destinationCountry: true,
      destinationPostalCode: true,
      requiresColdChain: true,
      requiresTemperatureRange: true,
      requiresSterileHandling: true,
      isDangerousGoods: true,
      sellerOrderGroupId: true,
    },
  });

  if (shipment === null) throw notFound('Shipment');

  const loadType = await consignmentLoadType(shipment.sellerOrderGroupId);
  const needed = requiredCapabilities(shipment);

  // A pallet needs a pallet truck and somebody approved to run one. The
  // capability is an approval, like cold chain, and a carrier that has not
  // shown the marketplace its equipment is not offered a pallet.
  if (loadType === 'PALLET') needed.push('PALLET');

  const partners = await prisma.logisticsPartner.findMany({
    where: { archivedAt: null, status: { in: ['ACTIVE', 'SUSPENDED'] } },
    select: {
      id: true,
      displayName: true,
      partnerCode: true,
      status: true,
      maxOpenShipments: true,
      regions: {
        where: { isActive: true },
        select: {
          scope: true,
          countryCode: true,
          regionValue: true,
          supportsPickup: true,
          supportsDelivery: true,
        },
      },
      capabilities: {
        where: { state: 'APPROVED' },
        select: { kind: true, evidenceExpiresAt: true },
      },
      _count: {
        select: {
          shipments: {
            where: {
              status: {
                notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'],
              },
            },
          },
        },
      },
    },
  });

  const now = new Date();

  const scored = await Promise.all(
    partners.map(async (partner) => {
      const reasons: string[] = [];

      if (partner.status === 'SUSPENDED') reasons.push('SUSPENDED');

      const coversOrigin = partner.regions.some(
        (region) => region.supportsPickup && region.countryCode === shipment.originCountry,
      );
      const coversDestination = partner.regions.some(
        (region) =>
          region.supportsDelivery &&
          region.countryCode === shipment.destinationCountry &&
          postcodeMatches(region, shipment.destinationPostalCode),
      );

      if (!coversOrigin) reasons.push('NO_COVERAGE_ORIGIN');
      if (!coversDestination) reasons.push('NO_COVERAGE_DESTINATION');

      const approved = new Set(
        partner.capabilities
          // An expired certificate is not an approval. Checked here rather
          // than swept nightly, because a lapse that takes effect at the next
          // sweep is a lapse a consignment can slip through.
          .filter(
            (capability) =>
              capability.evidenceExpiresAt === null || capability.evidenceExpiresAt > now,
          )
          .map((capability) => capability.kind),
      );

      const missing = needed.filter((kind) => !approved.has(kind));
      for (const kind of missing) reasons.push(`MISSING_CAPABILITY:${kind}`);

      // A full or part container is sea or rail freight, arranged through a
      // freight quote with a forwarder. No capability on this platform says
      // a delivery company can move one, so none is offered it - rather than
      // offering it to everybody and letting a van turn up at a port.
      if (loadType === 'FCL' || loadType === 'LCL') reasons.push('CONTAINER_NOT_SUPPORTED');

      const openShipments = partner._count.shipments;
      if (partner.maxOpenShipments !== null && openShipments >= partner.maxOpenShipments) {
        reasons.push('AT_CAPACITY');
      }

      return {
        id: partner.id,
        displayName: partner.displayName,
        partnerCode: partner.partnerCode,
        status: partner.status,
        openShipments,
        maxOpenShipments: partner.maxOpenShipments,
        onTimePercentage: await onTimeScoreFor(partner.id),
        reasons,
        isEligible: reasons.length === 0,
      };
    }),
  );

  // Eligible first, then best on-time record, then least loaded. An operator
  // scanning this list should find the right answer at the top.
  return scored.sort((a, b) => {
    if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
    const scoreDiff = (b.onTimePercentage ?? -1) - (a.onTimePercentage ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    return a.openShipments - b.openShipments;
  });
}

/**
 * What kind of load a seller's consignment is, from the freight request made
 * for its order.
 *
 * PARCEL where there is no freight request, which is every order bought by
 * the box - the ordinary case, and the only one before bulk ordering existed.
 * The newest request wins, because a load re-quoted as two pallets instead of
 * a container is two pallets.
 */
export async function consignmentLoadType(
  sellerOrderGroupId: string | null,
): Promise<'PARCEL' | 'CARTON' | 'PALLET' | 'FCL' | 'LCL'> {
  if (sellerOrderGroupId === null) return 'PARCEL';

  const request = await prisma.sellerFreightQuoteRequest.findFirst({
    where: { sellerOrderGroupId },
    orderBy: { createdAt: 'desc' },
    select: { loadType: true },
  });

  return request?.loadType ?? 'PARCEL';
}

/**
 * Does a postcode-prefix region cover this address?
 *
 * A COUNTRY, STATE or CITY region carries an empty `regionValue` or a name
 * this function cannot compare against a postcode, so it matches. Only
 * POSTCODE_PREFIX narrows, and it narrows by prefix - which is what a carrier
 * contract actually says.
 */
function postcodeMatches(
  region: { scope: string; regionValue: string },
  postcode: string | null,
): boolean {
  if (region.scope !== 'POSTCODE_PREFIX') return true;
  if (region.regionValue.length === 0) return true;
  if (postcode === null) return false;

  return postcode.replace(/\s/g, '').toUpperCase().startsWith(region.regionValue.toUpperCase());
}

/**
 * A carrier's on-time record, over its last hundred deliveries.
 *
 * Null rather than 100 for a carrier that has delivered nothing. A brand-new
 * haulier showing a perfect score is the single most misleading number an
 * assignment screen can display, because it is exactly the carrier somebody is
 * deciding whether to trust with a consignment of reagents.
 */
async function onTimeScoreFor(partnerId: string): Promise<number | null> {
  const recent = await prisma.logisticsShipment.findMany({
    where: { assignedPartnerId: partnerId, deliveredAt: { not: null } },
    orderBy: { deliveredAt: 'desc' },
    take: 100,
    select: { deliveredAt: true, deliveryDueAt: true },
  });

  const measurable = recent.filter((row) => row.deliveryDueAt !== null && row.deliveredAt !== null);
  if (measurable.length === 0) return null;

  const onTime = measurable.filter(
    (row) => (row.deliveredAt as Date).getTime() <= (row.deliveryDueAt as Date).getTime(),
  ).length;

  return Math.round((onTime / measurable.length) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Offering
// ---------------------------------------------------------------------------

export interface OfferAssignmentInput {
  shipmentId: string;
  logisticsPartnerId: string;
  /** The staff account making the offer. Null for automatic assignment. */
  offeredByUserId: string | null;
  automatic: boolean;
  /** Overrides the deployment's default response window. */
  respondByHours?: number | null;
  correlationId?: string | null;
}

/**
 * Offer a consignment to a carrier.
 *
 * Operator-side. The partner's own routes never reach this - a carrier cannot
 * assign work to itself, which is why this takes a partner ID directly and
 * every partner-facing function in this module takes a `LogisticsMembership`
 * instead. The two argument shapes are the visible difference between "the
 * marketplace is acting" and "a tenant is acting", and keeping them different
 * is deliberate.
 *
 * Refuses a SUSPENDED carrier here rather than letting the offer sit
 * unanswered: a suspended carrier may finish what it holds and may not be
 * given more.
 */
export async function offerAssignment(input: OfferAssignmentInput): Promise<{
  assignmentId: string;
  respondBy: Date | null;
}> {
  const offered = await prisma.$transaction((tx) => offerAssignmentInTransaction(tx, input));
  await announceOffer(offered);
  return { assignmentId: offered.assignmentId, respondBy: offered.respondBy };
}

/** What an offer made inside a transaction needs announced once it commits. */
export interface OfferOutcome {
  assignmentId: string;
  respondBy: Date | null;
  partnerId: string;
  partnerName: string;
  shipment: { id: string; shipmentReference: string; receivingCompanyName: string; destinationCity: string | null };
}

/**
 * The offer itself, inside somebody's transaction.
 *
 * Exported for the seller's reassignment, which has to withdraw the incumbent
 * and offer to the replacement as ONE unit: done as two transactions, a
 * failure between them left the consignment with nobody - a carrier told it
 * had lost the work, and no carrier given it. Announcing is left to the
 * caller, after its commit, through `announceOffer`: an email queued for an
 * offer that then rolls back is an email about something that never happened.
 */
export async function offerAssignmentInTransaction(
  tx: PrismaTransaction,
  input: OfferAssignmentInput,
): Promise<OfferOutcome> {
  const respondBy = dueAtFrom(
    new Date(),
    input.respondByHours ?? env.LOGISTICS_ASSIGNMENT_RESPONSE_HOURS,
  );

  {
    const shipment = await tx.logisticsShipment.findUnique({
      where: { id: input.shipmentId },
      select: {
        id: true,
        status: true,
        version: true,
        shipmentReference: true,
        assignedPartnerId: true,
        receivingCompanyName: true,
        destinationCity: true,
      },
    });

    if (shipment === null) throw notFound('Shipment');

    const partner = await tx.logisticsPartner.findFirst({
      where: { id: input.logisticsPartnerId, archivedAt: null },
      select: { id: true, displayName: true, status: true },
    });

    if (partner === null) throw notFound('Logistics partner');

    if (partner.status !== 'ACTIVE') {
      throw conflict(
        ErrorCode.LOGISTICS_PARTNER_NOT_ACTIVE,
        `${partner.displayName} cannot take on new work right now.`,
      );
    }

    // An offer already outstanding with somebody. Withdraw it first - which is
    // an explicit act with its own audit row, rather than a silent overwrite.
    const outstanding = await tx.logisticsShipmentAssignment.findFirst({
      where: { shipmentId: shipment.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { id: true, logisticsPartnerId: true, state: true },
    });

    if (outstanding !== null) {
      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        outstanding.logisticsPartnerId === partner.id
          ? 'This shipment is already with that carrier.'
          : 'This shipment is already with another carrier. Withdraw that assignment first.',
        [{ code: 'ASSIGNMENT_OUTSTANDING', meta: { state: outstanding.state } }],
      );
    }

    const from = shipment.status;
    const assignmentId = newId();

    await tx.logisticsShipmentAssignment.create({
      data: {
        id: assignmentId,
        shipmentId: shipment.id,
        logisticsPartnerId: partner.id,
        state: 'OFFERED',
        assignedAutomatically: input.automatic,
        respondBy,
        offeredByUserId: input.offeredByUserId,
      },
    });

    /*
     * Two status moves in one breath: ASSIGNED, then ACCEPTANCE_PENDING.
     *
     * Both are real states with different meanings - ASSIGNED is "the
     * marketplace has chosen somebody", ACCEPTANCE_PENDING is "and they have
     * been asked" - and skipping the first would make the timeline of a
     * withdrawn-before-asked offer unreadable. They happen in the same
     * transaction because between them the consignment is in nobody's queue.
     */
    await moveShipmentInTransaction(tx, {
      shipmentId: shipment.id,
      version: shipment.version,
      from,
      to: 'ASSIGNED',
      source: 'UBOSS_ADMIN',
      actorUserId: input.offeredByUserId,
      publicDescription: 'A carrier has been assigned.',
      internalNote: `Offered to ${partner.displayName}.`,
      assignedPartnerId: partner.id,
    });

    await moveShipmentInTransaction(tx, {
      shipmentId: shipment.id,
      version: shipment.version + 1,
      from: 'ASSIGNED',
      to: 'ACCEPTANCE_PENDING',
      source: 'UBOSS_ADMIN',
      actorUserId: input.offeredByUserId,
      internalNote: 'Waiting for the carrier to accept.',
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partner.id,
        actorUserId: input.offeredByUserId,
        actorLabel: OPERATOR_LABEL,
        action: 'logistics.assignment.offered',
        resourceType: 'logistics_shipment_assignment',
        resourceId: assignmentId,
        after: { shipmentId: shipment.id, automatic: input.automatic },
        summary: `${shipment.shipmentReference} was offered to your company.`,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    // Outside-the-transaction work is deliberately not done here: this runs
    // inside one, and an email queued for a change that then rolls back is an
    // email about something that never happened. The caller notifies.
    return {
      assignmentId,
      respondBy,
      partnerId: partner.id,
      partnerName: partner.displayName,
      shipment: {
        id: shipment.id,
        shipmentReference: shipment.shipmentReference,
        receivingCompanyName: shipment.receivingCompanyName,
        destinationCity: shipment.destinationCity,
      },
    };
  }
}

/** Tell the carrier it has been offered work. After the commit, never inside it. */
export async function announceOffer(result: OfferOutcome): Promise<void> {
  await createLogisticsNotification({
    logisticsPartnerId: result.partnerId,
    shipmentId: result.shipment.id,
    kind: 'SHIPMENT_ASSIGNED',
    title: `New shipment ${result.shipment.shipmentReference}`,
    body: `${result.shipment.receivingCompanyName}${
      result.shipment.destinationCity === null ? '' : `, ${result.shipment.destinationCity}`
    }`,
    variables: { shipmentReference: result.shipment.shipmentReference },
    dedupeKey: `assignment:${result.assignmentId}`,
  });
}

/**
 * Move a shipment's status from inside somebody else's transaction.
 *
 * A narrow helper, and it exists because `recordShipmentEvent` opens a
 * transaction of its own. Assignment, acceptance and withdrawal all have to
 * write a row AND move a status atomically, and nesting transactions in MySQL
 * gets you a savepoint at best.
 *
 * It deliberately does NOT run `assertShipmentTransition`: every caller here
 * has already established the move is legal by its own rules - an offer to a
 * partner, an acceptance by that partner - and the transitions it makes are
 * the operator/system ones the matrix already permits. Anything a PERSON
 * requests goes through `recordShipmentEvent`, which does check.
 */
async function moveShipmentInTransaction(
  tx: PrismaTransaction,
  params: {
    shipmentId: string;
    version: number;
    from: ShipmentStatusName;
    to: ShipmentStatusName;
    source: 'UBOSS_ADMIN' | 'LOGISTICS_PORTAL' | 'SYSTEM_AUTOMATION';
    actorUserId?: string | null;
    actorLogisticsPartnerId?: string | null;
    publicDescription?: string | null;
    internalNote?: string | null;
    reason?: string | null;
    /** Set or clear the denormalised carrier column in the same write. */
    assignedPartnerId?: string | null;
    acceptedAt?: Date | null;
  },
): Promise<void> {
  const now = new Date();

  const updated = await tx.logisticsShipment.updateMany({
    where: { id: params.shipmentId, version: params.version },
    data: {
      status: params.to,
      lastEventAt: now,
      version: { increment: 1 },
      ...(params.assignedPartnerId !== undefined
        ? { assignedPartnerId: params.assignedPartnerId }
        : {}),
      ...((params.acceptedAt !== undefined && params.acceptedAt !== null) ? { acceptedAt: params.acceptedAt } : {}),
    },
  });

  if (updated.count !== 1) {
    throw conflict(
      ErrorCode.CONFLICT,
      'This shipment was changed by somebody else a moment ago. Reload and try again.',
      [{ code: 'VERSION_CONFLICT' }],
    );
  }

  await appendEventInTransaction(tx, {
    shipmentId: params.shipmentId,
    from: params.from,
    to: params.to,
    source: params.source,
    actorUserId: params.actorUserId ?? null,
    actorLogisticsPartnerId: params.actorLogisticsPartnerId ?? null,
    publicDescription: params.publicDescription ?? null,
    internalNote: params.internalNote ?? null,
    reason: params.reason ?? null,
    occurredAt: now,
  });
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/**
 * A carrier takes the job.
 *
 * `updateMany` guarded on `state: 'OFFERED'` is what makes this idempotent
 * against a double-click and safe against a race with a withdrawal: exactly
 * one caller sees `count === 1`, and the loser is told the question has
 * already been answered rather than being allowed to answer it again.
 */
export async function acceptAssignment(
  membership: LogisticsMembership,
  shipmentId: string,
  correlationId?: string | null,
): Promise<{ status: ShipmentStatusName }> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_ACCEPT);
  assertPartnerCanAcceptWork(membership);

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.logisticsShipmentAssignment.findFirst({
      where: {
        shipmentId,
        logisticsPartnerId: membership.logisticsPartnerId,
        state: 'OFFERED',
      },
      select: {
        id: true,
        shipment: {
          select: { id: true, status: true, version: true, shipmentReference: true },
        },
      },
    });

    if (assignment === null) {
      // Either it was never offered to this carrier, or it has already been
      // answered. Both are a 404-shaped answer from here: confirming which
      // would tell a caller that a shipment they cannot see exists.
      const settled = await tx.logisticsShipmentAssignment.findFirst({
        where: { shipmentId, logisticsPartnerId: membership.logisticsPartnerId },
        select: { state: true },
      });

      if (settled === null) throw notFound('Shipment');

      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        'This assignment has already been answered.',
        [{ code: 'ALREADY_ANSWERED', meta: { state: settled.state } }],
      );
    }

    const claimed = await tx.logisticsShipmentAssignment.updateMany({
      where: { id: assignment.id, state: 'OFFERED' },
      data: { state: 'ACCEPTED', respondedAt: new Date(), respondedByPartnerUserId: membership.partnerUserId },
    });

    if (claimed.count !== 1) {
      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        'This assignment has already been answered.',
      );
    }

    await moveShipmentInTransaction(tx, {
      shipmentId: assignment.shipment.id,
      version: assignment.shipment.version,
      from: assignment.shipment.status,
      to: 'ACCEPTED',
      source: 'LOGISTICS_PORTAL',
      actorUserId: membership.userId,
      actorLogisticsPartnerId: membership.logisticsPartnerId,
      publicDescription: 'The carrier has accepted this shipment.',
      acceptedAt: new Date(),
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.assignment.accepted',
        resourceType: 'logistics_shipment_assignment',
        resourceId: assignment.id,
        summary: `${membership.fullName} accepted ${assignment.shipment.shipmentReference}.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );

    return {
      status: 'ACCEPTED' as ShipmentStatusName,
      shipmentId: assignment.shipment.id,
      assignmentId: assignment.id,
    };
  }).then(async (result) => {
    // After the commit, never inside it: a seller told that their carrier
    // accepted, on a transaction that then rolled back, has been told about
    // something that did not happen.
    await notifySellerCarrierAccepted({
      shipmentId: result.shipmentId,
      carrierName: membership.displayName,
    });

    await resolveUnassignedConsignmentAlert(
      result.shipmentId,
      `${membership.displayName} accepted it.`,
    );

    /*
     * And the carrier's own dispatch is reminded what acceptance obliges.
     *
     * An accepted consignment with no driver is the one state in which
     * everybody believes somebody else has it: the seller sees "accepted", the
     * marketplace sees a carrier, and nobody is driving. An ALERT, resolved by
     * the driver assignment itself (`driverNeededKey`), so it cannot be
     * dismissed by reading it.
     */
    await createLogisticsNotification({
      logisticsPartnerId: membership.logisticsPartnerId,
      shipmentId: result.shipmentId,
      kind: 'ASSIGNMENT_ACCEPTED',
      class: 'ALERT',
      resolutionKey: driverNeededKey(result.shipmentId),
      title: 'Assign a driver',
      body: `You accepted this consignment. Put a driver on it so it can be collected.`,
      dedupeKey: `driver-needed:${result.shipmentId}:${result.assignmentId}`,
    });

    return { status: result.status };
  });
}

/**
 * A carrier declines.
 *
 * The reason is mandatory and is enforced here rather than only by the form.
 * It counts against the carrier's record and the operator has to be able to
 * read why - "no reason given" on a refused consignment of reagents is not an
 * acceptable entry in a contract review.
 *
 * The consignment goes back to AWAITING_ASSIGNMENT rather than to CREATED: it
 * has been through an offer, and the timeline should say so.
 */
export async function rejectAssignment(
  membership: LogisticsMembership,
  shipmentId: string,
  reason: string,
  correlationId?: string | null,
): Promise<{ status: ShipmentStatusName }> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_ACCEPT);

  const trimmed = reason.trim();
  if (trimmed.length < 4) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      'Say why you are turning this shipment down. The marketplace has to reassign it.',
      [{ field: 'reason', code: 'REASON_REQUIRED' }],
    );
  }

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.logisticsShipmentAssignment.findFirst({
      where: { shipmentId, logisticsPartnerId: membership.logisticsPartnerId, state: 'OFFERED' },
      select: {
        id: true,
        shipment: { select: { id: true, status: true, version: true, shipmentReference: true } },
      },
    });

    if (assignment === null) {
      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        'This assignment has already been answered.',
      );
    }

    const claimed = await tx.logisticsShipmentAssignment.updateMany({
      where: { id: assignment.id, state: 'OFFERED' },
      data: {
        state: 'REJECTED',
        respondedAt: new Date(),
        respondedByPartnerUserId: membership.partnerUserId,
        responseReason: trimmed.slice(0, 512),
      },
    });

    if (claimed.count !== 1) {
      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        'This assignment has already been answered.',
      );
    }

    await moveShipmentInTransaction(tx, {
      shipmentId: assignment.shipment.id,
      version: assignment.shipment.version,
      from: assignment.shipment.status,
      to: 'AWAITING_ASSIGNMENT',
      source: 'LOGISTICS_PORTAL',
      actorUserId: membership.userId,
      actorLogisticsPartnerId: membership.logisticsPartnerId,
      publicDescription: 'We are arranging another carrier.',
      internalNote: `Declined by ${membership.displayName}: ${trimmed}`,
      reason: trimmed,
      // Back to nobody. The carrier keeps its REJECTED assignment row, so the
      // shipment stays in its history and stays unwritable to it.
      assignedPartnerId: null,
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.assignment.rejected',
        resourceType: 'logistics_shipment_assignment',
        resourceId: assignment.id,
        after: { reason: trimmed },
        summary: `${membership.fullName} declined ${assignment.shipment.shipmentReference}.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );

    return {
      status: 'AWAITING_ASSIGNMENT' as ShipmentStatusName,
      shipmentId: assignment.shipment.id,
    };
  }).then(async (result) => {
    // The parcel now has nobody, which is the seller's problem to solve and
    // is raised as an alert rather than as news - see the seller module.
    await notifySellerCarrierDeclined({
      shipmentId: result.shipmentId,
      carrierName: membership.displayName,
      kind: 'CARRIER_REJECTED',
      reason: trimmed,
    });

    return { status: result.status };
  });
}

/**
 * The marketplace takes an assignment back.
 *
 * Used for reassignment and when a carrier is suspended mid-flight. Unlike a
 * rejection this can act on an ACCEPTED assignment, which is why it is
 * operator-only: a carrier that could withdraw its own accepted work would be
 * able to abandon a parcel it is holding without telling anybody.
 */
export interface WithdrawAssignmentInput {
  shipmentId: string;
  reason: string;
  actorUserId: string | null;
  /** How the actor is named in the carrier's audit trail. The marketplace by default. */
  actorLabel?: string;
  correlationId?: string | null;
}

export async function withdrawAssignment(params: WithdrawAssignmentInput): Promise<void> {
  const withdrawn = await prisma.$transaction((tx) => withdrawAssignmentInTransaction(tx, params));
  await announceWithdrawal(withdrawn);
}

export interface WithdrawalOutcome {
  assignmentId: string;
  logisticsPartnerId: string;
  shipmentId: string;
  shipmentReference: string;
  reason: string;
}

/**
 * The withdrawal itself, inside somebody's transaction. See
 * `offerAssignmentInTransaction` for why the two are exported this way.
 */
export async function withdrawAssignmentInTransaction(
  tx: PrismaTransaction,
  params: WithdrawAssignmentInput,
): Promise<WithdrawalOutcome> {
  const trimmed = params.reason.trim();

  if (trimmed.length < 4) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      'A withdrawal needs a reason. The carrier is told it, and so is the audit trail.',
      [{ field: 'reason', code: 'REASON_REQUIRED' }],
    );
  }

  {
    const assignment = await tx.logisticsShipmentAssignment.findFirst({
      where: { shipmentId: params.shipmentId, state: { in: ['OFFERED', 'ACCEPTED'] } },
      select: {
        id: true,
        logisticsPartnerId: true,
        shipment: { select: { id: true, status: true, version: true, shipmentReference: true } },
      },
    });

    if (assignment === null) {
      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        'There is no live assignment on this shipment to withdraw.',
      );
    }

    await tx.logisticsShipmentAssignment.updateMany({
      where: { id: assignment.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
      data: {
        state: 'WITHDRAWN',
        withdrawnAt: new Date(),
        withdrawnReason: trimmed.slice(0, 512),
      },
    });

    /*
     * The carrier losing the work loses its driver's stop too.
     *
     * Without this, an ACCEPTED assignment withdrawn after a driver was put
     * on it left that driver on the consignment: the old carrier's driver
     * still had it on their round, and the new carrier could not put its own
     * driver on it at all, because the one-live-driver index refused. The
     * row stays, with the reason, as part of the chain of custody.
     */
    await tx.logisticsDriverAssignment.updateMany({
      where: { shipmentId: assignment.shipment.id, unassignedAt: null },
      data: {
        unassignedAt: new Date(),
        activeShipmentId: null,
        unassignedReason: `Consignment withdrawn from the carrier: ${trimmed}`.slice(0, 512),
      },
    });

    await moveShipmentInTransaction(tx, {
      shipmentId: assignment.shipment.id,
      version: assignment.shipment.version,
      from: assignment.shipment.status,
      to: 'AWAITING_ASSIGNMENT',
      source: 'UBOSS_ADMIN',
      actorUserId: params.actorUserId,
      publicDescription: 'We are arranging another carrier.',
      internalNote: `Withdrawn: ${trimmed}`,
      reason: trimmed,
      assignedPartnerId: null,
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: assignment.logisticsPartnerId,
        actorUserId: params.actorUserId,
        actorLabel: params.actorLabel ?? OPERATOR_LABEL,
        action: 'logistics.assignment.withdrawn',
        resourceType: 'logistics_shipment_assignment',
        resourceId: assignment.id,
        after: { reason: trimmed },
        summary: `${assignment.shipment.shipmentReference} was withdrawn from your company: ${trimmed}`,
        correlationId: params.correlationId ?? null,
      },
      tx,
    );

    return {
      assignmentId: assignment.id,
      logisticsPartnerId: assignment.logisticsPartnerId,
      shipmentId: assignment.shipment.id,
      shipmentReference: assignment.shipment.shipmentReference,
      reason: trimmed,
    };
  }
}

/**
 * Tell the carrier that lost the work.
 *
 * It used to learn only from an audit row nobody reads in real time - so a
 * driver could still turn up at a seller's door for a parcel that had been
 * given to somebody else. Its driver-needed alert is closed too: there is no
 * longer anything to put a driver on.
 */
export async function announceWithdrawal(result: WithdrawalOutcome): Promise<void> {
  await createLogisticsNotification({
    logisticsPartnerId: result.logisticsPartnerId,
    shipmentId: result.shipmentId,
    kind: 'ASSIGNMENT_REJECTED',
    title: `${result.shipmentReference} is no longer yours`,
    body: `It was withdrawn: ${result.reason}`,
    variables: { shipmentReference: result.shipmentReference },
    dedupeKey: `withdrawn:${result.assignmentId}`,
  });

  await resolveLogisticsNotifications({
    resolutionKey: driverNeededKey(result.shipmentId),
    reason: 'The consignment was withdrawn.',
    source: 'DOMAIN_EVENT',
  });
}


/**
 * Close out offers nobody answered.
 *
 * Run on the maintenance beat. Without it an unanswered offer sits
 * ACCEPTANCE_PENDING for ever and the consignment is in nobody's queue - which
 * is the worst of the available states, because it looks assigned on the
 * operator's screen and appears in no carrier's work.
 *
 * Returns the count so the job can log something useful.
 */
export async function expireStaleAssignments(now = new Date()): Promise<{ expired: number }> {
  const stale = await prisma.logisticsShipmentAssignment.findMany({
    where: { state: 'OFFERED', respondBy: { not: null, lt: now } },
    take: 200,
    select: {
      id: true,
      logisticsPartnerId: true,
      partner: { select: { displayName: true } },
      shipment: { select: { id: true, status: true, version: true, shipmentReference: true } },
    },
  });

  let expired = 0;

  for (const assignment of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.logisticsShipmentAssignment.updateMany({
          where: { id: assignment.id, state: 'OFFERED' },
          data: { state: 'EXPIRED', respondedAt: now },
        });

        if (claimed.count !== 1) return;

        await moveShipmentInTransaction(tx, {
          shipmentId: assignment.shipment.id,
          version: assignment.shipment.version,
          from: assignment.shipment.status,
          to: 'AWAITING_ASSIGNMENT',
          source: 'SYSTEM_AUTOMATION',
          publicDescription: 'We are arranging a carrier.',
          internalNote: 'The carrier did not answer in time.',
          reason: 'Assignment offer expired.',
          assignedPartnerId: null,
        });

        expired += 1;
      });

      // Outside the transaction, and only once it committed: the parcel now
      // has nobody, and the seller is the one who has to give it to somebody.
      await notifySellerCarrierDeclined({
        shipmentId: assignment.shipment.id,
        carrierName: assignment.partner.displayName,
        kind: 'CARRIER_OFFER_EXPIRED',
      });
    } catch {
      // One stubborn row must not stop the sweep. It is retried next pass;
      // the conditional update above makes that safe.
      continue;
    }
  }

  return { expired };
}

/**
 * Mark a carrier's assignment finished.
 *
 * Called when a consignment reaches a terminal state. The row stays - it is
 * the evidence of who carried what - and its COMPLETED state is what turns the
 * carrier's access from read-and-write into read-only, so the consignee's
 * address stops being live for a company that has finished with it.
 */
export async function completeAssignmentsFor(
  shipmentId: string,
  tx?: PrismaTransaction,
): Promise<void> {
  const client = tx ?? prisma;

  await client.logisticsShipmentAssignment.updateMany({
    where: { shipmentId, state: 'ACCEPTED' },
    data: { state: 'COMPLETED', completedAt: new Date() },
  });
}

/**
 * Tell the marketplace about seller consignments nobody is carrying.
 *
 * Two cases, both past the deployment's response window
 * (`LOGISTICS_ASSIGNMENT_RESPONSE_HOURS`): a confirmed order's consignment
 * with nobody assigned, and a hand-made carrier booking still without a
 * tracking number. Either way a buyer has paid and nothing is moving. One
 * ALERT per consignment, closed by a carrier accepting it or the booking's
 * number being entered - never by being read.
 */
export async function raiseUnassignedConsignmentAlerts(
  now = new Date(),
): Promise<{ raised: number }> {
  const cutoff = new Date(now.getTime() - env.LOGISTICS_ASSIGNMENT_RESPONSE_HOURS * 3_600_000);

  const stuck = await prisma.logisticsShipment.findMany({
    where: {
      sellerAccountId: { not: null },
      createdAt: { lt: cutoff },
      sellerOrderGroup: { status: { in: ['ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] } },
      OR: [
        { status: { in: ['CREATED', 'AWAITING_ASSIGNMENT'] } },
        {
          status: 'ASSIGNED',
          manualCarrierBookings: {
            some: { status: 'BOOKING_REQUIRED', activeShipmentId: { not: null } },
          },
        },
      ],
    },
    take: 200,
    select: { id: true, shipmentReference: true, receivingCompanyName: true, createdAt: true },
  });

  for (const shipment of stuck) {
    await createAdminNotification({
      kind: AdminNotificationKind.LOGISTICS_SHIPMENT_UNASSIGNED,
      variables: {
        shipmentReference: shipment.shipmentReference,
        receivingCompany: shipment.receivingCompanyName,
        waitingHours: Math.floor((now.getTime() - shipment.createdAt.getTime()) / 3_600_000),
      },
      linkPath: `/logistics/shipments/${shipment.id}`,
      requiredPermission: Permission.LOGISTICS_READ,
      relatedType: 'logistics_shipment',
      relatedId: shipment.id,
      dedupeKey: `shipment-unassigned:${shipment.id}`,
      resolutionKey: ResolutionKey.shipmentAssignment(shipment.id),
    });
  }

  return { raised: stuck.length };
}

/** Close the marketplace's "nobody is carrying this" alert for one consignment. */
export async function resolveUnassignedConsignmentAlert(
  shipmentId: string,
  reason: string,
): Promise<void> {
  try {
    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.shipmentAssignment(shipmentId),
      reason,
      source: 'DOMAIN_EVENT',
    });
  } catch (error) {
    logger.warn({ err: error, shipmentId }, 'could not close the unassigned-consignment alert');
  }
}
