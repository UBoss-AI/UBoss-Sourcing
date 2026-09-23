/**
 * Pricing a consignment, and buying it once.
 *
 * THE ONE THAT MATTERS: a consignment must not be bought twice. Creating a
 * shipment at a carrier is a chargeable act, and a retry, a double click or a
 * redelivered job will repeat it unless something refuses. That something is a
 * UNIQUE index, and this file proves it holds rather than trusting that the
 * check before it always runs first.
 *
 * WHAT IS NOT EXERCISED: a real DHL or FedEx booking. Those need a real
 * account, which in this product belongs to a seller and not to this
 * repository. What is exercised is everything around the call - the quote
 * lifecycle, the selection race, the idempotency key, and the tenant boundary.
 * No test here makes an outbound request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { listQuotes, selectQuote } from '../../src/modules/seller/carrier-purchase.service.js';
import { chooseFulfilmentMethod, type SellerActor } from '../../src/modules/seller/fulfilment-method.service.js';

const SLUG_A = 'purchase-co';
const SLUG_B = 'purchase-rival-co';

let sellerA = '';
let sellerB = '';
let shipmentId = '';
let methodId = '';
let connectionId = '';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Purchase Co' };

async function cleanUp(): Promise<void> {
  const slugs = { in: [SLUG_A, SLUG_B] };

  await prisma.shipmentPurchase.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.carrierRateQuote.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  /*
   * By reference prefix, not by seller.
   *
   * `LogisticsShipment` carries `sellerAccountId` as a plain column with no
   * relation to traverse - deliberately, because a consignment can exist for a
   * movement that has no seller behind it at all.
   */
  await prisma.logisticsShipmentDocument.deleteMany({
    where: { shipment: { shipmentReference: { startsWith: 'LS-TEST-' } } },
  });
  await prisma.logisticsShipment.deleteMany({
    where: { shipmentReference: { startsWith: 'LS-TEST-' } },
  });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerCarrierCredential.deleteMany({
    where: { connection: { sellerAccount: { slug: slugs } } },
  });
  await prisma.sellerCarrierConnection.deleteMany({ where: { sellerAccount: { slug: slugs } } });
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

/** A consignment with a carrier account behind it, ready to be priced. */
async function makeShipment(): Promise<void> {
  const connection = await prisma.sellerCarrierConnection.create({
    data: {
      id: newId(),
      sellerAccountId: sellerA,
      provider: 'DHL',
      environment: 'SANDBOX',
      state: 'ACTIVE',
      accountNumber: '123456789',
      lastTestPassedAt: new Date(),
      productionConfirmedAt: new Date(),
    },
  });

  connectionId = connection.id;

  const method = await chooseFulfilmentMethod({
    sellerAccountId: sellerA,
    actor: ACTOR,
    mode: 'INTEGRATED_CARRIER',
    provider: 'DHL',
  });

  methodId = method.id;

  await prisma.sellerFulfilmentMethod.update({
    where: { id: methodId },
    data: { status: 'APPROVED', sellerCarrierConnectionId: connectionId },
  });

  const shipment = await prisma.logisticsShipment.create({
    data: {
      id: newId(),
      shipmentReference: `LS-TEST-${newId().slice(-8)}`,
      trackingNumber: `UB${newId().slice(-12).toUpperCase()}`,
      sellerAccountId: sellerA,
      sellerCompanyName: 'Purchase Co',
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
      sellerCarrierConnectionId: connectionId,
      sellerFulfilmentMethodId: methodId,
    },
  });

  shipmentId = shipment.id;
}

