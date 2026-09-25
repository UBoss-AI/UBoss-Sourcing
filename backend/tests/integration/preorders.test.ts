/**
 * Bulk preorders, end to end.
 *
 * The buyer's side runs over HTTP - a real session, the real guards, the real
 * idempotency - because that is where "a guest can see the button", "another
 * buyer's preorder is a 404" and "a double submit is one request" are true or
 * not. The seller's side calls the services with a resolved membership, as
 * every other Seller Hub integration test in this suite does.
 *
 * THE FIGURES
 *
 *   list price   ₹100.00 a piece   (10,000 paise)
 *   carton       48 pieces
 *   policy       minimum 1,000 pieces, steps of 100, production lead 10 days,
 *                capacity 20,000 pieces a month, FIXED pricing:
 *                  from 1,000 pieces   ₹90.00
 *                  from 10,000 pieces  ₹80.00
 *
 * So 12,000 pieces are indicatively ₹9,60,000.00, and two buyers each asking
 * for 12,000 in the same month cannot both be confirmed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type * as RequestService from '../../src/modules/preorders/request.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import type { Responder } from '../../src/modules/preorders/supplier.js';

/** A seller answering in Seller Hub, as the seller routes build it. */
function sellerResponder(membership: SellerMembership): Responder {
  return {
    kind: 'SELLER',
    sellerAccountId: membership.sellerAccountId,
    displayName: membership.displayName,
    userId: null,
    staffEmail: null,
  };
}

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;
let service: typeof RequestService;

const PREFIX = 'pro-';
const EMAIL = 'preorder-buyer@test.local';
const EMAIL_TWO = 'preorder-buyer-two@test.local';
const EMAIL_PERSONAL = 'preorder-personal@test.local';
const EMAIL_SELLER = 'preorder-seller@test.local';
const EMAIL_RIVAL = 'preorder-rival@test.local';
const EMAILS = [EMAIL, EMAIL_TWO, EMAIL_PERSONAL, EMAIL_SELLER, EMAIL_RIVAL];
const PASSWORD = 'PreorderBuyer!2026';
const CATEGORY_SLUG = 'preorder-test';

let productId = '';
let operatorProductId = '';
let unconfiguredProductId = '';
let offerId = '';
let sellerAccountId = '';
let rivalSellerAccountId = '';
let locationId = '';
let buyerProfileId = '';
let buyerTwoProfileId = '';
let personalProfileId = '';
let addressId = '';
let addressTwoId = '';
let seller: SellerMembership;
let rival: SellerMembership;
let cookieHeader = '';
let csrfToken = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kolkataToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function plusDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Comfortably inside the window, and in one calendar month for capacity. */
function deliveryDay(): string {
  const base = plusDays(kolkataToday(), 40);
  return `${base.slice(0, 7)}-28`;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    productId,
    orderingUnit: 'PIECE',
    unitQuantity: 12_000,
    requestedDeliveryDate: deliveryDay(),
    shippingAddressId: addressId,
    acceptTerms: true,
    purchaseOrderReference: 'PO-4471',
    ...overrides,
  };
}

async function post(url: string, payload: unknown, key?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: payload as Record<string, unknown>,
  });
}

function errorOf(body: string): { code: string; details: { meta?: Record<string, unknown> }[] } {
  return (
    JSON.parse(body) as { error: { code: string; details: { meta?: Record<string, unknown> }[] } }
  ).error;
}

interface PreorderBody {
  id: string;
  status: string;
  version: number;
  currentOffer: { id: string; termsHash: string } | null;
  order: { id: string } | null;
}

async function submitAsBuyerTwo(overrides: Record<string, unknown> = {}): Promise<PreorderBody> {
  const actor = { userId: 'x'.repeat(26), email: EMAIL_TWO, customerProfileId: buyerTwoProfileId };
  const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL_TWO } });
  actor.userId = user.id;
  // The second buyer has read the bulk preorder note, as every buyer must.
  await prisma.customerAcknowledgement.upsert({
    where: {
      userId_type_policyVersion: {
        userId: user.id,
        type: 'PREORDER_INFO',
        policyVersion: 'PREORDER_INFO_V1',
      },
    },
    create: { id: newId(), userId: user.id, type: 'PREORDER_INFO', policyVersion: 'PREORDER_INFO_V1' },
    update: {},
  });
  const parsed = service.preorderInputSchema.parse(
    request({ shippingAddressId: addressTwoId, ...overrides }),
  );
  return (await service.submitPreorder(actor, parsed)) as unknown as PreorderBody;
}

async function submitAsBuyer(overrides: Record<string, unknown> = {}): Promise<PreorderBody> {
  const response = await post('/api/v1/preorders', request(overrides), newId());
  expect(response.statusCode, response.body).toBe(201);
  return (JSON.parse(response.body) as { preorder: PreorderBody }).preorder;
}

async function sellerView(id: string): Promise<PreorderBody> {
  return (await service.getSellerPreorder(sellerAccountId, id)) as unknown as PreorderBody;
}

async function accept(id: string): Promise<PreorderBody> {
  const current = await sellerView(id);
  return (await service.sellerAccept(sellerResponder(seller), id, {
    unitPriceMinor: null,
    freightMinor: '1500000',
    committedDeliveryDate: null,
    originLocationId: locationId,
    note: null,
    expectedVersion: current.version,
  })) as unknown as PreorderBody;
}

