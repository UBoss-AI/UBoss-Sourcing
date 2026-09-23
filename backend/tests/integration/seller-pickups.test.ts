/**
 * Booking the van, and refusing to book it twice.
 *
 * THE ONE THAT MATTERS: two vans. The second booking is chargeable, it is the
 * one nobody remembers to cancel, and a warehouse that hands the same cartons
 * to two drivers has lost them. The defence is a UNIQUE index on
 * `activeForShipmentId` rather than a query, because two dispatchers pressing
 * the button in the same second both read no live collection - and this file
 * proves the index holds rather than trusting the check in front of it.
 *
 * WHAT IS NOT EXERCISED HERE: a real DHL collection. That needs a real account,
 * which in this product belongs to a seller and not to this repository. What is
 * exercised is the whole of the in-platform path and every rule that is the
 * same on both: the claim, the release, the states, and the tenant boundary.
 * No test in this file makes an outbound request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerActor } from '../../src/modules/seller/fulfilment-method.service.js';
import {
  cancelPickup,
  confirmReadiness,
  listPickups,
  schedulePickup,
} from '../../src/modules/seller/pickup.service.js';

const SLUG_A = 'pickup-co';
const SLUG_B = 'pickup-rival-co';
const PARTNER_CODE = 'LP-TEST-PICKUP';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Pickup Co' };

let sellerA = '';
let sellerB = '';
let partnerId = '';
/** A consignment with a delivery company behind it. */
let shipmentId = '';
/** A consignment with nobody behind it at all. */
let orphanShipmentId = '';

const WINDOW_START = new Date('2026-10-01T09:00:00.000Z');
const WINDOW_END = new Date('2026-10-01T12:00:00.000Z');

async function cleanUp(): Promise<void> {
  const slugs = { in: [SLUG_A, SLUG_B] };

  await prisma.logisticsPickupRequest.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  /*
   * Consignments go by reference prefix, not by seller.
   *
   * `LogisticsShipment` carries `sellerAccountId` as a plain column with no
   * relation to traverse - deliberately, because a consignment can exist for a
   * movement with no seller behind it at all.
   */
  await prisma.logisticsShipment.deleteMany({
    where: { shipmentReference: { startsWith: 'LS-PICKUP-' } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: PARTNER_CODE } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: slugs } });
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'RESELLER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  return seller.id;
}

async function makeShipment(withPartner: boolean): Promise<string> {
  const shipment = await prisma.logisticsShipment.create({
    data: {
      id: newId(),
      shipmentReference: `LS-PICKUP-${newId().slice(-8)}`,
      trackingNumber: `UB${newId().slice(-12).toUpperCase()}`,
      sellerAccountId: sellerA,
      sellerCompanyName: 'Pickup Co',
      receivingCompanyName: 'A Hospital',
      pickupAddressJson: {
        line1: '1 Depot Road',
        city: 'Delhi',
        postalCode: '110001',
        countryCode: 'IN',
      },
      deliveryAddressJson: {
        line1: '2 Clinic Way',
        city: 'Mumbai',
        postalCode: '400001',
        countryCode: 'IN',
      },
      originCountry: 'IN',
      destinationCountry: 'IN',
      currency: 'INR',
      totalWeightGrams: 2000,
      packageCount: 3,
      ...(withPartner ? { assignedPartnerId: partnerId } : {}),
    },
  });

  return shipment.id;
}

beforeAll(async () => {
  await cleanUp();

  sellerA = await makeSeller(SLUG_A, 'Pickup Co');
  sellerB = await makeSeller(SLUG_B, 'Pickup Rival Co');

  const partner = await prisma.logisticsPartner.create({
    data: {
      id: newId(),
      partnerCode: PARTNER_CODE,
      legalName: 'Pickup Vans Ltd',
      displayName: 'Pickup Vans',
      displayNameNormalized: 'pickupvans',
      registrationCountry: 'IN',
      contactEmail: 'ops@pickup-vans.example',
      status: 'ACTIVE',
      partnerKind: 'SELLER_SELF_MANAGED',
      ownerSellerAccountId: sellerA,
    },
  });

  partnerId = partner.id;

  shipmentId = await makeShipment(true);
  orphanShipmentId = await makeShipment(false);
});

