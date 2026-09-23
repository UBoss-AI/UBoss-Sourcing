/**
 * From a paid order to a delivered parcel, through the seller's own choice of
 * carrier - against a real MariaDB, with nothing stubbed.
 *
 * Two paths, because they are two different businesses:
 *
 *   A DELIVERY COMPANY ON THIS PLATFORM is offered the consignment, accepts
 *   or refuses it, and puts one of ITS OWN drivers on it.
 *
 *   DHL / FEDEX / INDIA POST WITHOUT AN API ACCOUNT is booked by the seller
 *   outside Glovia and recorded here. Nothing is booked, labelled, priced or
 *   numbered by this system, and every test on that path checks so.
 *
 * And the boundaries: a seller cannot touch another seller's consignment, a
 * carrier cannot see another carrier's, nobody is asked to carry an order the
 * seller has not confirmed, and a collected parcel cannot be moved by the
 * seller at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { acceptAssignment, rejectAssignment } from '../../src/modules/logistics/assignment.service.js';
import { asPartner, assignDriver } from '../../src/modules/logistics/driver.service.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { createShipmentsForOrder } from '../../src/modules/logistics/shipment-create.service.js';
import { listShipments } from '../../src/modules/logistics/shipment.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  createCarrierConnection,
} from '../../src/modules/seller/carrier-connection.service.js';
import {
  assignPartnerToConsignment,
  consignmentState,
  createManualBooking,
  logisticsOptionsForConsignment,
  raiseConsignmentForSellerOrder,
  recordManualMilestone,
  updateManualBooking,
  withdrawConsignmentCarrier,
  type SellerLogisticsActor,
} from '../../src/modules/seller/consignment-logistics.service.js';
import {
  chooseFulfilmentMethod,
  listFulfilmentMethods,
} from '../../src/modules/seller/fulfilment-method.service.js';
import { transitionSellerOrder } from '../../src/modules/seller/order.service.js';

const PREFIX = 'SLA';
const CARRIER_CODES = ['SLA-VAN', 'SLA-FAR', 'SLA-OTHER'];

let sellerA = '';
let sellerB = '';
let carrierVan = '';
let carrierFar = '';
let carrierOther = '';
let vanMember: LogisticsMembership;
let otherMember: LogisticsMembership;
let membershipA: SellerMembership;
let actorA: SellerLogisticsActor;
let actorB: SellerLogisticsActor;
let locationA = '';
let locationB = '';
let productId = '';
let offerA = '';
let offerB = '';
let buyerProfile = '';

const DELIVERY = { line1: '1 Rynek', city: 'Krakow', postalCode: '30-001', countryCode: 'PL' };

async function cleanUp(): Promise<void> {
  const sellerIds = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  const partnerIds = (
    await prisma.logisticsPartner.findMany({ where: { partnerCode: { in: CARRIER_CODES } }, select: { id: true } })
  ).map((row) => row.id);
  const orderIds = (
    await prisma.order.findMany({ where: { orderNumber: { startsWith: 'UB-SLA-' } }, select: { id: true } })
  ).map((row) => row.id);
  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { OR: [{ sellerAccountId: { in: sellerIds } }, { orderId: { in: orderIds } }] },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.sellerManualCarrierBooking.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentDocument.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsDriverAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: shipmentIds } } });
  await prisma.notificationOutbox.deleteMany({
    where: { OR: [{ relatedId: { in: shipmentIds } }, { relatedId: { in: orderIds } }] },
  });
  await prisma.logisticsNotification.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsDriverProfile.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerUser.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsServiceRegion.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.sellerLogisticsPartner.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: { in: orderIds } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerCarrierConnection.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerInventoryMovement.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });

  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: 'sla-' } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'sla-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'sla-' } } });
  await prisma.taxClass.deleteMany({ where: { code: 'SLATAX' } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: { endsWith: '@sla.local' } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: '@sla.local' } } });
}

async function makeSeller(slug: string, name: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      slug,
      legalName: `${name} sp. z o.o.`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'PL',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });
  return id;
}

async function makeCarrier(code: string, name: string, serves: string[]): Promise<string> {
  const id = newId();
  await prisma.logisticsPartner.create({
    data: {
      id,
      partnerCode: code,
      legalName: `${name} Sp. z o.o.`,
      displayName: name,
      displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'PL',
      contactEmail: `${code.toLowerCase()}@sla.local`,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
    },
  });
  for (const countryCode of serves) {
    await prisma.logisticsServiceRegion.create({
      data: { id: newId(), logisticsPartnerId: id, scope: 'COUNTRY', countryCode },
    });
  }
  return id;
}

async function makeMember(partnerId: string, code: string, name: string): Promise<LogisticsMembership> {
  const userId = newId();
  const partnerUserId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'LOGISTICS',
      email: `${code.toLowerCase()}.dispatch@sla.local`,
      emailNormalized: `${code.toLowerCase()}.dispatch@sla.local`,
      status: 'ACTIVE',
    },
  });
  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: partnerId,
      userId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: 'ACTIVE',
      fullName: `${name} Dispatch`,
    },
  });
  return {
    logisticsPartnerId: partnerId,
    partnerCode: code,
    displayName: name,
    legalName: `${name} Sp. z o.o.`,
    partnerStatus: 'ACTIVE',
    registrationCountry: 'PL',
    partnerUserId,
    userId,
    fullName: `${name} Dispatch`,
    role: 'LOGISTICS_PARTNER_OWNER',
    permissions: permissionsForLogisticsRole('LOGISTICS_PARTNER_OWNER'),
    canAcceptNewWork: true,
    requiresMfa: true,
    regionScope: null,
    driverProfileId: null,
  };
}

async function approveArrangement(sellerAccountId: string, logisticsPartnerId: string): Promise<void> {
  await prisma.sellerLogisticsPartner.create({
    data: {
      id: newId(),
      sellerAccountId,
      logisticsPartnerId,
      status: 'APPROVED',
      decidedAt: new Date(),
    },
  });
}

async function makeLocation(sellerAccountId: string, code: string, countryCode: string): Promise<string> {
  const id = newId();
  await prisma.sellerLocation.create({
    data: {
      id,
      sellerAccountId,
      code,
      name: `${code} depot`,
      addressLine1: 'ul. Fabryczna 1',
      city: countryCode === 'IN' ? 'Pune' : 'Warsaw',
      postcode: countryCode === 'IN' ? '411001' : '00-001',
      countryCode,
      timezone: 'Europe/Warsaw',
      dispatchCutoff: '16:00',
      workingDaysMask: 31,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });
  return id;
}

/**
 * A paid order with one line per seller given. Returns the groups by seller.
 * Written directly, as the acceptance test does, because checkout is tested
 * elsewhere and this file is about what happens after it.
 */
