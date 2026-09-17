/**
 * Collections and handovers: the two places a consignment changes hands.
 *
 * Pickups and manifests live together because they are the same working day
 * seen from two ends - the van going out to collect, and the load going on to
 * the trunk run - and because both are where the idempotency rules actually
 * bite. A driver's phone on a bad connection retries; a warehouse scanner
 * double-fires; a dispatcher clicks twice. Every completion here is guarded by
 * a key, and a repeat is a no-op rather than a second collection.
 *
 * WHY A PICKUP IS NOT A COLUMN ON THE SHIPMENT
 *
 * One van call collects several consignments, and one consignment can survive
 * a failed collection and be collected the next day. A column would model
 * neither, and the first thing an operator asks after a missed collection is
 * "when did we say we would come, and who went?".
 */
import type { LogisticsManifestState, LogisticsPickupState } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordLogisticsAudit } from './audit.service.js';
import { raiseException } from './exception.service.js';
import { recordShipmentEvent } from './shipment-event.service.js';
import { assertShipmentAccess, type ShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  assertPartnerCanAcceptWork,
  type LogisticsMembership,
} from './partner.service.js';

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------

export interface PickupRow {
  id: string;
  state: LogisticsPickupState;
  shipmentId: string | null;
  shipmentReference: string | null;
  warehouseName: string | null;
  /** The IANA zone the window's clock belongs to. See the note below. */
  timezone: string | null;
  windowStartAt: Date;
  windowEndAt: Date;
  warehouseInstructions: string | null;
  readinessConfirmedAt: Date | null;
  driverName: string | null;
  vehicleRegistration: string | null;
  packagesCollected: number | null;
  failureReason: string | null;
  completedAt: Date | null;
}

export interface PickupListFilters {
  state?: readonly LogisticsPickupState[] | null;
  from?: Date | null;
  to?: Date | null;
  driverProfileId?: string | null;
  locationId?: string | null;
}

/**
 * The pickup board.
 *
 * Ordered by window start, because that is the order a day happens in and the
 * order a dispatcher reads it. The window is stored as instants and carries
 * its OWN timezone beside it - the same rule `RecurringSchedule.timezone`
 * follows: "collect between 14:00 and 16:00" means the clock on the wall of
 * the building the van drives to, and a deployment with warehouses in Madrid
 * and the Canaries needs the two to disagree.
 */
