/**
 * The four delivery levels, end to end, against a real database.
 *
 * One seller walks through all three control modes, prices every level the
 * way the brief's fixture does (L1 100, L2 200, L3 300, L4 400 on a product of
 * 10,000), a buyer checks out through the real `submitCheckout`, the order is
 * confirmed and split, the seller confirms it, and the four legs are carried
 * one after another by the people allowed to carry each one.
 *
 * Nothing about the pricing or the authority is stubbed. What is written
 * directly is only reference data: the seller, the product, the buyer's
 * address, and one delivery company.
 *
 * The 10% platform fee is a TEST FIXTURE on a SELLER-scoped policy, so no
 * other test file sees it. The 15% on the fee is the value this deployment was
 * asked to configure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole, SellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { addItem, resolveCart, toCartView } from '../../src/modules/cart/cart.service.js';
import { submitCheckout, transitionOrder } from '../../src/modules/orders/order.service.js';
import { policyForLevelChange } from '../../src/domain/logistics-levels.js';
import { transitionSellerOrder } from '../../src/modules/seller/order.service.js';
import {
  listProviders,
  publishPolicy,
  publishRate,
  readPolicy,
  savePolicyDraft,
  saveRate,
  setProvider,
  type SellerLogisticsEditor,
  type UbossLogisticsEditor,
} from '../../src/modules/logistics/level-policy.service.js';
import {
  assignLeg,
  legsForPartner,
  legsForSellerOrder,
  priceBreakdownForCustomer,
  transitionLeg,
  updateLegReferences,
} from '../../src/modules/logistics/shipment-leg.service.js';
import {
  createDraftPolicy,
  publishPolicy as publishFeePolicy,
  retirePolicy,
} from '../../src/modules/settings/platform-fee.service.js';

const SLUG_A = 'lvl-seller-a';
const SLUG_B = 'lvl-seller-b';
const PARTNER_CODE = 'LP-TEST-LEVELS';
/** The seller's own fleet: a delivery company UBOSS may never name. */
const FLEET_CODE = 'LP-TEST-LEVELS-FLEET';
const EMAIL_DOMAIN = '@levels.test.local';
const PRODUCT_SLUG = 'lvl-test-gloves';

let sellerA = '';
let sellerB = '';
let locationA = '';
let offerA = '';
let partnerId = '';
let customerProfileId = '';
let otherCustomerProfileId = '';
let addressId = '';
let adminUserId = '';
let feePolicyId = '';
let createdBusinessProfile: string | null = null;
let createdLocation: string | null = null;

let sellerEditor: SellerLogisticsEditor;
let rivalEditor: SellerLogisticsEditor;
let uboss: UbossLogisticsEditor;

const rateIds: Record<string, string> = {};

function membership(sellerAccountId: string, slug: string): SellerMembership {
  return {
    sellerAccountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: slug,
    legalName: `${slug} Ltd`,
    slug,
    status: 'APPROVED',
    role: SellerRole.OWNER,
    permissions: permissionsForSellerRole(SellerRole.OWNER),
    hasLock: true,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

async function cleanUp(): Promise<void> {
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } }, select: { id: true } })).map(
    (row) => row.id,
  );
  const orders = (
    await prisma.order.findMany({
      where: { customerProfile: { user: { emailNormalized: { endsWith: EMAIL_DOMAIN } } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const partners = (await prisma.logisticsPartner.findMany({ where: { partnerCode: { in: [PARTNER_CODE, FLEET_CODE] } }, select: { id: true } })).map(
    (row) => row.id,
  );

  const legIds = (await prisma.shipmentLeg.findMany({ where: { OR: [{ orderId: { in: orders } }, { sellerAccountId: { in: sellers } }] }, select: { id: true } })).map((row) => row.id);
  const feeIds = (await prisma.platformFeePolicy.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } })).map((row) => row.id);
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: [...sellers, ...orders, ...legIds, ...feeIds] } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: orders } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ resourceId: { in: [...orders, ...legIds, ...feeIds] } }, { actorEmail: { endsWith: EMAIL_DOMAIN } }] } });
  await prisma.shipmentLeg.deleteMany({ where: { OR: [{ orderId: { in: orders } }, { sellerAccountId: { in: sellers } }] } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.platformFeePolicy.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.orderLogisticsLeg.deleteMany({ where: { orderId: { in: orders } } });
  const shipments = (await prisma.logisticsShipment.findMany({ where: { orderId: { in: orders } }, select: { id: true } })).map((row) => row.id);
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipmentAssignment.deleteMany({ where: { shipmentId: { in: shipments } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipments } } });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: { in: orders } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });

  await prisma.logisticsLevelRate.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLogisticsPolicy.updateMany({ where: { sellerAccountId: { in: sellers } }, data: { activeVersionId: null } });
  await prisma.sellerLogisticsPolicyVersion.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLogisticsPolicy.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLogisticsProvider.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.logisticsNotification.deleteMany({ where: { logisticsPartnerId: { in: partners } } });
  await prisma.sellerLogisticsPartner.deleteMany({ where: { logisticsPartnerId: { in: partners } } });
  await prisma.logisticsPartner.deleteMany({ where: { id: { in: partners } } });

  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerInventoryMovement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.cartItem.deleteMany({ where: { cart: { customerProfile: { user: { emailNormalized: { endsWith: EMAIL_DOMAIN } } } } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { user: { emailNormalized: { endsWith: EMAIL_DOMAIN } } } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });

  await prisma.product.deleteMany({ where: { slug: PRODUCT_SLUG } });
  await prisma.category.deleteMany({ where: { slug: 'lvl-test-category' } });
  await prisma.taxClass.deleteMany({ where: { code: 'LVLZERO' } });
  await prisma.address.deleteMany({ where: { customerProfile: { user: { emailNormalized: { endsWith: EMAIL_DOMAIN } } } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: { endsWith: EMAIL_DOMAIN } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { endsWith: EMAIL_DOMAIN } } });
}

