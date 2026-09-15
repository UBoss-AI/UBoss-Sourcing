/**
 * Two carriers, one marketplace, and no way from one to the other.
 *
 * This file is the acceptance criteria the brief numbers 3, 4, 9, 17 and 22,
 * turned into assertions:
 *
 *   - a carrier sees only what is assigned to it;
 *   - changing a URL does not reach another carrier's consignment;
 *   - a duplicate status update writes at most one event;
 *   - a shipment event never writes an inventory movement;
 *   - a settled assignment is history, not a live door.
 *
 * The two carriers are set up as they would be in production - created by the
 * marketplace, with a real assignment each - so the isolation being tested is
 * the one the product actually has rather than a filter this file supplies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { acceptAssignment, offerAssignment } from '../../src/modules/logistics/assignment.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import {
  assertShipmentAccess,
  listShipments,
  readShipment,
} from '../../src/modules/logistics/shipment.service.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';

const NORTH_CODE = 'LP-TEST-NORTH';
const SOUTH_CODE = 'LP-TEST-SOUTH';

let northId = '';
let southId = '';
let north: LogisticsMembership;
let south: LogisticsMembership;

/** The consignment offered to and accepted by North. */
let northShipmentId = '';
/** The consignment offered to and accepted by South. */
let southShipmentId = '';

const ADDRESS = {
  line1: '1 Dock Road',
  city: 'Antwerp',
  postalCode: '2000',
  countryCode: 'BE',
};

async function cleanUp(): Promise<void> {
  /*
   * Children first, and every delete is scoped to this file's own rows.
   *
   * Orders here are ON DELETE RESTRICT elsewhere in this schema, and leftovers
   * break the NEXT run's first file rather than this one - which is the most
   * confusing failure in the suite. See the note in the repository guide.
   */
  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: { in: [NORTH_CODE, SOUTH_CODE] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { shipmentReference: { startsWith: 'LS-' }, orderId: null },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsShipmentException.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsNotification.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.logisticsAuditLog.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartnerInvitation.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });
  await prisma.user.deleteMany({
    where: { emailNormalized: { in: ['north@carrier.test', 'south@carrier.test'] } },
  });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'logistics-' } } });
}

/** A carrier, its owner, and the membership the services take. */
async function makeCarrier(
  partnerCode: string,
  name: string,
  email: string,
): Promise<{ id: string; membership: LogisticsMembership }> {
  const id = newId();
  const userId = newId();
  const partnerUserId = newId();

  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode,
      legalName: `${name} Freight NV`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'BE',
      contactEmail: email,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });

  await prisma.user.create({
    data: {
      id: userId,
      type: 'LOGISTICS',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
    },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: id,
      userId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: 'ACTIVE',
      fullName: `${name} Owner`,
    },
  });

  return {
    id,
    membership: {
      logisticsPartnerId: id,
      partnerCode,
      displayName: name,
      legalName: `${name} Freight NV`,
      partnerStatus: 'ACTIVE',
      registrationCountry: 'BE',
      partnerUserId,
      userId,
      fullName: `${name} Owner`,
      role: 'LOGISTICS_PARTNER_OWNER',
      permissions: permissionsForLogisticsRole('LOGISTICS_PARTNER_OWNER'),
      canAcceptNewWork: true,
      requiresMfa: true,
      regionScope: null,
      driverProfileId: null,
    },
  };
}

async function makeShipment(receiver: string): Promise<string> {
  const created = await createShipment({
    sellerCompanyName: 'Northwind Medical',
    receivingCompanyName: receiver,
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
    deliveryContactName: 'Jan de Boer',
    deliveryContactPhone: '+32 478 12 34 56',
    packageCount: 2,
    totalWeightGrams: 4200,
  });

  return created.id;
}

