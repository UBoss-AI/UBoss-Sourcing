/**
 * The four legs of a confirmed seller order, carried out one after another.
 *
 *   L1 plant -> port of loading, L2 -> destination port, L3 -> destination
 *   warehouse, L4 -> the buyer.
 *
 * WHEN THEY EXIST. When the seller confirms their part of an order that was
 * priced on four levels - never before. Nobody may be offered work on an
 * order the seller may still refuse. Each leg copies its owner from the
 * charge frozen at checkout, so a policy published afterwards moves nobody's
 * parcel.
 *
 * WHO MAY DO WHAT, decided here on every call:
 *
 *   - the SELLER names the carrier for their own legs, on their own orders;
 *   - UBOSS staff name the carrier for UBOSS legs;
 *   - the delivery company holding a leg accepts or refuses it, puts its own
 *     driver on it, and records it starting and being handed over;
 *   - an external carrier (DHL, FedEx, India Post, a forwarder) booked by hand
 *     is moved by whoever controls the leg, and needs its real tracking
 *     reference first. Nothing here books a carrier, generates a reference or
 *     invents a driver.
 *
 * A seller can never reach another seller's legs: every seller read and write
 * is scoped by the seller id from the session, and a leg of somebody else's is
 * "not found" rather than "forbidden", so its existence is not disclosed.
 *
 * SEQUENTIAL. A leg starts only when the one before it has been handed over.
 * The next leg then becomes the next owner's turn, and they are told.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import {
  assertLegTransition,
  legMayBeAssigned,
  LegTransitionError,
  levelAt,
  levelSequence,
  LOGISTICS_LEVELS,
  TERMINAL_LEG_STATUSES,
  type LegActor,
  type LogisticsControlOwner,
  type LogisticsLevel,
  type ShipmentLegStatus,
} from '../../domain/logistics-levels.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import { notifySeller, resolveSellerNotifications } from '../seller/notification.service.js';
import { createLogisticsNotification } from './notification.service.js';
import { listProviders, type ManagedProvider } from './level-policy.service.js';

export type LegEditor =
  | { kind: 'SELLER'; sellerAccountId: string; userId: string | null; label: string; correlationId?: string | null }
  | { kind: 'UBOSS'; userId: string | null; email: string | null; ipAddress?: string | null; correlationId?: string | null }
  | { kind: 'PARTNER'; logisticsPartnerId: string; userId: string | null; label: string; correlationId?: string | null };

const sellerLegKey = (legId: string): string => `leg-assignment-seller:${legId}`;

// --- Creating them ------------------------------------------------------------

/**
 * Create the four legs for a seller's confirmed part of an order.
 *
 * Idempotent: `uq_shipment_leg_group_level` holds one leg per level per part,
 * and a second call finds them and creates nothing. Returns how many it made.
 */
