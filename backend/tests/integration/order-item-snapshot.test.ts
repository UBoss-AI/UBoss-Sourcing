/**
 * What was ordered, frozen at order creation, and shown to the seller.
 *
 * The claims, in order:
 *
 *   - the order's items get a snapshot in the creating transaction: the
 *     product's description and sections, its specifications with the
 *     variant's own values applied, packaging, minimum, carton and container
 *     figures, the options chosen and the buyer's instruction;
 *   - editing, unpublishing or archiving the product afterwards changes none
 *     of it, and capturing again never rewrites it;
 *   - the seller's order page shows it, read only, with the listing to edit;
 *   - an order from before snapshots shows today's listing, labelled so;
 *   - one seller cannot read another seller's part of the same order;
 *   - the page and the invoice / packing list name the same product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { readOrderItemSnapshot } from '../../src/domain/order-item-snapshot.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { captureOrderItemSnapshots } from '../../src/modules/orders/order-item-snapshot.service.js';
import { readSellerOrder } from '../../src/modules/seller/order.service.js';
import { splitOrder } from '../../src/modules/seller/order-split.service.js';

const PREFIX = 'ois-';
const EMAIL = 'ois-buyer@test.local';

let productId = '';
let variantId = '';
let taxClassId = '';
let createdTaxClass = false;
let customerProfileId = '';
let orderId = '';
let legacyOrderId = '';
const sellers: { id: string; offerId: string; membership: SellerMembership }[] = [];

function membershipFor(sellerAccountId: string, slug: string): SellerMembership {
  return {
    sellerAccountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: slug,
    legalName: slug,
    slug,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

async function cleanUp(): Promise<void> {
  const orders = await prisma.order.findMany({ where: { customerProfile: { user: { emailNormalized: EMAIL } } }, select: { id: true } });
  const orderIds = orders.map((order) => order.id);
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: { in: orderIds } } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItemPackaging.deleteMany({ where: { orderItem: { orderId: { in: orderIds } } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.productVariant.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  if (createdTaxClass) await prisma.taxClass.deleteMany({ where: { code: 'OIS-GST' } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

async function makeOrder(options: { capture: boolean }): Promise<string> {
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.order.create({
      data: {
        id,
        orderNumber: `OIS-${id.slice(-8)}`,
        customerProfileId,
        status: 'PENDING_PAYMENT',
        currency: 'INR',
        subtotalMinor: 20_000n,
        discountMinor: 0n,
        taxMinor: 0n,
        shippingMinor: 0n,
        grandTotalMinor: 20_000n,
        shippingAddressJson: {},
        billingAddressJson: {},
      },
    });
    const item = (sellerIndex: number, withVariant: boolean) => ({
      id: newId(),
      orderId: id,
      productId,
      variantId: withVariant ? variantId : null,
      sellerOfferId: sellers[sellerIndex]?.offerId ?? null,
      nameSnapshot: 'Stainless Steel Bottle',
      skuSnapshot: 'OIS-BTL',
      variantNameSnapshot: withVariant ? '1 litre' : null,
      taxClassCodeSnapshot: 'OIS-GST',
      unitPriceMinor: 10_000n,
      quantity: 48,
      orderingUnit: 'CARTON' as const,
      unitQuantity: 2,
      piecesPerUnitSnapshot: 24,
      noteSnapshot: sellerIndex === 0 ? 'Laser-engrave our logo on the lid' : null,
      lineSubtotalMinor: 10_000n,
      taxRatePercent: '0.000000',
      taxAmountMinor: 0n,
      lineTotalMinor: 10_000n,
    });
    await tx.orderItem.createMany({ data: [item(0, true), item(1, false)] });
    if (options.capture) await captureOrderItemSnapshots(tx, id);
  });
  await splitOrder(id);
  return id;
}

async function groupOf(order: string, sellerIndex: number): Promise<string> {
  const group = await prisma.sellerOrderGroup.findFirstOrThrow({
    where: { orderId: order, sellerAccountId: sellers[sellerIndex]?.id ?? '' },
    select: { id: true },
  });
  return group.id;
}

beforeAll(async () => {
  await cleanUp();
  const tax = await prisma.taxClass.findFirst({ select: { id: true } });
  if (tax === null) {
    taxClassId = newId();
    createdTaxClass = true;
    await prisma.taxClass.create({ data: { id: taxClassId, code: 'OIS-GST', name: 'OIS', ratePercent: '0.000000', isActive: true } });
  } else {
    taxClassId = tax.id;
  }
  const category = await prisma.category.create({ data: { id: newId(), name: 'OIS', slug: `${PREFIX}category`, isActive: true } });
  productId = newId();
  await prisma.product.create({
    data: {
      id: productId,
      categoryId: category.id,
      taxClassId,
      name: 'Stainless Steel Bottle',
      slug: `${PREFIX}bottle`,
      sku: 'OIS-BTL',
      description: 'Keeps drinks cold.',
      basePriceMinor: 10_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      isMarketplaceProduct: true,
      piecesPerCarton: 24,
      minOrderQty: 1,
      qtyIncrement: 1,
      attributes: {
        create: [
          { id: newId(), name: 'Capacity', value: '750', unit: 'ml', groupKey: 'TECHNICAL', sortOrder: 0, isHighlight: true },
          { id: newId(), name: 'Material', value: '18/8 stainless steel', groupKey: 'MATERIAL', sortOrder: 1 },
        ],
      },
      descriptionSections: { create: [{ id: newId(), heading: 'Overview', body: 'Double-walled.', sortOrder: 0 }] },
    },
  });
  variantId = newId();
  await prisma.productVariant.create({
    data: {
      id: variantId,
      productId,
      name: '1 litre',
      sku: 'OIS-BTL-1L',
      optionsJson: { capacity: '1 litre' },
      optionSignature: 'capacity=1 litre',
      attributes: { create: [{ id: newId(), name: 'Capacity', value: '1000', unit: 'ml', sortOrder: 0 }] },
    },
  });

  for (const slug of [`${PREFIX}acme`, `${PREFIX}rival`]) {
    const id = newId();
    await prisma.sellerAccount.create({
      data: { id, legalName: slug, displayName: slug, displayNameNormalized: slug, slug, kind: 'WHOLESALER', registrationCountry: 'IN', status: 'APPROVED' },
    });
    const offerId = newId();
    await prisma.sellerOffer.create({
      data: { id: offerId, sellerAccountId: id, productId, variantKey: slug.endsWith('acme') ? variantId : '', ...(slug.endsWith('acme') ? { variantId } : {}), sellerSku: `${slug}-SKU`, status: 'ACTIVE', priceMinor: 10_000n, currency: 'INR', minimumOrderQuantity: 24 },
    });
    sellers.push({ id, offerId, membership: membershipFor(id, slug) });
  }

  const user = await prisma.user.create({ data: { id: newId(), email: EMAIL, emailNormalized: EMAIL, passwordHash: 'x', type: 'CUSTOMER', status: 'ACTIVE' } });
  customerProfileId = (await prisma.customerProfile.create({ data: { id: newId(), userId: user.id, fullName: 'OIS Buyer' } })).id;

  orderId = await makeOrder({ capture: true });
  legacyOrderId = await makeOrder({ capture: false });
});

afterAll(async () => {
  await cleanUp();
});

describe('the snapshot taken when the order is created', () => {
  it('holds the description, specifications with the variant’s values, packaging and selections', async () => {
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId, variantId }, select: { productInfoSnapshotJson: true, productInfoCapturedAt: true } });
    const snapshot = readOrderItemSnapshot(item.productInfoSnapshotJson);
    expect(snapshot).not.toBeNull();
    expect(item.productInfoCapturedAt).not.toBeNull();
    expect(snapshot?.description.sections).toEqual([{ heading: 'Overview', body: 'Double-walled.' }]);
    const technical = snapshot?.specificationGroups.find((group) => group.group === 'TECHNICAL');
    expect(technical?.rows[0]).toMatchObject({ label: 'Capacity', value: '1000', unit: 'ml' });
    expect(snapshot?.selectedOptions).toEqual([{ name: 'capacity', value: '1 litre' }]);
    expect(snapshot?.packaging).toMatchObject({ orderingUnit: 'CARTON', unitQuantity: 2, piecesPerUnit: 24, equivalentPieces: 48 });
    expect(snapshot?.moqPieces).toBe(24);
    expect(snapshot?.piecesPerCarton).toBe(24);
    expect(snapshot?.specialInstructions).toBe('Laser-engrave our logo on the lid');
    // Nothing of what the buyer was charged.
    expect(JSON.stringify(snapshot)).not.toMatch(/Minor|price/i);
  });

  it('does not change when the product changes, is unpublished or archived, or capture runs again', async () => {
    const before = (await prisma.orderItem.findFirstOrThrow({ where: { orderId, variantId }, select: { productInfoSnapshotJson: true } })).productInfoSnapshotJson;
    await prisma.productAttribute.updateMany({ where: { productId, name: 'Material' }, data: { value: 'Plastic' } });
    await prisma.productVariantAttribute.updateMany({ where: { variantId }, data: { value: '2000' } });
    await prisma.productDescriptionSection.updateMany({ where: { productId }, data: { body: 'Rewritten.' } });
    await prisma.product.update({ where: { id: productId }, data: { name: 'Renamed bottle', isPublished: false, archivedAt: new Date() } });
    await prisma.$transaction((tx) => captureOrderItemSnapshots(tx, orderId));
    const after = (await prisma.orderItem.findFirstOrThrow({ where: { orderId, variantId }, select: { productInfoSnapshotJson: true } })).productInfoSnapshotJson;
    expect(after).toEqual(before);
  });
});

describe('the seller’s order page', () => {
  it('shows the seller their line’s snapshot, read only, with the listing to edit', async () => {
    const order = await readSellerOrder(sellers[0]?.membership as SellerMembership, await groupOf(orderId, 0));
    expect(order.lines).toHaveLength(1);
    const line = order.lines[0];
    expect(line?.productInfo.source).toBe('SNAPSHOT');
    const material = line?.productInfo.info?.specificationGroups.find((group) => group.group === 'MATERIAL');
    // What was sold, not what the listing says after the edit above.
    expect(material?.rows[0]?.value).toBe('18/8 stainless steel');
    expect(line?.productInfo.info?.productName).toBe('Stainless Steel Bottle');
    expect(line?.offerId).toBe(sellers[0]?.offerId);
  });

  it('shows an order from before snapshots today’s listing, labelled as such', async () => {
    const order = await readSellerOrder(sellers[1]?.membership as SellerMembership, await groupOf(legacyOrderId, 1));
    expect(order.lines[0]?.productInfo.source).toBe('CURRENT_LISTING');
    expect(order.lines[0]?.productInfo.info?.description.sections[0]?.body).toBe('Rewritten.');
    // Nothing was written back to the order: the fallback is never stored.
    const stored = await prisma.orderItem.findFirstOrThrow({ where: { orderId: legacyOrderId, variantId: null }, select: { productInfoSnapshotJson: true } });
    expect(stored.productInfoSnapshotJson).toBeNull();
  });

  it('shows each seller only their own part of a shared order', async () => {
    const acme = await readSellerOrder(sellers[0]?.membership as SellerMembership, await groupOf(orderId, 0));
    const rival = await readSellerOrder(sellers[1]?.membership as SellerMembership, await groupOf(orderId, 1));
    expect(acme.lines.map((line) => line.offerId)).toEqual([sellers[0]?.offerId]);
    expect(rival.lines.map((line) => line.offerId)).toEqual([sellers[1]?.offerId]);
    // Rival's instruction-free, variant-free line - not Acme's engraving or capacity.
    expect(rival.lines[0]?.productInfo.info?.specialInstructions).toBeNull();
    await expect(
      readSellerOrder(sellers[1]?.membership as SellerMembership, await groupOf(orderId, 0)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('names the product exactly as the invoice and packing list do', async () => {
    // The documents name a line from nameSnapshot, variantNameSnapshot,
    // skuSnapshot and quantity (documents.service, packing-list.service).
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { nameSnapshot: true, variantNameSnapshot: true, skuSnapshot: true, quantity: true, productInfoSnapshotJson: true },
    });
    for (const item of items) {
      const snapshot = readOrderItemSnapshot(item.productInfoSnapshotJson);
      expect(snapshot?.productName).toBe(item.nameSnapshot);
      expect(snapshot?.variantName).toBe(item.variantNameSnapshot);
      expect(snapshot?.sku).toBe(item.skuSnapshot);
      expect(snapshot?.packaging.equivalentPieces).toBe(item.quantity);
    }
  });
});