async function makeSeller(slug: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      slug,
      legalName: `${slug} Ltd`,
      displayName: slug,
      displayNameNormalized: slug.replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'IN',
      kind: 'MANUFACTURER',
      status: 'APPROVED',
    },
  });
  return id;
}

async function makeCustomer(local: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: `${local}${EMAIL_DOMAIN}`,
      emailNormalized: `${local}${EMAIL_DOMAIN}`,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: `Buyer ${local}`, preferredCountry: 'IN', preferredCurrency: 'INR' },
  });
  return profile.id;
}

/** A price for one level, published. The route is Mumbai -> Rotterdam. */
async function price(editor: SellerLogisticsEditor | UbossLogisticsEditor, level: 'L1' | 'L2' | 'L3' | 'L4', amountMinor: string) {
  const routeByLevel = {
    L1: { originLocationId: locationA, originPortCode: 'INNSA', transportMode: 'ROAD' as const, provider: 'DHL' as const },
    L2: { originPortCode: 'INNSA', destinationPortCode: 'NLRTM', destinationCountry: 'NL', transportMode: 'SEA' as const, provider: 'MANUAL' as const, providerLabel: 'Sea forwarder' },
    L3: { destinationPortCode: 'NLRTM', destinationHubCode: 'RTM-DC', destinationHubName: 'Rotterdam DC', destinationCountry: 'NL', transportMode: 'ROAD' as const, provider: 'DHL' as const },
    L4: { destinationHubCode: 'RTM-DC', destinationCountry: 'NL', transportMode: 'ROAD' as const, provider: 'FEDEX' as const },
  };
  const saved = await saveRate(editor, {
    sellerAccountId: sellerA,
    level,
    ...routeByLevel[level],
    amountMinor,
    currency: 'INR',
    transitDaysMin: 1,
    transitDaysMax: 3,
  });
  const published = await publishRate(editor, { sellerAccountId: sellerA, rateId: saved.id });
  rateIds[`${editor.kind}:${level}`] = published.id;
  return published;
}

beforeAll(async () => {
  await cleanUp();

  if ((await prisma.businessProfile.count()) === 0) {
    createdBusinessProfile = newId();
    await prisma.businessProfile.create({
      data: {
        id: createdBusinessProfile,
        legalName: 'UBOSS Levels Test',
        displayName: 'UBOSS',
        supportEmail: 'support@levels.test.local',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      },
    });
  }

  // The cart reads the operator's default warehouse for its own stock, even on
  // a basket of marketplace lines. Other files delete every warehouse.
  if ((await prisma.inventoryLocation.count({ where: { isDefault: true } })) === 0) {
    createdLocation = newId();
    await prisma.inventoryLocation.create({
      data: { id: createdLocation, code: 'LVL-MAIN', name: 'Levels main', isDefault: true, isActive: true },
    });
  }

  sellerA = await makeSeller(SLUG_A);
  sellerB = await makeSeller(SLUG_B);

  sellerEditor = { kind: 'SELLER', sellerAccountId: sellerA, userId: null, label: SLUG_A };
  rivalEditor = { kind: 'SELLER', sellerAccountId: sellerB, userId: null, label: SLUG_B };

  const admin = await prisma.user.create({
    data: { id: newId(), type: 'ADMIN', email: `ops${EMAIL_DOMAIN}`, emailNormalized: `ops${EMAIL_DOMAIN}`, status: 'ACTIVE' },
  });
  adminUserId = admin.id;
  uboss = { kind: 'UBOSS', userId: adminUserId, email: `ops${EMAIL_DOMAIN}` };

  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: sellerA,
      code: 'LVL-PLANT',
      name: 'Mumbai plant',
      addressLine1: '1 MIDC Road',
      city: 'Mumbai',
      postcode: '400001',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      isOperational: true,
    },
  });
  locationA = location.id;

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: 'LVLZERO', name: 'Levels zero', ratePercent: '0.000000', isInclusive: false, isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Levels', slug: 'lvl-test-category', isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile gloves',
      slug: PRODUCT_SLUG,
      sku: 'LVL-GLOVE',
      basePriceMinor: 1_000_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });

  offerA = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerA,
      sellerAccountId: sellerA,
      productId: product.id,
      variantKey: '',
      sellerSku: 'A-GLOVE',
      status: 'ACTIVE',
      priceMinor: 1_000_000n, // ₹10,000
      currency: 'INR',
      taxClassId: taxClass.id,
      availableQuantity: 50,
    },
  });
  await prisma.sellerInventory.create({
    data: { id: newId(), sellerAccountId: sellerA, offerId: offerA, locationId: locationA, availableQuantity: 50 },
  });

  const partner = await prisma.logisticsPartner.create({
    data: {
      id: newId(),
      partnerCode: PARTNER_CODE,
      legalName: 'Levels Haulage Pvt Ltd',
      displayName: 'Levels Haulage',
      displayNameNormalized: 'levelshaulage',
      registrationCountry: 'IN',
      contactEmail: `haulage${EMAIL_DOMAIN}`,
      status: 'ACTIVE',
      contractStatus: 'ACTIVE',
      partnerKind: 'MARKETPLACE_CARRIER',
    },
  });
  partnerId = partner.id;

  customerProfileId = await makeCustomer('buyer');
  otherCustomerProfileId = await makeCustomer('other');
  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Rotterdam Clinic',
      contactPhone: '+31 10 000 0000',
      line1: 'Coolsingel 1',
      city: 'Rotterdam',
      state: 'ZH',
      postalCode: '3011 AA',
      country: 'NL',
      isDefaultShipping: true,
      isDefaultBilling: true,
    },
  });
  addressId = address.id;
});