export async function createLegsForSellerOrder(sellerOrderGroupId: string): Promise<number> {
  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: sellerOrderGroupId },
    select: {
      id: true,
      orderId: true,
      sellerAccountId: true,
      sellerOrderNumber: true,
      status: true,
      order: { select: { orderNumber: true } },
    },
  });
  if (group === null) return 0;
  if (group.status === 'NEW' || group.status === 'CANCELLED') return 0;

  const charges = await prisma.orderLogisticsLeg.findMany({
    where: { orderId: group.orderId, sellerAccountId: group.sellerAccountId },
  });
  if (charges.length === 0) return 0;

  const existing = await prisma.shipmentLeg.findMany({
    where: { sellerOrderGroupId },
    select: { level: true },
  });
  const have = new Set(existing.map((leg) => leg.level));

  const consignment = await prisma.logisticsShipment.findFirst({
    where: { sellerOrderGroupId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let created = 0;
  for (const level of LOGISTICS_LEVELS) {
    if (have.has(level)) continue;
    const charge = charges.find((row) => row.level === level);
    if (charge === undefined) continue;

    try {
      const leg = await prisma.shipmentLeg.create({
        data: {
          id: newId(),
          orderId: group.orderId,
          sellerOrderGroupId,
          sellerAccountId: group.sellerAccountId,
          orderLegId: charge.id,
          logisticsShipmentId: consignment?.id ?? null,
          level,
          sequence: levelSequence(level),
          owner: charge.owner,
          // L1 is the seller's turn straight away; the rest wait their turn.
          status: level === 'L1' ? 'AWAITING_ASSIGNMENT' : 'PENDING',
          events: {
            create: {
              id: newId(),
              kind: 'CREATED',
              fromStatus: null,
              toStatus: level === 'L1' ? 'AWAITING_ASSIGNMENT' : 'PENDING',
              actorRole: 'SYSTEM',
              note: 'Created when the seller confirmed the order.',
            },
          },
        },
      });
      created += 1;
      await raiseAssignmentAlert(leg.id, {
        owner: charge.owner,
        level,
        sellerAccountId: group.sellerAccountId,
        sellerOrderGroupId,
        sellerOrderNumber: group.sellerOrderNumber,
        orderNumber: group.order.orderNumber,
        orderId: group.orderId,
      });
    } catch (error: unknown) {
      // A concurrent call made it first. Not an error: the leg exists.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  return created;
}

async function raiseAssignmentAlert(
  legId: string,
  context: {
    owner: LogisticsControlOwner;
    level: LogisticsLevel;
    sellerAccountId: string;
    sellerOrderGroupId: string;
    sellerOrderNumber: string;
    orderNumber: string;
    orderId: string;
  },
): Promise<void> {
  if (context.owner === 'SELLER') {
    await notifySeller({
      sellerAccountId: context.sellerAccountId,
      kind: 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED',
      title: `${context.level} of ${context.sellerOrderNumber} needs a carrier`,
      body: `You manage ${context.level} for this order. Choose who carries it.`,
      linkPath: `/seller/orders/${context.sellerOrderGroupId}`,
      severity: 'WARNING',
      subjectType: 'shipment_leg',
      subjectId: legId,
      class: 'ALERT',
      resolutionKey: sellerLegKey(legId),
      dedupeKey: sellerLegKey(legId),
    });
    return;
  }
  await createAdminNotification({
    kind: AdminNotificationKind.LOGISTICS_LEG_NEEDS_ASSIGNMENT,
    variables: { orderNumber: context.orderNumber, sellerOrderNumber: context.sellerOrderNumber, level: context.level },
    linkPath: `/logistics/legs/${legId}`,
    requiredPermission: Permission.LOGISTICS_READ,
    relatedType: 'shipment_leg',
    relatedId: legId,
    dedupeKey: `leg-needs-assignment:${legId}`,
    resolutionKey: ResolutionKey.legAssignment(legId),
  });
}

async function resolveAssignmentAlert(legId: string, owner: LogisticsControlOwner, userId: string | null): Promise<void> {
  if (owner === 'SELLER') {
    await resolveSellerNotifications({ resolutionKey: sellerLegKey(legId), source: 'DOMAIN_EVENT', note: 'A carrier was named.' });
  } else {
    await resolveAdminNotifications({
      resolutionKey: ResolutionKey.legAssignment(legId),
      reason: 'A carrier was named for the leg.',
      source: 'DOMAIN_EVENT',
      resolvedByUserId: userId,
    });
  }
}

/** Cancel every leg of a seller order that is not finished. */
export async function cancelLegsForSellerOrder(sellerOrderGroupId: string, reason: string | null): Promise<void> {
  const legs = await prisma.shipmentLeg.findMany({
    where: { sellerOrderGroupId, status: { notIn: [...TERMINAL_LEG_STATUSES] } },
  });
  for (const leg of legs) {
    await prisma.$transaction(async (tx) => {
      await tx.shipmentLeg.update({
        where: { id: leg.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } },
      });
      await tx.shipmentLegEvent.create({
        data: {
          id: newId(),
          legId: leg.id,
          kind: 'CANCELLED',
          fromStatus: leg.status,
          toStatus: 'CANCELLED',
          actorRole: 'SYSTEM',
          note: (reason ?? 'The seller order was cancelled.').slice(0, 512),
        },
      });
    });
    await resolveAssignmentAlert(leg.id, leg.owner, null);
  }
}

// --- Naming the carrier ----------------------------------------------------------

export interface AssignLegInput {
  provider?: ManagedProvider | null;
  logisticsPartnerId?: string | null;
  providerLabel?: string | null;
  serviceName?: string | null;
  trackingNumber?: string | null;
  trackingReferenceKind?: 'AWB' | 'BOL' | 'CONTAINER' | 'TRACKING' | null;
  pickupReference?: string | null;
  expectedStartAt?: Date | null;
  expectedCompleteAt?: Date | null;
  reason?: string | null;
  expectedVersion?: number;
}

async function loadLegFor(editor: LegEditor, legId: string) {
  const leg = await prisma.shipmentLeg.findUnique({
    where: { id: legId },
    include: {
      order: { select: { orderNumber: true, customerProfileId: true } },
      sellerOrderGroup: { select: { sellerOrderNumber: true, status: true } },
    },
  });
  // Another seller's leg, or another company's, is simply not found.
  if (leg === null) throw notFound('Leg');
  if (editor.kind === 'SELLER' && leg.sellerAccountId !== editor.sellerAccountId) throw notFound('Leg');
  if (editor.kind === 'PARTNER' && leg.logisticsPartnerId !== editor.logisticsPartnerId) throw notFound('Leg');
  return leg;
}

function assertOwnerEditor(editor: LegEditor, owner: LogisticsControlOwner, level: LogisticsLevel): void {
  if (editor.kind === 'SELLER' && owner !== 'SELLER') {
    throw forbidden(
      ErrorCode.LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED,
      `${level} of this order is managed by UBOSS. UBOSS names its carrier.`,
    );
  }
  if (editor.kind === 'UBOSS' && owner !== 'UBOSS') {
    throw forbidden(
      ErrorCode.LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED,
      `${level} of this order is managed by the seller. Only the seller names its carrier.`,
    );
  }
}

const TRACKING = /^[A-Za-z0-9][A-Za-z0-9 \-/.]{3,62}$/;

function cleanReference(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!TRACKING.test(trimmed)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That reference does not look like one a carrier issues.', [
      { field, code: 'FORMAT' },
    ]);
  }
  return trimmed;
}

/**
 * Name who carries a leg: DHL, FedEx, India Post or a forwarder booked by
 * hand, or a delivery company on this platform.
 *
 * Allowed while the leg waits its turn (so the journey can be planned) and
 * until it starts. Naming a different carrier on an assigned leg is a
 * reassignment and needs a reason; the company that loses it is told.
 */
