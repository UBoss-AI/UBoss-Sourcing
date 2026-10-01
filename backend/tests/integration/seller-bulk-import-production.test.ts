/**
 * Master rows 37, 40 and 22.
 *
 *   37 - a seller's bulk update previews every problem and change, applies only
 *        to their own listings, refuses a file with problems, applies once;
 *   40 - production milestones go in order, exceptions carry a reason, and
 *        neither changes the seller order's or the buyer order's status;
 *   22 - the buyer's timeline combines production, inspection, shipments,
 *        documents and payment, never shows the seller's internal notes, and
 *        is scoped to the buyer who owns the order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { resolveSellerMembership, type SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  applySellerImport,
  createSellerImportDryRun,
  readSellerImport,
} from '../../src/modules/seller/bulk-import.service.js';
import { transitionSellerOrder } from '../../src/modules/seller/order.service.js';
import { splitOrder } from '../../src/modules/seller/order-split.service.js';
import {
  completeMilestone,
  planMilestone,
  raiseDelay,
  readProduction,
  resolveDelay,
} from '../../src/modules/seller/production.service.js';
import { readBuyerOrderMilestones } from '../../src/modules/orders/order-milestones.service.js';

const P = 'm37';
const SLUGS = [`${P}-seller`, `${P}-other`];
const EMAILS = [`${P}-owner@test.local`, `${P}-other@test.local`, `${P}-buyer@test.local`];
const ORDER_NUMBER = 'UB-M37-000001';

let app: Awaited<ReturnType<typeof buildApp>>;
let seller: SellerMembership;
let offerA = '';
let offerB = '';
let otherOffer = '';
let locationId = '';
let groupId = '';
let orderId = '';
let buyerProfileId = '';

async function cleanUp(): Promise<void> {
  const sellerIds = (await prisma.sellerAccount.findMany({ where: { slug: { in: SLUGS } }, select: { id: true } })).map(
    (row) => row.id,
  );
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: EMAILS } }, select: { id: true } })).map(
    (row) => row.id,
  );
  // Accepting the seller order raises its shipment. Left behind, it outlives the
  // order (the link is SET NULL) and a later file that restarts the shipment
  // sequence collides with its reference.
  const shipments = (
    await prisma.logisticsShipment.findMany({ where: { sellerAccountId: { in: sellerIds } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipments } } });
  const order = await prisma.order.findFirst({ where: { orderNumber: ORDER_NUMBER }, select: { id: true } });
  if (order !== null) {
    await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: order.id } } });
    await prisma.sellerOrderGroup.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: order.id } });
    await prisma.order.deleteMany({ where: { id: order.id } });
  }
  await prisma.sellerInventoryMovement.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerBulkImportJob.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: `${P}-product` } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: `${P}-product` } } });
  await prisma.category.deleteMany({ where: { slug: `${P}-category` } });
  await prisma.taxClass.deleteMany({ where: { code: 'M37' } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function customer(email: string, name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { id: newId(), type: 'CUSTOMER', email, emailNormalized: email, passwordHash: 'x', status: 'ACTIVE' },
  });
  return (await prisma.customerProfile.create({ data: { id: newId(), userId: user.id, fullName: name } })).id;
}

async function sellerAccount(slug: string, name: string, ownerProfileId: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      slug,
      legalName: `${name} Ltd`,
      displayName: name,
      displayNameNormalized: name.toLowerCase(),
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId: id, customerProfileId: ownerProfileId, role: 'OWNER' },
  });
  return id;
}

function csv(lines: string[]): Buffer {
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: 'M37', name: 'M37', ratePercent: '0.000000', isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'M37', slug: `${P}-category`, isActive: true },
  });
  const product = async (n: number): Promise<string> =>
    (
      await prisma.product.create({
        data: {
          id: newId(),
          categoryId: category.id,
          taxClassId: taxClass.id,
          name: `M37 product ${String(n)}`,
          slug: `${P}-product-${String(n)}`,
          sku: `M37-P${String(n)}`,
          basePriceMinor: 10_000n,
          currency: 'INR',
          status: 'ACTIVE',
          isPublished: true,
          publishedAt: new Date(),
          isStockTracked: false,
          minOrderQty: 1,
          qtyIncrement: 1,
        },
      })
    ).id;
  const [p1, p2, p3] = [await product(1), await product(2), await product(3)];

  const ownerProfile = await customer(EMAILS[0] ?? '', 'M37 Owner');
  const otherProfile = await customer(EMAILS[1] ?? '', 'M37 Other');
  buyerProfileId = await customer(EMAILS[2] ?? '', 'M37 Buyer');
  const sellerId = await sellerAccount(SLUGS[0] ?? '', 'M37 Seller', ownerProfile);
  const otherId = await sellerAccount(SLUGS[1] ?? '', 'M37 Other', otherProfile);

  const offer = async (sellerAccountId: string, productId: string, sku: string): Promise<string> =>
    (
      await prisma.sellerOffer.create({
        data: {
          id: newId(),
          sellerAccountId,
          productId,
          variantKey: '',
          sellerSku: sku,
          status: 'ACTIVE',
          priceMinor: 10_000n,
          currency: 'INR',
        },
      })
    ).id;
  offerA = await offer(sellerId, p1, 'M37-A');
  offerB = await offer(sellerId, p2, 'M37-B');
  otherOffer = await offer(otherId, p3, 'M37-OTHER');

  locationId = (
    await prisma.sellerLocation.create({
      data: {
        id: newId(),
        sellerAccountId: sellerId,
        code: 'WH1',
        name: 'Main',
        addressLine1: '1 Road',
        city: 'Pune',
        postcode: '411001',
        countryCode: 'IN',
      },
    })
  ).id;

  // Stock rows exist once a listing is approved for a place; B has none.
  await prisma.sellerInventory.create({
    data: { id: newId(), sellerAccountId: sellerId, offerId: offerA, locationId, availableQuantity: 0 },
  });

  seller = await resolveSellerMembership(ownerProfile);

  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: ORDER_NUMBER,
      customerProfileId: buyerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 10_000n,
      grandTotalMinor: 10_000n,
      paidMinor: 10_000n,
      placedAt: new Date(Date.now() - 60_000),
      confirmedAt: new Date(Date.now() - 30_000),
      shippingAddressJson: { line1: '1 Test Road', city: 'Pune', postalCode: '411001', countryCode: 'IN' },
      billingAddressJson: { line1: '1 Test Road', city: 'Pune', postalCode: '411001', countryCode: 'IN' },
    },
  });
  await prisma.orderItem.create({
    data: {
      id: newId(),
      orderId,
      productId: p1,
      sellerOfferId: offerA,
      nameSnapshot: 'M37 product 1',
      skuSnapshot: 'M37-P1',
      taxClassCodeSnapshot: 'M37',
      unitPriceMinor: 10_000n,
      quantity: 1,
      lineSubtotalMinor: 10_000n,
      taxRatePercent: '0.000000',
      taxAmountMinor: 0n,
      lineTotalMinor: 10_000n,
    },
  });
  await splitOrder(orderId);
  groupId = (await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId }, select: { id: true } })).id;
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('Master row 37 - seller bulk update', () => {
  it('previews problems, refuses to apply them, and never touches another seller', async () => {
    const jobId = await createSellerImportDryRun(seller, {
      fileName: 'bad.csv',
      content: csv([
        'seller_sku,price,location_code,available_quantity',
        'M37-OTHER,50.00,,',
        'M37-A,12.345,,',
        'M37-A,1,,',
        'M37-B,,WH1,5',
      ]),
    });
    const view = await readSellerImport(seller, jobId);
    expect(view.errors.map((e) => e.code).sort()).toEqual([
      'DUPLICATE',
      'INVALID_PRICE',
      'NOT_STOCKED_HERE',
      'UNKNOWN_SKU',
    ]);
    expect(view.preview).toBeNull();

    await expect(applySellerImport(seller, jobId)).rejects.toMatchObject({ code: 'BULK_IMPORT_NOT_APPLICABLE' });
    const other = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: otherOffer } });
    expect(other.priceMinor).toBe(10_000n);
  });

  it('applies price, stock and status to the seller own listings, once', async () => {
    const jobId = await createSellerImportDryRun(seller, {
      fileName: 'good.csv',
      content: csv([
        'SKU,Price,Minimum Order Quantity,Status,Location Code,Available Quantity',
        'm37-a,125.50,2,,WH1,40',
        'M37-B,,,PAUSED,,',
      ]),
    });
    const preview = await readSellerImport(seller, jobId);
    expect(preview.errors).toEqual([]);
    expect(preview.preview?.changes).toHaveLength(2);
    expect(preview.preview?.changes[0]).toMatchObject({
      sellerSku: 'M37-A',
      price: { from: '100.00', to: '125.50' },
      minimumOrderQuantity: { from: 1, to: 2 },
      stock: { locationCode: 'WH1', from: 0, to: 40 },
    });
    // The preview changed nothing.
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerA } })).priceMinor).toBe(10_000n);

    const appliedId = await applySellerImport(seller, jobId);
    const applied = await readSellerImport(seller, appliedId);
    expect(applied.job).toMatchObject({ isDryRun: false, status: 'SUCCEEDED', updatedRows: 2 });

    const a = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerA } });
    expect(a.priceMinor).toBe(12_550n);
    expect(a.minimumOrderQuantity).toBe(2);
    const stock = await prisma.sellerInventory.findFirstOrThrow({ where: { offerId: offerA, locationId } });
    expect(stock.availableQuantity).toBe(40);
    expect(await prisma.sellerInventoryMovement.count({ where: { offerId: offerA, referenceId: appliedId } })).toBe(1);
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerB } })).status).toBe('PAUSED');

    await expect(applySellerImport(seller, jobId)).rejects.toMatchObject({ code: 'BULK_IMPORT_NOT_APPLICABLE' });
  });
});

describe('Master rows 40 and 22 - production milestones and the buyer timeline', () => {
  it('refuses production before the order is accepted', async () => {
    await expect(
      completeMilestone({ membership: seller, groupId, stage: 'RAW_MATERIAL' }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_MILESTONE_NOT_ALLOWED' });
  });

  it('records stages in order, raises and resolves an exception, and changes no status', async () => {
    await transitionSellerOrder({ membership: seller, groupId, to: 'ACCEPTED', locationId });
    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });

    await expect(
      completeMilestone({ membership: seller, groupId, stage: 'IN_PRODUCTION' }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_MILESTONE_NOT_ALLOWED' });

    await completeMilestone({
      membership: seller,
      groupId,
      stage: 'RAW_MATERIAL',
      internalNote: 'SECRET-SUPPLIER-NOTE',
      buyerNote: 'Steel has arrived.',
    });
    await expect(
      completeMilestone({ membership: seller, groupId, stage: 'RAW_MATERIAL' }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_MILESTONE_NOT_ALLOWED' });

    await planMilestone({ membership: seller, groupId, stage: 'READY', plannedFor: '2026-11-20' });
    const { delayId } = await raiseDelay({
      membership: seller,
      groupId,
      stage: 'IN_PRODUCTION',
      reason: 'MACHINE_BREAKDOWN',
      revisedDate: '2026-11-10',
      detail: 'SECRET-PRESS-3-DOWN',
      buyerMessage: 'A press is being repaired.',
    });

    const view = await readProduction(seller, groupId);
    expect(view.nextStage).toBe('IN_PRODUCTION');
    expect(view.delays[0]).toMatchObject({ id: delayId, reason: 'MACHINE_BREAKDOWN', resolvedAt: null });

    // The buyer, mid-exception.
    const scope = { customerProfileId: buyerProfileId, buyerCompanyId: null };
    const timeline = await readBuyerOrderMilestones(scope, orderId);
    const part = timeline.sellers[0];
    expect(part?.production.stages[0]).toMatchObject({ stage: 'RAW_MATERIAL', note: 'Steel has arrived.' });
    expect(part?.production.stages[3]).toMatchObject({ stage: 'READY', plannedFor: '2026-11-20' });
    expect(part?.production.openDelays).toHaveLength(1);
    expect(timeline.payment.state).toBe('PAID');
    expect(timeline.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['ORDER_PLACED', 'PAYMENT_CONFIRMED', 'MILESTONE_REACHED', 'DELAY_RAISED']),
    );
    const text = JSON.stringify(timeline);
    expect(text).not.toContain('SECRET-SUPPLIER-NOTE');
    expect(text).not.toContain('SECRET-PRESS-3-DOWN');

    await resolveDelay({ membership: seller, groupId, delayId, resolutionNote: 'Press fixed.' });
    await completeMilestone({ membership: seller, groupId, stage: 'IN_PRODUCTION' });
    expect((await readBuyerOrderMilestones(scope, orderId)).sellers[0]?.production.openDelays).toEqual([]);

    // Neither the seller order nor the buyer order moved.
    const group = await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: groupId }, select: { status: true } });
    expect(group.status).toBe('ACCEPTED');
    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    expect(after.status).toBe(before.status);
  });

  it('is invisible to another buyer and to another seller', async () => {
    const strangerScope = { customerProfileId: newId(), buyerCompanyId: null };
    await expect(readBuyerOrderMilestones(strangerScope, orderId)).rejects.toMatchObject({ statusCode: 404 });

    const otherProfile = (await prisma.customerProfile.findFirstOrThrow({
      where: { user: { emailNormalized: EMAILS[1] } },
      select: { id: true },
    })).id;
    const other = await resolveSellerMembership(otherProfile);
    await expect(readProduction(other, groupId)).rejects.toBeTruthy();
    await expect(
      completeMilestone({ membership: other, groupId, stage: 'QUALITY_CHECKED' }),
    ).rejects.toBeTruthy();
  });

  it('answers the buyer route only when signed in', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}/milestones` });
    expect(response.statusCode).toBe(401);
    const sellerRoute = await app.inject({ method: 'GET', url: `/api/v1/seller/orders/${groupId}/production` });
    expect(sellerRoute.statusCode).toBe(401);
  });
});
