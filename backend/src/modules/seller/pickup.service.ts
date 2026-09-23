/**
 * Booking the van.
 *
 * A consignment that has been bought still has to be collected, and who
 * arranges that depends on how the seller delivers:
 *
 *   - **Their own carrier account.** The seller has a contract with DHL, so
 *     the collection is booked WITH DHL, through the seller's own credentials,
 *     and DHL gives back a confirmation number. Nothing about it is this
 *     platform's arrangement.
 *   - **A delivery company inside the platform** - the seller's own operation,
 *     or a courier that works for them. Nothing is called. The request appears
 *     on that company's own board, and a person there schedules it.
 *
 * WHAT THIS SERVICE REFUSES TO DO
 *
 * Book a second van for a consignment that already has one coming. Two vans is
 * expensive in a way one missed van is not: the second booking is chargeable,
 * and it is the one nobody remembers to cancel. The defence is a UNIQUE index
 * on `activeForShipmentId`, not a query - two dispatchers pressing the button
 * in the same second both read no live collection, and only the database can
 * settle that.
 *
 * And invent a confirmation. A collection shows as booked with a carrier only
 * when the carrier answered; an adapter that cannot do pickups says so, and the
 * seller is told to ring them rather than shown a green tick over nothing.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { LogisticsPickupState } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { assertPickupTransition, LIVE_PICKUP_STATES } from '../../domain/logistics-pickup-state.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { CarrierAddress } from '../logistics/carrier/adapter.js';
import { recordSellerAudit } from './audit.service.js';
import { adapterForSellerConnection } from './carrier-connection.service.js';
import { safeCarrierMessage } from './carrier-credential.service.js';
import {
  recordConnectionFailure,
  recordConnectionSuccess,
} from './carrier-purchase.service.js';
import type { SellerActor } from './fulfilment-method.service.js';

export interface PickupView {
  id: string;
  shipmentId: string | null;
  shipmentReference: string | null;
  state: LogisticsPickupState;
  windowStartAt: string;
  windowEndAt: string;
  timezone: string | null;
  instructions: string | null;
  /** Who is coming, in words a seller reads. */
  arrangedWith: string;
  /** Only ever what the carrier actually returned. */
  carrierConfirmationNumber: string | null;
  readinessConfirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  failureReason: string | null;
}

function view(row: {
  id: string;
  shipmentId: string | null;
  state: LogisticsPickupState;
  windowStartAt: Date;
  windowEndAt: Date;
  timezone: string | null;
  warehouseInstructions: string | null;
  carrierConfirmationNumber: string | null;
  readinessConfirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  failureReason: string | null;
  shipment: { shipmentReference: string } | null;
  partner: { displayName: string } | null;
  sellerConnection: { provider: string } | null;
}): PickupView {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    shipmentReference: row.shipment?.shipmentReference ?? null,
    state: row.state,
    windowStartAt: row.windowStartAt.toISOString(),
    windowEndAt: row.windowEndAt.toISOString(),
    timezone: row.timezone,
    instructions: row.warehouseInstructions,
    // One of the two is set - `chk_logistics_pickup_arranger` guarantees it -
    // so the fallback below is unreachable and is here only because a type
    // cannot say that.
    arrangedWith: row.partner?.displayName ?? row.sellerConnection?.provider ?? 'Unknown',
    carrierConfirmationNumber: row.carrierConfirmationNumber,
    readinessConfirmedAt: row.readinessConfirmedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    failureReason: row.failureReason,
  };
}

const SELECT = {
  id: true,
  shipmentId: true,
  state: true,
  windowStartAt: true,
  windowEndAt: true,
  timezone: true,
  warehouseInstructions: true,
  carrierConfirmationNumber: true,
  readinessConfirmedAt: true,
  completedAt: true,
  cancelledAt: true,
  failureReason: true,
  shipment: { select: { shipmentReference: true } },
  partner: { select: { displayName: true } },
  sellerConnection: { select: { provider: true } },
} as const;

// ---------------------------------------------------------------------------