export async function assignLeg(editor: LegEditor, legId: string, input: AssignLegInput) {
  if (editor.kind === 'PARTNER') throw forbidden();
  const leg = await loadLegFor(editor, legId);
  assertOwnerEditor(editor, leg.owner, leg.level);

  if (!legMayBeAssigned(leg.status)) {
    throw conflict(
      ErrorCode.LOGISTICS_LEG_NOT_ASSIGNABLE,
      leg.status === 'IN_PROGRESS'
        ? 'This leg is already moving. Its carrier cannot be changed now.'
        : 'This leg is finished or cancelled.',
      [{ field: 'legId', code: 'NOT_ASSIGNABLE', meta: { status: leg.status } }],
    );
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== leg.version) {
    throw conflict(ErrorCode.LOGISTICS_POLICY_VERSION_CONFLICT, 'This leg was changed somewhere else. Reload it and try again.');
  }

  const provider = input.provider ?? null;
  const partnerId = input.logisticsPartnerId ?? null;
  if ((provider === null) === (partnerId === null)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose exactly one carrier or delivery company.', [
      { field: 'provider', code: 'ONE_CARRIER' },
    ]);
  }

  if (provider !== null && editor.kind === 'SELLER') {
    const providers = await listProviders(leg.sellerAccountId);
    if (providers.find((row) => row.provider === provider)?.enabled !== true) {
      throw badRequest(
        ErrorCode.LOGISTICS_PROVIDER_NOT_ENABLED,
        `Switch ${provider === 'MANUAL' ? 'booking a forwarder by hand' : provider} on under Seller Hub, Logistics, first.`,
        [{ field: 'provider', code: 'NOT_ENABLED' }],
      );
    }
  }

  let partnerName: string | null = null;
  if (partnerId !== null) {
    const partner = await prisma.logisticsPartner.findUnique({
      where: { id: partnerId },
      select: {
        status: true,
        displayName: true,
        ownerSellerAccountId: true,
        partnerKind: true,
        sellerLinks: { where: { sellerAccountId: leg.sellerAccountId }, select: { status: true } },
      },
    });
    const sellerMayUse =
      partner !== null &&
      (partner.ownerSellerAccountId === leg.sellerAccountId || partner.sellerLinks.some((link) => link.status === 'APPROVED'));
    // UBOSS carries its own levels with marketplace carriers, never with a
    // seller's private fleet it has no arrangement with.
    const ubossMayUse = partner !== null && partner.partnerKind === 'MARKETPLACE_CARRIER';
    if (partner === null || partner.status !== 'ACTIVE' || (editor.kind === 'SELLER' ? !sellerMayUse : !ubossMayUse)) {
      throw badRequest(ErrorCode.LOGISTICS_PARTNER_NOT_ELIGIBLE, 'That delivery company cannot be given this leg.', [
        { field: 'logisticsPartnerId', code: 'NOT_ELIGIBLE' },
      ]);
    }
    partnerName = partner.displayName;
  }

  const isReassignment =
    (leg.provider !== null || leg.logisticsPartnerId !== null) &&
    (leg.provider !== provider || leg.logisticsPartnerId !== partnerId);
  if (isReassignment && (input.reason ?? '').trim().length < 4) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the carrier is being changed.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  const trackingNumber = cleanReference(input.trackingNumber, 'trackingNumber');
  const pickupReference = cleanReference(input.pickupReference, 'pickupReference');

  // A leg still waiting its turn keeps waiting, now with its carrier planned.
  // Otherwise it is ASSIGNED: from the queue (AWAITING_ASSIGNMENT), or by
  // replacing the carrier on an ASSIGNED or ACCEPTED leg - which is the
  // owner's take-back followed by a new assignment, both edges it holds.
  const nextStatus: ShipmentLegStatus = leg.status === 'PENDING' ? 'PENDING' : 'ASSIGNED';
  if (leg.status === 'AWAITING_ASSIGNMENT') assertLegTransition('AWAITING_ASSIGNMENT', 'ASSIGNED', 'OWNER');
  if (leg.status === 'ACCEPTED') assertLegTransition('ACCEPTED', 'AWAITING_ASSIGNMENT', 'OWNER');

  const now = new Date();
  const actorRole = editor.kind === 'SELLER' ? 'SELLER' : 'UBOSS';
  const previousPartner = leg.logisticsPartnerId;

  const updated = await prisma.$transaction(async (tx) => {
    const moved = await tx.shipmentLeg.updateMany({
      where: { id: leg.id, version: leg.version },
      data: {
        provider,
        logisticsPartnerId: partnerId,
        providerLabel: (input.providerLabel ?? '').trim() === '' ? partnerName : (input.providerLabel ?? '').trim().slice(0, 160),
        serviceName: (input.serviceName ?? '').trim() === '' ? null : (input.serviceName ?? '').trim().slice(0, 120),
        // Carrier legs are booked by hand here - see the file header. Even
        // with an API account connected, nothing on this path calls it.
        connectionMode: provider === null ? null : 'MANUAL_ONLY',
        trackingNumber: trackingNumber ?? (isReassignment ? null : leg.trackingNumber),
        trackingReferenceKind: input.trackingReferenceKind ?? leg.trackingReferenceKind,
        pickupReference: pickupReference ?? (isReassignment ? null : leg.pickupReference),
        expectedStartAt: input.expectedStartAt ?? leg.expectedStartAt,
        expectedCompleteAt: input.expectedCompleteAt ?? leg.expectedCompleteAt,
        driverProfileId: isReassignment ? null : leg.driverProfileId,
        assignedAt: now,
        assignedByUserId: editor.userId,
        assignedByRole: actorRole,
        acceptedAt: isReassignment ? null : leg.acceptedAt,
        status: nextStatus,
        version: { increment: 1 },
      },
    });
    if (moved.count === 0) {
      throw conflict(ErrorCode.LOGISTICS_POLICY_VERSION_CONFLICT, 'This leg was changed somewhere else. Reload it and try again.');
    }
    await tx.shipmentLegEvent.create({
      data: {
        id: newId(),
        legId: leg.id,
        kind: isReassignment ? 'REASSIGNED' : 'ASSIGNED',
        fromStatus: leg.status,
        toStatus: nextStatus,
        actorRole,
        performedByUserId: editor.userId,
        note: [provider ?? partnerName, input.reason?.trim()].filter((part) => part !== null && part !== undefined && part !== '').join(' - ').slice(0, 512),
      },
    });
    return tx.shipmentLeg.findUniqueOrThrow({ where: { id: leg.id } });
  });

  await auditLeg(editor, leg.sellerAccountId, AuditAction.LOGISTICS_LEG_ASSIGNED, leg, updated,
    `${leg.level} of ${leg.sellerOrderGroup.sellerOrderNumber} ${isReassignment ? 'moved' : 'given'} to ${provider ?? partnerName ?? 'a carrier'} by ${editor.kind === 'SELLER' ? editor.label : 'UBOSS'}.`);
  await resolveAssignmentAlert(leg.id, leg.owner, editor.userId);

  if (partnerId !== null) {
    await createLogisticsNotification({
      logisticsPartnerId: partnerId,
      kind: 'LEG_ASSIGNED',
      title: `${leg.level} of order ${leg.order.orderNumber} is yours`,
      body: `${levelRouteWords(leg.level)}. Accept it to confirm you will carry it.`,
      variables: { level: leg.level, orderNumber: leg.order.orderNumber },
      dedupeKey: `leg-assigned:${leg.id}:${String(updated.version)}`,
    });
  }
  if (previousPartner !== null && previousPartner !== partnerId) {
    await createLogisticsNotification({
      logisticsPartnerId: previousPartner,
      kind: 'LEG_WITHDRAWN',
      title: `${leg.level} of order ${leg.order.orderNumber} is no longer yours`,
      body: (input.reason ?? '').trim().slice(0, 500) || 'It was given to another carrier.',
      variables: { level: leg.level, orderNumber: leg.order.orderNumber },
      dedupeKey: `leg-withdrawn:${leg.id}:${String(updated.version)}`,
    });
  }
  if (leg.owner === 'UBOSS') {
    await notifySeller({
      sellerAccountId: leg.sellerAccountId,
      kind: 'LOGISTICS_LEG_UPDATE',
      title: `UBOSS named the ${leg.level} carrier for ${leg.sellerOrderGroup.sellerOrderNumber}`,
      body: `${leg.level} will be carried by ${provider ?? partnerName ?? 'a carrier'}.`,
      linkPath: `/seller/orders/${leg.sellerOrderGroupId}`,
      severity: 'INFO',
      subjectType: 'shipment_leg',
      subjectId: leg.id,
      dedupeKey: `leg-assigned-news:${leg.id}:${String(updated.version)}`,
    });
  }

  return updated;
}