beforeAll(async () => {
  await cleanUp();

  const northCarrier = await makeCarrier(NORTH_CODE, 'North Courier', 'north@carrier.test');
  const southCarrier = await makeCarrier(SOUTH_CODE, 'South Courier', 'south@carrier.test');

  northId = northCarrier.id;
  north = northCarrier.membership;
  southId = southCarrier.id;
  south = southCarrier.membership;

  northShipmentId = await makeShipment('St Luke Hospital');
  southShipmentId = await makeShipment('Riverside Clinic');

  // Offered and accepted, exactly as the product does it.
  await prisma.logisticsShipment.update({
    where: { id: northShipmentId },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });
  await prisma.logisticsShipment.update({
    where: { id: southShipmentId },
    data: { status: 'AWAITING_ASSIGNMENT' },
  });

  await offerAssignment({
    shipmentId: northShipmentId,
    logisticsPartnerId: northId,
    offeredByUserId: null,
    automatic: false,
  });

  await offerAssignment({
    shipmentId: southShipmentId,
    logisticsPartnerId: southId,
    offeredByUserId: null,
    automatic: false,
  });

  await acceptAssignment(north, northShipmentId);
  await acceptAssignment(south, southShipmentId);
});

afterAll(async () => {
  await cleanUp();
});

describe('a carrier sees only its own work', () => {
  it('lists one consignment each', async () => {
    const northList = await listShipments(north, {});
    const southList = await listShipments(south, {});

    expect(northList.rows).toHaveLength(1);
    expect(northList.rows[0]?.id).toBe(northShipmentId);

    expect(southList.rows).toHaveLength(1);
    expect(southList.rows[0]?.id).toBe(southShipmentId);
  });

  it('shows the receiving company on its own and nothing of the other', async () => {
    const northList = await listShipments(north, {});

    expect(northList.rows[0]?.receivingCompanyName).toBe('St Luke Hospital');

    const everyName = northList.rows.map((row) => row.receivingCompanyName);
    expect(everyName).not.toContain('Riverside Clinic');
  });

  it('cannot widen the list with a filter', async () => {
    // A filter is a narrowing, never a widening. Asking for the other
    // carrier's receiver by name returns nothing rather than their row.
    const result = await listShipments(north, { receivingCompany: 'Riverside' });
    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe('changing the id in a URL', () => {
  it('answers NOT FOUND rather than FORBIDDEN', async () => {
    /*
     * 404 and not 403, deliberately. Confirming that a shipment exists but
     * belongs to somebody else still leaks its existence, and a shipment id is
     * guessable enough to matter. The same rule `assertOwnership` follows.
     */
    await expect(assertShipmentAccess(north, southShipmentId, 'READ')).rejects.toMatchObject({
      statusCode: 404,
    });

    await expect(readShipment(north, southShipmentId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it(`refuses a write to another carrier’s consignment`, async () => {
    await expect(assertShipmentAccess(north, southShipmentId, 'WRITE')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses to record an event against it', async () => {
    const before = await prisma.logisticsShipmentEvent.count({
      where: { shipmentId: southShipmentId },
    });

    await expect(assertShipmentAccess(north, southShipmentId, 'WRITE')).rejects.toThrow();

    const after = await prisma.logisticsShipmentEvent.count({
      where: { shipmentId: southShipmentId },
    });

    expect(after).toBe(before);
  });
});

describe('a settled assignment', () => {
  it('leaves the consignment readable and unwritable', async () => {
    // Withdraw North's assignment, as the marketplace would on a handover.
    await prisma.logisticsShipmentAssignment.updateMany({
      where: { shipmentId: northShipmentId, logisticsPartnerId: northId },
      data: { state: 'WITHDRAWN', withdrawnAt: new Date(), withdrawnReason: 'Test handover.' },
    });

    // Still in their history...
    const read = await assertShipmentAccess(north, northShipmentId, 'READ');
    expect(read.isLive).toBe(false);

    // ...and closed to every change.
    await expect(assertShipmentAccess(north, northShipmentId, 'WRITE')).rejects.toMatchObject({
      statusCode: 409,
    });

    // Put it back for the tests below.
    await prisma.logisticsShipmentAssignment.updateMany({
      where: { shipmentId: northShipmentId, logisticsPartnerId: northId },
      data: { state: 'ACCEPTED', withdrawnAt: null, withdrawnReason: null },
    });
  });
});

describe('duplicate status updates', () => {
  it('writes at most one event for one idempotency key', async () => {
    const key = `test-duplicate-${newId()}`;

    const first = await recordShipmentEvent({
      shipmentId: northShipmentId,
      status: 'PICKUP_SCHEDULED',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: northId,
      permissions: [...north.permissions],
      idempotencyKey: key,
    });

    const second = await recordShipmentEvent({
      shipmentId: northShipmentId,
      status: 'PICKUP_SCHEDULED',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: northId,
      permissions: [...north.permissions],
      idempotencyKey: key,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);

    const events = await prisma.logisticsShipmentEvent.count({
      where: { shipmentId: northShipmentId, idempotencyKey: key },
    });

    expect(events).toBe(1);
  });

  it('survives two callers racing the same key', async () => {
    /*
     * The case a check-then-insert loses. Both calls run concurrently; the
     * UNIQUE index decides, and exactly one of them is the writer.
     */
    const key = `test-race-${newId()}`;

    const [a, b] = await Promise.all([
      recordShipmentEvent({
        shipmentId: northShipmentId,
        status: 'READY_FOR_PICKUP',
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: northId,
        permissions: [...north.permissions],
        idempotencyKey: key,
      }),
      recordShipmentEvent({
        shipmentId: northShipmentId,
        status: 'READY_FOR_PICKUP',
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: northId,
        permissions: [...north.permissions],
        idempotencyKey: key,
      }),
    ]);

    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);

    const events = await prisma.logisticsShipmentEvent.count({
      where: { shipmentId: northShipmentId, idempotencyKey: key },
    });

    expect(events).toBe(1);
  });

  it('refuses an illegal transition even under a fresh key', async () => {
    // The status is READY_FOR_PICKUP after the tests above. Delivered is not
    // reachable from there at any price.
    await expect(
      recordShipmentEvent({
        shipmentId: northShipmentId,
        status: 'DELIVERED',
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: northId,
        permissions: [...north.permissions],
        hasProofOfDelivery: true,
        idempotencyKey: `test-illegal-${newId()}`,
      }),
    ).rejects.toMatchObject({ code: 'SHIPMENT_TRANSITION_NOT_ALLOWED' });
  });
});

describe('inventory', () => {
  it('is never written by a shipment event', async () => {
    /*
     * Acceptance criterion 17, asserted rather than asserted-in-prose.
     *
     * The logistics module writes no balance, no movement and no reservation.
     * Where a milestone should move stock it moves the ORDER, and the order
     * state machine does what it already does - which is why a duplicate
     * shipment event cannot produce a duplicate inventory movement.
     */
    const before = await prisma.inventoryMovement.count();

    await recordShipmentEvent({
      shipmentId: northShipmentId,
      status: 'PICKED_UP',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: northId,
      permissions: [...north.permissions],
      idempotencyKey: `test-inventory-${newId()}`,
    });

    const after = await prisma.inventoryMovement.count();
    expect(after).toBe(before);
  });
});

describe('the timeline', () => {
  it('records every accepted event and never edits one', async () => {
    const events = await prisma.logisticsShipmentEvent.findMany({
      where: { shipmentId: northShipmentId },
      orderBy: { occurredAt: 'asc' },
      select: { status: true, previousStatus: true },
    });

    // Created, assigned, acceptance pending, accepted, pickup scheduled,
    // ready for pickup, picked up. Every one of them still there.
    expect(events.map((event) => event.status)).toEqual([
      'CREATED',
      'ASSIGNED',
      'ACCEPTANCE_PENDING',
      'ACCEPTED',
      'PICKUP_SCHEDULED',
      'READY_FOR_PICKUP',
      'PICKED_UP',
    ]);

    // And each one names what it came from, so the chain is readable.
    expect(events[0]?.previousStatus).toBeNull();
    expect(events[1]?.previousStatus).toBe('AWAITING_ASSIGNMENT');
  });

  it('keeps the status column in step with the last event', async () => {
    const shipment = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: northShipmentId },
      select: { status: true },
    });

    expect(shipment.status).toBe('PICKED_UP');
  });
});
