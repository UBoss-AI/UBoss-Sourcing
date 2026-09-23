/**
 * A seller who delivers their own goods, from setting it up to the van.
 *
 * The companion to `acceptance-seller-to-doorstep.test.ts`, which walks the
 * other half of the split: there a seller hands a parcel to a haulage company
 * on this platform; here they run the operation themselves. One test rather
 * than fifteen, and its value is not in any single assertion — the files next
 * door cover each step far more thoroughly — but in the seam:
 *
 *     choose self-managed → create the delivery arm → marketplace approves →
 *     say where it collects from, where it delivers to, what it may carry and
 *     what it charges → a paid order raises a consignment → the picker
 *     chooses this method by itself → book the van → the goods are ready
 *
 * A service that works alone and refuses the shape the previous step actually
 * produces is exactly what this catches, and nothing in it is stubbed.
 *
 * WHAT IS DELIBERATELY REAL
 *
 * The method, the organisation, the approval, every piece of configuration,
 * the consignment, the automatic choice of method, and the collection. The
 * only thing written directly rather than driven through its own service is
 * the ORDER, for the same reason the other acceptance test gives: reproducing
 * a checkout here would test checkout.
 *
 * NO OUTBOUND REQUEST IS MADE. The operation is the seller's own, so there is
 * no carrier to call — which is the point of this path, and is why it can be
 * proven end to end in a test at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { setPartnerStatus } from '../../src/modules/logistics/admin.service.js';
import {
  createShipmentsForOrder,
  handConsignmentOnAfterConfirmation,
} from '../../src/modules/logistics/shipment-create.service.js';
import {
  chooseFulfilmentMethod,
  decideFulfilmentMethod,
  listFulfilmentMethods,
  upsertFulfilmentRule,
  type SellerActor,
} from '../../src/modules/seller/fulfilment-method.service.js';
import { createSelfManagedOrganisation } from '../../src/modules/seller/logistics-organisation.service.js';
import {
  confirmReadiness,
  listPickups,
  schedulePickup,
} from '../../src/modules/seller/pickup.service.js';
import {
  listCapabilities,
  listRateCards,
  listServiceAreas,
  publishRateCard,
  requestCapability,
  savePickupProfile,
  saveServiceArea,
} from '../../src/modules/seller/self-managed-config.service.js';

const SELLER_SLUG = 'OWN-DELIVERY-CO';
const BUYER_EMAIL = 'buyer@owndelivery.local';
const STAFF_EMAIL = 'staff@owndelivery.local';
const OPS_EMAIL = 'fleet@owndelivery.local';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Own Delivery Co' };

let sellerId = '';
let adminUserId = '';
let locationId = '';
let orderId = '';
let methodId = '';
let partnerId = '';

const DELIVERY = {
  line1: '2 Clinic Way',
  city: 'Mumbai',
  postalCode: '400001',
  countryCode: 'IN',
};

async function cleanUp(): Promise<void> {
  const sellerIds = (
    await prisma.sellerAccount.findMany({ where: { slug: SELLER_SLUG }, select: { id: true } })
  ).map((row) => row.id);

  const orderIds = (
    await prisma.order.findMany({
      where: { orderNumber: { startsWith: 'UB-OWND-' } },
      select: { id: true },
    })
  ).map((row) => row.id);

  const shipmentIds = (
    await prisma.logisticsShipment.findMany({
      where: { OR: [{ sellerAccountId: { in: sellerIds } }, { orderId: { in: orderIds } }] },
      select: { id: true },
    })
  ).map((row) => row.id);

  const partnerIds = (
    await prisma.logisticsPartner.findMany({
      where: { ownerSellerAccountId: { in: sellerIds } },
      select: { id: true },
    })
  ).map((row) => row.id);

  // Children first. Most of these cascade from the seller account, and the
  // ones that do not are exactly the ones that make the NEXT run's first file
  // fail - which is the hardest failure in this suite to attribute.
  await prisma.logisticsPickupRequest.deleteMany({
    where: { OR: [{ sellerAccountId: { in: sellerIds } }, { shipmentId: { in: shipmentIds } }] },
  });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.logisticsShipmentAssignment.deleteMany({
    where: { shipmentId: { in: shipmentIds } },
  });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });

  await prisma.sellerLogisticsRateBand.deleteMany({
    where: { rateCard: { sellerAccountId: { in: sellerIds } } },
  });
  await prisma.sellerLogisticsRateCard.deleteMany({
    where: { sellerAccountId: { in: sellerIds } },
  });
  await prisma.sellerLogisticsPickupProfile.deleteMany({
    where: { sellerAccountId: { in: sellerIds } },
  });
  await prisma.sellerFulfilmentRule.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });

  await prisma.logisticsServiceRegion.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsCapability.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { logisticsPartnerId: { in: partnerIds } },
  });
  await prisma.logisticsAuditLog.deleteMany({ where: { logisticsPartnerId: { in: partnerIds } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });

  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: { in: orderIds } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOnboardingProgress.deleteMany({
    where: { sellerAccountId: { in: sellerIds } },
  });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });

  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: 'ownd-' } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: 'ownd-' } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: 'ownd-' } } });
  await prisma.taxClass.deleteMany({ where: { code: 'OWNDTAX' } });
  await prisma.customerProfile.deleteMany({ where: { user: { email: BUYER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: '@owndelivery.local' } } });

  // The shipment-reference counter is shared and globally unique. Never reset.
}

beforeAll(async () => {
  await cleanUp();

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: SELLER_SLUG,
      legalName: 'Own Delivery Co Private Limited',
      displayName: 'Own Delivery Co',
      displayNameNormalized: 'owndeliveryco',
      registrationCountry: 'IN',
      kind: 'WHOLESALER',
      status: 'APPROVED',
    },
  });

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

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'OWNDTAX',
      name: 'Own delivery zero',
      ratePercent: '0.000000',
      isInclusive: false,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Own delivery', slug: 'ownd-consumables', isActive: true },
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
      name: 'Sterile Swabs',
      slug: 'ownd-swabs',
      sku: 'OWND-SWAB-1',
      basePriceMinor: 12_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });

  const offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerId,
      productId: product.id,
      variantKey: '',
      sellerSku: 'OWND-SWAB-1',
      status: 'ACTIVE',
      priceMinor: 11_000n,
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
    data: { id: newId(), userId: buyer.id, fullName: 'Mumbai Clinic' },
  });

  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      code: 'OWND-WH',
      name: 'Delhi depot',
      addressLine1: '1 Depot Road',
      city: 'Delhi',
      postcode: '110001',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      dispatchCutoff: '16:00',
      workingDaysMask: 31,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });
  locationId = location.id;

  // A paid, confirmed order. Written directly rather than through checkout:
  // what matters downstream is that it is CONFIRMED with a seller group, which
  // is exactly the state a signature-verified payment webhook leaves it in.
  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-OWND-${newId().slice(-8)}`,
      customerProfileId: profile.id,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 11_000n,
      taxMinor: 0n,
      grandTotalMinor: 11_000n,
      paidMinor: 11_000n,
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
      productId: product.id,
      sellerOfferId: offerId,
      nameSnapshot: 'Sterile Swabs',
      skuSnapshot: 'OWND-SWAB-1',
      taxClassCodeSnapshot: 'OWNDTAX',
      unitPriceMinor: 11_000n,
      quantity: 1,
      lineSubtotalMinor: 11_000n,
      discountMinor: 0n,
      taxRatePercent: '0.000000',
      taxInclusive: false,
      taxAmountMinor: 0n,
      lineTotalMinor: 11_000n,
    },
  });

  const groupId = newId();
  await prisma.sellerOrderGroup.create({
    data: {
      id: groupId,
      sellerAccountId: sellerId,
      orderId,
      sellerOrderNumber: `SO-OWND-${newId().slice(-6)}`,
      status: 'NEW',
      currency: 'INR',
      locationId,
      goodsTotalMinor: 11_000n,
      sellerNetMinor: 11_000n,
    },
  });

  await prisma.sellerOrderLine.create({
    data: {
      id: newId(),
      orderGroupId: groupId,
      orderItemId,
      offerId,
      quantity: 1,
      unitPriceMinor: 11_000n,
      lineTotalMinor: 11_000n,
      sellerNetMinor: 11_000n,
      currency: 'INR',
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('a seller who delivers their own goods', () => {
  it('runs the whole chain, from choosing the mode to the van being booked', async () => {
    // --- 1. The seller chooses to do it themselves -------------------------
    const method = await chooseFulfilmentMethod({
      sellerAccountId: sellerId,
      actor: ACTOR,
      mode: 'SELF_MANAGED',
      provider: null,
      environment: null,
      publicDisplayName: 'Own Delivery Fleet',
      makePrimary: true,
    });

    methodId = method.id;

    // PENDING_SETUP, and nothing more. Choosing a mode is not the same as
    // having an operation, and a method that went straight to usable would let
    // a paid order be routed to a fleet that does not exist yet.
    expect(method.status).toBe('PENDING_SETUP');

    // --- 2. They create the delivery arm and invite whoever will run it ----
    const organisation = await createSelfManagedOrganisation({
      sellerAccountId: sellerId,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      displayName: 'Own Delivery Fleet',
      legalName: 'Own Delivery Fleet Private Limited',
      registrationCountry: 'IN',
      contactEmail: 'ops@owndelivery.example',
      operationsOwnerEmail: OPS_EMAIL,
      operationsOwnerName: 'Fleet Manager',
    });

    partnerId = organisation.logisticsPartnerId;

    // The invitation went to an address, and the token is not in the answer.
    expect(organisation.invitedEmail).toBe(OPS_EMAIL);

    const afterOrganisation = await listFulfilmentMethods(sellerId);

    // PENDING_APPROVAL, not approved. A seller declaring they can deliver is a
    // statement until the marketplace has looked, and it is the marketplace
    // that decides.
    expect(afterOrganisation[0]?.status).toBe('PENDING_APPROVAL');

    // --- 3. The marketplace approves it ------------------------------------
    const approved = await decideFulfilmentMethod({
      fulfilmentMethodId: methodId,
      to: 'APPROVED',
      decidedByUserId: adminUserId,
      reason: null,
    });

    expect(approved.status).toBe('APPROVED');

    // ...and the seller is told, on their own feed, without having to look.
    const decision = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerId, kind: 'FULFILMENT_METHOD_DECISION' },
    });
    expect(decision).not.toBeNull();

    /*
     * The delivery arm itself is activated separately, and that is not a
     * formality.
     *
     * `createSelfManagedOrganisation` leaves it PENDING_ACTIVATION, because
     * the person who will run the fleet has been invited and has not yet
     * accepted their portal account. Until they have, the organisation is a
     * row rather than an operation - and the picker below WILL NOT choose it,
     * which is the behaviour that stops a paid order being routed to a fleet
     * nobody has signed into yet.
     */
    const beforeActivation = await prisma.logisticsPartner.findUniqueOrThrow({
      where: { id: partnerId },
      select: { status: true },
    });
    expect(beforeActivation.status).toBe('PENDING_ACTIVATION');

    await setPartnerStatus(
      { userId: adminUserId, email: STAFF_EMAIL, permissions: [] },
      partnerId,
      'ACTIVE',
      null,
    );

    // --- 4. Where it collects from ----------------------------------------
    const pickupProfile = await savePickupProfile({
      sellerAccountId: sellerId,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      sellerLocationId: locationId,
      pickupDaysMask: 31,
      windowStart: '09:00',
      windowEnd: '17:00',
      maxDailyShipments: 60,
      instructions: 'Bay 3, ring the bell on the left.',
    });

    expect(pickupProfile.locationName).toBe('Delhi depot');

    // --- 5. Where it delivers to, and where it does not -------------------
    await saveServiceArea({
      sellerAccountId: sellerId,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      scope: 'COUNTRY',
      countryCode: 'IN',
      transitDaysMin: 1,
      transitDaysMax: 4,
    });

    await saveServiceArea({
      sellerAccountId: sellerId,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      scope: 'STATE',
      countryCode: 'IN',
      regionValue: 'Andaman and Nicobar Islands',
      isExclusion: true,
    });

    const areas = await listServiceAreas(sellerId, methodId);

    // Two rows, and the exclusion is stored AS an exclusion. "The whole of
    // India except the islands" is the shape real coverage takes, and an
    // inclusion-only model loses the exception silently.
    expect(areas).toHaveLength(2);
    expect(areas.filter((area) => area.isExclusion)).toHaveLength(1);

    // --- 6. What it is allowed to carry -----------------------------------
    const asked = await requestCapability({
      sellerAccountId: sellerId,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      kind: 'STERILE_HANDLING',
      evidenceReference: 'CERT-STERILE-2026',
    });

    // REQUESTED. There is no argument to this function that would let a seller
    // approve their own, because the approval is the whole difference between
    // a claim and a fact.
    expect(asked.state).toBe('REQUESTED');

    await prisma.logisticsCapability.update({
      where: { id: asked.id },
      data: { state: 'APPROVED', decidedByUserId: adminUserId, decidedAt: new Date() },
    });

    const capabilities = await listCapabilities(sellerId, methodId);
    expect(capabilities[0]?.state).toBe('APPROVED');

    // --- 7. What it charges ------------------------------------------------
    const card = await publishRateCard({
      sellerAccountId: sellerId,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      name: 'Domestic standard',
      currency: 'INR',
      minimumChargeMinor: 5_000n,
      bands: [
        { basis: 'WEIGHT', minValue: 0, maxValue: 5_000, amountMinor: '9900' },
        {
          basis: 'WEIGHT',
          minValue: 5_001,
          maxValue: null,
          amountMinor: '9900',
          perUnitMinor: '40',
        },
      ],
    });

    expect(card.version).toBe(1);
    expect(card.isActive).toBe(true);
    // Minor units as STRINGS the whole way. A delivery charge that passed
    // through a JavaScript number is one that can disagree with the invoice.
    expect(card.bands[1]?.perUnitMinor).toBe('40');

    // --- 8. A rule, so the choice is not merely "the default" -------------
    await upsertFulfilmentRule({
      sellerAccountId: sellerId,
      actor: ACTOR,
      scope: 'WAREHOUSE',
      fulfilmentMethodId: methodId,
      sellerLocationId: locationId,
      note: 'Everything out of Delhi goes on our own vans.',
    });

    // --- 9. The paid order raises a consignment ----------------------------
    const raised = await createShipmentsForOrder(orderId, null);
    expect(raised).toHaveLength(1);

    // A redelivered payment webhook raises nothing new.
    expect(await createShipmentsForOrder(orderId, null)).toHaveLength(1);

    const consignment = await prisma.logisticsShipment.findFirstOrThrow({
      where: { orderId },
      select: {
        id: true,
        shipmentReference: true,
        sellerFulfilmentMethodId: true,
        assignedPartnerId: true,
        sellerCarrierConnectionId: true,
      },
    });

    // --- 10. The picker chose this method, without anybody being asked ----
    //
    // The whole point of the configuration above. A seller who has said where
    // they collect from, where they deliver and what they can carry should not
    // then have to choose a carrier by hand on every order.
    expect(consignment.sellerFulfilmentMethodId).toBe(methodId);

    // ...but it is NOT offered to anybody yet. The seller has not confirmed
    // the order, and a fleet offered work the seller may still refuse has
    // been given an obligation nobody agreed to.
    expect(consignment.assignedPartnerId).toBeNull();

    // --- 10b. The seller confirms, and the rule hands it on ---------------
    //
    // The confirmation itself, through the seller order service, is covered
    // in seller-logistics-assignment.test.ts. Here the group is marked
    // confirmed and the SAME hook that service calls is run.
    await prisma.sellerOrderGroup.updateMany({ where: { orderId }, data: { status: 'ACCEPTED' } });
    await handConsignmentOnAfterConfirmation(consignment.id);

    const handedOn = await prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: consignment.id },
      select: { assignedPartnerId: true },
    });
    expect(handedOn.assignedPartnerId).toBe(partnerId);
    // Nobody's external account is involved: this is the seller's own fleet.
    expect(consignment.sellerCarrierConnectionId).toBeNull();

    // ...so no alert was raised. "This paid order has nothing to carry it" is
    // the one notification that must NOT appear on a correctly set-up seller's
    // bell, and a system that raised it anyway would teach them to ignore it.
    const stuck = await prisma.sellerNotification.count({
      where: {
        sellerAccountId: sellerId,
        kind: 'CONSIGNMENT_AWAITING_METHOD',
        status: 'ACTIVE',
      },
    });
    expect(stuck).toBe(0);

    // --- 11. The van is booked --------------------------------------------
    const pickup = await schedulePickup({
      sellerAccountId: sellerId,
      actor: ACTOR,
      shipmentId: consignment.id,
      windowStartAt: new Date('2026-10-05T09:00:00.000Z'),
      windowEndAt: new Date('2026-10-05T12:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      instructions: 'Bay 3, ring the bell on the left.',
    });

    // REQUESTED, and no confirmation number. This is the seller's own fleet:
    // there is nobody external to call, and a reference here would be one this
    // system invented.
    expect(pickup.state).toBe('REQUESTED');
    expect(pickup.carrierConfirmationNumber).toBeNull();
    expect(pickup.arrangedWith).toBe('Own Delivery Fleet');

    // A second van for the same parcel is refused by the database.
    await expect(
      schedulePickup({
        sellerAccountId: sellerId,
        actor: ACTOR,
        shipmentId: consignment.id,
        windowStartAt: new Date('2026-10-05T14:00:00.000Z'),
        windowEndAt: new Date('2026-10-05T16:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'PICKUP_ALREADY_BOOKED' });

    // --- 12. The goods are on the dock ------------------------------------
    const confirmed = await confirmReadiness({
      sellerAccountId: sellerId,
      actor: ACTOR,
      pickupId: pickup.id,
    });

    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.readinessConfirmedAt).not.toBeNull();

    const live = await listPickups(sellerId, { liveOnly: true });
    expect(live).toHaveLength(1);
    expect(live[0]?.shipmentReference).toBe(consignment.shipmentReference);

    // --- And the price list is still there, at the version it was ---------
    const cards = await listRateCards(sellerId, methodId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.version).toBe(1);
  });
});
