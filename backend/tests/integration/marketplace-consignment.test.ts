/**
 * Raising a carrier consignment for an order a SELLER is fulfilling.
 *
 * A seller's goods leave the seller's building. Reading the operator's own
 * warehouse as the origin made a marketplace order impossible to put on a
 * carrier at all - an order made entirely of sellers' lines has no warehouse
 * of the operator's, so the whole order was refused and the buyer's delivery
 * never reached the assignment queue.
 *
 * Four things this has to get right, and each has a case here:
 *
 *   - **A seller's consignment is collected from the seller.** Their address,
 *     their contact, and no operator warehouse pointed at.
 *   - **An order carrying both raises one of each.** Two buildings, two
 *     collections; a single consignment covering both is one nobody can
 *     collect.
 *   - **A seller who has not said where it ships from holds nobody else up.**
 *     Theirs waits for their acceptance; everybody else's is raised.
 *   - **It is idempotent.** A payment provider will resend a webhook, and the
 *     second delivery must not raise a second consignment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { createShipmentsForOrder } from '../../src/modules/logistics/shipment-create.service.js';

const EMAIL = 'consignment-buyer@test.local';
const SELLER_SLUGS = ['consignment-northwind', 'consignment-rival'];
const WAREHOUSE_CODE = 'CONSIGN-WH';

let customerProfileId = '';
let productId = '';
let warehouseId = '';

/** Northwind: one pickup place, so there is never any doubt where it leaves. */
let northwindId = '';
let northwindOfferId = '';
/** Rival: two places and no acceptance, so nobody knows where it leaves from. */
let rivalId = '';
let rivalOfferId = '';

const DELIVERY = {
  line1: '42 Hospital Road',
  city: 'Pune',
  region: 'Maharashtra',
  postalCode: '411057',
  countryCode: 'IN',
};

/**
 * Everything this file made, in an order the foreign keys allow.
 *
 * Orders are ON DELETE RESTRICT from several directions and a consignment
 * points at both the order and the seller group, so the logistics rows go
 * first. Leaving any of it behind breaks the first file of the next run.
 */
async function cleanUp(): Promise<void> {
  const shipmentIds = (
    await prisma.logisticsShipment.findMany({ select: { id: true } })
  ).map((shipment) => shipment.id);

  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });

  await prisma.sellerOrderLine.deleteMany({});
  await prisma.sellerOrderGroup.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.sellerOffer.deleteMany({});
  await prisma.sellerLocation.deleteMany({});
  await prisma.sellerMember.deleteMany({});
  await prisma.sellerAccount.deleteMany({ where: { slug: { in: SELLER_SLUGS } } });
  await prisma.numberSequence.deleteMany({
    where: { key: { startsWith: 'logistics-shipment:' } },
  });
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({ where: { code: WAREHOUSE_CODE } });
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