function levelRouteWords(level: LogisticsLevel): string {
  switch (level) {
    case 'L1':
      return 'First mile: from the seller\'s warehouse to the port of loading';
    case 'L2':
      return 'International transport: from the port of loading to the destination port';
    case 'L3':
      return 'Destination inland: from the destination port to the destination warehouse';
    case 'L4':
      return 'Last mile: from the destination warehouse to the customer';
  }
}

/** Enter the carrier's references on a leg that has a carrier. */
export async function updateLegReferences(
  editor: LegEditor,
  legId: string,
  input: {
    trackingNumber?: string | null;
    trackingReferenceKind?: 'AWB' | 'BOL' | 'CONTAINER' | 'TRACKING' | null;
    pickupReference?: string | null;
    expectedStartAt?: Date | null;
    expectedCompleteAt?: Date | null;
  },
) {
  const leg = await loadLegFor(editor, legId);
  if (editor.kind !== 'PARTNER') assertOwnerEditor(editor, leg.owner, leg.level);
  if (TERMINAL_LEG_STATUSES.includes(leg.status)) {
    throw conflict(ErrorCode.LOGISTICS_LEG_NOT_ASSIGNABLE, 'This leg is finished or cancelled.');
  }
  if (leg.provider === null && leg.logisticsPartnerId === null) {
    throw conflict(ErrorCode.LOGISTICS_LEG_NOT_ASSIGNABLE, 'Name the carrier before entering its references.');
  }

  const data: Prisma.ShipmentLegUpdateInput = { version: { increment: 1 } };
  if (input.trackingNumber !== undefined) data.trackingNumber = cleanReference(input.trackingNumber, 'trackingNumber');
  if (input.trackingReferenceKind !== undefined) data.trackingReferenceKind = input.trackingReferenceKind;
  if (input.pickupReference !== undefined) data.pickupReference = cleanReference(input.pickupReference, 'pickupReference');
  if (input.expectedStartAt !== undefined) data.expectedStartAt = input.expectedStartAt;
  if (input.expectedCompleteAt !== undefined) data.expectedCompleteAt = input.expectedCompleteAt;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.shipmentLeg.update({ where: { id: leg.id }, data });
    await tx.shipmentLegEvent.create({
      data: {
        id: newId(),
        legId: leg.id,
        kind: 'REFERENCES_UPDATED',
        fromStatus: leg.status,
        toStatus: leg.status,
        actorRole: editor.kind === 'PARTNER' ? 'PARTNER' : editor.kind === 'SELLER' ? 'SELLER' : 'UBOSS',
        performedByUserId: editor.userId,
        note: row.trackingNumber === null ? null : `Tracking reference ${row.trackingNumber}`,
      },
    });
    return row;
  });
  await auditLeg(editor, leg.sellerAccountId, AuditAction.LOGISTICS_LEG_STATUS_CHANGED, leg, updated, `${leg.level} references updated.`);
  return updated;
}