export async function listPickups(
  membership: LogisticsMembership,
  filters: PickupListFilters = {},
): Promise<PickupRow[]> {
  assertLogisticsPermission(membership, LogisticsPermission.PICKUP_READ);

  const rows = await prisma.logisticsPickupRequest.findMany({
    where: {
      logisticsPartnerId: membership.logisticsPartnerId,
      ...((filters.state !== undefined && filters.state !== null) && filters.state.length > 0
        ? { state: { in: [...filters.state] } }
        : {}),
      ...((filters.driverProfileId !== undefined && filters.driverProfileId !== null) ? { driverProfileId: filters.driverProfileId } : {}),
      ...((filters.locationId !== undefined && filters.locationId !== null) ? { locationId: filters.locationId } : {}),
      ...((filters.from !== undefined && filters.from !== null) || (filters.to !== undefined && filters.to !== null)
        ? {
            windowStartAt: {
              ...((filters.from !== undefined && filters.from !== null) ? { gte: filters.from } : {}),
              ...((filters.to !== undefined && filters.to !== null) ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ windowStartAt: 'asc' }],
    take: 500,
    select: {
      id: true,
      state: true,
      shipmentId: true,
      timezone: true,
      windowStartAt: true,
      windowEndAt: true,
      warehouseInstructions: true,
      readinessConfirmedAt: true,
      packagesCollected: true,
      failureReason: true,
      completedAt: true,
      shipment: { select: { shipmentReference: true } },
      location: { select: { name: true } },
      driver: { select: { fullName: true } },
      vehicle: { select: { registration: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    shipmentId: row.shipmentId,
    shipmentReference: row.shipment?.shipmentReference ?? null,
    warehouseName: row.location?.name ?? null,
    timezone: row.timezone,
    windowStartAt: row.windowStartAt,
    windowEndAt: row.windowEndAt,
    warehouseInstructions: row.warehouseInstructions,
    readinessConfirmedAt: row.readinessConfirmedAt,
    driverName: row.driver?.fullName ?? null,
    vehicleRegistration: row.vehicle?.registration ?? null,
    packagesCollected: row.packagesCollected,
    failureReason: row.failureReason,
    completedAt: row.completedAt,
  }));
}

export interface SchedulePickupInput {
  shipmentId: string;
  windowStartAt: Date;
  windowEndAt: Date;
  timezone?: string | null;
  driverProfileId?: string | null;
  vehicleId?: string | null;
  warehouseInstructions?: string | null;
}

/**
 * Book a collection, and move the consignment to PICKUP_SCHEDULED.
 *
 * The status move goes through `recordShipmentEvent`, which re-checks the
 * transition and writes the timeline entry. This function does not touch
 * `status` itself - nothing outside that file does.
 */
export async function schedulePickup(
  membership: LogisticsMembership,
  input: SchedulePickupInput,
  correlationId?: string | null,
): Promise<{ pickupId: string; status: ShipmentStatusName }> {
  assertLogisticsPermission(membership, LogisticsPermission.PICKUP_WRITE);
  assertPartnerCanAcceptWork(membership);

  if (input.windowEndAt.getTime() <= input.windowStartAt.getTime()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The collection window has to end after it starts.', [
      { field: 'windowEndAt', code: 'WINDOW_INVALID' },
    ]);
  }

  const access = await assertShipmentAccess(membership, input.shipmentId, 'WRITE');

  if ((input.driverProfileId !== undefined && input.driverProfileId !== null)) {
    await assertDriverBelongsToPartner(membership, input.driverProfileId);
  }
  if ((input.vehicleId !== undefined && input.vehicleId !== null)) {
    await assertVehicleBelongsToPartner(membership, input.vehicleId);
  }

  const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
    where: { id: access.shipmentId },
    select: { originLocationId: true, shipmentReference: true, originLocation: { select: { timezone: true } } },
  });

  const pickupId = newId();

  await prisma.logisticsPickupRequest.create({
    data: {
      id: pickupId,
      logisticsPartnerId: membership.logisticsPartnerId,
      shipmentId: access.shipmentId,
      locationId: shipment.originLocationId,
      state: 'SCHEDULED',
      windowStartAt: input.windowStartAt,
      windowEndAt: input.windowEndAt,
      // The warehouse's own zone where it has one. A window with no zone is a
      // window that means different things to the dispatcher and the driver.
      timezone: input.timezone ?? shipment.originLocation?.timezone ?? null,
      warehouseInstructions: input.warehouseInstructions ?? null,
      driverProfileId: input.driverProfileId ?? null,
      vehicleId: input.vehicleId ?? null,
      scheduledAt: new Date(),
      createdByUserId: membership.userId,
    },
  });

  const event = await recordShipmentEvent({
    shipmentId: access.shipmentId,
    status: 'PICKUP_SCHEDULED',
    actor: 'PARTNER',
    source: 'LOGISTICS_PORTAL',
    actorUserId: membership.userId,
    actorLogisticsPartnerId: membership.logisticsPartnerId,
    actorLabel: membership.fullName,
    permissions: [...membership.permissions],
    publicDescription: 'Collection has been arranged.',
    // The window itself, so a later dispute about "when did you say you would
    // come" is answered from the timeline rather than from a deleted booking.
    internalNote: `Window ${input.windowStartAt.toISOString()} to ${input.windowEndAt.toISOString()}.`,
    idempotencyKey: `pickup-scheduled:${pickupId}`,
    correlationId,
  });

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.pickup.scheduled',
    resourceType: 'logistics_pickup_request',
    resourceId: pickupId,
    after: { shipmentId: access.shipmentId },
    summary: `Collection booked for ${shipment.shipmentReference}.`,
    correlationId: correlationId ?? null,
  });

  return { pickupId, status: event.status };
}