afterAll(async () => {
  await cleanUp();
  if (createdLocation !== null) {
    await prisma.inventoryLocation.deleteMany({ where: { id: createdLocation } });
  }
  if (createdBusinessProfile !== null) {
    await prisma.businessProfile.deleteMany({ where: { id: createdBusinessProfile } });
  }
  await prisma.$disconnect();
});

// --- Carriers without credentials --------------------------------------------

describe('carriers with no API account', () => {
  it('starts every carrier as NOT_CONFIGURED, and never CONNECTED', async () => {
    const providers = await listProviders(sellerA);
    expect(providers.map((row) => row.connectionState)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
  });

  it('lets DHL, FedEx and India Post be switched on in MANUAL_ONLY mode', async () => {
    for (const provider of ['DHL', 'FEDEX', 'INDIA_POST', 'MANUAL'] as const) {
      const view = await setProvider({ editor: sellerEditor, provider, enabled: true, connectionMode: 'MANUAL_ONLY' });
      expect(view.connectionState).toBe('MANUAL_ONLY');
      expect(view.enabled).toBe(true);
    }
    // Asking for API mode with no account saved creates no connection.
    const dhl = await setProvider({ editor: sellerEditor, provider: 'DHL', enabled: true, connectionMode: 'API' });
    expect(dhl.connectionState).not.toBe('CONNECTED');
    expect(await prisma.sellerCarrierConnection.count({ where: { sellerAccountId: sellerA } })).toBe(0);
    await setProvider({ editor: sellerEditor, provider: 'DHL', enabled: true, connectionMode: 'MANUAL_ONLY' });
  });

  it('keeps India Post honest: it is manual even if API is asked for', async () => {
    const view = await setProvider({ editor: sellerEditor, provider: 'INDIA_POST', enabled: true, connectionMode: 'API' });
    expect(view.requestedMode).toBe('MANUAL_ONLY');
    expect(view.hasVerifiedApi).toBe(false);
  });
});

// --- Self -----------------------------------------------------------------

describe('Self mode', () => {
  it('gives the seller all four levels', async () => {
    await savePolicyDraft(sellerEditor, { mode: 'SELF' });
    const policy = await publishPolicy(sellerEditor, {});
    expect(policy.active?.owners).toEqual({ L1: 'SELLER', L2: 'SELLER', L3: 'SELLER', L4: 'SELLER' });
    expect(policy.levels.every((level) => level.editableBySeller)).toBe(true);
  });

  it('shows a level with no price as needing one, not as free', async () => {
    const policy = await readPolicy(sellerA, 'SELLER');
    expect(policy.levels.map((level) => level.pricingStatus)).toEqual(['PRICE_REQUIRED', 'PRICE_REQUIRED', 'PRICE_REQUIRED', 'PRICE_REQUIRED']);
    expect(policy.routesCanBeOffered).toBe(false);
  });

  it('lets the seller price and publish all four levels', async () => {
    for (const [level, amount] of [['L1', '10000'], ['L2', '20000'], ['L3', '30000'], ['L4', '40000']] as const) {
      const rate = await price(sellerEditor, level, amount);
      expect(rate.status).toBe('PUBLISHED');
    }
    expect((await readPolicy(sellerA, 'SELLER')).routesCanBeOffered).toBe(true);
  });

  it('refuses an empty price as zero, and free without a confirmation', async () => {
    const draft = await saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L4', transportMode: 'ROAD', provider: 'FEDEX', destinationCountry: 'DE', amountMinor: '' });
    expect(draft.price).toBeNull();
    await expect(publishRate(sellerEditor, { sellerAccountId: sellerA, rateId: draft.id })).rejects.toMatchObject({ code: 'LOGISTICS_RATE_INCOMPLETE' });
    await expect(
      saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L4', transportMode: 'ROAD', provider: 'FEDEX', amountMinor: '0' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_PRICE_INVALID' });
    await expect(
      saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L4', transportMode: 'ROAD', provider: 'FEDEX', isFree: true }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_FREE_NOT_CONFIRMED' });
  });

  it('refuses a sea leg on DHL, and a carrier the seller has not switched on', async () => {
    await expect(
      saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L2', transportMode: 'SEA', provider: 'DHL', amountMinor: '100' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_CARRIER_UNSUITABLE' });
    await setProvider({ editor: sellerEditor, provider: 'INDIA_POST', enabled: false, connectionMode: 'MANUAL_ONLY' });
    await expect(
      saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L4', transportMode: 'POSTAL', provider: 'INDIA_POST', amountMinor: '100' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_PROVIDER_NOT_ENABLED' });
  });

  it('shows UBOSS the configuration, and lets it edit none of it', async () => {
    const view = await readPolicy(sellerA, 'UBOSS');
    expect(view.active?.mode).toBe('SELF');
    await expect(
      saveRate(uboss, { sellerAccountId: sellerA, level: 'L2', transportMode: 'AIR', provider: 'DHL', amountMinor: '100' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED' });
  });

  it('keeps another seller out entirely', async () => {
    await expect(
      saveRate(rivalEditor, { sellerAccountId: sellerA, level: 'L1', transportMode: 'ROAD', provider: 'DHL', amountMinor: '1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(publishRate(rivalEditor, { sellerAccountId: sellerB, rateId: rateIds['SELLER:L1'] ?? '' })).rejects.toMatchObject({
      statusCode: 404,
    });
    // B's own policy shows none of A's prices.
    const rivalView = await readPolicy(sellerB, 'SELLER');
    expect(rivalView.levels.flatMap((level) => level.rates)).toHaveLength(0);
  });
});

// --- Pricing a basket, and checkout ----------------------------------------------

let firstOrderId = '';

describe('what the buyer pays', () => {
  it('prices product + L1 + L2 + L3 + L4 as the brief says: 10,000 + 1,000 = 11,000', async () => {
    await addItem(customerProfileId, { productId: (await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerA } })).productId, quantity: 1, sellerOfferId: offerA });
    const view = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));

    expect(view.delivery?.quoteRequired).toBe(false);
    expect(view.delivery?.sellers[0]?.levels.map((level) => level.amount)).toEqual(['10000', '20000', '30000', '40000']);
    expect(view.delivery?.total).toBe('100000');
    expect(view.totals.subtotal.minor).toBe('1000000');
    expect(view.totals.shipping.minor).toBe('100000');
    expect(view.totals.grandTotal.minor).toBe('1100000');
  });

  it('says quote required, never zero, for a destination nobody priced', async () => {
    const view = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'AE', destinationPostcode: null }));
    expect(view.delivery?.quoteRequired).toBe(true);
    expect(view.delivery?.sellers[0]?.total).toBeNull();
    expect(view.checkoutReady).toBe(false);
    expect(view.blockingIssues.map((issue) => issue.code)).toContain('LOGISTICS_QUOTE_REQUIRED');
  });

  it('refuses a checkout carrying a tampered or missing delivery quote', async () => {
    const view = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));
    const token = view.delivery?.token ?? '';
    const forged = `${token.slice(0, -2)}xx`;

    for (const logisticsQuoteToken of [forged, null]) {
      await expect(
        submitCheckout({
          customerProfileId,
          shippingAddressId: addressId,
          paymentMode: 'ONLINE',
          logisticsQuoteToken,
          actor: { userId: null, email: `buyer${EMAIL_DOMAIN}`, type: 'CUSTOMER' },
        }),
      ).rejects.toMatchObject({ code: 'LOGISTICS_PRICE_CHANGED' });
    }
  });

  it('checks out at the reviewed total and freezes every level on the order', async () => {
    const view = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));
    const result = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      paymentMode: 'ONLINE',
      logisticsQuoteToken: view.delivery?.token ?? '',
      actor: { userId: null, email: `buyer${EMAIL_DOMAIN}`, type: 'CUSTOMER' },
    });
    firstOrderId = result.orderId;

    expect(result.totals.grandTotal.minor).toBe('1100000');
    const legs = await prisma.orderLogisticsLeg.findMany({ where: { orderId: firstOrderId }, orderBy: { level: 'asc' } });
    expect(legs.map((leg) => [leg.level, leg.owner, leg.amountMinor])).toEqual([
      ['L1', 'SELLER', 10_000n],
      ['L2', 'SELLER', 20_000n],
      ['L3', 'SELLER', 30_000n],
      ['L4', 'SELLER', 40_000n],
    ]);
    // Priced in the order's own currency: no conversion, so no rate recorded.
    expect(legs.every((leg) => leg.fxRate === null && leg.originalCurrency === 'INR')).toBe(true);
  });

  it('keeps the order’s delivery charges when the price changes afterwards', async () => {
    const replacement = await saveRate(sellerEditor, {
      sellerAccountId: sellerA,
      rateId: rateIds['SELLER:L4'] ?? '',
      level: 'L4',
      destinationHubCode: 'RTM-DC',
      destinationCountry: 'NL',
      transportMode: 'ROAD',
      provider: 'FEDEX',
      amountMinor: '45000',
    });
    await publishRate(sellerEditor, { sellerAccountId: sellerA, rateId: replacement.id });

    const frozen = await prisma.orderLogisticsLeg.findFirstOrThrow({ where: { orderId: firstOrderId, level: 'L4' } });
    expect(frozen.amountMinor).toBe(40_000n);
    const old = await prisma.logisticsLevelRate.findUniqueOrThrow({ where: { id: rateIds['SELLER:L4'] ?? '' } });
    expect(old.status).toBe('SUPERSEDED');
  });

  it('shows the buyer the breakdown of their own order, and nobody else’s', async () => {
    const breakdown = await priceBreakdownForCustomer(customerProfileId, firstOrderId);
    expect(breakdown.sellerDelivery.minor).toBe('100000');
    expect(breakdown.sellers[0]?.levels.map((level) => level.amount?.minor)).toEqual(['10000', '20000', '30000', '40000']);
    await expect(priceBreakdownForCustomer(otherCustomerProfileId, firstOrderId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

// --- Platform fee ------------------------------------------------------------

describe('the platform fee and the tax on it', () => {
  it('settles the order on the policy in force: 10,000 - 1,000 fee - 150 tax', async () => {
    const draft = await createDraftPolicy(
      { userId: adminUserId, email: `ops${EMAIL_DOMAIN}` },
      {
        scope: 'SELLER',
        sellerAccountId: sellerA,
        name: 'Levels test fixture',
        feeType: 'PERCENT',
        feeBasis: 'PRODUCT_SUBTOTAL',
        percentRate: '10',
        currency: 'INR',
        taxRatePercent: '15',
      },
    );
    const published = await publishFeePolicy({ userId: adminUserId, email: `ops${EMAIL_DOMAIN}` }, draft.id);
    feePolicyId = published.id;
    expect(published.isTaxRuleVerified).toBe(false);
    expect(published.taxDisplayLabel).toBe('Tax on platform fee - configured 15%');

    await transitionOrder({ orderId: firstOrderId, to: 'CONFIRMED', actor: { userId: null, email: null, type: 'SYSTEM' }, reason: 'Test payment' });

    const settlement = await prisma.sellerOrderSettlement.findFirstOrThrow({ where: { sellerAccountId: sellerA } });
    expect(settlement.grossProceedsMinor).toBe(1_000_000n);
    expect(settlement.platformFeeMinor).toBe(100_000n);
    expect(settlement.platformFeeTaxMinor).toBe(15_000n);
    // Self mode: every delivery level was the seller's, so all of it is theirs.
    expect(settlement.sellerDeliveryProceedsMinor).toBe(100_000n);
    expect(settlement.estimatedSettlementMinor).toBe(1_000_000n + 100_000n - 100_000n - 15_000n);
    expect(settlement.platformFeePolicyId).toBe(feePolicyId);
    expect(settlement.feeTaxVerified).toBe(false);
    expect(settlement.feeTaxLabel).not.toContain('GST');

    // The buyer paid goods + delivery. The fee and its tax are nowhere in it.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: firstOrderId } });
    expect(order.grandTotalMinor).toBe(1_100_000n);
  });

  it('leaves the settlement alone when a new fee version is published', async () => {
    const actor = { userId: adminUserId, email: `ops${EMAIL_DOMAIN}` };
    const next = await createDraftPolicy(actor, {
      scope: 'SELLER',
      sellerAccountId: sellerA,
      name: 'Levels test fixture v2',
      feeType: 'PERCENT',
      feeBasis: 'PRODUCT_SUBTOTAL',
      percentRate: '20',
      currency: 'INR',
      taxRatePercent: '15',
    });
    await publishFeePolicy(actor, next.id);

    const old = await prisma.platformFeePolicy.findUniqueOrThrow({ where: { id: feePolicyId } });
    expect(old.status).toBe('RETIRED');
    const settlement = await prisma.sellerOrderSettlement.findFirstOrThrow({ where: { sellerAccountId: sellerA } });
    expect(settlement.platformFeeMinor).toBe(100_000n);
    expect(settlement.platformFeePolicyId).toBe(feePolicyId);
    await retirePolicy(actor, next.id);
  });
});

// --- Legs --------------------------------------------------------------------

describe('carrying the order, level by level', () => {
  let groupId = '';

  it('creates four legs, with the owners frozen at checkout, when the seller confirms', async () => {
    const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: firstOrderId, sellerAccountId: sellerA } });
    groupId = group.id;
    expect(await prisma.shipmentLeg.count({ where: { sellerOrderGroupId: groupId } })).toBe(0);

    await transitionSellerOrder({ membership: membership(sellerA, SLUG_A), groupId, to: 'ACCEPTED', locationId: locationA });

    const legs = await legsForSellerOrder(sellerA, groupId);
    // Every price named its carrier, so each leg arrives with it: L1 is
    // ASSIGNED straight away, the rest are planned and wait their turn.
    expect(legs.map((leg) => [leg.level, leg.owner, leg.status])).toEqual([
      ['L1', 'SELLER', 'ASSIGNED'],
      ['L2', 'SELLER', 'PENDING'],
      ['L3', 'SELLER', 'PENDING'],
      ['L4', 'SELLER', 'PENDING'],
    ]);
  });

  it('carries the carrier on the price the buyer paid onto each leg', async () => {
    const rows = await prisma.shipmentLeg.findMany({ where: { sellerOrderGroupId: groupId }, orderBy: { sequence: 'asc' } });
    expect(rows.map((leg) => [leg.level, leg.provider, leg.logisticsPartnerId, leg.connectionMode])).toEqual([
      ['L1', 'DHL', null, 'MANUAL_ONLY'],
      ['L2', 'MANUAL', null, 'MANUAL_ONLY'],
      ['L3', 'DHL', null, 'MANUAL_ONLY'],
      ['L4', 'FEDEX', null, 'MANUAL_ONLY'],
    ]);
    expect(rows[1]?.providerLabel).toBe('Sea forwarder');
    expect(rows.every((leg) => leg.assignedByRole === 'SYSTEM' && leg.assignedAt !== null)).toBe(true);
    // Nobody is asked to name a carrier that is already named.
    const asked = await prisma.sellerNotification.count({
      where: { sellerAccountId: sellerA, kind: 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', subjectId: { in: rows.map((leg) => leg.id) } },
    });
    expect(asked).toBe(0);
  });

  it('keeps another seller away from these legs', async () => {
    await expect(legsForSellerOrder(sellerB, groupId)).rejects.toMatchObject({ statusCode: 404 });
    const leg = await prisma.shipmentLeg.findFirstOrThrow({ where: { sellerOrderGroupId: groupId, level: 'L1' } });
    await expect(assignLeg(rivalEditor, leg.id, { provider: 'DHL' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets UBOSS assign none of the seller’s legs', async () => {
    const leg = await prisma.shipmentLeg.findFirstOrThrow({ where: { sellerOrderGroupId: groupId, level: 'L1' } });
    await expect(assignLeg(uboss, leg.id, { logisticsPartnerId: partnerId })).rejects.toMatchObject({
      code: 'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED',
    });
  });

  it('needs the carrier’s real tracking number before a hand-booked leg starts', async () => {
    const leg = await prisma.shipmentLeg.findFirstOrThrow({ where: { sellerOrderGroupId: groupId, level: 'L1' } });
    await assignLeg(sellerEditor, leg.id, { provider: 'DHL' });
    await expect(transitionLeg(sellerEditor, leg.id, { to: 'IN_PROGRESS' })).rejects.toMatchObject({
      code: 'LOGISTICS_LEG_TRACKING_REQUIRED',
    });
    await updateLegReferences(sellerEditor, leg.id, { trackingNumber: '1234567890' });
    await transitionLeg(sellerEditor, leg.id, { to: 'IN_PROGRESS' });
    await transitionLeg(sellerEditor, leg.id, { to: 'COMPLETED', note: 'Handed to the forwarder at Nhava Sheva' });

    const legs = await legsForSellerOrder(sellerA, groupId);
    expect(legs[0]?.status).toBe('COMPLETED');
    // The handover makes L2 its owner's turn - with its carrier already on it.
    expect(legs[1]?.status).toBe('ASSIGNED');
    expect(legs[2]?.status).toBe('PENDING');
  });

  it('refuses to start a leg before the one ahead of it is handed over', async () => {
    const l3 = await prisma.shipmentLeg.findFirstOrThrow({ where: { sellerOrderGroupId: groupId, level: 'L3' } });
    await assignLeg(sellerEditor, l3.id, { provider: 'DHL', trackingNumber: 'RTM-CART-0001' });
    await expect(transitionLeg(sellerEditor, l3.id, { to: 'IN_PROGRESS' })).rejects.toMatchObject({
      code: 'LOGISTICS_LEG_TRANSITION_INVALID',
    });
  });
});

// --- UBOSS and Self + UBOSS ------------------------------------------------------

describe('UBOSS mode', () => {
  it('needs the seller to confirm moving published levels to UBOSS', async () => {
    await expect(savePolicyDraft(sellerEditor, { mode: 'UBOSS' })).rejects.toMatchObject({ code: 'LOGISTICS_CHANGE_NOT_CONFIRMED' });
    await savePolicyDraft(sellerEditor, { mode: 'UBOSS', confirmOwnershipChange: true });
    const policy = await publishPolicy(sellerEditor, { confirmOwnershipChange: true });
    expect(policy.active?.owners).toEqual({ L1: 'SELLER', L2: 'UBOSS', L3: 'UBOSS', L4: 'UBOSS' });
  });

  it('keeps L1 with the seller and makes L2 to L4 read-only for them', async () => {
    const policy = await readPolicy(sellerA, 'SELLER');
    expect(policy.levels.map((level) => level.editableBySeller)).toEqual([true, false, false, false]);
    expect(policy.levels.slice(1).map((level) => level.pricingStatus)).toEqual(['PENDING_UBOSS_PRICE', 'PENDING_UBOSS_PRICE', 'PENDING_UBOSS_PRICE']);
    await expect(
      saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L3', transportMode: 'ROAD', provider: 'DHL', amountMinor: '1' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED' });
    // L1 stays the seller's, with the same price it had under Self.
    expect(policy.levels[0]?.rates.some((rate) => rate.id === rateIds['SELLER:L1'] && rate.status === 'PUBLISHED')).toBe(true);
  });

  it('asks for a quote until UBOSS publishes its prices, then prices the route', async () => {
    // The first checkout converted the basket; start a new one.
    const productId = (await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerA } })).productId;
    await addItem(customerProfileId, { productId, quantity: 1, sellerOfferId: offerA });

    const before = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));
    expect(before.delivery?.quoteRequired).toBe(true);

    for (const [level, amount] of [['L2', '20000'], ['L3', '30000'], ['L4', '40000']] as const) {
      await price(uboss, level, amount);
    }
    const seller = await readPolicy(sellerA, 'SELLER');
    expect(seller.levels.slice(1).every((level) => level.rates.some((rate) => rate.owner === 'UBOSS' && rate.status === 'PUBLISHED'))).toBe(true);

    const after = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));
    expect(after.delivery?.quoteRequired).toBe(false);
    expect(after.delivery?.sellers[0]?.levels.map((level) => level.owner)).toEqual(['SELLER', 'UBOSS', 'UBOSS', 'UBOSS']);
    expect(after.delivery?.total).toBe('100000');
  });

  it('leaves the first order’s legs with the seller who owned them', async () => {
    const legs = await prisma.shipmentLeg.findMany({ where: { orderId: firstOrderId }, orderBy: { sequence: 'asc' } });
    expect(legs.map((leg) => leg.owner)).toEqual(['SELLER', 'SELLER', 'SELLER', 'SELLER']);
  });
});