/** A delivery company puts one of its own drivers on a leg it holds. */
export async function setLegDriver(editor: Extract<LegEditor, { kind: 'PARTNER' }>, legId: string, driverProfileId: string | null) {
  const leg = await loadLegFor(editor, legId);
  if (TERMINAL_LEG_STATUSES.includes(leg.status)) {
    throw conflict(ErrorCode.LOGISTICS_LEG_NOT_ASSIGNABLE, 'This leg is finished or cancelled.');
  }
  if (driverProfileId !== null) {
    const driver = await prisma.logisticsDriverProfile.findFirst({
      where: { id: driverProfileId, logisticsPartnerId: editor.logisticsPartnerId },
      select: { id: true },
    });
    if (driver === null) throw notFound('Driver');
  }
  const updated = await prisma.shipmentLeg.update({
    where: { id: leg.id },
    data: { driverProfileId, version: { increment: 1 } },
  });
  await prisma.shipmentLegEvent.create({
    data: {
      id: newId(),
      legId: leg.id,
      kind: driverProfileId === null ? 'DRIVER_REMOVED' : 'DRIVER_ASSIGNED',
      fromStatus: leg.status,
      toStatus: leg.status,
      actorRole: 'PARTNER',
      performedByUserId: editor.userId,
    },
  });
  return updated;
}

// --- Moving it ---------------------------------------------------------------------

/**
 * Move a leg: accept, refuse, start, hand over.
 *
 * `idempotencyKey` makes a retried request an answer rather than a second
 * handover - `uq_shipment_leg_event_idem` refuses the duplicate.
 */
export async function transitionLeg(
  editor: LegEditor,
  legId: string,
  input: { to: ShipmentLegStatus; note?: string | null; idempotencyKey?: string | null },
) {
  const leg = await loadLegFor(editor, legId);

  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    const seen = await prisma.shipmentLegEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey.slice(0, 80) } });
    if (seen !== null) return leg;
  }

  let actor: LegActor;
  if (editor.kind === 'PARTNER') {
    actor = 'PARTNER';
  } else {
    assertOwnerEditor(editor, leg.owner, leg.level);
    actor = 'OWNER';
  }

  // A partner-held leg is moved by the partner; the owner may only take it
  // back. A hand-booked carrier leg is moved by the owner.
  if (actor === 'OWNER' && leg.logisticsPartnerId !== null && (input.to === 'IN_PROGRESS' || input.to === 'COMPLETED') && leg.status !== 'ACCEPTED') {
    throw conflict(ErrorCode.LOGISTICS_LEG_TRANSITION_INVALID, 'The delivery company holding this leg records its progress.');
  }

  try {
    assertLegTransition(leg.status, input.to, actor);
  } catch (error) {
    if (!(error instanceof LegTransitionError)) throw error;
    throw conflict(
      ErrorCode.LOGISTICS_LEG_TRANSITION_INVALID,
      leg.status === 'PENDING' ? 'This leg cannot start until the one before it has been handed over.' : 'This leg cannot move to that step from where it is.',
      [{ field: 'to', code: 'TRANSITION', meta: { from: leg.status, to: input.to } }],
    );
  }

  if (input.to === 'IN_PROGRESS' && leg.provider !== null && (leg.trackingNumber ?? '') === '') {
    throw conflict(
      ErrorCode.LOGISTICS_LEG_TRACKING_REQUIRED,
      "Enter the carrier's own tracking reference before this leg starts. It is never generated here.",
      [{ field: 'trackingNumber', code: 'REQUIRED' }],
    );
  }

  const now = new Date();
  const refused = actor === 'PARTNER' && input.to === 'AWAITING_ASSIGNMENT';
  const takenBack = actor === 'OWNER' && input.to === 'AWAITING_ASSIGNMENT';
  const actorRole = editor.kind === 'PARTNER' ? 'PARTNER' : editor.kind === 'SELLER' ? 'SELLER' : 'UBOSS';

  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.shipmentLeg.updateMany({
      where: { id: leg.id, version: leg.version },
      data: {
        status: input.to,
        version: { increment: 1 },
        ...(input.to === 'ACCEPTED' ? { acceptedAt: now } : {}),
        ...(input.to === 'IN_PROGRESS' ? { startedAt: now } : {}),
        ...(input.to === 'COMPLETED' ? { completedAt: now } : {}),
        ...(refused || takenBack
          ? { logisticsPartnerId: null, provider: null, providerLabel: null, driverProfileId: null, acceptedAt: null, connectionMode: null }
          : {}),
      },
    });
    if (moved.count === 0) {
      throw conflict(ErrorCode.LOGISTICS_POLICY_VERSION_CONFLICT, 'This leg was changed somewhere else. Reload it and try again.');
    }

    await tx.shipmentLegEvent.create({
      data: {
        id: newId(),
        legId: leg.id,
        kind: refused ? 'REFUSED' : takenBack ? 'WITHDRAWN' : input.to === 'COMPLETED' ? 'HANDED_OVER' : input.to,
        fromStatus: leg.status,
        toStatus: input.to,
        actorRole,
        performedByUserId: editor.userId,
        note: (input.note ?? '').trim() === '' ? null : (input.note ?? '').trim().slice(0, 512),
        idempotencyKey: input.idempotencyKey?.slice(0, 80) ?? null,
      },
    });

    // The handover makes the next leg its owner's turn.
    let next: { id: string; level: LogisticsLevel; owner: LogisticsControlOwner; status: ShipmentLegStatus } | null = null;
    if (input.to === 'COMPLETED') {
      const nextLevel = levelAt(leg.sequence + 1);
      if (nextLevel !== null) {
        const row = await tx.shipmentLeg.findUnique({
          where: { sellerOrderGroupId_level: { sellerOrderGroupId: leg.sellerOrderGroupId, level: nextLevel } },
        });
        if (row !== null && row.status === 'PENDING') {
          const hasCarrier = row.provider !== null || row.logisticsPartnerId !== null;
          const to: ShipmentLegStatus = hasCarrier ? 'ASSIGNED' : 'AWAITING_ASSIGNMENT';
          assertLegTransition('PENDING', to, 'SYSTEM');
          await tx.shipmentLeg.update({ where: { id: row.id }, data: { status: to, version: { increment: 1 } } });
          await tx.shipmentLegEvent.create({
            data: {
              id: newId(),
              legId: row.id,
              kind: 'READY',
              fromStatus: 'PENDING',
              toStatus: to,
              actorRole: 'SYSTEM',
              note: `${leg.level} was handed over.`,
            },
          });
          next = { id: row.id, level: row.level, owner: row.owner, status: to };
        }
      }
    }

    return { leg: await tx.shipmentLeg.findUniqueOrThrow({ where: { id: leg.id } }), next };
  });

  await auditLeg(editor, leg.sellerAccountId, AuditAction.LOGISTICS_LEG_STATUS_CHANGED, leg, result.leg,
    `${leg.level} of ${leg.sellerOrderGroup.sellerOrderNumber}: ${leg.status} to ${input.to}.`);

  await announceTransition(leg, input.to, { refused, takenBack, next: result.next, note: input.note ?? null });

  return result.leg;
}