/** Every collection this seller has arranged, newest window first. */
export async function listPickups(
  sellerAccountId: string,
  options: { shipmentId?: string; liveOnly?: boolean } = {},
): Promise<PickupView[]> {
  const rows = await prisma.logisticsPickupRequest.findMany({
    where: {
      sellerAccountId,
      ...(options.shipmentId === undefined ? {} : { shipmentId: options.shipmentId }),
      ...(options.liveOnly === true ? { state: { in: [...LIVE_PICKUP_STATES] } } : {}),
    },
    select: SELECT,
    orderBy: { windowStartAt: 'desc' },
    take: 100,
  });

  return rows.map(view);
}

interface ShipmentForPickup {
  id: string;
  shipmentReference: string;
  connectionId: string | null;
  partnerId: string | null;
  from: CarrierAddress;
  packageCount: number;
}

/**
 * The consignment, and who would collect it.
 *
 * Both ids in the same query: a consignment belonging to another seller is not
 * found rather than found and then refused, which is the difference between a
 * boundary and a check.
 */
async function loadShipment(
  sellerAccountId: string,
  shipmentId: string,
): Promise<ShipmentForPickup> {
  const shipment = await prisma.logisticsShipment.findFirst({
    where: { id: shipmentId, sellerAccountId },
    select: {
      id: true,
      shipmentReference: true,
      sellerCompanyName: true,
      sellerCarrierConnectionId: true,
      assignedPartnerId: true,
      pickupAddressJson: true,
      pickupContactName: true,
      pickupContactPhone: true,
      packageCount: true,
    },
  });

  if (shipment === null) throw notFound('Consignment');

  if (shipment.sellerCarrierConnectionId === null && shipment.assignedPartnerId === null) {
    throw badRequest(
      ErrorCode.PICKUP_NOT_AVAILABLE,
      'Nothing has been chosen to carry this consignment yet, so there is nobody to collect it.',
      [{ code: 'NO_CARRIER' }],
    );
  }

  const record = (
    typeof shipment.pickupAddressJson === 'object' && shipment.pickupAddressJson !== null
      ? shipment.pickupAddressJson
      : {}
  ) as Record<string, unknown>;

  const text = (key: string): string =>
    typeof record[key] === 'string' ? record[key] : '';

  return {
    id: shipment.id,
    shipmentReference: shipment.shipmentReference,
    connectionId: shipment.sellerCarrierConnectionId,
    // Only when there is no connection. A consignment that has both is going
    // out on the seller's own carrier account, and the partner row is the
    // in-platform record of it rather than a second party to call.
    partnerId:
      shipment.sellerCarrierConnectionId === null ? shipment.assignedPartnerId : null,
    from: {
      companyName: shipment.sellerCompanyName,
      contactName: shipment.pickupContactName,
      phone: shipment.pickupContactPhone,
      line1: text('line1'),
      line2: typeof record.line2 === 'string' ? record.line2 : null,
      city: text('city'),
      region: typeof record.region === 'string' ? record.region : null,
      postalCode: text('postalCode'),
      countryCode: text('countryCode'),
    },
    packageCount: Math.max(1, shipment.packageCount),
  };
}

export interface SchedulePickupInput {
  sellerAccountId: string;
  actor: SellerActor;
  shipmentId: string;
  windowStartAt: Date;
  windowEndAt: Date;
  /** IANA zone of the warehouse. A wall-clock window means nothing without it. */
  timezone?: string | null;
  instructions?: string | null;
}

/**
 * Book a collection for one consignment.
 *
 * The carrier is called FIRST and the row written afterwards, deliberately.
 * The reverse order leaves a row saying a van is coming when the carrier
 * refused - and a seller who has been told a collection is booked stops
 * checking.
 *
 * The only thing written before the call is the uniqueness claim, and that is
 * what the transaction below is for: the insert takes `activeForShipmentId`,
 * so a second dispatcher pressing the button in the same second collides in
 * the database rather than booking a second van.
 */