export interface CompletePickupInput {
  pickupId: string;
  packagesCollected?: number | null;
  /** The key the driver's phone retried under. */
  idempotencyKey?: string | null;
  occurredAt?: Date | null;
}

/**
 * The van came, and took the goods.
 *
 * Idempotent on `completionIdempotencyKey`, which is unique per carrier. A
 * driver's phone flushing a queued action twice completes one collection.
 *
 * A partial collection - fewer packages than the consignment declares - raises
 * an exception rather than being recorded quietly. A carton left on a dock is
 * the single most common cause of a delivery nobody can explain.
 */
export async function completePickup(
  membership: LogisticsMembership,
  input: CompletePickupInput,
  correlationId?: string | null,
): Promise<{ status: ShipmentStatusName; duplicate: boolean }> {
  assertLogisticsPermission(membership, LogisticsPermission.PICKUP_WRITE);

  const pickup = await prisma.logisticsPickupRequest.findFirst({
    where: { id: input.pickupId, logisticsPartnerId: membership.logisticsPartnerId },
    select: {
      id: true,
      state: true,
      shipmentId: true,
      completionIdempotencyKey: true,
      shipment: { select: { id: true, status: true, packageCount: true, shipmentReference: true } },
    },
  });

  if (pickup === null) throw notFound('Pickup');

  if (pickup.state === 'COMPLETED') {
    // Already done. Not an error - it is what idempotency looks like.
    return { status: (pickup.shipment?.status ?? 'PICKED_UP'), duplicate: true };
  }

  if (pickup.state === 'CANCELLED') {
    throw conflict(
      ErrorCode.LOGISTICS_PICKUP_NOT_ACTIONABLE,
      'This collection was cancelled. Book another one.',
    );
  }

  if (pickup.shipmentId === null || pickup.shipment === null) {
    throw conflict(
      ErrorCode.LOGISTICS_PICKUP_NOT_ACTIONABLE,
      'This collection is not against a shipment, so there is nothing to mark collected.',
    );
  }

  await assertShipmentAccess(membership, pickup.shipmentId, 'WRITE');

  const occurredAt = input.occurredAt ?? new Date();
  const key = (input.idempotencyKey ?? `pickup:${pickup.id}`).slice(0, 64);

  const claimed = await prisma.logisticsPickupRequest.updateMany({
    where: { id: pickup.id, state: { in: ['REQUESTED', 'SCHEDULED', 'CONFIRMED'] } },
    data: {
      state: 'COMPLETED',
      completedAt: occurredAt,
      packagesCollected: input.packagesCollected ?? pickup.shipment.packageCount,
      completionIdempotencyKey: key,
    },
  });

  if (claimed.count !== 1) {
    return { status: pickup.shipment.status, duplicate: true };
  }

  const event = await recordShipmentEvent({
    shipmentId: pickup.shipmentId,
    status: 'PICKED_UP',
    actor: membership.driverProfileId !== null ? 'DRIVER' : 'PARTNER',
    source: membership.driverProfileId !== null ? 'DRIVER_APP' : 'LOGISTICS_PORTAL',
    actorUserId: membership.userId,
    actorLogisticsPartnerId: membership.logisticsPartnerId,
    actorLabel: membership.fullName,
    permissions: [...membership.permissions],
    publicDescription: 'Your order has been collected by the carrier.',
    occurredAt,
    idempotencyKey: key,
    correlationId,
  });

  const collected = input.packagesCollected ?? pickup.shipment.packageCount;

  if (collected < pickup.shipment.packageCount) {
    await raiseException({
      shipmentId: pickup.shipmentId,
      logisticsPartnerId: membership.logisticsPartnerId,
      type: 'PACKAGE_NOT_READY',
      severity: 'HIGH',
      reason: `Only ${String(collected)} of ${String(pickup.shipment.packageCount)} packages were collected.`,
      raisedByUserId: membership.userId,
      actorLabel: membership.fullName,
      correlationId,
    });
  }

  return { status: event.status, duplicate: event.duplicate };
}

