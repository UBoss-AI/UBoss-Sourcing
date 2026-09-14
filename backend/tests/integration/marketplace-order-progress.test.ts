/**
 * The buyer's order following the sellers who are actually shipping it.
 *
 * On an order made of a seller's goods nobody on the operator's staff picks
 * anything, so the buyer's status has no other source. Without this the order
 * page says "Confirmed - we are getting your order ready" while a courier is
 * carrying the box, and then goes on saying it after the buyer has signed for
 * it.
 *
 * Four things it has to get right, and each has a case here:
 *
 *   - **An order holding any of the operator's own lines is left alone.** Part
 *     of that order is genuinely the warehouse's work, and a status saying
 *     "shipped" while a box is still on their shelf is a lie to the buyer.
 *   - **One seller of two is not a shipped order.** It moves when every group
 *     has, not when the fastest one has.
 *   - **It walks the states rather than jumping.** CONFIRMED to PROCESSING to
 *     SHIPPED to DELIVERED, each written to the history the buyer reads.
 *   - **A cancelled group does not hold the rest back**, and an order with
 *     nothing but cancelled groups is not "shipped" at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { syncOrderWithSellerGroups } from '../../src/modules/seller/order-split.service.js';

const EMAIL = 'progress-buyer@test.local';
const SELLER_SLUGS = ['progress-north', 'progress-south'];

let productId = '';
let customerProfileId = '';
let northId = '';
let southId = '';
let northOfferId = '';
let southOfferId = '';

async function cleanUp(): Promise<void> {
  await prisma.sellerOrderLine.deleteMany({});
  await prisma.sellerOrderGroup.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { in: SELLER_SLUGS } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { in: SELLER_SLUGS } } });
  await prisma.productPrice.deleteMany({ where: { product: { sku: 'PROG-1' } } });
  await prisma.product.deleteMany({ where: { sku: 'PROG-1' } });
  await prisma.category.deleteMany({ where: { slug: 'progress-test' } });
  await prisma.taxClass.deleteMany({ where: { code: 'PROGGST' } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  return id;
}

async function makeOffer(sellerAccountId: string, sellerSku: string): Promise<string> {
  const id = newId();

  await prisma.sellerOffer.create({
    data: {
      id,
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku,
      status: 'ACTIVE',
      priceMinor: 10_000n,
      currency: 'INR',
    },
  });

  return id;
}

/**
 * A confirmed order, with a group per seller line.
 *
 * Written directly rather than driven through checkout and a payment webhook:
 * what is under test is which way the buyer's status moves once the groups
 * exist, and building it through the whole purchase would make this a test of
 * pricing and payments that asserts on a status at the end.
 */
