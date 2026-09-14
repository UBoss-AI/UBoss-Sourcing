/**
 * One buyer's order becoming each seller's share of it.
 *
 * This is the seam between the shop and the marketplace, and it is the one
 * place where getting it wrong is expensive in a way nobody notices for a
 * month: a seller packs a box and is paid the wrong amount, or is never told
 * to pack it at all.
 *
 * Five things it has to get right, and each has a case here:
 *
 *   - **A group per seller, and only for seller lines.** The operator's own
 *     stock is most of what most deployments sell and produces no group,
 *     because nobody else is owed anything for it.
 *   - **The money, per seller.** Commission on goods only — not on tax, which
 *     is money passing through to a tax authority, and not on shipping, which
 *     is recovery of a cost.
 *   - **The RATE is stored beside the figure.** Without it a disputed
 *     settlement cannot be recomputed to show it was right.
 *   - **A seller's own rate beats the platform's.** The whole reason the column
 *     is nullable.
 *   - **It is idempotent.** A payment provider will resend a webhook, and a
 *     second confirmation must not produce a second set of groups — or a second
 *     set of order numbers, which would be visible on a seller's paperwork.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { splitOrder } from '../../src/modules/seller/order-split.service.js';

const EMAIL = 'split-buyer@test.local';

let orderId = '';
let productId = '';
let northwindId = '';
let rivalId = '';
let northwindOfferId = '';
let rivalOfferId = '';
let customerProfileId = '';

/**
 * Everything this file made, in an order the foreign keys allow.
 *
 * Orders are ON DELETE RESTRICT from several directions, so the seller rows
 * have to go before the order items they point at, which have to go before the
 * order. Leaving any of it behind breaks the first file of the next run.
 */
async function cleanUp(): Promise<void> {
  await prisma.sellerOrderLine.deleteMany({});
  await prisma.sellerOrderGroup.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.sellerOffer.deleteMany({});
  await prisma.sellerMember.deleteMany({});
  await prisma.sellerAccount.deleteMany({
    where: { slug: { in: ['split-northwind', 'split-rival'] } },
  });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'seller-order:' } } });
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

async function makeSeller(
  slug: string,
  displayName: string,
  commissionBasisPoints: number | null,
): Promise<string> {
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
      commissionBasisPoints,
    },
  });

  return id;
}

async function makeOffer(sellerAccountId: string, sellerSku: string, priceMinor: bigint): Promise<string> {
  const id = newId();

  await prisma.sellerOffer.create({
    data: {
      id,
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku,
      status: 'ACTIVE',
      priceMinor,
      currency: 'INR',
    },
  });

  return id;
}

/**
 * An order with three lines: one from each seller, and one of the operator's.
 *
 * Written directly rather than through checkout. What is under test is the
 * split, and driving a full checkout would make this a test of pricing, tax,
 * reservations and coupons that happens to assert on groups at the end.
 */