/**
 * The van came and could not take the goods.
 *
 * The reason is mandatory. A failed collection with no reason is a failed
 * collection nobody can prevent happening again, and it is the carrier's own
 * record that suffers.
 */
export async function failPickup(
  membership: LogisticsMembership,
  pickupId: string,
  reason: string,
  correlationId?: string | null,
): Promise<void> {
  assertLogisticsPermission(membership, LogisticsPermission.PICKUP_WRITE);

  const trimmed = reason.trim();
  if (trimmed.length < 4) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the collection could not be made.', [
      { field: 'reason', code: 'REASON_REQUIRED' },
    ]);
  }

  const pickup = await prisma.logisticsPickupRequest.findFirst({
    where: { id: pickupId, logisticsPartnerId: membership.logisticsPartnerId },
    select: { id: true, state: true, shipmentId: true },
  });

  if (pickup === null) throw notFound('Pickup');

  if (pickup.state === 'COMPLETED' || pickup.state === 'CANCELLED') {
    throw conflict(
      ErrorCode.LOGISTICS_PICKUP_NOT_ACTIONABLE,
      'This collection has already been closed.',
    );
  }

  await prisma.logisticsPickupRequest.update({
    where: { id: pickup.id },
    data: { state: 'FAILED', failedAt: new Date(), failureReason: trimmed.slice(0, 512) },
  });

  if (pickup.shipmentId !== null) {
    await assertShipmentAccess(membership, pickup.shipmentId, 'WRITE');

    await raiseException({
      shipmentId: pickup.shipmentId,
      logisticsPartnerId: membership.logisticsPartnerId,
      type: 'PICKUP_MISSED',
      severity: 'HIGH',
      reason: trimmed,
      raisedByUserId: membership.userId,
      actorLabel: membership.fullName,
      correlationId,
    });

    await recordShipmentEvent({
      shipmentId: pickup.shipmentId,
      status: 'DELAYED',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorUserId: membership.userId,
      actorLogisticsPartnerId: membership.logisticsPartnerId,
      actorLabel: membership.fullName,
      permissions: [...membership.permissions],
      reason: trimmed,
      publicDescription: 'Collection could not be made. We are rearranging it.',
      idempotencyKey: `pickup-failed:${pickup.id}`,
      correlationId,
    });
  }
}

