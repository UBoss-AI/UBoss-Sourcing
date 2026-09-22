/**
 * What a seller is told about their carrier, and when it stops being told.
 *
 * The loop under test: a seller hands a consignment to a carrier and, until
 * this existed, heard nothing back. No acceptance, no refusal, no word when
 * the offer lapsed — the parcel sat in a state only the marketplace could see.
 *
 * Three claims, and the third is the one that is easy to get wrong:
 *
 *   - **A duplicate event announces once.** Enforced by a unique index rather
 *     than by a query, because a check-then-insert loses to a provider
 *     redelivering a webhook twice in the same second.
 *   - **Read is not resolved.** "Your carrier refused this" cannot be cleared
 *     by glancing at it: the parcel still has nobody.
 *   - **Resolving preserves the row.** It stops counting towards the badge and
 *     stays in the history, with what closed it and when. A notification that
 *     vanished when the problem was fixed would delete the record of the
 *     problem.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import {
  notifySellerCarrierAccepted,
  notifySellerCarrierArrangement,
  notifySellerCarrierDeclined,
  resolveConsignmentUnassigned,
} from '../../src/modules/seller/carrier-notification.service.js';
import {
  consignmentUnassignedKey,
  notifySeller,
  notifySellerOnce,
  resolveSellerNotifications,
} from '../../src/modules/seller/notification.service.js';

const SELLER_SLUG = 'CN-ACME';
const OTHER_SLUG = 'CN-RIVAL';

let sellerId = '';
let otherSellerId = '';
let shipmentId = '';

const ADDRESS = { line1: '1 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };

async function cleanUp(): Promise<void> {
  const sellerIds = (
    await prisma.sellerAccount.findMany({
      where: { slug: { in: [SELLER_SLUG, OTHER_SLUG] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { sellerAccountId: { in: sellerIds } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });

  // The shipment-reference counter is deliberately NOT reset.
  //
  // It is shared with every other file in this suite, and `shipmentReference`
  // is globally unique. Resetting it makes the next `createShipment` reissue
  // a reference that a shipment from another file is still holding, which
  // fails on the unique index for a reason that has nothing to do with the
  // test that hits it. Gaps in the counter are fine; that is what it is for.
}

async function makeSeller(slug: string, name: string): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      slug,
      legalName: `${name} NV`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'BE',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });

  return id;
}

beforeEach(async () => {
  await cleanUp();

  sellerId = await makeSeller(SELLER_SLUG, 'Acme Supplies');
  otherSellerId = await makeSeller(OTHER_SLUG, 'Rival Supplies');

  const created = await createShipment({
    sellerAccountId: sellerId,
    sellerCompanyName: 'Acme Supplies',
    receivingCompanyName: 'St Luke Hospital',
    pickupAddress: ADDRESS,
    deliveryAddress: { ...ADDRESS, city: 'Ghent', postalCode: '9000' },
  });

  shipmentId = created.id;
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

function activeFor(sellerAccountId: string) {
  return prisma.sellerNotification.findMany({
    where: { sellerAccountId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

describe('a carrier accepting', () => {
  it('tells the seller, as news rather than as a problem', async () => {
    await notifySellerCarrierAccepted({ shipmentId, carrierName: 'North Courier' });

    const rows = await activeFor(sellerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('CARRIER_ACCEPTED');
    expect(rows[0]?.class).toBe('INFORMATION');
    expect(rows[0]?.title).toContain('North Courier');
  });

  it('announces once however many times the event arrives', async () => {
    // A redelivered webhook, or a retried worker. Enforced by the unique
    // index, so two of these landing in the same millisecond is still one row.
    await Promise.all([
      notifySellerCarrierAccepted({ shipmentId, carrierName: 'North Courier' }),
      notifySellerCarrierAccepted({ shipmentId, carrierName: 'North Courier' }),
      notifySellerCarrierAccepted({ shipmentId, carrierName: 'North Courier' }),
    ]);

    expect(await activeFor(sellerId)).toHaveLength(1);
  });

  it('says nothing for a consignment with no seller behind it', async () => {
    // The operator's own goods. There is nobody to tell, and that is a no-op
    // rather than an error.
    const operatorShipment = await createShipment({
      sellerCompanyName: 'The operator',
      receivingCompanyName: 'St Luke Hospital',
      pickupAddress: ADDRESS,
      deliveryAddress: ADDRESS,
    });

    await notifySellerCarrierAccepted({
      shipmentId: operatorShipment.id,
      carrierName: 'North Courier',
    });

    expect(await prisma.sellerNotification.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

describe('a carrier refusing or going quiet', () => {
  it('raises an ALERT, because the parcel now has nobody', async () => {
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'No refrigerated vehicle available.',
    });

    const rows = await activeFor(sellerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.class).toBe('ALERT');
    expect(rows[0]?.resolutionKey).toBe(consignmentUnassignedKey(shipmentId));
    expect(rows[0]?.body).toContain('No refrigerated vehicle');
  });

  it('distinguishes a refusal from an unanswered offer', async () => {
    // Different kinds because the seller's next move differs: a refusal comes
    // with a reason they can act on, a lapse means the carrier is not reading
    // their queue.
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_OFFER_EXPIRED',
    });

    const rows = await activeFor(sellerId);
    expect(rows[0]?.kind).toBe('CARRIER_OFFER_EXPIRED');
    expect(rows[0]?.body).toContain('lapsed');
  });

  it('records a second carrier refusing as a second entry', async () => {
    // Two refusals are two facts. The carrier is in the dedupe key so the
    // second is not swallowed as a duplicate of the first.
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'Too far.',
    });
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'South Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'No capacity.',
    });

    const rows = await activeFor(sellerId);

    expect(rows).toHaveLength(2);
    // ...but ONE problem, so one assignment closes both.
    expect(new Set(rows.map((row) => row.resolutionKey)).size).toBe(1);
  });

  it('refuses to raise an alert with no resolution key', async () => {
    // An alert nothing can close is an alert that stays up for ever. Caught at
    // the call rather than discovered on a badge that never empties.
    await expect(
      notifySeller({
        sellerAccountId: sellerId,
        kind: 'CARRIER_REJECTED',
        title: 'x',
        body: 'y',
        class: 'ALERT',
        tx: prisma,
      }),
    ).rejects.toThrow(/resolutionKey/);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('giving the parcel to somebody', () => {
  it('closes every alert about it, and keeps them', async () => {
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'Too far.',
    });
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'South Courier',
      kind: 'CARRIER_OFFER_EXPIRED',
    });

    expect(await activeFor(sellerId)).toHaveLength(2);

    await resolveConsignmentUnassigned({ shipmentId, carrierName: 'East Freight' });

    // Nothing active...
    expect(await activeFor(sellerId)).toHaveLength(0);

    // ...and nothing lost. THE CLAIM THAT MATTERS: a notification that
    // vanished when the problem was fixed would delete the record of the
    // problem, which is exactly what somebody reads after a bad week.
    const all = await prisma.sellerNotification.findMany({ where: { sellerAccountId: sellerId } });

    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(row.status).toBe('RESOLVED');
      expect(row.resolvedAt).not.toBeNull();
      expect(row.resolutionSource).toBe('DOMAIN_EVENT');
      expect(row.resolutionNote).toContain('East Freight');
    }
  });

  it('is idempotent, and the first resolution is the one that survives', async () => {
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'Too far.',
    });

    const first = await resolveSellerNotifications({
      resolutionKey: consignmentUnassignedKey(shipmentId),
      note: 'Given to East Freight.',
    });
    const second = await resolveSellerNotifications({
      resolutionKey: consignmentUnassignedKey(shipmentId),
      note: 'Given to somebody else entirely.',
    });

    expect(first).toBe(1);
    expect(second).toBe(0);

    const row = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: sellerId },
    });
    expect(row.resolutionNote).toContain('East Freight');
  });

  it('an acceptance closes an outstanding alert too', async () => {
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'Too far.',
    });

    await notifySellerCarrierAccepted({ shipmentId, carrierName: 'East Freight' });

    const active = await activeFor(sellerId);

    // Only the acceptance is live; the refusal is resolved.
    expect(active).toHaveLength(1);
    expect(active[0]?.kind).toBe('CARRIER_ACCEPTED');
  });

  it('leaves another consignment alone', async () => {
    const second = await createShipment({
      sellerAccountId: sellerId,
      sellerCompanyName: 'Acme Supplies',
      receivingCompanyName: 'Riverside Clinic',
      pickupAddress: ADDRESS,
      deliveryAddress: ADDRESS,
    });

    for (const id of [shipmentId, second.id]) {
      await notifySellerCarrierDeclined({
        shipmentId: id,
        carrierName: 'North Courier',
        kind: 'CARRIER_REJECTED',
        reason: 'Too far.',
      });
    }

    await resolveConsignmentUnassigned({ shipmentId, carrierName: 'East Freight' });

    const active = await activeFor(sellerId);
    expect(active).toHaveLength(1);
    expect(active[0]?.subjectId).toBe(second.id);
  });
});

// ---------------------------------------------------------------------------
// Read is not resolved
// ---------------------------------------------------------------------------

describe('read and resolved are different things', () => {
  it('reading an alert does not clear it', async () => {
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'Too far.',
    });

    const row = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: sellerId },
    });

    // Somebody opens the list. That is a per-person mark, not a statement
    // about the parcel.
    await prisma.sellerNotification.update({
      where: { id: row.id },
      data: { readByJson: { 'profile-1': new Date().toISOString() } },
    });

    const after = await activeFor(sellerId);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('one seller never sees another', () => {
  it('addresses the notice to the seller who owns the consignment', async () => {
    await notifySellerCarrierDeclined({
      shipmentId,
      carrierName: 'North Courier',
      kind: 'CARRIER_REJECTED',
      reason: 'Too far.',
    });

    expect(await activeFor(sellerId)).toHaveLength(1);
    expect(await activeFor(otherSellerId)).toHaveLength(0);
  });

  it('lets two sellers hold the same dedupe key without colliding', async () => {
    // The unique index is per seller, so an identical key for a different
    // business is a different row rather than a swallowed duplicate.
    for (const id of [sellerId, otherSellerId]) {
      await notifySeller({
        sellerAccountId: id,
        kind: 'CARRIER_ACCEPTED',
        title: 'Accepted',
        body: 'x',
        dedupeKey: 'same-key-for-both',
      });
    }

    expect(await activeFor(sellerId)).toHaveLength(1);
    expect(await activeFor(otherSellerId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Arrangement decisions
// ---------------------------------------------------------------------------

describe('a decision about a carrier arrangement', () => {
  it('tells the seller, with the reason', async () => {
    await notifySellerCarrierArrangement({
      sellerAccountId: sellerId,
      linkId: newId(),
      carrierName: 'North Courier',
      status: 'REJECTED',
      reason: 'No liability cover on file.',
    });

    const rows = await activeFor(sellerId);

    expect(rows[0]?.kind).toBe('CARRIER_ARRANGEMENT_DECISION');
    expect(rows[0]?.body).toContain('liability cover');
    // News, not an alert: a refused arrangement is a decision read once, not
    // an ongoing problem with a parcel.
    expect(rows[0]?.class).toBe('INFORMATION');
  });

  it('treats approve, pause and approve again as three things to read', async () => {
    const linkId = newId();

    for (const status of ['APPROVED', 'SUSPENDED', 'APPROVED'] as const) {
      await notifySellerCarrierArrangement({
        sellerAccountId: sellerId,
        linkId,
        carrierName: 'North Courier',
        status,
        reason: 'x',
      });
    }

    // Two rows, not three: the second APPROVED is the same decision about the
    // same arrangement and is deduplicated. The pause is its own.
    const rows = await activeFor(sellerId);
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The repeating notices this shares its table with
// ---------------------------------------------------------------------------

describe('notifySellerOnce still repeats by the day', () => {
  it('says one thing per subject per day', async () => {
    for (let index = 0; index < 3; index += 1) {
      await notifySellerOnce({
        sellerAccountId: sellerId,
        kind: 'LOW_STOCK',
        title: 'Low stock',
        body: 'Running out.',
        subjectType: 'seller_offer',
        subjectId: 'offer-1',
      });
    }

    const rows = await prisma.sellerNotification.findMany({
      where: { sellerAccountId: sellerId, kind: 'LOW_STOCK' },
    });

    expect(rows).toHaveLength(1);
  });

  it('does not lose a race between two workers', async () => {
    // The window query alone is a check-then-insert and both callers would
    // find nothing. The unique index is what makes this one row.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        notifySellerOnce({
          sellerAccountId: sellerId,
          kind: 'LOW_STOCK',
          title: 'Low stock',
          body: 'Running out.',
          subjectType: 'seller_offer',
          subjectId: 'offer-race',
        }),
      ),
    );

    const rows = await prisma.sellerNotification.findMany({
      where: { sellerAccountId: sellerId, kind: 'LOW_STOCK' },
    });

    expect(rows).toHaveLength(1);
  });
});