async function announceTransition(
  leg: Awaited<ReturnType<typeof loadLegFor>>,
  to: ShipmentLegStatus,
  context: {
    refused: boolean;
    takenBack: boolean;
    next: { id: string; level: LogisticsLevel; owner: LogisticsControlOwner; status: ShipmentLegStatus } | null;
    note: string | null;
  },
): Promise<void> {
  try {
    const orderNumber = leg.order.orderNumber;
    const sellerOrderNumber = leg.sellerOrderGroup.sellerOrderNumber;
    const event = context.refused
      ? 'REFUSED'
      : to === 'ACCEPTED'
        ? 'ACCEPTED'
        : to === 'IN_PROGRESS'
          ? 'STARTED'
          : to === 'COMPLETED'
            ? 'HANDED_OVER'
            : context.takenBack
              ? 'WITHDRAWN'
              : to;

    // The seller hears about every leg of their own order, whoever runs it.
    await notifySeller({
      sellerAccountId: leg.sellerAccountId,
      kind: 'LOGISTICS_LEG_UPDATE',
      title: `${leg.level} of ${sellerOrderNumber}: ${event.toLowerCase().replace('_', ' ')}`,
      body:
        context.refused
          ? `The delivery company refused ${leg.level}${context.note === null ? '' : `: ${context.note}`}. It needs a new carrier.`
          : to === 'COMPLETED' && leg.level === 'L4'
            ? 'Delivered to the customer.'
            : to === 'COMPLETED'
              ? `${leg.level} was handed over.`
              : `${leg.level} is ${event.toLowerCase().replace('_', ' ')}.`,
      linkPath: `/seller/orders/${leg.sellerOrderGroupId}`,
      severity: context.refused ? 'WARNING' : 'INFO',
      subjectType: 'shipment_leg',
      subjectId: leg.id,
      dedupeKey: `leg-update:${leg.id}:${to}:${String(leg.version + 1)}`,
    });

    if (leg.owner === 'UBOSS') {
      await createAdminNotification({
        kind: AdminNotificationKind.LOGISTICS_LEG_UPDATE,
        variables: { orderNumber, level: leg.level, event },
        linkPath: `/logistics/legs/${leg.id}`,
        requiredPermission: Permission.LOGISTICS_READ,
        relatedType: 'shipment_leg',
        relatedId: leg.id,
        dedupeKey: `leg-update:${leg.id}:${to}:${String(leg.version + 1)}`,
      });
    }

    // A refusal or a withdrawal puts the leg back in its owner's queue.
    if (context.refused || context.takenBack) {
      await raiseAssignmentAlert(leg.id, {
        owner: leg.owner,
        level: leg.level,
        sellerAccountId: leg.sellerAccountId,
        sellerOrderGroupId: leg.sellerOrderGroupId,
        sellerOrderNumber,
        orderNumber,
        orderId: leg.orderId,
      });
    }

    if (context.next !== null && context.next.status === 'AWAITING_ASSIGNMENT') {
      await raiseAssignmentAlert(context.next.id, {
        owner: context.next.owner,
        level: context.next.level,
        sellerAccountId: leg.sellerAccountId,
        sellerOrderGroupId: leg.sellerOrderGroupId,
        sellerOrderNumber,
        orderNumber,
        orderId: leg.orderId,
      });
    } else if (context.next !== null) {
      const nextLeg = await prisma.shipmentLeg.findUnique({ where: { id: context.next.id }, select: { logisticsPartnerId: true } });
      if (nextLeg?.logisticsPartnerId !== null && nextLeg?.logisticsPartnerId !== undefined) {
        await createLogisticsNotification({
          logisticsPartnerId: nextLeg.logisticsPartnerId,
          kind: 'LEG_ASSIGNED',
          title: `${context.next.level} of order ${orderNumber} is ready for you`,
          body: `${leg.level} was handed over. ${context.next.level} can begin.`,
          variables: { level: context.next.level, orderNumber },
          dedupeKey: `leg-ready:${context.next.id}`,
        });
      }
    }
  } catch (error: unknown) {
    // A notification failing must not undo a handover that has happened.
    logger.warn({ err: error, legId: leg.id }, 'could not announce a leg transition');
  }
}