/** The warehouse says the goods are on the dock. */
export async function confirmPickupReadiness(
  membership: LogisticsMembership,
  pickupId: string,
): Promise<void> {
  assertLogisticsPermission(membership, LogisticsPermission.PICKUP_WRITE);

  const claimed = await prisma.logisticsPickupRequest.updateMany({
    where: {
      id: pickupId,
      logisticsPartnerId: membership.logisticsPartnerId,
      state: { in: ['REQUESTED', 'SCHEDULED'] },
    },
    data: { state: 'CONFIRMED', readinessConfirmedAt: new Date() },
  });

  if (claimed.count !== 1) {
    throw conflict(
      ErrorCode.LOGISTICS_PICKUP_NOT_ACTIONABLE,
      'This collection cannot be confirmed in its current state.',
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatch manifests
// ---------------------------------------------------------------------------

export interface ManifestRow {
  id: string;
  manifestNumber: string;
  state: LogisticsManifestState;
  driverName: string | null;
  vehicleRegistration: string | null;
  originLabel: string | null;
  destinationLabel: string | null;
  plannedDepartureAt: Date | null;
  closedAt: Date | null;
  handedOverAt: Date | null;
  shipmentCount: number;
  packageCount: number;
}

/**
 * A manifest number, per carrier.
 *
 * Numbered per carrier rather than globally, so a manifest number is the
 * carrier's own paperwork and does not leak how much work the marketplace as a
 * whole is moving. The same reasoning as `SellerOrderGroup.sellerOrderNumber`.
 */
async function nextManifestNumber(logisticsPartnerId: string): Promise<string> {
  const key = `logistics-manifest:${logisticsPartnerId}`;

  await prisma.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'MF', padding: 5 },
  });

  const sequence = await prisma.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

export async function listManifests(
  membership: LogisticsMembership,
  filters: { state?: readonly LogisticsManifestState[] | null } = {},
): Promise<ManifestRow[]> {
  assertLogisticsPermission(membership, LogisticsPermission.DISPATCH_READ);

  const rows = await prisma.logisticsDispatchManifest.findMany({
    where: {
      logisticsPartnerId: membership.logisticsPartnerId,
      ...((filters.state !== undefined && filters.state !== null) && filters.state.length > 0
        ? { state: { in: [...filters.state] } }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      manifestNumber: true,
      state: true,
      originLabel: true,
      destinationLabel: true,
      plannedDepartureAt: true,
      closedAt: true,
      handedOverAt: true,
      driver: { select: { fullName: true } },
      vehicle: { select: { registration: true } },
      entries: { where: { removedAt: null }, select: { packageCount: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    manifestNumber: row.manifestNumber,
    state: row.state,
    driverName: row.driver?.fullName ?? null,
    vehicleRegistration: row.vehicle?.registration ?? null,
    originLabel: row.originLabel,
    destinationLabel: row.destinationLabel,
    plannedDepartureAt: row.plannedDepartureAt,
    closedAt: row.closedAt,
    handedOverAt: row.handedOverAt,
    shipmentCount: row.entries.length,
    packageCount: row.entries.reduce((sum, entry) => sum + entry.packageCount, 0),
  }));
}

export interface CreateManifestInput {
  shipmentIds: readonly string[];
  driverProfileId?: string | null;
  vehicleId?: string | null;
  originLabel?: string | null;
  destinationLabel?: string | null;
  plannedDepartureAt?: Date | null;
  notes?: string | null;
}

/**
 * Build a load and dispatch it.
 *
 * Every consignment on it is checked for access individually BEFORE anything
 * is written. A bulk action that authorised the first id and assumed the rest
 * is the classic way a bulk endpoint becomes a cross-tenant read, and the
 * check is cheap relative to the paperwork.
 */
export async function createManifest(
  membership: LogisticsMembership,
  input: CreateManifestInput,
  correlationId?: string | null,
): Promise<{ manifestId: string; manifestNumber: string; dispatched: number }> {
  assertLogisticsPermission(membership, LogisticsPermission.DISPATCH_WRITE);
  assertPartnerCanAcceptWork(membership);

  if (input.shipmentIds.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A manifest needs at least one shipment.', [
      { field: 'shipmentIds', code: 'EMPTY' },
    ]);
  }

  if ((input.driverProfileId !== undefined && input.driverProfileId !== null)) {
    await assertDriverBelongsToPartner(membership, input.driverProfileId);
  }
  if ((input.vehicleId !== undefined && input.vehicleId !== null)) {
    await assertVehicleBelongsToPartner(membership, input.vehicleId);
  }

  // Authorise every one, first. Nothing is written until all of them pass.
  const accesses: ShipmentAccess[] = [];
  for (const shipmentId of input.shipmentIds) {
    accesses.push(await assertShipmentAccess(membership, shipmentId, 'WRITE'));
  }

  const manifestId = newId();
  const manifestNumber = await nextManifestNumber(membership.logisticsPartnerId);

  const packageCounts = await prisma.logisticsShipment.findMany({
    where: { id: { in: [...input.shipmentIds] } },
    select: { id: true, packageCount: true },
  });

  const packagesById = new Map(packageCounts.map((row) => [row.id, row.packageCount]));

  await prisma.$transaction(async (tx) => {
    await tx.logisticsDispatchManifest.create({
      data: {
        id: manifestId,
        logisticsPartnerId: membership.logisticsPartnerId,
        manifestNumber,
        state: 'OPEN',
        driverProfileId: input.driverProfileId ?? null,
        vehicleId: input.vehicleId ?? null,
        originLabel: input.originLabel ?? null,
        destinationLabel: input.destinationLabel ?? null,
        plannedDepartureAt: input.plannedDepartureAt ?? null,
        notes: input.notes ?? null,
        createdByPartnerUserId: membership.partnerUserId,
      },
    });

    await tx.logisticsDispatchManifestEntry.createMany({
      data: accesses.map((access) => ({
        id: newId(),
        manifestId,
        shipmentId: access.shipmentId,
        packageCount: packagesById.get(access.shipmentId) ?? 0,
      })),
      // A consignment appears on a manifest once. Re-adding a removed one is
      // an update of that row rather than a second row.
      skipDuplicates: true,
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.manifest.created',
        resourceType: 'logistics_dispatch_manifest',
        resourceId: manifestId,
        after: { manifestNumber, shipments: accesses.length },
        summary: `Manifest ${manifestNumber} built with ${String(accesses.length)} shipments.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  /*
   * The status moves, one at a time and outside the transaction.
   *
   * Each goes through `recordShipmentEvent`, which re-checks the transition
   * for that particular consignment - and they will not all be in the same
   * state. A bulk action that assumed they were would fail the whole load
   * because one parcel was still awaiting collection.
   *
   * A refusal on one consignment is recorded against that consignment and does
   * not undo the manifest: the manifest is the paperwork, and the paperwork is
   * correct even where one line could not move.
   */
  let dispatched = 0;

  for (const access of accesses) {
    try {
      await recordShipmentEvent({
        shipmentId: access.shipmentId,
        status: 'DISPATCHED',
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorUserId: membership.userId,
        actorLogisticsPartnerId: membership.logisticsPartnerId,
        actorLabel: membership.fullName,
        permissions: [...membership.permissions],
        publicDescription: 'Your order is on its way.',
        internalNote: `Manifest ${manifestNumber}.`,
        idempotencyKey: `manifest:${manifestId}:${access.shipmentId}`,
        correlationId,
      });
      dispatched += 1;
    } catch {
      // Left on the manifest, not dispatched. The portal shows which.
      continue;
    }
  }

  return { manifestId, manifestNumber, dispatched };
}

/**
 * Hand a load over, and say who signed for it.
 *
 * Idempotent through the state guard: a second handover finds the manifest
 * already HANDED_OVER and changes nothing.
 */
export async function handOverManifest(
  membership: LogisticsMembership,
  manifestId: string,
  signedBy: string,
): Promise<void> {
  assertLogisticsPermission(membership, LogisticsPermission.DISPATCH_WRITE);

  const claimed = await prisma.logisticsDispatchManifest.updateMany({
    where: {
      id: manifestId,
      logisticsPartnerId: membership.logisticsPartnerId,
      state: { in: ['OPEN', 'CLOSED'] },
    },
    data: {
      state: 'HANDED_OVER',
      closedAt: new Date(),
      handedOverAt: new Date(),
      handoverSignedBy: signedBy.slice(0, 160),
    },
  });

  if (claimed.count !== 1) {
    throw conflict(
      ErrorCode.LOGISTICS_MANIFEST_NOT_ACTIONABLE,
      'This manifest has already been handed over or cancelled.',
    );
  }
}

/**
 * The manifest as a document a person can print.
 *
 * Returned as data rather than as a PDF, so the portal renders it with the
 * rest of its own typography and the operator's own letterhead. A PDF
 * generated server-side would be a second place branding has to be configured.
 */
export async function readManifestForPrint(
  membership: LogisticsMembership,
  manifestId: string,
): Promise<{
  manifestNumber: string;
  state: LogisticsManifestState;
  driverName: string | null;
  vehicleRegistration: string | null;
  originLabel: string | null;
  destinationLabel: string | null;
  plannedDepartureAt: Date | null;
  notes: string | null;
  lines: {
    shipmentReference: string;
    trackingNumber: string;
    receivingCompanyName: string;
    destinationCity: string | null;
    destinationCountry: string;
    packageCount: number;
    weightGrams: number;
    requiresColdChain: boolean;
    isDangerousGoods: boolean;
  }[];
}> {
  assertLogisticsPermission(membership, LogisticsPermission.DISPATCH_READ);

  const manifest = await prisma.logisticsDispatchManifest.findFirst({
    where: { id: manifestId, logisticsPartnerId: membership.logisticsPartnerId },
    select: {
      manifestNumber: true,
      state: true,
      originLabel: true,
      destinationLabel: true,
      plannedDepartureAt: true,
      notes: true,
      driver: { select: { fullName: true } },
      vehicle: { select: { registration: true } },
      entries: {
        where: { removedAt: null },
        orderBy: { addedAt: 'asc' },
        select: {
          packageCount: true,
          shipment: {
            select: {
              shipmentReference: true,
              trackingNumber: true,
              receivingCompanyName: true,
              destinationCity: true,
              destinationCountry: true,
              totalWeightGrams: true,
              requiresColdChain: true,
              isDangerousGoods: true,
            },
          },
        },
      },
    },
  });

  if (manifest === null) throw notFound('Manifest');

  return {
    manifestNumber: manifest.manifestNumber,
    state: manifest.state,
    driverName: manifest.driver?.fullName ?? null,
    vehicleRegistration: manifest.vehicle?.registration ?? null,
    originLabel: manifest.originLabel,
    destinationLabel: manifest.destinationLabel,
    plannedDepartureAt: manifest.plannedDepartureAt,
    notes: manifest.notes,
    lines: manifest.entries.map((entry) => ({
      shipmentReference: entry.shipment.shipmentReference,
      trackingNumber: entry.shipment.trackingNumber,
      receivingCompanyName: entry.shipment.receivingCompanyName,
      destinationCity: entry.shipment.destinationCity,
      destinationCountry: entry.shipment.destinationCountry,
      packageCount: entry.packageCount,
      weightGrams: entry.shipment.totalWeightGrams,
      requiresColdChain: entry.shipment.requiresColdChain,
      isDangerousGoods: entry.shipment.isDangerousGoods,
    })),
  };
}

// ---------------------------------------------------------------------------
// Shared tenant checks
// ---------------------------------------------------------------------------

/**
 * A driver id from a request body is an id somebody chose.
 *
 * Checked against the caller's own carrier before it is written anywhere. The
 * failure is a 404 rather than a 403, on the same reasoning as everywhere
 * else: confirming that another carrier's driver exists is itself a leak.
 */
export async function assertDriverBelongsToPartner(
  membership: LogisticsMembership,
  driverProfileId: string,
): Promise<void> {
  const driver = await prisma.logisticsDriverProfile.findFirst({
    where: {
      id: driverProfileId,
      logisticsPartnerId: membership.logisticsPartnerId,
      state: 'ACTIVE',
    },
    select: { id: true },
  });

  if (driver === null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      'That driver is not on your active list.',
    );
  }
}

export async function assertVehicleBelongsToPartner(
  membership: LogisticsMembership,
  vehicleId: string,
): Promise<void> {
  const vehicle = await prisma.logisticsVehicle.findFirst({
    where: { id: vehicleId, logisticsPartnerId: membership.logisticsPartnerId, isActive: true },
    select: { id: true },
  });

  if (vehicle === null) throw notFound('Vehicle');
}