async function confirmAsBuyer(preorder: PreorderBody) {
  return post(
    `/api/v1/preorders/${preorder.id}/confirm`,
    { offerId: preorder.currentOffer?.id, termsHash: preorder.currentOffer?.termsHash },
    newId(),
  );
}

async function bucketReserved(): Promise<number> {
  const rows = await prisma.preorderCapacityBucket.findMany({ where: { sellerAccountId } });
  return rows.reduce((sum, row) => sum + row.reservedBaseUnits, 0);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({
      where: { slug: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const profiles = (
    await prisma.customerProfile.findMany({
      where: { user: { emailNormalized: { in: EMAILS } } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.preorderRequest.deleteMany({ where: { sellerAccountId: { in: sellers } } });

  const orders = (
    await prisma.order.findMany({
      where: { customerProfileId: { in: profiles } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.shipmentLeg.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.orderLogisticsLeg.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.logisticsShipment.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderLine.deleteMany({
    where: { orderGroup: { sellerAccountId: { in: sellers } } },
  });
  await prisma.sellerOrderGroup.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerInventoryMovement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderItemPackaging.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.orderApproval.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });

  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerPackagingOption.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerPackagingProfile.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });

  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });

  await prisma.address.deleteMany({ where: { customerProfileId: { in: profiles } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

async function makeCustomer(
  email: string,
  organization: string | null,
  roleId: string,
  hash: string,
) {
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: hash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId } },
    },
  });
  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: user.id,
      fullName: `Buyer ${email.split('@')[0] ?? ''}`,
      organization,
      activatedAt: new Date(),
    },
  });
  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId: profile.id,
      contactName: 'Receiving dock',
      contactPhone: '+919800000000',
      line1: '4 Industrial Estate',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411001',
      country: 'IN',
      timezone: 'Asia/Kolkata',
      isDefaultShipping: true,
    },
  });
  return { profileId: profile.id, addressId: address.id };
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  service = await import('../../src/modules/preorders/request.service.js');
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { Role } = await import('../../src/domain/permissions.js');
  const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');

  app = await buildApp();
  await app.ready();
  await cleanUp();

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: {
        id: newId(),
        code: 'PRO18',
        name: 'GST 18%',
        ratePercent: '18.000000',
        isActive: true,
      },
      select: { id: true },
    }));

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Preorder test', slug: CATEGORY_SLUG, isActive: true },
  });

  const makeProduct = async (slug: string, marketplace: boolean) =>
    (
      await prisma.product.create({
        data: {
          id: newId(),
          categoryId: category.id,
          taxClassId: taxClass.id,
          name: `Examination gloves ${slug}`,
          slug: `${PREFIX}${slug}`,
          sku: `PRO-${slug.toUpperCase()}`,
          basePriceMinor: 0n,
          currency: 'INR',
          status: 'ACTIVE',
          isPublished: true,
          publishedAt: new Date(),
          isMarketplaceProduct: marketplace,
          isStockTracked: false,
          minOrderQty: 1,
          qtyIncrement: 1,
        },
      })
    ).id;

  productId = await makeProduct('gloves', true);
  unconfiguredProductId = await makeProduct('masks', true);
  operatorProductId = await makeProduct('operator', false);

  const customerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CUSTOMER },
    select: { id: true },
  });
  const hash = await hashPassword(PASSWORD);

  const buyer = await makeCustomer(EMAIL, 'Acme Hospital Group', customerRole.id, hash);
  buyerProfileId = buyer.profileId;
  addressId = buyer.addressId;
  const buyerTwo = await makeCustomer(EMAIL_TWO, 'Beta Clinics', customerRole.id, hash);
  buyerTwoProfileId = buyerTwo.profileId;
  addressTwoId = buyerTwo.addressId;
  personalProfileId = (await makeCustomer(EMAIL_PERSONAL, null, customerRole.id, hash)).profileId;
  const sellerPerson = await makeCustomer(EMAIL_SELLER, 'Seller staff', customerRole.id, hash);
  const rivalPerson = await makeCustomer(EMAIL_RIVAL, 'Rival staff', customerRole.id, hash);

  const makeSeller = async (slug: string, ownerProfileId: string) => {
    const id = newId();
    await prisma.sellerAccount.create({
      data: {
        id,
        legalName: `${slug} Manufacturing Pvt Ltd`,
        displayName: `${slug} Manufacturing`,
        displayNameNormalized: `${slug} manufacturing`,
        slug: `${PREFIX}${slug}`,
        kind: 'MANUFACTURER',
        registrationCountry: 'IN',
        status: 'APPROVED',
      },
    });
    await prisma.sellerMember.create({
      data: { id: newId(), sellerAccountId: id, customerProfileId: ownerProfileId, role: 'OWNER' },
    });
    return id;
  };

  sellerAccountId = await makeSeller('gamma', sellerPerson.profileId);
  rivalSellerAccountId = await makeSeller('delta', rivalPerson.profileId);
  seller = await resolveSellerMembership(sellerPerson.profileId);
  rival = await resolveSellerMembership(rivalPerson.profileId);

  locationId = newId();
  await prisma.sellerLocation.create({
    data: {
      id: locationId,
      sellerAccountId,
      code: 'PUNE-1',
      name: 'Pune plant',
      addressLine1: '1 MIDC',
      city: 'Pune',
      postcode: '411019',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
    },
  });

  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId,
      productId,
      variantKey: '',
      sellerSku: 'GAMMA-GLOVE',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 10_000n,
      currency: 'INR',
      availableQuantity: 500,
    },
  });

  // Where the goods will be booked in once they are made. Empty until then.
  await prisma.sellerInventory.create({
    data: { id: newId(), sellerAccountId, offerId, locationId, availableQuantity: 0 },
  });

  // The rival's offer on the same product. Cheaper, so it is also the one the
  // product page would show - which is why every request below names ours.
  await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId: rivalSellerAccountId,
      productId,
      variantKey: '',
      sellerSku: 'DELTA-GLOVE',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 9_500n,
      currency: 'INR',
      availableQuantity: 500,
    },
  });

  await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId,
      productId: unconfiguredProductId,
      variantKey: '',
      sellerSku: 'GAMMA-MASK',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 2_000n,
      currency: 'INR',
      availableQuantity: 500,
    },
  });

  const profile = await prisma.sellerPackagingProfile.create({
    data: { id: newId(), sellerAccountId, offerId, version: 1 },
  });
  await prisma.sellerPackagingOption.create({
    data: {
      id: newId(),
      profileId: profile.id,
      sellerAccountId,
      packageType: 'CARTON',
      isEnabled: true,
      state: 'ACTIVE',
      unitsPerCarton: 48,
      unitsPerPackage: 48,
      unitsPerPackageDerived: 48,
      priceMode: 'DERIVED_FROM_UNIT',
      currency: 'INR',
      grossWeightGrams: 6_000n,
      lengthMm: 400,
      widthMm: 300,
      heightMm: 250,
    },
  });

  const { savePolicy, policyInputSchema } =
    await import('../../src/modules/preorders/policy.service.js');
  await savePolicy(
    seller,
    policyInputSchema.parse({
      scope: 'OFFER',
      offerId,
      isEnabled: true,
      moqUnit: 'PIECE',
      moqQuantity: 1000,
      incrementQuantity: 100,
      capacityBaseUnits: 20_000,
      capacityPeriod: 'MONTH',
      minLeadTimeDays: 10,
      pricingMode: 'FIXED',
      allowSplitDelivery: true,
      tiers: [
        { minBaseUnits: 1000, unitPriceMinor: '9000' },
        { minBaseUnits: 10_000, unitPriceMinor: '8000' },
      ],
    }),
  );

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const jar = signIn.cookies as { name: string; value: string }[];
  cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  csrfToken = jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '';
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