async function makeOrder(): Promise<string> {
  const id = newId();

  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-TEST-${Date.now().toString().slice(-6)}`,
      customerProfileId,
      status: 'PENDING_PAYMENT',
      currency: 'INR',
      subtotalMinor: 30_000n,
      discountMinor: 0n,
      taxMinor: 3_600n,
      shippingMinor: 0n,
      grandTotalMinor: 33_600n,
      shippingAddressJson: {},
      billingAddressJson: {},
    },
  });

  const line = (sellerOfferId: string | null, subtotal: bigint, tax: bigint) => ({
    id: newId(),
    orderId: id,
    productId,
    sellerOfferId,
    nameSnapshot: 'Test product',
    skuSnapshot: 'TP-1',
    taxClassCodeSnapshot: 'GST12',
    unitPriceMinor: subtotal,
    quantity: 1,
    lineSubtotalMinor: subtotal,
    taxRatePercent: '12.000000',
    taxAmountMinor: tax,
    lineTotalMinor: subtotal + tax,
  });

  await prisma.orderItem.createMany({
    data: [
      line(northwindOfferId, 10_000n, 1_200n),
      line(rivalOfferId, 10_000n, 1_200n),
      // The operator's own stock. No offer, so no group, so nobody else is owed
      // anything for it.
      line(null, 10_000n, 1_200n),
    ],
  });

  return id;
}

beforeAll(async () => {
  await cleanUp();

  /*
   * The platform rate every seller falls back to unless they have their own.
   *
   * Created where the test database has no business profile at all, rather than
   * only updated: `updateMany` over nothing is a silent no-op, and the
   * fallback case would then pass for the wrong reason — zero commission
   * because there is no rate, not because the fallback works.
   */
  const existingProfile = await prisma.businessProfile.findFirst({ select: { id: true } });

  if (existingProfile === null) {
    await prisma.businessProfile.create({
      data: {
        id: newId(),
        legalName: 'Split Test Operator',
        displayName: 'Split Test',
        supportEmail: 'support@test.local',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        sellerCommissionBasisPoints: 500,
      },
    });
  } else {
    await prisma.businessProfile.update({
      where: { id: existingProfile.id },
      data: { sellerCommissionBasisPoints: 500 },
    });
  }

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST12',
      name: 'GST 12%',
      ratePercent: '12.000000',
      isDefault: true,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Split', slug: 'split-test', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Test product',
      slug: 'split-test-product',
      sku: 'TP-1',
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
    data: { id: newId(), userId: user.id, fullName: 'Split Buyer' },
  });
  customerProfileId = profile.id;

  // Northwind on their own negotiated rate; Rival on the platform's.
  northwindId = await makeSeller('split-northwind', 'Northwind', 250);
  rivalId = await makeSeller('split-rival', 'Rival', null);

  northwindOfferId = await makeOffer(northwindId, 'NW-1', 10_000n);
  rivalOfferId = await makeOffer(rivalId, 'RV-1', 10_000n);

  orderId = await makeOrder();
});

afterAll(async () => {
  await cleanUp();
});

describe('splitOrderToSellers', () => {
  it('creates one group per seller and none for the operator lines', async () => {
    const result = await splitOrder(orderId);

    expect(result.groups).toBe(2);
    expect(result.lines).toBe(2);

    const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId } });
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.sellerAccountId))).toEqual(
      new Set([northwindId, rivalId]),
    );
  });

  it("uses the seller's own commission rate and stores it beside the figure", async () => {
    const northwind = await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId, sellerAccountId: northwindId },
    });

    // 2.50% of ₹100.00 goods.
    expect(northwind.commissionBasisPointsApplied).toBe(250);
    expect(northwind.goodsTotalMinor).toBe(10_000n);
    expect(northwind.commissionMinor).toBe(250n);
    expect(northwind.sellerNetMinor).toBe(9_750n);
  });

  it('falls back to the platform rate for a seller who has none', async () => {
    const rival = await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId, sellerAccountId: rivalId },
    });

    expect(rival.commissionBasisPointsApplied).toBe(500);
    expect(rival.commissionMinor).toBe(500n);
    expect(rival.sellerNetMinor).toBe(9_500n);
  });

  it('takes commission on the goods only, never on the tax', async () => {
    const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId } });

    for (const group of groups) {
      // Tax is carried so the seller can see it, but it is money passing
      // through to a tax authority rather than their revenue. A commission that
      // moved with the buyer's VAT rate would be indefensible.
      expect(group.taxTotalMinor).toBe(1_200n);
      expect(group.sellerNetMinor).toBe(group.goodsTotalMinor - group.commissionMinor);
    }
  });

  it('gives each seller their own order number, starting from one', async () => {
    const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId } });

    // Sequential PER SELLER, so neither leaks how much the marketplace as a
    // whole is selling.
    for (const group of groups) {
      expect(group.sellerOrderNumber).toBe('SO-00001');
    }
  });

  it('starts a group as NEW with no dispatch deadline', async () => {
    const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId } });

    expect(group.status).toBe('NEW');
    // Set when the seller accepts and says where it ships from. Inventing one
    // before there is a location to compute it against marks a seller late
    // against a deadline nobody gave them.
    expect(group.dispatchDueAt).toBeNull();
  });

  it('links each seller line back to the order item it came from', async () => {
    const lines = await prisma.sellerOrderLine.findMany({
      where: { orderGroup: { orderId } },
    });

    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: line.orderItemId } });
      expect(item.sellerOfferId).toBe(line.offerId);
      expect(line.sellerNetMinor).toBe(line.lineTotalMinor - line.commissionMinor - 1_200n);
    }
  });

  it('tells each seller there is an order waiting', async () => {
    const notices = await prisma.sellerNotification.findMany({ where: { kind: 'NEW_ORDER' } });

    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.linkPath?.startsWith('/seller/orders/') === true)).toBe(
      true,
    );
  });

  it('does nothing on a second run, because a webhook will be resent', async () => {
    const before = await prisma.sellerOrderGroup.count({ where: { orderId } });

    const result = await splitOrder(orderId);

    expect(result.groups).toBe(0);
    expect(result.lines).toBe(0);
    expect(await prisma.sellerOrderGroup.count({ where: { orderId } })).toBe(before);
  });

  it('splits an order of only operator stock into nothing at all', async () => {
    const id = newId();

    await prisma.order.create({
      data: {
        id,
        orderNumber: `UB-TEST-OP-${Date.now().toString().slice(-5)}`,
        customerProfileId,
        status: 'PENDING_PAYMENT',
        currency: 'INR',
        subtotalMinor: 10_000n,
        discountMinor: 0n,
        taxMinor: 1_200n,
        shippingMinor: 0n,
        grandTotalMinor: 11_200n,
        shippingAddressJson: {},
        billingAddressJson: {},
      },
    });

    await prisma.orderItem.create({
      data: {
        id: newId(),
        orderId: id,
        productId,
        sellerOfferId: null,
        nameSnapshot: 'Test product',
        skuSnapshot: 'TP-1',
        taxClassCodeSnapshot: 'GST12',
        unitPriceMinor: 10_000n,
        quantity: 1,
        lineSubtotalMinor: 10_000n,
        taxRatePercent: '12.000000',
        taxAmountMinor: 1_200n,
        lineTotalMinor: 11_200n,
      },
    });

    const result = await splitOrder(id);

    expect(result).toEqual({ groups: 0, lines: 0 });
    expect(await prisma.sellerOrderGroup.count({ where: { orderId: id } })).toBe(0);
  });
});
