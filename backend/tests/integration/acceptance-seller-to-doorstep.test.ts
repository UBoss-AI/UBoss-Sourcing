/**
 * One order, from a seller being approved to a parcel on a doorstep.
 *
 * The twenty-step acceptance scenario, as one test rather than twenty. Its
 * value is not in any single assertion — nearly all of them are covered more
 * thoroughly in the files next door — but in the fact that the whole chain
 * holds together when nothing is stubbed:
 *
 *     seller → carrier arrangement → paid order → consignment →
 *     seller picks a carrier → carrier accepts → carrier picks a driver →
 *     tracking → delivery → notifications closing as conditions clear
 *
 * Each of those halves has its own file and its own edge cases. What this
 * catches is the seam: a service that works alone and refuses the shape the
 * previous step actually produces.
 *
 * WHAT IS DELIBERATELY REAL HERE
 *
 * The rate set, the arrangement, the eligibility check, the offer, the
 * acceptance, the driver assignment and every notification. Nothing is
 * stubbed. The one thing written directly rather than driven through its own
 * service is the ORDER, because `submitCheckout` needs a cart, an address, a
 * shipping method and a payment intent, and reproducing all of that here
 * would test checkout rather than this chain — `checkout.test.ts` and
 * `fx-conversion.test.ts` already do that, including the payment-webhook
 * idempotency this relies on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForLogisticsRole } from '../../src/domain/logistics-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { LogisticsMembership } from '../../src/modules/logistics/partner.service.js';
import { acceptAssignment } from '../../src/modules/logistics/assignment.service.js';
import { asPartner, assignDriver } from '../../src/modules/logistics/driver.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { createShipmentsForOrder } from '../../src/modules/logistics/shipment-create.service.js';
import { listShipments } from '../../src/modules/logistics/shipment.service.js';
import { captureProofOfDelivery } from '../../src/modules/logistics/pod.service.js';
import {
  carrierChoicesForShipment,
  decideSellerCarrier,
  requestSellerCarrier,
  sellerAssignCarrier,
} from '../../src/modules/seller/logistics-partner.service.js';

const SELLER_SLUG = 'ACC-XYZ';
const CARRIER_CODE = 'ACC-VISTULA';
const RIVAL_CARRIER_CODE = 'ACC-ODRA';
const BUYER_EMAIL = 'buyer@acceptance.local';
const STAFF_EMAIL = 'staff@acceptance.local';

let sellerId = '';
let carrierId = '';
let rivalCarrierId = '';
let carrier: LogisticsMembership;
let adminUserId = '';
let customerProfileId = '';
let productId = '';
let orderId = '';

const DELIVERY = {
  line1: 'ul. Szpitalna 4',
  city: 'Krakow',
  postalCode: '30-001',
  countryCode: 'PL',
};

async function cleanUp(): Promise<void> {
  const sellerIds = (
    await prisma.sellerAccount.findMany({ where: { slug: SELLER_SLUG }, select: { id: true } })
  ).map((row) => row.id);

  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { partnerCode: { in: [CARRIER_CODE, RIVAL_CARRIER_CODE] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const orderIds = (
    await prisma.order.findMany({
      where: { orderNumber: { startsWith: 'UB-ACC-' } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { OR: [{ sellerAccountId: { in: sellerIds } }, { orderId: { in: orderIds } }] },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.logisticsDriverAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.logisticsNotification.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsDriverProfile.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsServiceRegion.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: { in: orderIds } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerLogisticsPartner.deleteMany({
    where: { sellerAccountId: { in: sellerIds } },
  });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });

  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: 'acc-' } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'acc-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'acc-' } } });
  await prisma.taxClass.deleteMany({ where: { code: 'ACCTAX' } });
  await prisma.customerProfile.deleteMany({ where: { user: { email: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: '@acceptance.local' } } });

  // The shipment-reference counter is shared and globally unique. Never reset.
}

beforeAll(async () => {
  await cleanUp();

  // --- 1. A seller, approved -----------------------------------------------
  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: SELLER_SLUG,
      legalName: 'XYZ Medical sp. z o.o.',
      displayName: 'XYZ Medical',
      displayNameNormalized: 'xyzmedical',
      registrationCountry: 'PL',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });

  // --- Two carriers, so "only the assigned one sees it" is testable --------
  const makeCarrier = async (code: string, name: string): Promise<string> => {
    const id = newId();
    await prisma.logisticsPartner.create({
      data: {
        id,
        partnerCode: code,
        legalName: `${name} Sp. z o.o.`,
        displayName: name,
        displayNameNormalized: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        registrationCountry: 'PL',
        contactEmail: `${code.toLowerCase()}@acceptance.local`,
        status: 'ACTIVE',
        contractStatus: 'ACTIVE',
      },
    });
    return id;
  };

  carrierId = await makeCarrier(CARRIER_CODE, 'Vistula Freight');
  // Where it collects and delivers. A seller's arrangement narrows what a
  // carrier may do and never widens it, so a carrier with no service area
  // is offered nothing.
  await prisma.logisticsServiceRegion.create({
    data: { id: newId(), logisticsPartnerId: carrierId, scope: 'COUNTRY', countryCode: 'PL' },
  });
  rivalCarrierId = await makeCarrier(RIVAL_CARRIER_CODE, 'Odra Logistics');

  const carrierUserId = newId();
  const partnerUserId = newId();

  await prisma.user.create({
    data: {
      id: carrierUserId,
      type: 'LOGISTICS',
      email: 'dispatch@acceptance.local',
      emailNormalized: 'dispatch@acceptance.local',
      status: 'ACTIVE',
    },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: partnerUserId,
      logisticsPartnerId: carrierId,
      userId: carrierUserId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: 'ACTIVE',
      fullName: 'Vistula Dispatch',
    },
  });

  carrier = {
    logisticsPartnerId: carrierId,
    partnerCode: CARRIER_CODE,
    displayName: 'Vistula Freight',
    legalName: 'Vistula Freight Sp. z o.o.',
    partnerStatus: 'ACTIVE',
    registrationCountry: 'PL',
    partnerUserId,
    userId: carrierUserId,
    fullName: 'Vistula Dispatch',
    role: 'LOGISTICS_PARTNER_OWNER',
    permissions: permissionsForLogisticsRole('LOGISTICS_PARTNER_OWNER'),
    canAcceptNewWork: true,
    requiresMfa: true,
    regionScope: null,
    driverProfileId: null,
  };

  const staff = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: STAFF_EMAIL,
      emailNormalized: STAFF_EMAIL,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  adminUserId = staff.id;

  // --- 2. A published product with stock, sold by XYZ ----------------------
  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'ACCTAX',
      name: 'Acceptance zero',
      ratePercent: '0.000000',
      isInclusive: false,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Acceptance', slug: 'acc-tools', isActive: true },
  });
  await prisma.category.update({
    where: { id: category.id },
    data: { path: `/${category.id}/` },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Examination Gloves',
      slug: 'acc-gloves',
      sku: 'ACC-GLOVE-1',
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

  const offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerId,
      productId,
      variantKey: '',
      sellerSku: 'XYZ-GLOVE-1',
      status: 'ACTIVE',
      priceMinor: 9_000n,
      currency: 'INR',
    },
  });

  const buyer = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: BUYER_EMAIL,
      emailNormalized: BUYER_EMAIL,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: buyer.id, fullName: 'Szpital Bielanski' },
  });
  customerProfileId = profile.id;

  // --- 6/7. A paid, confirmed order ---------------------------------------
  //
  // Written directly rather than through checkout: see the file header. What
  // matters downstream is that it is CONFIRMED with a seller group, which is
  // exactly the state a verified payment webhook leaves it in.
  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-ACC-${newId().slice(-8)}`,
      customerProfileId,
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
      sellerOfferId: offerId,
      nameSnapshot: 'Examination Gloves',
      skuSnapshot: 'ACC-GLOVE-1',
      taxClassCodeSnapshot: 'ACCTAX',
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

  // Where XYZ ships from. Without one, no consignment can be raised - the
  // marketplace does not know which of the seller's buildings a parcel leaves
  // from, and guessing would send a carrier to the wrong address.
  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      code: 'ACC-WH',
      name: 'Warsaw depot',
      addressLine1: 'ul. Fabryczna 1',
      city: 'Warsaw',
      postcode: '00-001',
      countryCode: 'PL',
      timezone: 'Europe/Warsaw',
      dispatchCutoff: '16:00',
      workingDaysMask: 31,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });

  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: `SO-ACC-${newId().slice(-6)}`,
      status: 'NEW',
      currency: 'INR',
      locationId: location.id,
      goodsTotalMinor: 9_000n,
      sellerNetMinor: 9_000n,
    },
  });

  await prisma.sellerOrderLine.create({
    data: {
      id: newId(),
      orderGroupId: groupId,
      orderItemId,
      offerId,
      quantity: 1,
      unitPriceMinor: 9_000n,
      lineTotalMinor: 9_000n,
      sellerNetMinor: 9_000n,
      currency: 'INR',
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

describe('a seller order, from approval to doorstep', () => {
  it('runs the whole chain without anything being stubbed', async () => {
    // --- 3. XYZ gets an approved arrangement with an eligible carrier ------
    const requested = await requestSellerCarrier({
      sellerAccountId: sellerId,
      logisticsPartnerId: carrierId,
      sellerMemberId: null,
      actorEmail: 'ops@xyz.local',
    });

    // A seller cannot approve their own request; it waits for the marketplace.
    expect(requested.status).toBe('REQUESTED');

    await decideSellerCarrier({
      linkId: requested.linkId,
      to: 'APPROVED',
      decidedByUserId: adminUserId,
    });

    // ...and the seller is told, on their own feed.
    const decisionNotice = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerId, kind: 'CARRIER_ARRANGEMENT_DECISION' },
    });
    expect(decisionNotice?.title).toContain('Vistula Freight');

    // --- 8. Exactly one consignment for the seller's part ------------------
    const raised = await createShipmentsForOrder(orderId, null);
    expect(raised).toHaveLength(1);

    // Re-running raises nothing new. This is what a redelivered payment
    // webhook does, and it is why the creation is idempotent by construction.
    expect(await createShipmentsForOrder(orderId, null)).toHaveLength(1);

    const consignments = await prisma.logisticsShipment.findMany({ where: { orderId } });
    expect(consignments).toHaveLength(1);

    const shipmentId = consignments[0]?.id ?? '';
    expect(consignments[0]?.sellerAccountId).toBe(sellerId);
    expect(consignments[0]?.assignedPartnerId).toBeNull();

    // --- 10. XYZ sees only their approved carrier as an option -------------
    const options = await carrierChoicesForShipment(sellerId, shipmentId);
    const eligible = options.filter((option) => option.isEligible);

    expect(eligible.map((option) => option.logisticsPartnerId)).toEqual([carrierId]);
    // The carrier they have no arrangement with is not in the list at all.
    expect(options.some((option) => option.logisticsPartnerId === rivalCarrierId)).toBe(false);

    // --- ...but only once they have confirmed the order --------------------
    //
    // A carrier offered work on an order the seller may still refuse has
    // been handed an obligation nobody agreed to, so this is refused until
    // the seller confirms. The confirmation itself, through the seller order
    // service, is covered in seller-logistics-assignment.test.ts.
    await expect(
      sellerAssignCarrier({
        sellerAccountId: sellerId,
        shipmentId,
        logisticsPartnerId: carrierId,
        sellerMemberId: null,
        actorEmail: 'ops@xyz.local',
      }),
    ).rejects.toMatchObject({ code: 'SELLER_ORDER_NOT_CONFIRMED' });

    await prisma.sellerOrderGroup.updateMany({ where: { orderId }, data: { status: 'ACCEPTED' } });

    // --- ...and assigns it --------------------------------------------------
    const offered = await sellerAssignCarrier({
      sellerAccountId: sellerId,
      shipmentId,
      logisticsPartnerId: carrierId,
      sellerMemberId: null,
      actorEmail: 'ops@xyz.local',
    });

    expect(offered.assignmentId).toBeTruthy();

    // --- 11. The carrier sees that consignment, and only that one ----------
    const carrierView = await listShipments(carrier, {});
    const visible = carrierView.rows.map((row) => row.id);

    expect(visible).toContain(shipmentId);

    // Nothing belonging to anybody else. The carrier's own list is scoped by
    // its assignment, not filtered by this test.
    const foreign = await prisma.logisticsShipment.count({
      where: { id: { in: visible }, assignedPartnerId: { not: carrierId } },
    });
    expect(foreign).toBe(0);

    // --- The carrier accepts, and XYZ is told ------------------------------
    await acceptAssignment(carrier, shipmentId);

    const accepted = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerId, kind: 'CARRIER_ACCEPTED' },
    });
    expect(accepted?.body).toContain('Vistula Freight');

    // --- 12/13. The carrier puts one of ITS OWN drivers on it --------------
    const driver = await prisma.logisticsDriverProfile.create({
      data: {
        id: newId(),
        logisticsPartnerId: carrierId,
        fullName: 'Marek Nowak',
        state: 'ACTIVE',
      },
    });

    // The CARRIER acting on its own fleet - never the seller, and never the
    // marketplace. `asPartner` is the shape that says so.
    await assignDriver(asPartner(carrier), {
      shipmentId,
      driverProfileId: driver.id,
    });

    const liveAssignment = await prisma.logisticsDriverAssignment.findFirst({
      where: { shipmentId, unassignedAt: null },
    });
    expect(liveAssignment?.driverProfileId).toBe(driver.id);

    // Exactly one live driver, enforced by the database rather than by a rule.
    const live = await prisma.logisticsDriverAssignment.count({
      where: { activeShipmentId: shipmentId },
    });
    expect(live).toBe(1);

    // --- 14. The operator can see the whole chain --------------------------
    const chain = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: {
        assignments: true,
        driverAssignments: { include: { driver: true } },
        assignedPartner: { select: { displayName: true } },
      },
    });

    // The seller is a snapshot name and an id, NOT a relation: a carrier
    // must not be able to join from a consignment to a seller's account.
    expect(chain.sellerCompanyName).toBe('XYZ Medical');
    expect(chain.sellerAccountId).toBe(sellerId);
    expect(chain.assignedPartner?.displayName).toBe('Vistula Freight');
    expect(chain.driverAssignments[0]?.driver.fullName).toBe('Marek Nowak');
    expect(chain.assignments.some((row) => row.state === 'ACCEPTED')).toBe(true);

    // --- 15. Tracking progresses through valid states only -----------------
    // The real chain, not a convenient one. Every hop below is a move the
    // state machine actually permits from the one before it - which is the
    // point: a consignment cannot jump from accepted to delivered, and this
    // walks the road a parcel walks.
    const ROUTE = [
      'PICKUP_SCHEDULED',
      'READY_FOR_PICKUP',
      'PICKED_UP',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
    ] as const;

    for (const status of ROUTE) {
      await recordShipmentEvent({
        shipmentId,
        status,
        actor: 'PARTNER',
        source: 'LOGISTICS_PORTAL',
        actorLogisticsPartnerId: carrierId,
        permissions: [...carrier.permissions],
        idempotencyKey: `acc-${status}`,
      });
    }

    // --- The last step is the proof, not a status anybody types ------------
    //
    // A consignment cannot be called delivered on somebody's say-so: the
    // state machine refuses `DELIVERED` without proof, and capturing the
    // proof is what performs the move. That is the right way round — a parcel
    // marked delivered with nothing behind it is precisely what the rule
    // exists to prevent — and it is why this is not another loop iteration.
    await captureProofOfDelivery(carrier, {
      shipmentId,
      recipientName: 'A. Kowalska',
      recipientDesignation: 'Ward sister',
    });

    const delivered = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: shipmentId },
    });
    expect(delivered.status).toBe('DELIVERED');

    // --- 16/18. The timeline is the record, and it is append-only ----------
    const events = await prisma.logisticsShipmentEvent.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.length).toBeGreaterThanOrEqual(4);

    // A redelivered event writes nothing. Two unique indexes do this, not a
    // check-then-insert.
    await recordShipmentEvent({
      shipmentId,
      status: 'OUT_FOR_DELIVERY',
      actor: 'PARTNER',
      source: 'LOGISTICS_PORTAL',
      actorLogisticsPartnerId: carrierId,
      permissions: [...carrier.permissions],
      idempotencyKey: 'acc-OUT_FOR_DELIVERY',
    });

    const afterReplay = await prisma.logisticsShipmentEvent.count({ where: { shipmentId } });
    expect(afterReplay).toBe(events.length);

    // --- 17. Nothing is left active that has been resolved -----------------
    const activeAlerts = await prisma.sellerNotification.count({
      where: { sellerAccountId: sellerId, status: 'ACTIVE', class: 'ALERT' },
    });
    expect(activeAlerts).toBe(0);

    // --- 19/20. The order keeps what it was charged ------------------------
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.grandTotalMinor).toBe(9_000n);
    expect(order.currency).toBe('INR');
  });
});