// ---------------------------------------------------------------------------
// Eligibility: what the button on the product page is told
// ---------------------------------------------------------------------------

describe('the Preorder button', () => {
  it('is available to a guest, with the seller’s real terms in pieces', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${productId}&offerId=${offerId}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      eligibility: {
        available: boolean;
        moq: { minimumBaseUnits: number; incrementBaseUnits: number };
        units: { unit: string; baseUnits: number }[];
      };
      viewer: { signedIn: boolean };
    };
    expect(body.viewer.signedIn).toBe(false);
    expect(body.eligibility.available).toBe(true);
    expect(body.eligibility.moq.minimumBaseUnits).toBe(1000);
    expect(body.eligibility.moq.incrementBaseUnits).toBe(100);
    expect(body.eligibility.units).toContainEqual({ unit: 'CARTON', baseUnits: 48 });
  });

  it('opens a listing whose seller configured nothing, on the platform default terms', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${unconfiguredProductId}`,
    });
    const body = JSON.parse(response.body) as {
      eligibility: {
        available: boolean;
        pricingMode: string;
        moq: { minimumBaseUnits: number };
        tiers: { minBaseUnits: number; unitPriceMinor: string }[];
      };
    };
    // Preorders on every product: nobody configured terms, so the platform
    // default applies - the deployment's bulk minimum (PREORDER_DEFAULT_MOQ,
    // 1,000) because the listing's own minimum of 1 is lower, its own list
    // price as an indicative band, and the seller still answers every request.
    expect(body.eligibility.available).toBe(true);
    expect(body.eligibility.pricingMode).toBe('FIXED');
    expect(body.eligibility.moq.minimumBaseUnits).toBe(1000);
    expect(body.eligibility.tiers).toEqual([{ minBaseUnits: 1000, unitPriceMinor: '2000' }]);
  });

  it('lets a seller’s own minimum override the platform default', async () => {
    // The configured listing's policy says 1,000 in steps of 100; set it to
    // 250 and the button, the form and the threshold all read 250.
    const { savePolicy, policyInputSchema } =
      await import('../../src/modules/preorders/policy.service.js');
    const current = await prisma.preorderPolicy.findFirstOrThrow({
      where: { scope: 'OFFER', scopeKey: offerId },
      select: { version: true },
    });
    const base = {
      scope: 'OFFER',
      offerId,
      isEnabled: true,
      moqUnit: 'PIECE',
      incrementQuantity: 100,
      capacityBaseUnits: 20_000,
      capacityPeriod: 'MONTH',
      minLeadTimeDays: 10,
      pricingMode: 'FIXED',
      allowSplitDelivery: true,
      tiers: [
        { minBaseUnits: 1000, unitPriceMinor: '9000' },
        { minBaseUnits: 10_000, unitPriceMinor: '8000' },
      ],
    };
    await savePolicy(
      seller,
      policyInputSchema.parse({ ...base, moqQuantity: 250, expectedVersion: current.version }),
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/preorders/eligibility?productId=${productId}&offerId=${offerId}`,
      });
      const body = JSON.parse(response.body) as {
        eligibility: { moq: { quantity: number; minimumBaseUnits: number } };
      };
      expect(body.eligibility.moq).toMatchObject({ quantity: 250, minimumBaseUnits: 250 });
    } finally {
      await savePolicy(
        seller,
        policyInputSchema.parse({
          ...base,
          moqQuantity: 1000,
          expectedVersion: current.version + 1,
        }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The bulk preorder note: read once per version, recorded by the server
// ---------------------------------------------------------------------------

describe('the bulk preorder information acknowledgement', () => {
  async function viewerInfo(): Promise<{ policyVersion: string; acknowledged: boolean }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${productId}&offerId=${offerId}`,
      headers: { cookie: cookieHeader },
    });
    return (
      JSON.parse(response.body) as {
        viewer: { preorderInfo: { policyVersion: string; acknowledged: boolean } };
      }
    ).viewer.preorderInfo;
  }

  it('is not acknowledged by a guest, and names the current version', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${productId}&offerId=${offerId}`,
    });
    const body = JSON.parse(response.body) as {
      viewer: { preorderInfo: { policyVersion: string; acknowledged: boolean } };
    };
    expect(body.viewer.preorderInfo).toEqual({
      policyVersion: 'PREORDER_INFO_V1',
      acknowledged: false,
    });
  });

  it('refuses a submission before the buyer has acknowledged it', async () => {
    expect((await viewerInfo()).acknowledged).toBe(false);
    const response = await post('/api/v1/preorders', request({ offerId }), newId());
    expect(response.statusCode).toBe(409);
    const error = errorOf(response.body);
    expect(error.code).toBe('PREORDER_ACKNOWLEDGEMENT_REQUIRED');
    expect(error.details[0]?.meta?.['policyVersion']).toBe('PREORDER_INFO_V1');
    expect(await prisma.preorderRequest.count({ where: { customerProfileId: buyerProfileId } })).toBe(0);
  });

  it('cannot be forged with a flag in the request body', async () => {
    const response = await post(
      '/api/v1/preorders',
      request({ offerId, acknowledged: true, policyVersion: 'PREORDER_INFO_V1' }),
      newId(),
    );
    // The body schema is strict: an unknown field is refused outright.
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).code).toBe('VALIDATION_FAILED');
  });

  it('does not count an acknowledgement of an older version', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL } });
    await prisma.customerAcknowledgement.create({
      data: { id: newId(), userId: user.id, type: 'PREORDER_INFO', policyVersion: 'PREORDER_INFO_V0' },
    });
    expect((await viewerInfo()).acknowledged).toBe(false);
    const response = await post('/api/v1/preorders', request({ offerId }), newId());
    expect(errorOf(response.body).code).toBe('PREORDER_ACKNOWLEDGEMENT_REQUIRED');
  });

  it('refuses to record a version that is not the current one', async () => {
    const response = await post('/api/v1/preorders/acknowledgement', {
      policyVersion: 'PREORDER_INFO_V0',
    });
    expect(response.statusCode).toBe(409);
    const error = errorOf(response.body);
    expect(error.code).toBe('PREORDER_INFO_OUTDATED');
    expect(error.details[0]?.meta?.['policyVersion']).toBe('PREORDER_INFO_V1');
  });

  it('needs a signed-in customer to record one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/preorders/acknowledgement',
      payload: { policyVersion: 'PREORDER_INFO_V1' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('records the current version once, audits it, and then lets a request through', async () => {
    const first = await post('/api/v1/preorders/acknowledgement', {
      policyVersion: 'PREORDER_INFO_V1',
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await post('/api/v1/preorders/acknowledgement', {
      policyVersion: 'PREORDER_INFO_V1',
    });
    const at = (body: string) =>
      (JSON.parse(body) as { acknowledgement: { acknowledgedAt: string } }).acknowledgement
        .acknowledgedAt;
    // Idempotent: the second press answers with the first record.
    expect(at(second.body)).toBe(at(first.body));

    const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL } });
    expect(
      await prisma.customerAcknowledgement.count({
        where: { userId: user.id, policyVersion: 'PREORDER_INFO_V1' },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'preorder.info_acknowledged', actorUserId: user.id },
      }),
    ).toBe(1);
    expect((await viewerInfo()).acknowledged).toBe(true);
  });

  it('still refuses a quantity below the minimum once acknowledged', async () => {
    const response = await post(
      '/api/v1/preorders',
      request({ offerId, unitQuantity: 999 }),
      newId(),
    );
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).code).toBe('PREORDER_BELOW_MINIMUM');
  });
});

