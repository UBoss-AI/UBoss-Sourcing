/**
 * A seller's stock through one order: held, sent, and counted correctly after.
 *
 * The seller's ledger is the only record of these units - the operator holds
 * none of them - so the two moments that matter are the two where it moves.
 *
 *   - **Accepting is where the hold is taken.** Checkout cannot take it: at
 *     that moment nobody has said which of the seller's buildings the parcel
 *     leaves from, and a reservation with no place cannot be released or
 *     dispatched again. Accepting is the first moment both facts exist.
 *   - **Dispatching turns the hold into a movement**, and never into stock
 *     that quietly reappears.
 *
 * Between them sits the thing that is easy to get wrong and impossible to see:
 * `SellerOffer.availableQuantity` is a cached sum of the location rows, and it
 * is what the storefront, the listings table and the buyer's basket read.
 * Moving a location row without refreshing it keeps the shop selling units
 * that are already promised to somebody, so every case here asserts on both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { recordStockMovement } from '../../src/modules/seller/inventory.service.js';
import { recordShipment, transitionSellerOrder } from '../../src/modules/seller/order.service.js';

const EMAIL = 'fulfil-buyer@test.local';
const SLUG = 'fulfil-north';

let membership: SellerMembership;
let sellerId = '';
let locationId = '';
let offerId = '';
let productId = '';
let customerProfileId = '';
let orderId = '';
let groupId = '';
let lineId = '';
let orderItemId = '';

async function cleanUp(): Promise<void> {
  await prisma.sellerShipment.deleteMany({});
  await prisma.sellerOrderLine.deleteMany({});
  await prisma.sellerOrderGroup.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.sellerInventoryMovement.deleteMany({
    where: { sellerAccount: { slug: SLUG } },
  });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
  await prisma.productPrice.deleteMany({ where: { product: { sku: 'FUL-1' } } });
  await prisma.product.deleteMany({ where: { sku: 'FUL-1' } });
  await prisma.category.deleteMany({ where: { slug: 'fulfil-test' } });
  await prisma.taxClass.deleteMany({ where: { code: 'FULGST' } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

/** What the shop reads, and what the shelf actually holds. */
async function counts(): Promise<{
  offerAvailable: number;
  offerReserved: number;
  locationAvailable: number;
  locationReserved: number;
}> {
  const offer = await prisma.sellerOffer.findUniqueOrThrow({
    where: { id: offerId },
    select: { availableQuantity: true, reservedQuantity: true },
  });

  const row = await prisma.sellerInventory.findUniqueOrThrow({
    where: { offerId_locationId: { offerId, locationId } },
    select: { availableQuantity: true, reservedQuantity: true },
  });

  return {
    offerAvailable: offer.availableQuantity,
    offerReserved: offer.reservedQuantity,
    locationAvailable: row.availableQuantity,
    locationReserved: row.reservedQuantity,
  };
}