async function auditLeg(
  editor: LegEditor,
  sellerAccountId: string,
  action: string,
  before: { status: string; provider: string | null; logisticsPartnerId: string | null; trackingNumber: string | null },
  after: { status: string; provider: string | null; logisticsPartnerId: string | null; trackingNumber: string | null; id: string },
  summary: string,
): Promise<void> {
  const shape = (row: typeof before) => ({
    status: row.status,
    provider: row.provider,
    logisticsPartnerId: row.logisticsPartnerId,
    trackingNumber: row.trackingNumber,
  });
  await recordSellerAudit({
    sellerAccountId,
    action,
    actor:
      editor.kind === 'SELLER'
        ? { type: 'CUSTOMER', userId: editor.userId, label: editor.label }
        : editor.kind === 'UBOSS'
          ? { type: 'ADMIN', userId: editor.userId, label: 'UBOSS logistics' }
          : { type: 'LOGISTICS', userId: editor.userId, label: editor.label },
    resourceType: 'shipment_leg',
    resourceId: after.id,
    before: shape(before),
    after: shape(after),
    summary,
    correlationId: editor.correlationId ?? null,
  });
  if (editor.kind === 'UBOSS') {
    await recordAudit({
      action: action as never,
      resourceType: 'shipment_leg',
      resourceId: after.id,
      actorType: 'ADMIN',
      actorUserId: editor.userId,
      actorEmail: editor.email,
      before: shape(before),
      after: { ...shape(after), sellerAccountId },
      ipAddress: editor.ipAddress ?? null,
      correlationId: editor.correlationId ?? null,
    });
  }
}

// --- Reading ---------------------------------------------------------------------

const LEG_INCLUDE = {
  orderLeg: true,
  logisticsPartner: { select: { displayName: true } },
  events: { orderBy: { occurredAt: 'asc' as const }, take: 100 },
  order: { select: { orderNumber: true, currency: true } },
  sellerOrderGroup: { select: { sellerOrderNumber: true, status: true } },
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.ShipmentLegInclude;

type LegRow = Prisma.ShipmentLegGetPayload<{ include: typeof LEG_INCLUDE }>;

export type LegViewer = 'SELLER' | 'UBOSS' | 'PARTNER' | 'CUSTOMER';

function toLegView(leg: LegRow, viewer: LegViewer) {
  const charge = leg.orderLeg;
  const carrier = leg.providerLabel ?? leg.logisticsPartner?.displayName ?? leg.provider ?? null;
  const base = {
    id: leg.id,
    level: leg.level,
    sequence: leg.sequence,
    owner: leg.owner,
    status: leg.status,
    carrier,
    provider: leg.provider,
    trackingNumber: leg.trackingNumber,
    trackingReferenceKind: leg.trackingReferenceKind,
    expectedStartAt: leg.expectedStartAt?.toISOString() ?? null,
    expectedCompleteAt: leg.expectedCompleteAt?.toISOString() ?? null,
    startedAt: leg.startedAt?.toISOString() ?? null,
    completedAt: leg.completedAt?.toISOString() ?? null,
    origin: charge?.originLabel ?? null,
    destination: charge?.destinationLabel ?? null,
    transportMode: charge?.transportMode ?? null,
  };
  if (viewer === 'CUSTOMER') return base;

  return {
    ...base,
    version: leg.version,
    orderId: leg.orderId,
    orderNumber: leg.order.orderNumber,
    sellerOrderGroupId: leg.sellerOrderGroupId,
    sellerOrderNumber: leg.sellerOrderGroup.sellerOrderNumber,
    sellerName: leg.sellerAccount.displayName,
    logisticsPartnerId: leg.logisticsPartnerId,
    serviceName: leg.serviceName,
    connectionMode: leg.connectionMode,
    pickupReference: leg.pickupReference,
    hasDriver: leg.driverProfileId !== null,
    driverProfileId: viewer === 'PARTNER' || viewer === 'UBOSS' ? leg.driverProfileId : null,
    assignedByRole: leg.assignedByRole,
    assignedAt: leg.assignedAt?.toISOString() ?? null,
    acceptedAt: leg.acceptedAt?.toISOString() ?? null,
    // What the buyer paid for this level. A partner is shown none of it - a
    // carrier is never told what the marketplace charged for its own work.
    charge:
      viewer === 'PARTNER' || charge === null
        ? null
        : {
            amount: serialiseMoney(charge.amountMinor, charge.currency),
            original: serialiseMoney(charge.originalAmountMinor, charge.originalCurrency),
            isFree: charge.isFree,
            pricedWith: charge.providerLabel ?? charge.provider,
            transitDaysMin: charge.transitDaysMin,
            transitDaysMax: charge.transitDaysMax,
          },
    events: leg.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorRole: event.actorRole,
      note: viewer === 'PARTNER' && event.actorRole !== 'PARTNER' && event.kind === 'REASSIGNED' ? null : event.note,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
}

export type LegView = ReturnType<typeof toLegView>;

/** The legs of one of THIS seller's orders. Creates missing ones for a confirmed order. */
export async function legsForSellerOrder(sellerAccountId: string, sellerOrderGroupId: string) {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: sellerOrderGroupId, sellerAccountId },
    select: { id: true, status: true },
  });
  if (group === null) throw notFound('Order');

  // Self-healing: a confirmation whose leg creation failed after commit is
  // repaired by the first read of the order.
  if (group.status !== 'NEW' && group.status !== 'CANCELLED') {
    await createLegsForSellerOrder(sellerOrderGroupId).catch((error: unknown) => {
      logger.warn({ err: error, sellerOrderGroupId }, 'could not create the legs of a confirmed seller order');
    });
  }

  const legs = await prisma.shipmentLeg.findMany({
    where: { sellerOrderGroupId, sellerAccountId },
    include: LEG_INCLUDE,
    orderBy: { sequence: 'asc' },
  });
  return legs.map((leg) => ({ ...toLegView(leg, 'SELLER'), editableBySeller: leg.owner === 'SELLER' }));
}