async function makeOrder(offerIds: (string | null)[]): Promise<string> {
  const orderId = newId();

  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-PROG-${newId().slice(-8)}`,
      customerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: BigInt(10_000 * offerIds.length),
      discountMinor: 0n,
      taxMinor: 0n,
      shippingMinor: 0n,
      grandTotalMinor: BigInt(10_000 * offerIds.length),
      shippingAddressJson: {},
      billingAddressJson: {},
      confirmedAt: new Date(),
    },
  });

  for (const sellerOfferId of offerIds) {
    const itemId = newId();

    await prisma.orderItem.create({
      data: {
        id: itemId,
        orderId,
        productId,
        sellerOfferId,
        nameSnapshot: 'Progress product',
        skuSnapshot: 'PROG-1',
        taxClassCodeSnapshot: 'PROGGST',
        unitPriceMinor: 10_000n,
        quantity: 1,
        lineSubtotalMinor: 10_000n,
        taxRatePercent: '0.000000',
        taxAmountMinor: 0n,
        lineTotalMinor: 10_000n,
      },
    });

    if (sellerOfferId === null) continue;

    const offer = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: sellerOfferId },
      select: { sellerAccountId: true },
    });

    const groupId = newId();

    await prisma.sellerOrderGroup.create({
      data: {
        id: groupId,
        sellerAccountId: offer.sellerAccountId,
        orderId,
        sellerOrderNumber: `SO-${newId().slice(-6)}`,
        status: 'NEW',
        currency: 'INR',
        goodsTotalMinor: 10_000n,
        sellerNetMinor: 10_000n,
      },
    });

    await prisma.sellerOrderLine.create({
      data: {
        id: newId(),
        orderGroupId: groupId,
        orderItemId: itemId,
        offerId: sellerOfferId,
        quantity: 1,
        unitPriceMinor: 10_000n,
        lineTotalMinor: 10_000n,
        sellerNetMinor: 10_000n,
        currency: 'INR',
      },
    });
  }

  return orderId;
}

/** Move every group of an order, the way a seller working through it would. */
async function setGroups(orderId: string, status: string): Promise<void> {
  await prisma.sellerOrderGroup.updateMany({
    where: { orderId },
    data: { status: status as never },
  });
}

async function statusOf(orderId: string): Promise<string> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true },
  });

  return order.status;
}

beforeAll(async () => {
  await cleanUp();

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'PROGGST',
      name: 'Progress zero rate',
      ratePercent: '0.000000',
      isDefault: false,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Progress', slug: 'progress-test', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Progress product',
      slug: 'progress-test-product',
      sku: 'PROG-1',
      basePriceMinor: 10_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

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
    data: { id: newId(), userId: user.id, fullName: 'Progress Buyer' },
  });
  customerProfileId = profile.id;

  northId = await makeSeller(SELLER_SLUGS[0] ?? '', 'Progress North');
  southId = await makeSeller(SELLER_SLUGS[1] ?? '', 'Progress South');

  northOfferId = await makeOffer(northId, 'PN-1');
  southOfferId = await makeOffer(southId, 'PS-1');
});

afterAll(async () => {
  await cleanUp();
});

describe('syncOrderWithSellerGroups', () => {
  it('leaves an order alone while the operator still has a line to send', async () => {
    const orderId = await makeOrder([northOfferId, null]);

    await setGroups(orderId, 'SHIPPED');
    await syncOrderWithSellerGroups(orderId);

    // The seller's half has gone; the warehouse's has not. Staff move this one.
    expect(await statusOf(orderId)).toBe('CONFIRMED');
  });

  it('moves to being prepared as soon as one seller starts', async () => {
    const orderId = await makeOrder([northOfferId, southOfferId]);

    await prisma.sellerOrderGroup.updateMany({
      where: { orderId, sellerAccountId: northId },
      data: { status: 'ACCEPTED' },
    });

    await syncOrderWithSellerGroups(orderId);

    expect(await statusOf(orderId)).toBe('PROCESSING');
  });

  it('does not say shipped until every seller has dispatched', async () => {
    const orderId = await makeOrder([northOfferId, southOfferId]);

    await prisma.sellerOrderGroup.updateMany({
      where: { orderId, sellerAccountId: northId },
      data: { status: 'SHIPPED' },
    });

    await syncOrderWithSellerGroups(orderId);

    // One box out of two is not an order that has shipped.
    expect(await statusOf(orderId)).toBe('PROCESSING');

    await prisma.sellerOrderGroup.updateMany({
      where: { orderId, sellerAccountId: southId },
      data: { status: 'SHIPPED' },
    });

    await syncOrderWithSellerGroups(orderId);

    expect(await statusOf(orderId)).toBe('SHIPPED');
  });

  it('writes every step into the history the buyer reads', async () => {
    const orderId = await makeOrder([northOfferId]);

    await setGroups(orderId, 'DELIVERED');
    await syncOrderWithSellerGroups(orderId);

    expect(await statusOf(orderId)).toBe('DELIVERED');

    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: { fromStatus: true, toStatus: true },
    });

    // No jump from CONFIRMED to DELIVERED: support has to be able to read back
    // what happened, and a missing row is a question nobody can answer.
    expect(history.map((entry) => `${entry.fromStatus ?? ''}->${entry.toStatus}`)).toEqual([
      'CONFIRMED->PROCESSING',
      'PROCESSING->SHIPPED',
      'SHIPPED->DELIVERED',
    ]);
  });

  it('ignores a cancelled group and refuses to move an order that is all cancelled', async () => {
    const both = await makeOrder([northOfferId, southOfferId]);

    await prisma.sellerOrderGroup.updateMany({
      where: { orderId: both, sellerAccountId: northId },
      data: { status: 'CANCELLED' },
    });
    await prisma.sellerOrderGroup.updateMany({
      where: { orderId: both, sellerAccountId: southId },
      data: { status: 'SHIPPED' },
    });

    await syncOrderWithSellerGroups(both);

    // The cancelled half is not waited for - the rest of the order has gone.
    expect(await statusOf(both)).toBe('SHIPPED');

    const dead = await makeOrder([northOfferId]);
    await setGroups(dead, 'CANCELLED');
    await syncOrderWithSellerGroups(dead);

    // Cancelling the last group is not the same as shipping it. What happens
    // to this order is the operator's decision, through the refund path.
    expect(await statusOf(dead)).toBe('CONFIRMED');
  });

  it('can be run again without moving anything twice', async () => {
    const orderId = await makeOrder([northOfferId]);

    await setGroups(orderId, 'SHIPPED');
    await syncOrderWithSellerGroups(orderId);
    await syncOrderWithSellerGroups(orderId);

    expect(await statusOf(orderId)).toBe('SHIPPED');

    const history = await prisma.orderStatusHistory.count({ where: { orderId } });
    expect(history).toBe(2);
  });
});