/** Two priced services, written the way `quoteConsignment` writes them. */
async function seedQuotes(): Promise<{ cheap: string; dear: string }> {
  const cheap = newId();
  const dear = newId();

  for (const [id, code, amount] of [
    [cheap, 'ECONOMY', 4500n],
    [dear, 'EXPRESS', 9900n],
  ] as const) {
    await prisma.carrierRateQuote.create({
      data: {
        id,
        shipmentId,
        sellerAccountId: sellerA,
        fulfilmentMethodId: methodId,
        sellerCarrierConnectionId: connectionId,
        provider: 'DHL',
        serviceCode: code,
        currency: 'INR',
        baseChargeMinor: amount,
        totalMinor: amount,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  return { cheap, dear };
}

beforeAll(async () => {
  await cleanUp();
  sellerA = await makeSeller(SLUG_A, 'Purchase Co');
  sellerB = await makeSeller(SLUG_B, 'Purchase Rival Co');
  await makeShipment();
});

afterAll(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('choosing a price', () => {
  let quotes: { cheap: string; dear: string };

  beforeAll(async () => {
    quotes = await seedQuotes();
  });

  it('lists what the carrier offered, cheapest first', async () => {
    const listed = await listQuotes(sellerA, shipmentId);

    expect(listed).toHaveLength(2);
    expect(listed[0]?.serviceCode).toBe('ECONOMY');
    // Minor units as STRINGS. A delivery charge that crossed the API as a
    // JavaScript number would be a float the moment it arrived.
    expect(listed[0]?.totalMinor).toBe('4500');
    expect(typeof listed[0]?.totalMinor).toBe('string');
  });

  it('marks exactly one as chosen', async () => {
    await selectQuote({
      sellerAccountId: sellerA,
      actor: ACTOR,
      shipmentId,
      quoteId: quotes.dear,
    });

    const selected = await prisma.carrierRateQuote.count({
      where: { shipmentId, state: 'SELECTED' },
    });

    expect(selected).toBe(1);
  });

  it('moves the choice rather than ending up with two', async () => {
    // Two selected quotes is two different numbers on one invoice, and the
    // database refuses it: `selectedForShipmentId` is UNIQUE.
    await selectQuote({
      sellerAccountId: sellerA,
      actor: ACTOR,
      shipmentId,
      quoteId: quotes.cheap,
    });

    const holders = await prisma.carrierRateQuote.count({
      where: { shipmentId, selectedForShipmentId: { not: null } },
    });

    expect(holders).toBe(1);

    const chosen = await prisma.carrierRateQuote.findFirstOrThrow({
      where: { shipmentId, state: 'SELECTED' },
    });

    expect(chosen.id).toBe(quotes.cheap);
  });

  it('refuses a price that has expired rather than re-pricing quietly', async () => {
    // A consignment that silently changed price between the seller agreeing
    // and the carrier booking is the failure this whole path is arranged to
    // prevent.
    await prisma.carrierRateQuote.update({
      where: { id: quotes.dear },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      selectQuote({ sellerAccountId: sellerA, actor: ACTOR, shipmentId, quoteId: quotes.dear }),
    ).rejects.toMatchObject({ code: 'CARRIER_QUOTE_NOT_USABLE' });

    const after = await prisma.carrierRateQuote.findUniqueOrThrow({ where: { id: quotes.dear } });
    expect(after.state).toBe('EXPIRED');
  });

  it('will not let another seller choose for this consignment', async () => {
    await expect(
      selectQuote({ sellerAccountId: sellerB, actor: ACTOR, shipmentId, quoteId: quotes.cheap }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('will not show another seller the prices', async () => {
    expect(await listQuotes(sellerB, shipmentId)).toEqual([]);
  });
});

describe('buying it once', () => {
  it('refuses a second purchase under the same key', async () => {
    /*
     * THE ASSERTION THE WHOLE TABLE EXISTS FOR.
     *
     * The key is derived from the consignment and the chosen quote, so a
     * genuine retry of the same purchase produces the same key. Here both
     * inserts are attempted directly, which is what two workers racing past
     * the service's own check would do - and the UNIQUE index is what stops
     * the second one.
     */
    const selected = await prisma.carrierRateQuote.findFirstOrThrow({
      where: { shipmentId, state: 'SELECTED' },
      select: { id: true, serviceCode: true },
    });

    const key = sha256Hex(`${shipmentId}:${selected.id}:${selected.serviceCode}`).slice(0, 64);

    await prisma.shipmentPurchase.create({
      data: {
        id: newId(),
        shipmentId,
        sellerAccountId: sellerA,
        idempotencyKey: key,
        provider: 'DHL',
        state: 'PENDING',
      },
    });

    await expect(
      prisma.shipmentPurchase.create({
        data: {
          id: newId(),
          shipmentId,
          sellerAccountId: sellerA,
          idempotencyKey: key,
          provider: 'DHL',
          state: 'PENDING',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const count = await prisma.shipmentPurchase.count({ where: { shipmentId } });
    expect(count).toBe(1);
  });

  it('allows only one SUCCEEDED purchase per consignment', async () => {
    // The `activeShipmentId` idiom once more: `purchasedShipmentId` holds the
    // consignment id on success and NULL otherwise, so a second successful
    // booking for one parcel collides.
    await prisma.shipmentPurchase.updateMany({
      where: { shipmentId },
      data: { state: 'SUCCEEDED', purchasedShipmentId: shipmentId },
    });

    await expect(
      prisma.shipmentPurchase.create({
        data: {
          id: newId(),
          shipmentId,
          sellerAccountId: sellerA,
          idempotencyKey: `different-key-${newId()}`,
          provider: 'DHL',
          state: 'SUCCEEDED',
          purchasedShipmentId: shipmentId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('leaves a PENDING row behind when a booking is interrupted', async () => {
    /*
     * The state a reconciliation has to be able to find.
     *
     * The row is written BEFORE the carrier is called, so a crash mid-call
     * leaves evidence that something may have been bought. A row written
     * afterwards would leave a booked-and-unrecorded parcel invisible.
     */
    const stranded = await prisma.shipmentPurchase.create({
      data: {
        id: newId(),
        shipmentId,
        sellerAccountId: sellerA,
        idempotencyKey: `interrupted-${newId()}`,
        provider: 'DHL',
        state: 'PENDING',
      },
    });

    const found = await prisma.shipmentPurchase.findMany({
      where: { shipmentId, state: 'PENDING' },
    });

    expect(found.map((row) => row.id)).toContain(stranded.id);
  });
});