async function paidOrder(
  parts: { sellerAccountId: string; offerId: string; locationId: string }[],
): Promise<{ orderId: string; groups: Map<string, string> }> {
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-SLA-${newId().slice(-8)}`,
      customerProfileId: buyerProfile,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 9_000n * BigInt(parts.length),
      taxMinor: 0n,
      grandTotalMinor: 9_000n * BigInt(parts.length),
      paidMinor: 9_000n * BigInt(parts.length),
      shippingAddressJson: DELIVERY,
      billingAddressJson: DELIVERY,
      placedAt: new Date(),
    },
  });

  const groups = new Map<string, string>();
  for (const part of parts) {
    const orderItemId = newId();
    await prisma.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        productId,
        sellerOfferId: part.offerId,
        nameSnapshot: 'Gloves',
        skuSnapshot: 'SLA-GLOVE',
        taxClassCodeSnapshot: 'SLATAX',
        unitPriceMinor: 9_000n,
        quantity: 1,
        lineSubtotalMinor: 9_000n,
        discountMinor: 0n,
        taxRatePercent: '0.000000',
        taxInclusive: false,
        taxAmountMinor: 0n,
        lineTotalMinor: 9_000n,
      },
    });
    const groupId = newId();
    await prisma.sellerOrderGroup.create({
      data: {
        id: groupId,
        sellerAccountId: part.sellerAccountId,
        orderId,
        sellerOrderNumber: `SO-SLA-${newId().slice(-6)}`,
        status: 'NEW',
        currency: 'INR',
        locationId: part.locationId,
        goodsTotalMinor: 9_000n,
        sellerNetMinor: 9_000n,
      },
    });
    await prisma.sellerOrderLine.create({
      data: {
        id: newId(),
        orderGroupId: groupId,
        orderItemId,
        offerId: part.offerId,
        quantity: 1,
        unitPriceMinor: 9_000n,
        lineTotalMinor: 9_000n,
        sellerNetMinor: 9_000n,
        currency: 'INR',
      },
    });
    groups.set(part.sellerAccountId, groupId);
  }

  // What the verified payment webhook does next.
  await createShipmentsForOrder(orderId, null);
  return { orderId, groups };
}

async function consignmentOf(groupId: string): Promise<string> {
  const row = await prisma.logisticsShipment.findFirstOrThrow({
    where: { sellerOrderGroupId: groupId },
    select: { id: true },
  });
  return row.id;
}

async function confirm(membership: SellerMembership, groupId: string, locationId: string): Promise<void> {
  await transitionSellerOrder({ membership, groupId, to: 'ACCEPTED', locationId });
}

beforeAll(async () => {
  await cleanUp();

  sellerA = await makeSeller(`${PREFIX}-ALPHA`, 'Alpha Medical');
  sellerB = await makeSeller(`${PREFIX}-BRAVO`, 'Bravo Supplies');
  locationA = await makeLocation(sellerA, 'SLA-A', 'PL');
  locationB = await makeLocation(sellerB, 'SLA-B', 'PL');

  carrierVan = await makeCarrier('SLA-VAN', 'Vistula Vans', ['PL']);
  carrierFar = await makeCarrier('SLA-FAR', 'Far Away Freight', ['DE']);
  carrierOther = await makeCarrier('SLA-OTHER', 'Other Couriers', ['PL']);
  vanMember = await makeMember(carrierVan, 'SLA-VAN', 'Vistula Vans');
  otherMember = await makeMember(carrierOther, 'SLA-OTHER', 'Other Couriers');

  await approveArrangement(sellerA, carrierVan);
  await approveArrangement(sellerA, carrierFar);
  await approveArrangement(sellerB, carrierOther);

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: 'SLATAX', name: 'SLA zero', ratePercent: '0.000000', isInclusive: false },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'SLA', slug: 'sla-tools', isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'SLA Gloves',
      slug: 'sla-gloves',
      sku: 'SLA-GLOVE',
      basePriceMinor: 10_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

  const makeOffer = async (sellerAccountId: string, sku: string): Promise<string> => {
    const id = newId();
    await prisma.sellerOffer.create({
      data: {
        id,
        sellerAccountId,
        productId,
        variantKey: '',
        sellerSku: sku,
        status: 'ACTIVE',
        priceMinor: 9_000n,
        currency: 'INR',
      },
    });
    return id;
  };
  offerA = await makeOffer(sellerA, 'A-GLOVE');
  offerB = await makeOffer(sellerB, 'B-GLOVE');

  // Stock on the shelf: confirming an order reserves it.
  for (const [sellerAccountId, offerId, locationId] of [
    [sellerA, offerA, locationA],
    [sellerB, offerB, locationB],
  ] as const) {
    await prisma.sellerInventory.create({
      data: { id: newId(), sellerAccountId, offerId, locationId, availableQuantity: 100, reservedQuantity: 0 },
    });
  }

  const buyer = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: 'buyer@sla.local',
      emailNormalized: 'buyer@sla.local',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  buyerProfile = (
    await prisma.customerProfile.create({ data: { id: newId(), userId: buyer.id, fullName: 'Szpital SLA' } })
  ).id;

  membershipA = {
    sellerAccountId: sellerA,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Alpha Medical',
    legalName: 'Alpha Medical sp. z o.o.',
    slug: `${PREFIX}-ALPHA`,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'PL',
    logoStorageKey: null,
  };

  actorA = { sellerAccountId: sellerA, memberId: membershipA.memberId, label: 'ops@alpha.local' };
  actorB = { sellerAccountId: sellerB, memberId: null, label: 'ops@bravo.local' };
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the carrier setup screens tell the truth about FedEx, DHL and India Post', () => {
  it('a FedEx method says FedEx before any connection exists, and is never connected by a saved form', async () => {
    const actor = { memberId: membershipA.memberId, userId: newId(), label: 'ops@alpha.local' };

    await chooseFulfilmentMethod({ sellerAccountId: sellerA, actor, mode: 'INTEGRATED_CARRIER', provider: 'FEDEX' });
    await chooseFulfilmentMethod({ sellerAccountId: sellerA, actor, mode: 'INTEGRATED_CARRIER', provider: 'DHL' });
    await chooseFulfilmentMethod({ sellerAccountId: sellerA, actor, mode: 'INTEGRATED_CARRIER', provider: 'INDIA_POST' });

    let methods = await listFulfilmentMethods(sellerA);
    const byProvider = (provider: string) => methods.find((method) => method.provider === provider);

    // The bug: with no connection, the FedEx method used to have no provider
    // at all, and the screen fell back to DHL.
    expect(byProvider('FEDEX')?.connection).toBeNull();
    expect(byProvider('FEDEX')?.carrierSetupStatus).toBe('NOT_CONFIGURED');
    expect(byProvider('INDIA_POST')?.carrierSetupStatus).toBe('MANUAL_MODE_AVAILABLE');
    for (const method of methods.filter((row) => row.mode === 'INTEGRATED_CARRIER')) {
      expect(method.manualBookingAvailable).toBe(true);
      expect(method.status).toBe('PENDING_SETUP');
    }

    // Adding the FedEx account joins it to the FedEx method, and ONLY that one.
    await createCarrierConnection({
      sellerAccountId: sellerA,
      actor,
      provider: 'FEDEX',
      environment: 'SANDBOX',
      accountNumber: '123456789',
    });

    methods = await listFulfilmentMethods(sellerA);
    expect(byProvider('FEDEX')?.connection?.provider).toBe('FEDEX');
    expect(byProvider('DHL')?.connection).toBeNull();

    // An account without a key is not connected, and says why.
    expect(byProvider('FEDEX')?.carrierSetupStatus).toBe('CREDENTIALS_REQUIRED');
    expect(byProvider('FEDEX')?.status).toBe('PENDING_SETUP');
  });
});

describe('a confirmed consignment, handed to a delivery company on the platform', () => {
  let groupA = '';
  let groupB = '';
  let shipmentA = '';
  let shipmentB = '';

  it('keeps a multi-seller order separated into one consignment per seller', async () => {
    const order = await paidOrder([
      { sellerAccountId: sellerA, offerId: offerA, locationId: locationA },
      { sellerAccountId: sellerB, offerId: offerB, locationId: locationB },
    ]);
    groupA = order.groups.get(sellerA) ?? '';
    groupB = order.groups.get(sellerB) ?? '';
    shipmentA = await consignmentOf(groupA);
    shipmentB = await consignmentOf(groupB);

    expect(shipmentA).not.toBe(shipmentB);
    const rows = await prisma.logisticsShipment.findMany({ where: { orderId: order.orderId } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sellerAccountId))).toEqual(new Set([sellerA, sellerB]));
  });

  it('refuses to hand anything on before the seller confirms', async () => {
    const state = await consignmentState(sellerA, shipmentA);
    expect(state.assignBlock).toBe('SELLER_ORDER_NOT_CONFIRMED');
    expect(state.canAssign).toBe(false);

    await expect(
      assignPartnerToConsignment({ actor: actorA, shipmentId: shipmentA, logisticsPartnerId: carrierVan }),
    ).rejects.toMatchObject({ code: 'SELLER_ORDER_NOT_CONFIRMED' });

    await expect(
      createManualBooking({ actor: actorA, shipmentId: shipmentA, provider: 'DHL' }),
    ).rejects.toMatchObject({ code: 'SELLER_ORDER_NOT_CONFIRMED' });
  });

  it('after confirmation the consignment awaits assignment and the seller is told to assign it', async () => {
    await confirm(membershipA, groupA, locationA);

    const state = await consignmentState(sellerA, shipmentA);
    expect(state.stage).toBe('AWAITING_LOGISTICS_ASSIGNMENT');
    expect(state.canAssign).toBe(true);

    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerA, kind: 'CONSIGNMENT_NEEDS_CARRIER', status: 'ACTIVE' },
    });
    expect(alert?.linkPath).toBe(`/seller/orders/${groupA}`);
  });

  it('lists every partner with its reason, and DHL/FedEx/India Post as manual options', async () => {
    const options = await logisticsOptionsForConsignment(sellerA, shipmentA);

    const van = options.partners.find((row) => row.logisticsPartnerId === carrierVan);
    const far = options.partners.find((row) => row.logisticsPartnerId === carrierFar);
    expect(van?.isEligible).toBe(true);
    expect(far?.isEligible).toBe(false);
    expect(far?.serviceability).toContain('NO_COVERAGE_ORIGIN');
    // Another seller's carrier is not in the list at all.
    expect(options.partners.some((row) => row.logisticsPartnerId === carrierOther)).toBe(false);

    const dhl = options.carriers.find((row) => row.provider === 'DHL');
    expect(dhl?.isAvailable).toBe(true);
    expect(dhl?.automaticBookingAvailable).toBe(false);
    expect(dhl?.notes).toEqual(expect.arrayContaining(['API_CREDENTIALS_REQUIRED', 'MANUAL_BOOKING_AVAILABLE']));
    // India Post collects in India only; this parcel leaves Poland.
    const post = options.carriers.find((row) => row.provider === 'INDIA_POST');
    expect(post?.isAvailable).toBe(false);
    expect(post?.notes).toContain('ORIGIN_NOT_SERVED');
  });

  it('refuses a partner that does not serve the route, even though the arrangement is approved', async () => {
    await expect(
      assignPartnerToConsignment({ actor: actorA, shipmentId: shipmentA, logisticsPartnerId: carrierFar }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_PARTNER_NOT_ELIGIBLE' });
  });

  it('a seller cannot touch another seller\'s consignment, and learns nothing about it', async () => {
    await expect(consignmentState(sellerB, shipmentA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      assignPartnerToConsignment({ actor: actorB, shipmentId: shipmentA, logisticsPartnerId: carrierOther }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createManualBooking({ actor: actorB, shipmentId: shipmentA, provider: 'DHL' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('offers it once, however many times the request arrives', async () => {
    const [first, second] = await Promise.all([
      assignPartnerToConsignment({ actor: actorA, shipmentId: shipmentA, logisticsPartnerId: carrierVan }),
      assignPartnerToConsignment({ actor: actorA, shipmentId: shipmentA, logisticsPartnerId: carrierVan }),
    ]);
    const third = await assignPartnerToConsignment({
      actor: actorA,
      shipmentId: shipmentA,
      logisticsPartnerId: carrierVan,
    });

    expect(new Set([first.assignmentId, second.assignmentId, third.assignmentId]).size).toBe(1);
    expect(third.idempotent).toBe(true);

    const live = await prisma.logisticsShipmentAssignment.count({
      where: { shipmentId: shipmentA, state: { in: ['OFFERED', 'ACCEPTED'] } },
    });
    expect(live).toBe(1);

    // The "assign a partner" alert closed itself.
    const open = await prisma.sellerNotification.count({
      where: { sellerAccountId: sellerA, kind: 'CONSIGNMENT_NEEDS_CARRIER', status: 'ACTIVE' },
    });
    expect(open).toBe(0);

    expect((await consignmentState(sellerA, shipmentA)).stage).toBe('ASSIGNMENT_PENDING');
  });

  it('the partner receives it, and another partner cannot see it', async () => {
    const notice = await prisma.logisticsNotification.findFirst({
      where: { logisticsPartnerId: carrierVan, shipmentId: shipmentA, kind: 'SHIPMENT_ASSIGNED' },
    });
    expect(notice).not.toBeNull();

    const mine = (await listShipments(vanMember, {})).rows.map((row) => row.id);
    expect(mine).toContain(shipmentA);
    expect(mine).not.toContain(shipmentB);

    const theirs = (await listShipments(otherMember, {})).rows.map((row) => row.id);
    expect(theirs).not.toContain(shipmentA);
  });

  it('a refusal comes back to the seller as a refusal, with the reason', async () => {
    await rejectAssignment(vanMember, shipmentA, 'No van free on Friday');

    const state = await consignmentState(sellerA, shipmentA);
    expect(state.stage).toBe('PARTNER_REJECTED');
    expect(state.history[0]?.reason).toBe('No van free on Friday');

    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerA, kind: 'CARRIER_REJECTED', status: 'ACTIVE' },
    });
    expect(alert?.body).toContain('No van free on Friday');
  });

  it('offered again, accepted, and the partner is told a driver is owed', async () => {
    const offered = await assignPartnerToConsignment({
      actor: actorA,
      shipmentId: shipmentA,
      logisticsPartnerId: carrierVan,
    });
    expect(offered.idempotent).toBe(false);

    await acceptAssignment(vanMember, shipmentA);

    expect((await consignmentState(sellerA, shipmentA)).stage).toBe('DRIVER_ASSIGNMENT_REQUIRED');

    const accepted = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerA, kind: 'CARRIER_ACCEPTED' },
    });
    expect(accepted).not.toBeNull();

    const driverNeeded = await prisma.logisticsNotification.findFirst({
      where: { logisticsPartnerId: carrierVan, shipmentId: shipmentA, class: 'ALERT', status: 'ACTIVE' },
    });
    expect(driverNeeded?.title).toBe('Assign a driver');
  });

  it('the partner assigns ITS OWN driver; the driver and the dispatcher are told; the alert closes', async () => {
    const driverUser = newId();
    const driverPartnerUser = newId();
    await prisma.user.create({
      data: {
        id: driverUser,
        type: 'LOGISTICS',
        email: 'driver@sla.local',
        emailNormalized: 'driver@sla.local',
        status: 'ACTIVE',
      },
    });
    await prisma.logisticsPartnerUser.create({
      data: {
        id: driverPartnerUser,
        logisticsPartnerId: carrierVan,
        userId: driverUser,
        role: 'DRIVER',
        status: 'ACTIVE',
        fullName: 'Marek Nowak',
      },
    });
    const driver = await prisma.logisticsDriverProfile.create({
      data: {
        id: newId(),
        logisticsPartnerId: carrierVan,
        fullName: 'Marek Nowak',
        state: 'ACTIVE',
        partnerUserId: driverPartnerUser,
      },
    });

    await assignDriver(asPartner(vanMember), { shipmentId: shipmentA, driverProfileId: driver.id });

    const state = await consignmentState(sellerA, shipmentA);
    expect(state.stage).toBe('DRIVER_ASSIGNED');
    // The seller sees THAT there is a driver, masked - never a control.
    expect(state.driver.isAssigned).toBe(true);
    expect(state.driver.maskedName).not.toBe('Marek Nowak');

    const driverNotice = await prisma.logisticsNotification.findFirst({
      where: { partnerUserId: driverPartnerUser, shipmentId: shipmentA, kind: 'DRIVER_ASSIGNED' },
    });
    expect(driverNotice).not.toBeNull();

    const stillNeeded = await prisma.logisticsNotification.count({
      where: { logisticsPartnerId: carrierVan, shipmentId: shipmentA, class: 'ALERT', status: 'ACTIVE' },
    });
    expect(stillNeeded).toBe(0);
  });

  it('a seller can reach no driver function: the driver service refuses a seller-shaped actor', async () => {
    // The seller routes do not import the driver service at all; this is the
    // second lock - a membership of a carrier the seller is not is refused.
    const impostor = { ...vanMember, logisticsPartnerId: carrierOther, permissions: new Set<never>() };
    await expect(
      assignDriver(asPartner(impostor), { shipmentId: shipmentA, driverProfileId: newId() }),
    ).rejects.toBeTruthy();
  });

  it('reassigning before pickup keeps the history and tells the carrier that lost it', async () => {
    // Bravo cannot use Vistula; give Alpha a second eligible carrier.
    await approveArrangement(sellerA, carrierOther);

    await expect(
      assignPartnerToConsignment({ actor: actorA, shipmentId: shipmentA, logisticsPartnerId: carrierOther }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await assignPartnerToConsignment({
      actor: actorA,
      shipmentId: shipmentA,
      logisticsPartnerId: carrierOther,
      reason: 'Vistula cannot make the Friday slot',
    });

    const rows = await prisma.logisticsShipmentAssignment.findMany({
      where: { shipmentId: shipmentA },
      orderBy: { offeredAt: 'asc' },
    });
    expect(rows.map((row) => row.state)).toEqual(['REJECTED', 'WITHDRAWN', 'OFFERED']);

    const told = await prisma.logisticsNotification.findFirst({
      where: { logisticsPartnerId: carrierVan, shipmentId: shipmentA, title: { contains: 'no longer yours' } },
    });
    expect(told?.body).toContain('Friday slot');

    // Its driver is off the round.
    const liveDriver = await prisma.logisticsDriverAssignment.count({ where: { activeShipmentId: shipmentA } });
    expect(liveDriver).toBe(0);
  });

  it('after pickup the seller cannot move it, and after delivery nobody can offer it', async () => {
    await acceptAssignment(otherMember, shipmentA);
    for (const status of ['PICKUP_SCHEDULED', 'PICKED_UP'] as const) {
      await recordShipmentEvent({
        shipmentId: shipmentA,
        status,
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: carrierOther,
        permissions: [...otherMember.permissions],
      });
    }

    const state = await consignmentState(sellerA, shipmentA);
    expect(state.stage).toBe('PICKED_UP');
    expect(state.assignBlock).toBe('COLLECTED');

    await expect(
      assignPartnerToConsignment({
        actor: actorA,
        shipmentId: shipmentA,
        logisticsPartnerId: carrierVan,
        reason: 'changed my mind',
      }),
    ).rejects.toMatchObject({ code: 'CONSIGNMENT_REASSIGNMENT_LOCKED' });
    await expect(
      withdrawConsignmentCarrier({ actor: actorA, shipmentId: shipmentA, reason: 'changed my mind' }),
    ).rejects.toMatchObject({ code: 'CONSIGNMENT_REASSIGNMENT_LOCKED' });

    for (const status of ['IN_TRANSIT', 'OUT_FOR_DELIVERY'] as const) {
      await recordShipmentEvent({
        shipmentId: shipmentA,
        status,
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: carrierOther,
        permissions: [...otherMember.permissions],
      });
    }
    await recordShipmentEvent({
      shipmentId: shipmentA,
      status: 'DELIVERED',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: carrierOther,
      permissions: [...otherMember.permissions],
      hasProofOfDelivery: true,
    });

    await expect(
      assignPartnerToConsignment({
        actor: actorA,
        shipmentId: shipmentA,
        logisticsPartnerId: carrierVan,
        reason: 'changed my mind',
      }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_SHIPMENT_TERMINAL' });

    // The buyer was told, one email per milestone.
    const mail = await prisma.notificationOutbox.findMany({
      where: { relatedId: shipmentA },
      select: { eventKey: true },
    });
    expect(mail.map((row) => row.eventKey)).toEqual(
      expect.arrayContaining(['shipment.picked_up', 'shipment.in_transit', 'shipment.out_for_delivery', 'shipment.delivered']),
    );
  });

  it('Bravo\'s consignment on the same order is untouched by all of it', async () => {
    const state = await consignmentState(sellerB, shipmentB);
    expect(state.stage).toBe('AWAITING_LOGISTICS_ASSIGNMENT');
    expect(state.assignBlock).toBe('SELLER_ORDER_NOT_CONFIRMED');
    expect(state.history).toHaveLength(0);
  });
});

describe('DHL booked by hand, with no API account', () => {
  let shipmentId = '';
  let groupId = '';

  it('is recorded as a manual booking and nothing more', async () => {
    const order = await paidOrder([{ sellerAccountId: sellerA, offerId: offerA, locationId: locationA }]);
    groupId = order.groups.get(sellerA) ?? '';
    shipmentId = await consignmentOf(groupId);
    await confirm(membershipA, groupId, locationA);

    const created = await createManualBooking({ actor: actorA, shipmentId, provider: 'DHL' });
    const again = await createManualBooking({ actor: actorA, shipmentId, provider: 'DHL' });
    expect(again.idempotent).toBe(true);
    expect(again.booking.id).toBe(created.booking.id);

    const row = await prisma.logisticsShipment.findUniqueOrThrow({ where: { id: shipmentId } });
    // No tracking number was invented, no label bought, no carrier holds it.
    expect(row.carrierTrackingNumber).toBeNull();
    expect(row.assignedPartnerId).toBeNull();
    expect(await prisma.shipmentPurchase.count({ where: { shipmentId } })).toBe(0);
    expect(row.status).toBe('ASSIGNED');

    const state = await consignmentState(sellerA, shipmentId);
    expect(state.mode).toBe('MANUAL_CARRIER');
    expect(state.stage).toBe('CARRIER_BOOKING_PENDING');
    expect(state.manualBooking?.status).toBe('BOOKING_REQUIRED');

    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerA, kind: 'CARRIER_BOOKING_INCOMPLETE', status: 'ACTIVE' },
    });
    expect(alert?.body).toContain('has not booked anything with DHL');

    expect(
      await prisma.sellerManualCarrierBooking.count({ where: { shipmentId, activeShipmentId: { not: null } } }),
    ).toBe(1);
  });

  it('cannot record where the parcel is until the real tracking number is entered', async () => {
    await expect(
      recordManualMilestone({ actor: actorA, shipmentId, status: 'PICKED_UP' }),
    ).rejects.toMatchObject({ code: 'CARRIER_TRACKING_NUMBER_REQUIRED' });
  });

  it('takes the real tracking number later, and only then is it booked', async () => {
    await expect(
      updateManualBooking({
        editor: { kind: 'SELLER', actor: actorA },
        shipmentId,
        details: { carrierTrackingNumber: 'not a number!' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const booking = await updateManualBooking({
      editor: { kind: 'SELLER', actor: actorA },
      shipmentId,
      details: { carrierTrackingNumber: '1234567890', serviceName: 'Express Worldwide', shippingCostMinor: '45000' },
    });

    expect(booking.status).toBe('BOOKED');
    expect(booking.trackingPageUrl).toContain('dhl.com');
    expect(booking.shippingCostMinor).toBe('45000');

    const row = await prisma.logisticsShipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect(row.status).toBe('PICKUP_SCHEDULED');
    expect(row.carrierTrackingNumber).toBe('1234567890');

    const openAlert = await prisma.sellerNotification.count({
      where: { sellerAccountId: sellerA, kind: 'CARRIER_BOOKING_INCOMPLETE', status: 'ACTIVE' },
    });
    expect(openAlert).toBe(0);
  });

  it('walks the journey by hand, marked as the seller\'s word, and will not deliver without proof', async () => {
    for (const status of ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']) {
      await recordManualMilestone({ actor: actorA, shipmentId, status, idempotencyKey: `sla-${status}` });
    }
    // A retry is not a second event.
    await recordManualMilestone({ actor: actorA, shipmentId, status: 'OUT_FOR_DELIVERY', idempotencyKey: 'sla-OUT_FOR_DELIVERY' });

    const events = await prisma.logisticsShipmentEvent.findMany({
      where: { shipmentId, source: 'SELLER_PORTAL' },
      select: { status: true },
    });
    expect(events.map((event) => event.status)).toEqual(
      expect.arrayContaining(['ASSIGNED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']),
    );
    expect(events.filter((event) => event.status === 'OUT_FOR_DELIVERY')).toHaveLength(1);

    await expect(
      recordManualMilestone({ actor: actorA, shipmentId, status: 'DELIVERED' }),
    ).rejects.toMatchObject({ code: 'SHIPMENT_POD_REQUIRED' });

    // No "accept" or "dispatch" is open to a seller.
    await expect(
      recordManualMilestone({ actor: actorA, shipmentId, status: 'DISPATCHED' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('the tracking number cannot be rewritten once the carrier has the parcel', async () => {
    await expect(
      updateManualBooking({
        editor: { kind: 'SELLER', actor: actorA },
        shipmentId,
        details: { carrierTrackingNumber: '9999999999' },
      }),
    ).rejects.toMatchObject({ code: 'CONSIGNMENT_REASSIGNMENT_LOCKED' });
  });

  it('a seller cannot type progress over a delivery company\'s consignment', async () => {
    const order = await paidOrder([{ sellerAccountId: sellerA, offerId: offerA, locationId: locationA }]);
    const other = order.groups.get(sellerA) ?? '';
    const partnered = await consignmentOf(other);
    await confirm(membershipA, other, locationA);
    await assignPartnerToConsignment({ actor: actorA, shipmentId: partnered, logisticsPartnerId: carrierVan });

    await expect(
      recordManualMilestone({ actor: actorA, shipmentId: partnered, status: 'PICKED_UP' }),
    ).rejects.toMatchObject({ code: 'SHIPMENT_TRANSITION_NOT_ALLOWED' });

    // And switching it to a hand booking is a reassignment: reason required,
    // the partner told, one live carrier only.
    await expect(
      createManualBooking({ actor: actorA, shipmentId: partnered, provider: 'FEDEX' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await createManualBooking({
      actor: actorA,
      shipmentId: partnered,
      provider: 'FEDEX',
      reason: 'Buyer asked for FedEx',
    });

    const liveOffers = await prisma.logisticsShipmentAssignment.count({
      where: { shipmentId: partnered, state: { in: ['OFFERED', 'ACCEPTED'] } },
    });
    expect(liveOffers).toBe(0);
    expect((await consignmentState(sellerA, partnered)).mode).toBe('MANUAL_CARRIER');
  });
});

describe('a confirmed order that has no consignment', () => {
  it('can have one raised by the seller, once', async () => {
    const orderId = newId();
    await prisma.order.create({
      data: {
        id: orderId,
        orderNumber: `UB-SLA-${newId().slice(-8)}`,
        customerProfileId: buyerProfile,
        status: 'CONFIRMED',
        currency: 'INR',
        subtotalMinor: 9_000n,
        taxMinor: 0n,
        grandTotalMinor: 9_000n,
        paidMinor: 9_000n,
        shippingAddressJson: DELIVERY,
        billingAddressJson: DELIVERY,
        placedAt: new Date(),
      },
    });
    const orderItemId = newId();
    await prisma.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        productId,
        sellerOfferId: offerA,
        nameSnapshot: 'Gloves',
        skuSnapshot: 'SLA-GLOVE',
        taxClassCodeSnapshot: 'SLATAX',
        unitPriceMinor: 9_000n,
        quantity: 1,
        lineSubtotalMinor: 9_000n,
        discountMinor: 0n,
        taxRatePercent: '0.000000',
        taxInclusive: false,
        taxAmountMinor: 0n,
        lineTotalMinor: 9_000n,
      },
    });
    // Confirmed before consignments were raised automatically: the state the
    // development database really had one of.
    const groupId = newId();
    await prisma.sellerOrderGroup.create({
      data: {
        id: groupId,
        sellerAccountId: sellerA,
        orderId,
        sellerOrderNumber: `SO-SLA-${newId().slice(-6)}`,
        status: 'ACCEPTED',
        currency: 'INR',
        locationId: locationA,
        goodsTotalMinor: 9_000n,
        sellerNetMinor: 9_000n,
      },
    });
    await prisma.sellerOrderLine.create({
      data: {
        id: newId(),
        orderGroupId: groupId,
        orderItemId,
        offerId: offerA,
        quantity: 1,
        unitPriceMinor: 9_000n,
        lineTotalMinor: 9_000n,
        sellerNetMinor: 9_000n,
        currency: 'INR',
      },
    });

    const first = await raiseConsignmentForSellerOrder({ actor: actorA, sellerOrderGroupId: groupId });
    const second = await raiseConsignmentForSellerOrder({ actor: actorA, sellerOrderGroupId: groupId });
    expect(first).toHaveLength(1);
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(first[0]?.canAssign).toBe(true);

    await expect(
      raiseConsignmentForSellerOrder({ actor: actorB, sellerOrderGroupId: groupId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