describe('one level’s checkbox against a published policy', () => {
  it('keeps a published UBOSS policy in UBOSS mode, with its version checked, for L1 as for any level', async () => {
    const current = await readPolicy(sellerA, 'SELLER');
    expect(current.active?.mode).toBe('UBOSS');

    // Ticking L1 as the seller's changes nothing, so it needs no confirmation
    // and must not turn the policy into the mixed mode.
    const saved = await savePolicyDraft(sellerEditor, {
      ...policyForLevelChange(current.draft, 'L1', 'SELLER'),
      expectedVersion: current.draft.version,
    });
    expect(saved.draft.mode).toBe('UBOSS');
    expect(saved.hasUnpublishedChanges).toBe(false);

    // The version the screen read is enforced for L1 too.
    await expect(
      savePolicyDraft(sellerEditor, { ...policyForLevelChange(saved.draft, 'L1', 'SELLER'), expectedVersion: current.draft.version }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_POLICY_VERSION_CONFLICT' });

    // Moving L4 back to the seller is a real change: mixed mode, confirmed.
    await expect(
      savePolicyDraft(sellerEditor, { ...policyForLevelChange(saved.draft, 'L4', 'SELLER'), expectedVersion: saved.draft.version }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_CHANGE_NOT_CONFIRMED' });
    const moved = await savePolicyDraft(sellerEditor, {
      ...policyForLevelChange(saved.draft, 'L4', 'SELLER'),
      expectedVersion: saved.draft.version,
      confirmOwnershipChange: true,
    });
    expect(moved.draft.mode).toBe('HYBRID');
    expect(moved.draft.owners).toEqual({ L1: 'SELLER', L2: 'UBOSS', L3: 'UBOSS', L4: 'SELLER' });

    // Put the draft back as published, for the tests that follow.
    await savePolicyDraft(sellerEditor, { mode: 'UBOSS', confirmOwnershipChange: true });
  });
});

describe('Self + UBOSS mode', () => {
  it('refuses the seller on all three of L2, L3 and L4', async () => {
    await expect(
      savePolicyDraft(sellerEditor, { mode: 'HYBRID', l2Owner: 'SELLER', l3Owner: 'SELLER', l4Owner: 'SELLER', confirmOwnershipChange: true }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_HYBRID_ALL_SELLER' });
  });

  it('refuses to hand L1 to UBOSS', async () => {
    await expect(
      savePolicyDraft(sellerEditor, { mode: 'HYBRID', l1Owner: 'UBOSS', l2Owner: 'SELLER', l3Owner: 'UBOSS', l4Owner: 'SELLER', confirmOwnershipChange: true }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_L1_OWNER_FIXED' });
  });

  it('maps "I will manage this level" to the seller, level by level', async () => {
    await savePolicyDraft(sellerEditor, { mode: 'HYBRID', l2Owner: 'SELLER', l3Owner: 'UBOSS', l4Owner: 'SELLER', confirmOwnershipChange: true });
    const policy = await publishPolicy(sellerEditor, { confirmOwnershipChange: true });
    expect(policy.active?.owners).toEqual({ L1: 'SELLER', L2: 'SELLER', L3: 'UBOSS', L4: 'SELLER' });
    expect(policy.levels.map((level) => level.editableBySeller)).toEqual([true, true, false, true]);
  });

  it('lets each side price only its own levels', async () => {
    await expect(
      saveRate(sellerEditor, { sellerAccountId: sellerA, level: 'L3', transportMode: 'ROAD', provider: 'DHL', amountMinor: '1' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED' });
    await expect(
      saveRate(uboss, { sellerAccountId: sellerA, level: 'L2', transportMode: 'AIR', provider: 'DHL', amountMinor: '1' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED' });
    await expect(
      saveRate(uboss, { sellerAccountId: sellerA, level: 'L1', transportMode: 'ROAD', provider: 'DHL', amountMinor: '1' }),
    ).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED' });
  });

  it('holds a UBOSS price to the rule a UBOSS leg is held to: marketplace carriers only', async () => {
    const fleet = await prisma.logisticsPartner.create({
      data: {
        id: newId(),
        partnerCode: FLEET_CODE,
        legalName: 'Levels Own Fleet Pvt Ltd',
        displayName: 'Levels Own Fleet',
        displayNameNormalized: 'levelsownfleet',
        registrationCountry: 'IN',
        contactEmail: `fleet${EMAIL_DOMAIN}`,
        status: 'ACTIVE',
        contractStatus: 'ACTIVE',
        partnerKind: 'SELLER_SELF_MANAGED',
        ownerSellerAccountId: sellerA,
      },
    });
    const l3 = { sellerAccountId: sellerA, level: 'L3' as const, transportMode: 'ROAD' as const, amountMinor: '1', currency: 'INR' };
    await expect(saveRate(uboss, { ...l3, logisticsPartnerId: fleet.id })).rejects.toMatchObject({
      code: 'LOGISTICS_PARTNER_NOT_ELIGIBLE',
    });
    // A marketplace carrier is fine; the draft is left unpublished.
    const draft = await saveRate(uboss, { ...l3, logisticsPartnerId: partnerId });
    expect(draft.logisticsPartnerId).toBe(partnerId);
    await prisma.logisticsLevelRate.delete({ where: { id: draft.id } });
  });

  it('prices the mixed route from each owner’s own prices', async () => {
    const view = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));
    // L2 and L4 are the seller's prices (L4 is the republished 450), L3 is UBOSS's.
    expect(view.delivery?.sellers[0]?.levels.map((level) => [level.owner, level.amount])).toEqual([
      ['SELLER', '10000'],
      ['SELLER', '20000'],
      ['UBOSS', '30000'],
      ['SELLER', '45000'],
    ]);
  });

  it('gives the partner only the leg it was assigned, and lets UBOSS assign only its own', async () => {
    const view = toCartView(await resolveCart(customerProfileId, { destinationCountry: 'NL', destinationPostcode: '3011 AA' }));
    const result = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      paymentMode: 'ONLINE',
      logisticsQuoteToken: view.delivery?.token ?? '',
      actor: { userId: null, email: `buyer${EMAIL_DOMAIN}`, type: 'CUSTOMER' },
    });
    await transitionOrder({ orderId: result.orderId, to: 'CONFIRMED', actor: { userId: null, email: null, type: 'SYSTEM' }, reason: 'Test payment' });
    const group = await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: result.orderId } });
    await transitionSellerOrder({ membership: membership(sellerA, SLUG_A), groupId: group.id, to: 'ACCEPTED', locationId: locationA });

    const legs = await prisma.shipmentLeg.findMany({ where: { sellerOrderGroupId: group.id }, orderBy: { sequence: 'asc' } });
    expect(legs.map((leg) => leg.owner)).toEqual(['SELLER', 'SELLER', 'UBOSS', 'SELLER']);

    const l3 = legs[2];
    const l2 = legs[1];
    if (l3 === undefined || l2 === undefined) throw new Error('legs missing');

    await expect(assignLeg(sellerEditor, l3.id, { provider: 'DHL' })).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_SELLER_CONTROLLED' });
    await expect(assignLeg(uboss, l2.id, { logisticsPartnerId: partnerId })).rejects.toMatchObject({ code: 'LOGISTICS_LEVEL_NOT_UBOSS_CONTROLLED' });

    // L3 arrived with the carrier on UBOSS's price. Staff may still change it,
    // as a reassignment: with a reason, and never to the seller's own fleet.
    expect(l3.provider).toBe('DHL');
    const fleet = await prisma.logisticsPartner.findFirstOrThrow({ where: { partnerCode: FLEET_CODE } });
    await expect(assignLeg(uboss, l3.id, { logisticsPartnerId: fleet.id, reason: 'Try the fleet' })).rejects.toMatchObject({
      code: 'LOGISTICS_PARTNER_NOT_ELIGIBLE',
    });
    await expect(assignLeg(uboss, l3.id, { logisticsPartnerId: partnerId })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await assignLeg(uboss, l3.id, { logisticsPartnerId: partnerId, reason: 'Our own marketplace haulier' });

    const held = await legsForPartner(partnerId);
    expect(held.map((leg) => leg.id)).toEqual([l3.id]);
    // A carrier is never shown what the buyer paid for its work.
    expect(held[0] !== undefined && 'charge' in held[0] ? held[0].charge : null).toBeNull();

    // The settlement splits the delivery: L3 was UBOSS's, the rest the seller's.
    const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: group.id } });
    expect(settlement.sellerDeliveryProceedsMinor).toBe(10_000n + 20_000n + 45_000n);
    expect(settlement.ubossDeliveryMinor).toBe(30_000n);
  });
});