async function makeSellerLocation(
  sellerAccountId: string,
  code: string,
  name: string,
  city: string,
): Promise<string> {
  const id = newId();

  await prisma.sellerLocation.create({
    data: {
      id,
      sellerAccountId,
      code,
      name,
      addressLine1: `1 ${city} Industrial Estate`,
      city,
      region: 'Karnataka',
      postcode: '560058',
      countryCode: 'IN',
      isPickupLocation: true,
      isOperational: true,
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
 * An order and its seller groups, written directly.
 *
 * What is under test is where a consignment is collected from, and driving a
 * checkout and a payment to get there would make this a test of pricing, tax
 * and webhooks that asserts on an address at the end.
 */
async function makeOrder(input: {
  offerIds: (string | null)[];
  /** The operator's warehouse, on an order that has lines of theirs. */
  fulfilmentLocationId?: string | null;
  /** Which sellers get a group, and where each says it ships from. */
  groups: { sellerAccountId: string; locationId?: string | null }[];
}): Promise<string> {
  const id = newId();

  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-CONSIGN-${newId().slice(-8)}`,
      customerProfileId,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 10_000n,
      discountMinor: 0n,
      taxMinor: 1_200n,
      shippingMinor: 0n,
      grandTotalMinor: 11_200n,
      shippingAddressJson: DELIVERY,
      billingAddressJson: DELIVERY,
      fulfilmentLocationId: input.fulfilmentLocationId ?? null,
    },
  });

  await prisma.orderItem.createMany({
    data: input.offerIds.map((sellerOfferId) => ({
      id: newId(),
      orderId: id,
      productId,
      sellerOfferId,
      nameSnapshot: 'Test product',
      skuSnapshot: 'TP-1',
      taxClassCodeSnapshot: 'GST12',
      unitPriceMinor: 10_000n,
      quantity: 1,
      lineSubtotalMinor: 10_000n,
      taxRatePercent: '12.000000',
      taxAmountMinor: 1_200n,
      lineTotalMinor: 11_200n,
    })),
  });

  for (const [index, group] of input.groups.entries()) {
    await prisma.sellerOrderGroup.create({
      data: {
        id: newId(),
        sellerAccountId: group.sellerAccountId,
        orderId: id,
        sellerOrderNumber: `SO-${newId().slice(-6)}-${String(index)}`,
        status: 'NEW',
        currency: 'INR',
        locationId: group.locationId ?? null,
      },
    });
  }

  return id;
}

beforeAll(async () => {
  await cleanUp();

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
    data: { id: newId(), name: 'Consignment', slug: 'consignment-test', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Test product',
      slug: 'consignment-test-product',
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

  const warehouse = await prisma.inventoryLocation.create({
    data: {
      id: newId(),
      code: WAREHOUSE_CODE,
      name: 'Consignment warehouse',
      countryCode: 'IN',
      addressJson: {
        line1: '7 Warehouse Way',
        city: 'Bengaluru',
        postalCode: '560058',
        countryCode: 'IN',
      },
    },
  });
  warehouseId = warehouse.id;

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
    data: {
      id: newId(),
      userId: user.id,
      fullName: 'Consignment Buyer',
      organization: 'Pune General Hospital',
    },
  });
  customerProfileId = profile.id;

  northwindId = await makeSeller(SELLER_SLUGS[0] ?? '', 'Northwind');
  await makeSellerLocation(northwindId, 'NW-1', 'Peenya works', 'Bengaluru');
  northwindOfferId = await makeOffer(northwindId, 'NW-1');

  rivalId = await makeSeller(SELLER_SLUGS[1] ?? '', 'Rival');
  await makeSellerLocation(rivalId, 'RV-1', 'Chakan works', 'Pune');
  await makeSellerLocation(rivalId, 'RV-2', 'Chakan depot', 'Pune');
  rivalOfferId = await makeOffer(rivalId, 'RV-1');
});

afterAll(async () => {
  await cleanUp();
});

describe('createShipmentsForOrder', () => {
  it("collects a seller's order from the seller's own place, not a warehouse", async () => {
    const orderId = await makeOrder({
      offerIds: [northwindOfferId],
      groups: [{ sellerAccountId: northwindId }],
    });

    const created = await createShipmentsForOrder(orderId, null);
    expect(created).toHaveLength(1);

    const consignment = await prisma.logisticsShipment.findFirstOrThrow({ where: { orderId } });

    expect(consignment.sellerCompanyName).toBe('Northwind');
    // No operator warehouse behind it: the goods are in the seller's building.
    expect(consignment.originLocationId).toBeNull();
    expect(consignment.pickupContactName).toBe('Peenya works');
    expect(consignment.pickupAddressJson).toMatchObject({
      line1: '1 Bengaluru Industrial Estate',
      city: 'Bengaluru',
      countryCode: 'IN',
    });
    // And it is addressed to the buyer's business, in their words.
    expect(consignment.receivingCompanyName).toBe('Pune General Hospital');
    expect(consignment.destinationPostalCode).toBe('411057');
  });

  it('raises one for the operator and one for the seller on an order carrying both', async () => {
    const orderId = await makeOrder({
      offerIds: [northwindOfferId, null],
      fulfilmentLocationId: warehouseId,
      groups: [{ sellerAccountId: northwindId }],
    });

    const created = await createShipmentsForOrder(orderId, null);
    expect(created).toHaveLength(2);

    const consignments = await prisma.logisticsShipment.findMany({
      where: { orderId },
      select: { originLocationId: true, sellerAccountId: true, pickupAddressJson: true },
    });

    const operator = consignments.find((row) => row.sellerAccountId === null);
    const seller = consignments.find((row) => row.sellerAccountId === northwindId);

    expect(operator?.originLocationId).toBe(warehouseId);
    expect(operator?.pickupAddressJson).toMatchObject({ line1: '7 Warehouse Way' });
    expect(seller?.originLocationId).toBeNull();
    expect(seller?.pickupAddressJson).toMatchObject({ line1: '1 Bengaluru Industrial Estate' });
  });

  it('holds nobody else up for a seller who has not said where it ships from', async () => {
    const orderId = await makeOrder({
      offerIds: [northwindOfferId, rivalOfferId],
      groups: [{ sellerAccountId: northwindId }, { sellerAccountId: rivalId }],
    });

    const created = await createShipmentsForOrder(orderId, null);

    // Rival has two places and has accepted nothing, so theirs waits.
    expect(created).toHaveLength(1);

    const consignments = await prisma.logisticsShipment.findMany({
      where: { orderId },
      select: { sellerAccountId: true },
    });
    expect(consignments.map((row) => row.sellerAccountId)).toEqual([northwindId]);

    // And it is raised the moment they name one, which is what accepting does.
    const rivalGroup = await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId, sellerAccountId: rivalId },
    });
    const chosen = await prisma.sellerLocation.findFirstOrThrow({
      where: { sellerAccountId: rivalId, code: 'RV-2' },
    });

    await prisma.sellerOrderGroup.update({
      where: { id: rivalGroup.id },
      data: { locationId: chosen.id },
    });

    const second = await createShipmentsForOrder(orderId, null);
    expect(second.filter((shipment) => shipment.created)).toHaveLength(1);

    const rivalConsignment = await prisma.logisticsShipment.findFirstOrThrow({
      where: { orderId, sellerAccountId: rivalId },
    });
    expect(rivalConsignment.pickupContactName).toBe('Chakan depot');
  });

  it('raises nothing new when a payment webhook is redelivered', async () => {
    const orderId = await makeOrder({
      offerIds: [northwindOfferId],
      groups: [{ sellerAccountId: northwindId }],
    });

    const first = await createShipmentsForOrder(orderId, null);
    const again = await createShipmentsForOrder(orderId, null);

    expect(first[0]?.created).toBe(true);
    expect(again[0]?.created).toBe(false);
    expect(again[0]?.id).toBe(first[0]?.id);

    const count = await prisma.logisticsShipment.count({ where: { orderId } });
    expect(count).toBe(1);
  });

  it('says what it is waiting for when nothing can be raised yet', async () => {
    const orderId = await makeOrder({
      offerIds: [rivalOfferId],
      groups: [{ sellerAccountId: rivalId }],
    });

    await expect(createShipmentsForOrder(orderId, null)).rejects.toThrow(
      /Rival has not said which of its places this ships from/,
    );
  });
});