describe('preorder quantities are the server’s to judge', () => {
  it('refuses below the minimum even when the unit is changed to dodge it', async () => {
    // 20 cartons of 48 is 960 pieces - under the 1,000 minimum in pieces.
    const response = await post(
      '/api/v1/preorders/preview',
      request({ offerId, orderingUnit: 'CARTON', unitQuantity: 20 }),
    );
    expect(errorOf(response.body).code).toBe('PREORDER_BELOW_MINIMUM');
  });

  it('opens the operator’s own product, answered by the store, quoted when it has no price', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${operatorProductId}`,
    });
    const body = JSON.parse(response.body) as {
      eligibility: { available: boolean; offerId: string | null; pricingMode: string };
    };
    expect(body.eligibility.available).toBe(true);
    // No seller offer: the operator's staff answer it in the admin console.
    expect(body.eligibility.offerId).toBeNull();
    // basePriceMinor is 0 in this fixture - nothing to show, so the store quotes.
    expect(body.eligibility.pricingMode).toBe('QUOTE_REQUIRED');
  });

  it('computes the earliest date from the production lead time on the buyer’s clock', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${productId}&offerId=${offerId}`,
      headers: { cookie: cookieHeader },
    });
    const body = JSON.parse(response.body) as {
      eligibility: { window: { earliest: string; decidedBy: string; timezone: string } };
      viewer: { signedIn: boolean; isBusinessBuyer: boolean };
    };
    expect(body.viewer).toMatchObject({ signedIn: true, isBusinessBuyer: true });
    expect(body.eligibility.window.timezone).toBe('Asia/Kolkata');
    expect(body.eligibility.window.earliest).toBe(plusDays(kolkataToday(), 10));
    expect(body.eligibility.window.decidedBy).toBe('PRODUCTION');
  });
});