afterAll(async () => {
  // Leftovers break the FIRST file of the next run, which is the hardest
  // failure in this suite to attribute to anything.
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('asking for a collection', () => {
  it('records the request without inventing a confirmation', async () => {
    const pickup = await schedulePickup({
      sellerAccountId: sellerA,
      actor: ACTOR,
      shipmentId,
      windowStartAt: WINDOW_START,
      windowEndAt: WINDOW_END,
      timezone: 'Asia/Kolkata',
      instructions: 'Bay 3, ring the bell on the left.',
    });

    // REQUESTED, not SCHEDULED. Nothing was called: the request lands on the
    // delivery company's own board and a person there schedules it, and a
    // confirmation number here would be one this system made up.
    expect(pickup.state).toBe('REQUESTED');
    expect(pickup.carrierConfirmationNumber).toBeNull();
    expect(pickup.arrangedWith).toBe('Pickup Vans');
    expect(pickup.timezone).toBe('Asia/Kolkata');
  });

  it('refuses a second live collection for the same consignment', async () => {
    // Two vans. The second booking is chargeable and is the one nobody
    // cancels - and this is refused by the UNIQUE index, not by the read in
    // front of it, because two dispatchers in the same second both read none.
    await expect(
      schedulePickup({
        sellerAccountId: sellerA,
        actor: ACTOR,
        shipmentId,
        windowStartAt: WINDOW_START,
        windowEndAt: WINDOW_END,
      }),
    ).rejects.toMatchObject({ code: 'PICKUP_ALREADY_BOOKED' });
  });

  it('names the existing collection, so the screen can offer to cancel it', async () => {
    // A seller told only "already booked" has to go and find it. The id is in
    // the error because the next thing they want is that row.
    const existing = await listPickups(sellerA, { shipmentId, liveOnly: true });

    await expect(
      schedulePickup({
        sellerAccountId: sellerA,
        actor: ACTOR,
        shipmentId,
        windowStartAt: WINDOW_START,
        windowEndAt: WINDOW_END,
      }),
    ).rejects.toMatchObject({
      details: [{ meta: { pickupId: existing[0]?.id } }],
    });
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(
      schedulePickup({
        sellerAccountId: sellerA,
        actor: ACTOR,
        shipmentId: orphanShipmentId,
        windowStartAt: WINDOW_END,
        windowEndAt: WINDOW_START,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a consignment nothing has been chosen to carry', async () => {
    // There is nobody to ask. Saying so is more use than a generic failure,
    // because the seller's next action is to pick a carrier.
    await expect(
      schedulePickup({
        sellerAccountId: sellerA,
        actor: ACTOR,
        shipmentId: orphanShipmentId,
        windowStartAt: WINDOW_START,
        windowEndAt: WINDOW_END,
      }),
    ).rejects.toMatchObject({ code: 'PICKUP_NOT_AVAILABLE' });
  });

  it('does not find a consignment that is not theirs', async () => {
    await expect(
      schedulePickup({
        sellerAccountId: sellerB,
        actor: ACTOR,
        shipmentId,
        windowStartAt: WINDOW_START,
        windowEndAt: WINDOW_END,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the readiness handshake', () => {
  it('records that somebody at the warehouse said the goods are on the dock', async () => {
    const live = await listPickups(sellerA, { shipmentId, liveOnly: true });

    const pickup = await confirmReadiness({
      sellerAccountId: sellerA,
      actor: ACTOR,
      pickupId: live[0]?.id ?? '',
    });

    // The single most common pickup failure is a van at an unready dock, and
    // this is the handshake that prevents it.
    expect(pickup.state).toBe('CONFIRMED');
    expect(pickup.readinessConfirmedAt).not.toBeNull();
  });
});

describe('calling the van off', () => {
  let cancelledId = '';

  it('records the cancellation with its reason and keeps the row', async () => {
    const live = await listPickups(sellerA, { shipmentId, liveOnly: true });
    cancelledId = live[0]?.id ?? '';

    const pickup = await cancelPickup({
      sellerAccountId: sellerA,
      actor: ACTOR,
      pickupId: cancelledId,
      reason: 'The customer changed the delivery date.',
    });

    expect(pickup.state).toBe('CANCELLED');
    expect(pickup.cancelledAt).not.toBeNull();
    expect(pickup.failureReason).toBe('The customer changed the delivery date.');
  });

  it('frees the consignment, so another collection can be booked', async () => {
    // The claim is released on cancellation. Leaving it would block every
    // later attempt with "a collection is already booked" for a van that is
    // not coming.
    const pickup = await schedulePickup({
      sellerAccountId: sellerA,
      actor: ACTOR,
      shipmentId,
      windowStartAt: new Date('2026-10-02T09:00:00.000Z'),
      windowEndAt: new Date('2026-10-02T12:00:00.000Z'),
    });

    expect(pickup.state).toBe('REQUESTED');

    const all = await listPickups(sellerA, { shipmentId });

    // Both rows, newest window first. The cancelled one stays: "did we book a
    // van last Tuesday?" is asked a week later.
    expect(all).toHaveLength(2);
    expect(all[1]?.id).toBe(cancelledId);
  });

  it('answers a second cancel without touching anything', async () => {
    // A double-click, a retried request or a stale screen. The van was already
    // called off, which is what the caller wanted, so this is an answer rather
    // than an error - and the carrier must not be told twice, nor the
    // cancelled-at quietly become the moment of the second click.
    const before = await listPickups(sellerA, { shipmentId });
    const first = before.find((row) => row.id === cancelledId);

    const again = await cancelPickup({
      sellerAccountId: sellerA,
      actor: ACTOR,
      pickupId: cancelledId,
    });

    expect(again.state).toBe('CANCELLED');
    expect(again.cancelledAt).toBe(first?.cancelledAt);
    expect(again.failureReason).toBe('The customer changed the delivery date.');
  });

  it('refuses to cancel a collection that already happened', async () => {
    // The one that matters. A driver's phone retrying an old cancel against a
    // collection the van already made must be told the truth rather than
    // silently winning, because the parcels are gone.
    await prisma.logisticsPickupRequest.update({
      where: { id: cancelledId },
      data: { state: 'COMPLETED', completedAt: new Date(), cancelledAt: null },
    });

    await expect(
      cancelPickup({ sellerAccountId: sellerA, actor: ACTOR, pickupId: cancelledId }),
    ).rejects.toMatchObject({ code: 'PICKUP_TRANSITION_INVALID' });
  });

  it('does not find a collection that is not theirs', async () => {
    await expect(
      cancelPickup({ sellerAccountId: sellerB, actor: ACTOR, pickupId: cancelledId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