/** Every leg, for the admin desk. */
export async function legsForAdmin(input: {
  owner?: LogisticsControlOwner | null;
  status?: ShipmentLegStatus | null;
  needsAssignment?: boolean;
  orderId?: string | null;
  take?: number;
}) {
  const legs = await prisma.shipmentLeg.findMany({
    where: {
      ...(input.owner === undefined || input.owner === null ? {} : { owner: input.owner }),
      ...(input.status === undefined || input.status === null ? {} : { status: input.status }),
      ...(input.orderId === undefined || input.orderId === null ? {} : { orderId: input.orderId }),
      ...(input.needsAssignment === true
        ? { status: { in: ['PENDING', 'AWAITING_ASSIGNMENT'] }, provider: null, logisticsPartnerId: null }
        : {}),
    },
    include: LEG_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { sequence: 'asc' }],
    take: Math.min(input.take ?? 200, 500),
  });
  return legs.map((leg) => toLegView(leg, 'UBOSS'));
}

export async function legForAdmin(legId: string) {
  const leg = await prisma.shipmentLeg.findUnique({ where: { id: legId }, include: LEG_INCLUDE });
  if (leg === null) throw notFound('Leg');
  const siblings = await prisma.shipmentLeg.findMany({
    where: { sellerOrderGroupId: leg.sellerOrderGroupId },
    include: LEG_INCLUDE,
    orderBy: { sequence: 'asc' },
  });
  return { leg: toLegView(leg, 'UBOSS'), journey: siblings.map((row) => toLegView(row, 'UBOSS')) };
}

/** The legs a delivery company holds - its own, and nothing else. */
export async function legsForPartner(logisticsPartnerId: string) {
  const legs = await prisma.shipmentLeg.findMany({
    where: { logisticsPartnerId },
    include: LEG_INCLUDE,
    orderBy: [{ updatedAt: 'desc' }],
    take: 200,
  });
  return legs.map((leg) => toLegView(leg, 'PARTNER'));
}

export async function legForPartner(logisticsPartnerId: string, legId: string) {
  const leg = await prisma.shipmentLeg.findFirst({ where: { id: legId, logisticsPartnerId }, include: LEG_INCLUDE });
  if (leg === null) throw notFound('Leg');
  return toLegView(leg, 'PARTNER');
}

/**
 * What a buyer paid for delivery on one of their own orders, level by level,
 * and where each level is. Scoped by the buyer in the query.
 */
export async function priceBreakdownForCustomer(customerProfileId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerProfileId },
    select: {
      id: true,
      orderNumber: true,
      currency: true,
      subtotalMinor: true,
      discountMinor: true,
      taxMinor: true,
      shippingMinor: true,
      grandTotalMinor: true,
      fxPriceSource: true,
      fxRateUsed: true,
      fxRateAsOf: true,
      fxProvider: true,
    },
  });
  if (order === null) throw notFound('Order');

  const [charges, legs, profile, sellers] = await Promise.all([
    prisma.orderLogisticsLeg.findMany({ where: { orderId }, orderBy: [{ sellerAccountId: 'asc' }, { level: 'asc' }] }),
    prisma.shipmentLeg.findMany({ where: { orderId }, include: LEG_INCLUDE, orderBy: { sequence: 'asc' } }),
    prisma.businessProfile.findFirst({ select: { showLogisticsLevelBreakdown: true } }),
    prisma.orderLogisticsLeg.findMany({
      where: { orderId },
      distinct: ['sellerAccountId'],
      select: { sellerAccountId: true, sellerAccount: { select: { displayName: true } } },
    }),
  ]);
  const showLevels = profile?.showLogisticsLevelBreakdown ?? true;
  const money = (amount: bigint) => serialiseMoney(amount, order.currency);
  const deliveryMinor = charges.reduce((total, row) => total + row.amountMinor, 0n);

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    currency: order.currency,
    subtotal: money(order.subtotalMinor),
    discount: money(order.discountMinor),
    tax: money(order.taxMinor),
    shipping: money(order.shippingMinor),
    grandTotal: money(order.grandTotalMinor),
    sellerDelivery: money(deliveryMinor),
    showLevels,
    exchange:
      order.fxPriceSource === 'CONVERTED'
        ? { rate: order.fxRateUsed?.toString() ?? null, asOf: order.fxRateAsOf?.toISOString() ?? null, provider: order.fxProvider }
        : null,
    sellers: sellers.map((seller) => {
      const mine = charges.filter((row) => row.sellerAccountId === seller.sellerAccountId);
      return {
        sellerName: seller.sellerAccount.displayName,
        total: money(mine.reduce((total, row) => total + row.amountMinor, 0n)),
        levels: mine.map((row) => {
          const leg = legs.find((candidate) => candidate.orderLegId === row.id);
          return {
            level: row.level,
            amount: showLevels ? money(row.amountMinor) : null,
            isFree: row.isFree,
            transitDaysMin: row.transitDaysMin,
            transitDaysMax: row.transitDaysMax,
            progress: leg === undefined ? null : toLegView(leg, 'CUSTOMER'),
          };
        }),
      };
    }),
  };
}