// ---------------------------------------------------------------------------
// Refusals, each with its own reason
// ---------------------------------------------------------------------------

describe('a preorder is refused, with a specific reason, when', () => {
  it('the quantity is below the minimum', async () => {
    const response = await post(
      '/api/v1/preorders/preview',
      request({ offerId, unitQuantity: 999 }),
    );
    expect(response.statusCode).toBe(400);
    const error = errorOf(response.body);
    expect(error.code).toBe('PREORDER_BELOW_MINIMUM');
    expect(error.details[0]?.meta?.['minimumBaseUnits']).toBe(1000);
    expect((JSON.parse(response.body) as { error: { message: string } }).error.message).toBe(
      'Minimum preorder quantity is 1,000 pieces.',
    );
  });

  it('the quantity is off the increment', async () => {
    const response = await post(
      '/api/v1/preorders/preview',
      request({ offerId, unitQuantity: 1050 }),
    );
    expect(errorOf(response.body).code).toBe('PREORDER_INCREMENT_MISMATCH');
    expect(errorOf(response.body).details[0]?.meta?.['incrementBaseUnits']).toBe(100);
  });

  it('the date is inside the lead time, naming the earliest', async () => {
    const tooSoon = plusDays(kolkataToday(), 8);
    const response = await post(
      '/api/v1/preorders/preview',
      request({ offerId, requestedDeliveryDate: tooSoon }),
    );
    const error = errorOf(response.body);
    expect(error.code).toBe('PREORDER_DATE_TOO_EARLY');
    expect(error.details[0]?.meta?.['earliest']).toBe(plusDays(kolkataToday(), 10));
  });

  it('today is asked for', async () => {
    const response = await post(
      '/api/v1/preorders/preview',
      request({ offerId, requestedDeliveryDate: kolkataToday() }),
    );
    expect(errorOf(response.body).code).toBe('PREORDER_DATE_TOO_EARLY');
  });

  it('the unit is one the offer has no packaging for', async () => {
    const response = await post(
      '/api/v1/preorders/preview',
      request({ offerId, orderingUnit: 'CONTAINER', unitQuantity: 1 }),
    );
    expect(errorOf(response.body).code).toBe('PREORDER_UNIT_NOT_AVAILABLE');
  });

  it('the account is not a business', async () => {
    await expect(
      service.previewPreorder(
        personalProfileId,
        service.preorderInputSchema.parse(request({ offerId })),
      ),
    ).rejects.toMatchObject({ code: 'PREORDER_BUYER_NOT_ELIGIBLE' });
  });

  it('the seller switched preorders off for this listing (the default never overrides that)', async () => {
    const offer = await prisma.sellerOffer.findFirstOrThrow({
      where: { productId: unconfiguredProductId },
      select: { id: true },
    });
    const policyId = newId();
    await prisma.preorderPolicy.create({
      data: {
        id: policyId,
        sellerAccountId,
        scope: 'OFFER',
        scopeKey: offer.id,
        offerId: offer.id,
        productId: unconfiguredProductId,
        isEnabled: false,
      },
    });
    try {
      const response = await post(
        '/api/v1/preorders/preview',
        request({ productId: unconfiguredProductId }),
      );
      expect(errorOf(response.body).code).toBe('PREORDER_NOT_AVAILABLE');
      expect(errorOf(response.body).details[0]?.meta?.['reason']).toBe('DISABLED');
    } finally {
      await prisma.preorderPolicy.delete({ where: { id: policyId } });
    }
  });

  it('the seller is suspended', async () => {
    await prisma.sellerAccount.update({
      where: { id: sellerAccountId },
      data: { status: 'SUSPENDED' },
    });
    try {
      const response = await post('/api/v1/preorders/preview', request({ offerId }));
      expect(errorOf(response.body).code).toBe('PREORDER_NOT_AVAILABLE');
      expect(errorOf(response.body).details[0]?.meta?.['reason']).toBe('SELLER_SUSPENDED');
    } finally {
      await prisma.sellerAccount.update({
        where: { id: sellerAccountId },
        data: { status: 'APPROVED' },
      });
    }
  });

  it('the delivery country is not served', async () => {
    await prisma.preorderPolicy.updateMany({
      where: { sellerAccountId },
      data: { deliveryCountriesJson: ['DE'] },
    });
    try {
      const response = await post('/api/v1/preorders/preview', request({ offerId }));
      expect(errorOf(response.body).code).toBe('PREORDER_DESTINATION_NOT_SERVED');
    } finally {
      await prisma.preorderPolicy.updateMany({
        where: { sellerAccountId },
        data: { deliveryCountriesJson: [] },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The negotiation
// ---------------------------------------------------------------------------

describe('a preorder request', () => {
  let submitted: PreorderBody;

  it('is priced from the server’s own bands, never from the client', async () => {
    const response = await post('/api/v1/preorders/preview', request({ offerId }));
    expect(response.statusCode, response.body).toBe(200);
    const preview = (
      JSON.parse(response.body) as {
        preview: {
          unitPrice: { minor: string };
          goodsTotal: { minor: string };
          appliedTierMinBaseUnits: number;
          savingPerPiece: { minor: string };
        };
      }
    ).preview;
    expect(preview.unitPrice.minor).toBe('8000');
    expect(preview.goodsTotal.minor).toBe('96000000');
    expect(preview.appliedTierMinBaseUnits).toBe(10_000);
    expect(preview.savingPerPiece.minor).toBe('2000');
  });

  it('is submitted once however many times the same request is sent', async () => {
    const key = newId();
    const first = await post('/api/v1/preorders', request({ offerId }), key);
    const second = await post('/api/v1/preorders', request({ offerId }), key);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode).toBe(201);

    submitted = (JSON.parse(first.body) as { preorder: PreorderBody }).preorder;
    expect((JSON.parse(second.body) as { preorder: PreorderBody }).preorder.id).toBe(submitted.id);
    expect(
      await prisma.preorderRequest.count({ where: { customerProfileId: buyerProfileId } }),
    ).toBe(1);
    expect(submitted.status).toBe('SUBMITTED');
  });

  it('reserves no sellable stock and creates no order when it is submitted', async () => {
    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.reservedQuantity).toBe(0);
    expect(await prisma.order.count({ where: { customerProfileId: buyerProfileId } })).toBe(0);
  });

  it('reaches the seller as an alert that waits on them', async () => {
    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId, kind: 'PREORDER_REQUEST_RECEIVED', subjectId: submitted.id },
    });
    expect(alert?.status).toBe('ACTIVE');
  });

  it('is invisible to every other seller and every other buyer', async () => {
    await expect(
      service.getSellerPreorder(rivalSellerAccountId, submitted.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getBuyerPreorder(buyerTwoProfileId, submitted.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.sellerAccept(sellerResponder(rival), submitted.id, {
        unitPriceMinor: null,
        freightMinor: '0',
        committedDeliveryDate: null,
        originLocationId: null,
        note: null,
        expectedVersion: submitted.version,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('cannot be accepted "as requested" at a different price', async () => {
    await expect(
      service.sellerAccept(sellerResponder(seller), submitted.id, {
        unitPriceMinor: '7500',
        freightMinor: '0',
        committedDeliveryDate: null,
        originLocationId: null,
        note: null,
        expectedVersion: submitted.version,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('can be accepted by the seller, and acceptance charges nobody', async () => {
    const accepted = await accept(submitted.id);
    expect(accepted.status).toBe('SELLER_ACCEPTED');
    expect(accepted.currentOffer).not.toBeNull();
    expect(await prisma.order.count({ where: { customerProfileId: buyerProfileId } })).toBe(0);
    expect(
      await prisma.paymentTransaction.count({
        where: { order: { customerProfileId: buyerProfileId } },
      }),
    ).toBe(0);
    expect(await bucketReserved()).toBe(0);

    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId, kind: 'PREORDER_REQUEST_RECEIVED', subjectId: submitted.id },
    });
    expect(alert?.status).toBe('RESOLVED');
  });

  it('can be countered with a different quantity, price and date, which supersedes the acceptance', async () => {
    const before = await sellerView(submitted.id);
    const oldOffer = before.currentOffer;

    const countered = (await service.sellerCounter(sellerResponder(seller), submitted.id, {
      quantityBaseUnits: 12_000,
      unitPriceMinor: '7900',
      freightMinor: '1500000',
      committedDeliveryDate: plusDays(deliveryDay(), -1),
      deliverySplits: [
        { date: plusDays(deliveryDay(), -15), baseUnits: 6000 },
        { date: plusDays(deliveryDay(), -1), baseUnits: 6000 },
      ],
      originLocationId: locationId,
      note: 'Two loads, a fortnight apart.',
      expectedVersion: before.version,
    })) as unknown as PreorderBody;

    expect(countered.status).toBe('SELLER_COUNTERED');
    expect(countered.currentOffer?.id).not.toBe(oldOffer?.id);

    const superseded = await prisma.preorderOffer.findUniqueOrThrow({
      where: { id: oldOffer?.id ?? '' },
    });
    expect(superseded.state).toBe('SUPERSEDED');

    // The buyer cannot confirm the terms they were shown before the counter.
    const stale = await post(
      `/api/v1/preorders/${submitted.id}/confirm`,
      { offerId: oldOffer?.id, termsHash: oldOffer?.termsHash },
      newId(),
    );
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale.body).code).toBe('PREORDER_TERMS_CHANGED');
    expect(await prisma.order.count({ where: { customerProfileId: buyerProfileId } })).toBe(0);
  });

  it('becomes an order only when the buyer confirms, awaiting payment, and only once', async () => {
    const current = (await service.getBuyerPreorder(
      buyerProfileId,
      submitted.id,
    )) as unknown as PreorderBody;

    const confirm = await confirmAsBuyer(current);
    expect(confirm.statusCode, confirm.body).toBe(200);
    const confirmed = (
      JSON.parse(confirm.body) as { preorder: PreorderBody & { confirmed: { termsHash: string } } }
    ).preorder;

    expect(confirmed.status).toBe('PAYMENT_REQUIRED');
    expect(confirmed.confirmed.termsHash).toBe(current.currentOffer?.termsHash);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmed.order?.id ?? '' },
      include: { items: true, payments: true },
    });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.source).toBe('PREORDER');
    expect(order.payments).toHaveLength(0);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]?.sellerOfferId).toBe(offerId);
    expect(order.items[0]?.quantity).toBe(12_000);
    expect(order.items[0]?.unitPriceMinor).toBe(7_900n);
    // goods + tax + the seller's quoted freight, from the one pricing engine.
    expect(order.subtotalMinor).toBe(94_800_000n);
    expect(order.shippingMinor).toBe(1_500_000n);
    expect(order.grandTotalMinor).toBe(order.subtotalMinor + order.taxMinor + order.shippingMinor);

    // Capacity is held now, and not before.
    expect(await bucketReserved()).toBe(12_000);

    // A second confirmation - a new key, so idempotency does not absorb it -
    // is refused, and there is still one order.
    const again = await confirmAsBuyer(current);
    expect(again.statusCode).toBe(409);
    expect(await prisma.order.count({ where: { customerProfileId: buyerProfileId } })).toBe(1);
  });

  it('keeps the confirmed terms exactly as they were proposed', async () => {
    const row = await prisma.preorderRequest.findUniqueOrThrow({
      where: { id: submitted.id },
      include: { offers: true },
    });
    const acceptedOffer = row.offers.find((offer) => offer.id === row.acceptedOfferId);
    const { termsHash } = await import('../../src/domain/preorder.js');
    const { fromDateColumn } = await import('../../src/domain/delivery-dates.js');

    expect(acceptedOffer?.state).toBe('ACCEPTED');
    // Recompute the hash from the stored columns: nothing has been rewritten.
    expect(
      termsHash({
        requestId: row.id,
        revision: acceptedOffer?.revision ?? 0,
        quantityBaseUnits: acceptedOffer?.quantityBaseUnits ?? 0,
        unitPriceMinor: acceptedOffer?.unitPriceMinor ?? 0n,
        goodsTotalMinor: acceptedOffer?.goodsTotalMinor ?? 0n,
        freightMinor: acceptedOffer?.freightMinor ?? 0n,
        currency: acceptedOffer?.currency ?? '',
        committedDeliveryDate: fromDateColumn(acceptedOffer?.committedDeliveryDate ?? new Date()),
        deliverySplits: acceptedOffer?.deliverySplitsJson as
          { date: string; baseUnits: number }[] | null,
      }),
    ).toBe(row.confirmedTermsHash);
    expect(row.confirmedUnitPriceMinor).toBe(7_900n);

    // And the seller cannot put new terms on the table any more.
    await expect(
      service.sellerCounter(sellerResponder(seller), submitted.id, {
        quantityBaseUnits: 12_000,
        unitPriceMinor: '1',
        freightMinor: '0',
        committedDeliveryDate: deliveryDay(),
        deliverySplits: null,
        originLocationId: null,
        note: null,
        expectedVersion: row.version,
      }),
    ).rejects.toMatchObject({ code: 'PREORDER_TRANSITION_NOT_ALLOWED' });
  });

  it('is confirmed by the order’s own confirmation - the signed webhook’s path - and handed to fulfilment', async () => {
    const row = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: submitted.id } });
    const { transitionOrder } = await import('../../src/modules/orders/order.service.js');

    await transitionOrder({
      orderId: row.convertedOrderId ?? '',
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
      reason: 'Payment captured',
    });

    expect((await sellerView(submitted.id)).status).toBe('CONFIRMED');

    await service.sellerAdvanceProduction(
      sellerResponder(seller),
      submitted.id,
      'IN_PRODUCTION',
      null,
    );
    await service.sellerAdvanceProduction(
      sellerResponder(seller),
      submitted.id,
      'READY_FOR_FULFILLMENT',
      null,
    );
    expect((await sellerView(submitted.id)).status).toBe('READY_FOR_FULFILLMENT');

    // The goods now exist: the seller books them in and accepts the order,
    // which reserves them exactly as for any marketplace order.
    const { recordStockMovement } = await import('../../src/modules/seller/inventory.service.js');
    await recordStockMovement({
      membership: seller,
      offerId,
      locationId,
      type: 'RECEIPT',
      quantityDelta: 12_000,
      reason: 'Preorder production run',
    });

    const group = await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId: row.convertedOrderId ?? '', sellerAccountId },
    });
    const { transitionSellerOrder } = await import('../../src/modules/seller/order.service.js');
    await transitionSellerOrder({
      membership: seller,
      groupId: group.id,
      to: 'ACCEPTED',
      locationId,
    });

    const done = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(done.status).toBe('CONVERTED_TO_ORDER');
    // Used, not released.
    expect(await bucketReserved()).toBe(12_000);
  });
});