export async function schedulePickup(input: SchedulePickupInput): Promise<PickupView> {
  if (input.windowEndAt <= input.windowStartAt) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The collection window has to end after it starts.',
      [{ field: 'windowEndAt', code: 'RANGE_INVERTED' }],
    );
  }

  const shipment = await loadShipment(input.sellerAccountId, input.shipmentId);

  /*
   * Claim the consignment before calling anybody.
   *
   * REQUESTED with the window, and `activeForShipmentId` set. If a collection
   * is already live for this consignment the UNIQUE index refuses this insert,
   * and the seller is told which one rather than getting a second van.
   */
  const pickupId = newId();

  try {
    await prisma.logisticsPickupRequest.create({
      data: {
        id: pickupId,
        ...(shipment.partnerId === null
          ? { sellerCarrierConnectionId: shipment.connectionId }
          : { logisticsPartnerId: shipment.partnerId }),
        sellerAccountId: input.sellerAccountId,
        shipmentId: shipment.id,
        activeForShipmentId: shipment.id,
        state: 'REQUESTED',
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
        timezone: input.timezone ?? null,
        warehouseInstructions: input.instructions ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.logisticsPickupRequest.findFirst({
        where: { activeForShipmentId: shipment.id },
        select: { id: true, windowStartAt: true },
      });

      throw conflict(
        ErrorCode.PICKUP_ALREADY_BOOKED,
        'A collection is already booked for this consignment. Cancel it before booking another.',
        [
          {
            code: 'ALREADY_BOOKED',
            meta: {
              pickupId: existing?.id ?? null,
              windowStartAt: existing?.windowStartAt.toISOString() ?? null,
            },
          },
        ],
      );
    }

    throw error;
  }

  /*
   * A company inside the platform arranges its own van.
   *
   * Nothing is called, and nothing pretends to have been: the request lands on
   * that company's board and a person there schedules it. Showing a
   * confirmation number here would be inventing one.
   */
  if (shipment.partnerId !== null) {
    await recordSellerAudit({
      sellerAccountId: input.sellerAccountId,
      action: 'seller.pickup.requested',
      actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
      resourceType: 'LogisticsPickupRequest',
      resourceId: pickupId,
      summary: `Asked for ${shipment.shipmentReference} to be collected.`,
    });

    return readPickup(input.sellerAccountId, pickupId);
  }

  if (shipment.connectionId === null) {
    // Unreachable: `loadShipment` refuses a consignment with neither, and the
    // branch above took the partner case. Here so the types do not need a
    // non-null assertion, which is the thing that goes wrong silently later.
    throw badRequest(ErrorCode.PICKUP_NOT_AVAILABLE, 'There is nobody to collect this.');
  }

  const connectionId = shipment.connectionId;

  try {
    const adapter = await adapterForSellerConnection(connectionId);

    const result = await adapter.schedulePickup({
      from: shipment.from,
      windowStartAt: input.windowStartAt,
      windowEndAt: input.windowEndAt,
      parcelCount: shipment.packageCount,
      instructions: input.instructions ?? null,
      // The same window booked twice is one van. Derived from the consignment
      // and the window rather than from the row id, so a retry after a
      // timeout - where the row is gone and this runs again - still reaches
      // the carrier as the same request.
      idempotencyKey: sha256Hex(
        `pickup:${shipment.id}:${input.windowStartAt.toISOString()}`,
      ).slice(0, 64),
    });

    await prisma.logisticsPickupRequest.update({
      where: { id: pickupId },
      data: {
        state: 'SCHEDULED',
        scheduledAt: new Date(),
        carrierPickupId: result.carrierPickupId,
        // Only what the carrier actually sent. Null where it sent nothing,
        // rather than the internal id dressed up as a confirmation.
        carrierConfirmationNumber: result.confirmationNumber ?? null,
      },
    });

    await recordConnectionSuccess(connectionId);
  } catch (error) {
    /*
     * The carrier refused, so there is no van.
     *
     * The claim is released - `activeForShipmentId` back to NULL and the row
     * marked FAILED - because leaving it would block every later attempt with
     * "a collection is already booked" for a collection that never was.
     */
    assertPickupTransition('REQUESTED', 'FAILED');

    await prisma.logisticsPickupRequest.update({
      where: { id: pickupId },
      data: {
        state: 'FAILED',
        failedAt: new Date(),
        activeForShipmentId: null,
        // Sanitised. A failure message is the commonest place a credential
        // ends up in a database.
        failureReason: safeCarrierMessage(error).slice(0, 512),
      },
    });

    await recordConnectionFailure(connectionId, error);

    throw error;
  }

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.pickup.scheduled',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsPickupRequest',
    resourceId: pickupId,
    summary: `Booked a collection for ${shipment.shipmentReference}.`,
  });

  return readPickup(input.sellerAccountId, pickupId);
}