beforeAll(async () => {
  await cleanUp();

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'FULGST',
      name: 'Fulfilment zero rate',
      ratePercent: '0.000000',
      isDefault: false,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Fulfilment', slug: 'fulfil-test', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Fulfilment product',
      slug: 'fulfil-test-product',
      sku: 'FUL-1',
      basePriceMinor: 10_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Fulfil North Ltd',
      displayName: 'Fulfil North',
      displayNameNormalized: 'fulfil north',
      slug: SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'DE',
      status: 'APPROVED',
    },
  });
  sellerId = seller.id;

  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      code: 'FUL-1',
      name: 'Fulfil warehouse',
      addressLine1: '1 Test Street',
      city: 'Solingen',
      postcode: '42651',
      countryCode: 'DE',
      timezone: 'Europe/Berlin',
      dispatchCutoff: '16:30',
      workingDaysMask: 31,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });
  locationId = location.id;

  const offer = await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      productId,
      variantKey: '',
      sellerSku: 'FN-1',
      status: 'ACTIVE',
      priceMinor: 10_000n,
      currency: 'INR',
    },
  });
  offerId = offer.id;

  // Built by hand rather than resolved from a session: what is under test is
  // the stock ledger, not the login path.
  membership = {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Fulfil North',
    legalName: 'Fulfil North Ltd',
    slug: SLUG,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'DE',
    logoStorageKey: null,
  };

  // The shelf itself. A movement moves an existing row - the row is created
  // when a listing is approved into an offer, or by the seller's own stock
  // screen - so the fixture creates it empty and receives into it.
  await prisma.sellerInventory.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      offerId,
      locationId,
      availableQuantity: 0,
      reservedQuantity: 0,
    },
  });

  await recordStockMovement({
    membership,
    offerId,
    locationId,
    type: 'RECEIPT',
    quantityDelta: 100,
    reason: 'Opening stock',
  });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: 'x',
      type: 'CUSTOMER',
      status: 'ACTIVE',
    },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Fulfil Buyer' },
  });
  customerProfileId = profile.id;

  orderId = newId();

  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-FUL-${newId().slice(-8)}`,
      customerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 40_000n,
      discountMinor: 0n,
      taxMinor: 0n,
      shippingMinor: 0n,
      grandTotalMinor: 40_000n,
      shippingAddressJson: {},
      billingAddressJson: {},
      confirmedAt: new Date(),
    },
  });

  orderItemId = newId();

  await prisma.orderItem.create({
    data: {
      id: orderItemId,
      orderId,
      productId,
      sellerOfferId: offerId,
      nameSnapshot: 'Fulfilment product',
      skuSnapshot: 'FUL-1',
      taxClassCodeSnapshot: 'FULGST',
      unitPriceMinor: 10_000n,
      quantity: 4,
      lineSubtotalMinor: 40_000n,
      taxRatePercent: '0.000000',
      taxAmountMinor: 0n,
      lineTotalMinor: 40_000n,
    },
  });

  groupId = newId();

  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: `SO-${newId().slice(-6)}`,
      status: 'NEW',
      currency: 'INR',
      goodsTotalMinor: 40_000n,
      sellerNetMinor: 40_000n,
    },
  });

  lineId = newId();

  await prisma.sellerOrderLine.create({
    data: {
      id: lineId,
      orderGroupId: groupId,
      orderItemId,
      offerId,
      quantity: 4,
      unitPriceMinor: 10_000n,
      lineTotalMinor: 40_000n,
      sellerNetMinor: 40_000n,
      currency: 'INR',
    },
  });
});

afterAll(async () => {
  await cleanUp();
});

describe('accepting a marketplace order', () => {
  it('holds the units at the location the seller named, on the shelf and on the offer', async () => {
    const before = await counts();
    expect(before).toEqual({
      offerAvailable: 100,
      offerReserved: 0,
      locationAvailable: 100,
      locationReserved: 0,
    });

    await transitionSellerOrder({ membership, groupId, to: 'ACCEPTED', locationId });

    expect(await counts()).toEqual({
      offerAvailable: 96,
      offerReserved: 4,
      locationAvailable: 96,
      locationReserved: 4,
    });
  });

  it('sets the dispatch deadline from that location', async () => {
    const group = await prisma.sellerOrderGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: { status: true, locationId: true, dispatchDueAt: true },
    });

    expect(group.status).toBe('ACCEPTED');
    expect(group.locationId).toBe(locationId);

    // The figure the overdue list is measured against. Without it the SLA can
    // never be breached and a late order silently never appears.
    expect(group.dispatchDueAt).not.toBeNull();
  });

  it('writes the reservation as a movement, so the ledger still adds up', async () => {
    const movement = await prisma.sellerInventoryMovement.findFirstOrThrow({
      where: { offerId, type: 'RESERVATION' },
      select: { quantityDelta: true, referenceType: true, referenceId: true },
    });

    expect(movement.quantityDelta).toBe(-4);
    expect(movement.referenceType).toBe('order');
    expect(movement.referenceId).toBe(orderId);
  });
});

describe('recording a dispatch', () => {
  it('turns the hold into a dispatch rather than giving the stock back', async () => {
    await recordShipment({
      membership,
      groupId,
      carrierName: 'Blue Dart',
      trackingNumber: 'BD-TEST-1',
      contents: [{ orderItemId, quantity: 4 }],
    });

    // Reserved falls to nothing; available does NOT climb back. The units left
    // the building.
    expect(await counts()).toEqual({
      offerAvailable: 96,
      offerReserved: 0,
      locationAvailable: 96,
      locationReserved: 0,
    });
  });

  it('moves the group to shipped straight from accepted', async () => {
    const group = await prisma.sellerOrderGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: { status: true },
    });

    // "Picking" and "ready to go" are a seller's own note to their staff. A
    // shipment with a carrier and a tracking number is evidence the goods have
    // gone, and refusing it because a bookkeeping step was skipped would leave
    // the buyer with no tracking at all.
    expect(group.status).toBe('SHIPPED');
  });

  it('carries the buyer with it', async () => {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });

    expect(order.status).toBe('SHIPPED');
  });
});