describe('capacity', () => {
  it('is never overbooked by two buyers confirming at once', async () => {
    // 12,000 already used this month by the preorder above; capacity 20,000.
    // Two more buyers each want 4,000 - both fit on their own, only one fits
    // beside the other... and a third asking 8,000 too would not.
    await prisma.preorderCapacityBucket.updateMany({
      where: { sellerAccountId },
      data: { reservedBaseUnits: 12_000 },
    });

    const mine = await submitAsBuyer({ offerId, unitQuantity: 5000 });
    const theirs = await submitAsBuyerTwo({ offerId, unitQuantity: 5000 });
    const acceptedMine = await accept(mine.id);
    const acceptedTheirs = await accept(theirs.id);

    const buyerTwo = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL_TWO } });

    const results = await Promise.allSettled([
      confirmAsBuyer(acceptedMine).then((response) => {
        if (response.statusCode !== 200) throw new Error(errorOf(response.body).code);
        return response;
      }),
      service.buyerConfirm(
        { userId: buyerTwo.id, email: EMAIL_TWO, customerProfileId: buyerTwoProfileId },
        theirs.id,
        {
          offerId: acceptedTheirs.currentOffer?.id ?? '',
          termsHash: acceptedTheirs.currentOffer?.termsHash ?? '',
        },
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(
      /PREORDER_CAPACITY_EXCEEDED|can make/,
    );

    expect(await bucketReserved()).toBe(17_000);
  });

  it('is released when the buyer cancels before paying, and the order is cancelled with it', async () => {
    const waiting = await prisma.preorderRequest.findFirstOrThrow({
      where: { sellerAccountId, status: 'PAYMENT_REQUIRED' },
    });

    const buyerUser = await prisma.customerProfile.findUniqueOrThrow({
      where: { id: waiting.customerProfileId },
      include: { user: true },
    });

    await service.buyerCancel(
      {
        userId: buyerUser.userId,
        email: buyerUser.user.email,
        customerProfileId: waiting.customerProfileId,
      },
      waiting.id,
      { reason: 'Budget withdrawn' },
    );

    const after = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: waiting.id } });
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: waiting.convertedOrderId ?? '' },
    });
    expect(after.status).toBe('CANCELLED');
    expect(after.capacityReservedBaseUnits).toBe(0);
    expect(order.status).toBe('CANCELLED');
    expect(await bucketReserved()).toBe(12_000);
  });

  it('is released when an unpaid preorder expires', async () => {
    const pending = await submitAsBuyerTwo({ offerId, unitQuantity: 2000 });
    const accepted = await accept(pending.id);
    const buyerTwo = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL_TWO } });
    await service.buyerConfirm(
      { userId: buyerTwo.id, email: EMAIL_TWO, customerProfileId: buyerTwoProfileId },
      pending.id,
      {
        offerId: accepted.currentOffer?.id ?? '',
        termsHash: accepted.currentOffer?.termsHash ?? '',
      },
    );
    expect(await bucketReserved()).toBe(14_000);

    await prisma.preorderRequest.update({
      where: { id: pending.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await service.expireStalePreorders();

    const after = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe('EXPIRED');
    expect(await bucketReserved()).toBe(12_000);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: after.convertedOrderId ?? '' },
    });
    expect(order.status).toBe('CANCELLED');
  });

  it('expires a request the seller never answered', async () => {
    const unanswered = await submitAsBuyer({ offerId, unitQuantity: 1000 });
    await prisma.preorderRequest.update({
      where: { id: unanswered.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await service.expireStalePreorders();
    expect(
      (await prisma.preorderRequest.findUniqueOrThrow({ where: { id: unanswered.id } })).status,
    ).toBe('EXPIRED');
  });
});

describe('the buyer declining', () => {
  it('sends the request back to the seller rather than ending it', async () => {
    const fresh = await submitAsBuyer({ offerId, unitQuantity: 1000 });
    await accept(fresh.id);
    const response = await post(`/api/v1/preorders/${fresh.id}/decline`, {
      note: 'Need it a week earlier.',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((JSON.parse(response.body) as { preorder: PreorderBody }).preorder.status).toBe(
      'SELLER_REVIEW_REQUIRED',
    );

    const declined = await prisma.preorderOffer.findFirstOrThrow({
      where: { requestId: fresh.id },
    });
    expect(declined.state).toBe('DECLINED');

    const rejected = (await service.sellerReject(sellerResponder(seller), fresh.id, {
      reason: 'Cannot deliver sooner.',
    })) as unknown as PreorderBody;
    expect(rejected.status).toBe('REJECTED');
  });
});