async function readPickup(sellerAccountId: string, pickupId: string): Promise<PickupView> {
  const row = await prisma.logisticsPickupRequest.findFirst({
    where: { id: pickupId, sellerAccountId },
    select: SELECT,
  });

  if (row === null) throw notFound('Collection');
  return view(row);
}

/**
 * The goods are on the dock.
 *
 * The single most common pickup failure is a van at an unready warehouse, and
 * this is the handshake that prevents it. It does not call the carrier -
 * nobody's API has a "we are ready" endpoint - it records that somebody at the
 * warehouse said so, which is what the driver's screen needs to show.
 */
export async function confirmReadiness(input: {
  sellerAccountId: string;
  actor: SellerActor;
  pickupId: string;
}): Promise<PickupView> {
  const existing = await prisma.logisticsPickupRequest.findFirst({
    where: { id: input.pickupId, sellerAccountId: input.sellerAccountId },
    select: { id: true, state: true },
  });

  if (existing === null) throw notFound('Collection');

  assertPickupTransition(existing.state, 'CONFIRMED');

  await prisma.logisticsPickupRequest.update({
    where: { id: existing.id },
    data: { state: 'CONFIRMED', readinessConfirmedAt: new Date() },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.pickup.ready',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsPickupRequest',
    resourceId: existing.id,
    summary: 'Confirmed the goods are ready for collection.',
  });

  return readPickup(input.sellerAccountId, existing.id);
}

/**
 * Call the van off.
 *
 * The carrier is told FIRST where there is one to tell, and the row is only
 * marked cancelled once they have been - the reverse order leaves a seller
 * believing no van is coming while one is, which is the more expensive of the
 * two mistakes.
 *
 * A carrier that refuses the cancellation is reported rather than swallowed.
 * The claim stays in place, because a van that is still coming is still
 * booked.
 */
export async function cancelPickup(input: {
  sellerAccountId: string;
  actor: SellerActor;
  pickupId: string;
  reason?: string | null;
}): Promise<PickupView> {
  const existing = await prisma.logisticsPickupRequest.findFirst({
    where: { id: input.pickupId, sellerAccountId: input.sellerAccountId },
    select: {
      id: true,
      state: true,
      carrierPickupId: true,
      sellerCarrierConnectionId: true,
      shipment: { select: { shipmentReference: true } },
    },
  });

  if (existing === null) throw notFound('Collection');

  /*
   * Already cancelled: say so, and do nothing.
   *
   * A double-click, a retried request or a seller pressing cancel on a stale
   * screen must not reach the carrier a second time or move the timestamp. The
   * van was already called off, which is what the caller wanted, so this is an
   * answer rather than an error - and a cancelled-at that quietly became an
   * hour later would be the record of when somebody clicked, not of when the
   * collection was called off.
   */
  if (existing.state === 'CANCELLED') return readPickup(input.sellerAccountId, existing.id);

  // Everything else terminal IS refused. A collection that already happened
  // cannot be called off, and a phone retrying an old cancel against it must
  // be told the truth rather than silently winning.
  assertPickupTransition(existing.state, 'CANCELLED');

  if (existing.sellerCarrierConnectionId !== null && existing.carrierPickupId !== null) {
    const connectionId = existing.sellerCarrierConnectionId;

    try {
      const adapter = await adapterForSellerConnection(connectionId);
      await adapter.cancelPickup(existing.carrierPickupId);
      await recordConnectionSuccess(connectionId);
    } catch (error) {
      await recordConnectionFailure(connectionId, error);
      throw error;
    }
  }

  await prisma.logisticsPickupRequest.update({
    where: { id: existing.id },
    data: {
      state: 'CANCELLED',
      cancelledAt: new Date(),
      // The claim is released, so the consignment can be booked again.
      activeForShipmentId: null,
      ...(input.reason === null || input.reason === undefined
        ? {}
        : { failureReason: input.reason.slice(0, 512) }),
    },
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.pickup.cancelled',
    actor: { type: 'CUSTOMER', userId: input.actor.userId, label: input.actor.label },
    resourceType: 'LogisticsPickupRequest',
    resourceId: existing.id,
    summary: `Cancelled the collection for ${existing.shipment?.shipmentReference ?? 'a consignment'}.`,
  });

  return readPickup(input.sellerAccountId, existing.id);
}
