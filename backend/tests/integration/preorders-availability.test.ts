/**
 * Container preorders and availability proposals, end to end.
 *
 * THE FIGURES
 *
 *   carton          100 pieces, 400 x 300 x 250 mm, 10 kg
 *   variant "Box"   20-ft: 120 cartons = 12,000 pieces   40-ft: 250 = 25,000
 *   variant "Bulk"  20-ft:  60 cartons =  6,000 pieces   40-ft: not configured
 *   stock           15,000 pieces of "Box" at one location
 *   policy          minimum 10,000 pieces, steps of 100, FIXED at ₹90.00
 *
 * So 2 x 20-ft of "Box" is 24,000 pieces: 15,000 available now and 9,000 to
 * follow - the seller answers with a revised date or a split delivery, and the
 * buyer's acceptance holds the 15,000 atomically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type * as RequestService from '../../src/modules/preorders/request.service.js';
import type * as LoadingService from '../../src/modules/seller/container-loading.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import type { Responder } from '../../src/modules/preorders/supplier.js';
import type { BuyerActor } from '../../src/modules/preorders/request.service.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;
let service: typeof RequestService;
let loading: typeof LoadingService;

const PREFIX = 'pav-';
const CATEGORY_SLUG = 'preorder-availability-test';
const PASSWORD = 'PreorderAvail!2026';
const EMAILS = {
  buyer: 'pav-buyer@test.local',
  buyerTwo: 'pav-buyer-two@test.local',
  seller: 'pav-seller@test.local',
  rival: 'pav-rival@test.local',
};

let productId = '';
let boxVariantId = '';
let bulkVariantId = '';
let boxOfferId = '';
let bulkOfferId = '';
let sellerAccountId = '';
let locationId = '';
let seller: SellerMembership;
let rival: SellerMembership;
let buyer: BuyerActor;
let buyerTwo: BuyerActor;
let buyerAddressId = '';
let buyerTwoAddressId = '';
let cookieHeader = '';
let csrfToken = '';

function responder(membership: SellerMembership): Responder {
  return {
    kind: 'SELLER',
    sellerAccountId: membership.sellerAccountId,
    displayName: membership.displayName,
    userId: null,
    staffEmail: null,
  };
}

function kolkataToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function plusDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const REQUESTED = (): string => plusDays(kolkataToday(), 40);
const LATER = (): string => plusDays(kolkataToday(), 55);
const inTwoDays = (): string => new Date(Date.now() + 48 * 3_600_000).toISOString();

interface View {
  id: string;
  status: string;
  version: number;
  quantity: { orderingUnit: string; unitQuantity: number; unitsPerPackage: number; baseUnits: number };
  container: { piecesPerContainer: number; totalPieces: number; containers: number } | null;
  availability: {
    atSubmission: { availableNow: number; remaining: number; sufficient: boolean };
    live: { availableToPromise: number } | null;
  };
  currentOffer: {
    id: string;
    termsHash: string;
    kind: string;
    stockAllocationBaseUnits: number;
    stockStillAvailable: boolean;
    installments: { sequence: number; quantityBaseUnits: number; source: string; status: string }[];
    quote: { grandTotal: { minor: string } } | null;
  } | null;
  offers: { id: string; state: string; kind: string; responseNote: string | null }[];
  order: { id: string } | null;
}

function input(overrides: Record<string, unknown> = {}) {
  return service.preorderInputSchema.parse({
    productId,
    variantId: boxVariantId,
    offerId: boxOfferId,
    orderingUnit: 'PIECE',
    unitQuantity: 12_000,
    requestedDeliveryDate: REQUESTED(),
    shippingAddressId: buyerAddressId,
    acceptTerms: true,
    ...overrides,
  });
}

async function submit(actor: BuyerActor, overrides: Record<string, unknown> = {}): Promise<View> {
  const addressId = actor === buyer ? buyerAddressId : buyerTwoAddressId;
  return (await service.submitPreorder(
    actor,
    input({ shippingAddressId: addressId, ...overrides }),
  )) as unknown as View;
}

async function sellerView(id: string): Promise<View> {
  return (await service.getSellerPreorder(sellerAccountId, id)) as unknown as View;
}

async function buyerView(actor: BuyerActor, id: string): Promise<View> {
  return (await service.getBuyerPreorder(actor.customerProfileId, id)) as unknown as View;
}

function proposal(_id: string, version: number, overrides: Record<string, unknown> = {}) {
  return service.availabilityProposalSchema.parse({
    kind: 'SPLIT_DELIVERY',
    unitPriceMinor: '9000',
    freightMinor: '0',
    installments: [
      { date: REQUESTED(), baseUnits: 15_000 },
      { date: LATER(), baseUnits: 9_000 },
    ],
    expiresAt: inTwoDays(),
    originLocationId: locationId,
    note: 'First 15,000 from stock, the rest from the next run.',
    expectedVersion: version,
    ...overrides,
  });
}

async function propose(id: string, overrides: Record<string, unknown> = {}): Promise<View> {
  const current = await sellerView(id);
  return (await service.sellerProposeAvailability(
    responder(seller),
    id,
    proposal(id, current.version, overrides),
  )) as unknown as View;
}

async function confirm(actor: BuyerActor, view: View): Promise<View> {
  return (await service.buyerConfirm(actor, view.id, {
    offerId: view.currentOffer?.id ?? '',
    termsHash: view.currentOffer?.termsHash ?? '',
  })) as unknown as View;
}

async function stock(): Promise<{ available: number; reserved: number }> {
  const row = await prisma.sellerInventory.findUniqueOrThrow({
    where: { offerId_locationId: { offerId: boxOfferId, locationId } },
  });
  return { available: row.availableQuantity, reserved: row.reservedQuantity };
}

async function setStock(available: number): Promise<void> {
  await prisma.sellerInventory.update({
    where: { offerId_locationId: { offerId: boxOfferId, locationId } },
    data: { availableQuantity: available, reservedQuantity: 0 },
  });
  await prisma.sellerOffer.update({
    where: { id: boxOfferId },
    data: { availableQuantity: available, reservedQuantity: 0 },
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'NO_ERROR';
}

/** Close every open request, so each test starts from the stock it sets. */
async function closeOpenRequests(): Promise<void> {
  const open = await prisma.preorderRequest.findMany({
    where: { sellerAccountId, status: { notIn: ['CANCELLED', 'REJECTED', 'EXPIRED', 'CONVERTED_TO_ORDER'] } },
  });
  for (const row of open) {
    const actor = row.customerProfileId === buyer.customerProfileId ? buyer : buyerTwo;
    await service.buyerCancel(actor, row.id, { reason: 'Test tidy-up' }).catch(() => undefined);
  }
}

const cartonBody = {
  piecesPerCarton: 100,
  cartonLength: 400,
  cartonWidth: 300,
  cartonHeight: 250,
  dimensionUnit: 'MM',
  grossWeightPerCarton: 10,
  weightUnit: 'KG',
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  const profiles = (
    await prisma.customerProfile.findMany({
      where: { user: { emailNormalized: { in: Object.values(EMAILS) } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const orders = (
    await prisma.order.findMany({ where: { customerProfileId: { in: profiles } }, select: { id: true } })
  ).map((row) => row.id);

  await prisma.preorderRequest.deleteMany({ where: { customerProfileId: { in: profiles } } });
  await prisma.shipmentLeg.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.orderLogisticsLeg.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.sellerOrderSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.logisticsShipment.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerShipment.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { sellerAccountId: { in: sellers } } } });
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
  await prisma.sellerContainerLoading.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.preorderPolicy.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });

  await prisma.productVariant.deleteMany({ where: { product: { category: { slug: CATEGORY_SLUG } } } });
  await prisma.productPrice.deleteMany({ where: { product: { category: { slug: CATEGORY_SLUG } } } });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });

  await prisma.address.deleteMany({ where: { customerProfileId: { in: profiles } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.customerAcknowledgement.deleteMany({
    where: { user: { emailNormalized: { in: Object.values(EMAILS) } } },
  });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: Object.values(EMAILS) } } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: Object.values(EMAILS) } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: Object.values(EMAILS) } } });
}

async function makeCustomer(email: string, organization: string, roleId: string, hash: string) {
  const { env } = await import('../../src/config/env.js');
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
    data: { id: newId(), userId: user.id, fullName: `Buyer ${email}`, organization, activatedAt: new Date() },
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
  await prisma.customerAcknowledgement.create({
    data: { id: newId(), userId: user.id, type: 'PREORDER_INFO', policyVersion: env.PREORDER_INFO_VERSION },
  });
  return {
    actor: { userId: user.id, email, customerProfileId: profile.id } satisfies BuyerActor,
    addressId: address.id,
  };
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  service = await import('../../src/modules/preorders/request.service.js');
  loading = await import('../../src/modules/seller/container-loading.service.js');
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { Role } = await import('../../src/domain/permissions.js');
  const { resolveSellerMembership } = await import('../../src/modules/seller/account.service.js');

  app = await buildApp();
  await app.ready();
  await cleanUp();

  // This file's OWN taxable class, found by its code. It used to take whichever
  // class came first - on a fresh CI database that was a 0% class another file
  // had made, the quote's tax was zero, and the total-exceeds-goods assertion
  // below failed there while passing locally.
  const taxClass =
    (await prisma.taxClass.findFirst({ where: { code: 'PAV18' }, select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: { id: newId(), code: 'PAV18', name: 'GST 18%', ratePercent: '18.000000', isActive: true },
      select: { id: true },
    }));
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Preorder availability', slug: CATEGORY_SLUG, isActive: true },
  });
  productId = (
    await prisma.product.create({
      data: {
        id: newId(),
        categoryId: category.id,
        taxClassId: taxClass.id,
        name: 'Nitrile gloves',
        slug: `${PREFIX}gloves`,
        sku: 'PAV-GLOVES',
        basePriceMinor: 0n,
        currency: 'INR',
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(),
        isMarketplaceProduct: true,
        isStockTracked: false,
        minOrderQty: 1,
        qtyIncrement: 1,
      },
    })
  ).id;
  const variant = async (name: string) =>
    (
      await prisma.productVariant.create({
        data: {
          id: newId(),
          productId,
          sku: `PAV-${name.toUpperCase()}`,
          name,
          optionsJson: { pack: name },
          optionSignature: `pack=${name.toLowerCase()}`,
        },
      })
    ).id;
  boxVariantId = await variant('Box');
  bulkVariantId = await variant('Bulk');

  const customerRole = await prisma.role.findUniqueOrThrow({ where: { key: Role.CUSTOMER }, select: { id: true } });
  const hash = await hashPassword(PASSWORD);
  const one = await makeCustomer(EMAILS.buyer, 'Acme Hospitals', customerRole.id, hash);
  buyer = one.actor;
  buyerAddressId = one.addressId;
  const two = await makeCustomer(EMAILS.buyerTwo, 'Beta Clinics', customerRole.id, hash);
  buyerTwo = two.actor;
  buyerTwoAddressId = two.addressId;
  const sellerPerson = await makeCustomer(EMAILS.seller, 'Seller staff', customerRole.id, hash);
  const rivalPerson = await makeCustomer(EMAILS.rival, 'Rival staff', customerRole.id, hash);

  const makeSeller = async (slug: string, ownerProfileId: string) => {
    const id = newId();
    await prisma.sellerAccount.create({
      data: {
        id,
        legalName: `${slug} Gloves Pvt Ltd`,
        displayName: `${slug} Gloves`,
        displayNameNormalized: `${slug} gloves`,
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
  sellerAccountId = await makeSeller('epsilon', sellerPerson.actor.customerProfileId);
  await makeSeller('zeta', rivalPerson.actor.customerProfileId);
  seller = await resolveSellerMembership(sellerPerson.actor.customerProfileId);
  rival = await resolveSellerMembership(rivalPerson.actor.customerProfileId);

  locationId = newId();
  await prisma.sellerLocation.create({
    data: {
      id: locationId,
      sellerAccountId,
      code: 'PAV-1',
      name: 'Pune plant',
      addressLine1: '1 MIDC',
      city: 'Pune',
      postcode: '411019',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
    },
  });

  const makeOffer = async (variantId: string, sku: string) => {
    const id = newId();
    await prisma.sellerOffer.create({
      data: {
        id,
        sellerAccountId,
        productId,
        variantId,
        variantKey: variantId,
        sellerSku: sku,
        status: 'ACTIVE',
        orderingUnit: 'PIECE',
        priceMinor: 10_000n,
        currency: 'INR',
      },
    });
    return id;
  };
  boxOfferId = await makeOffer(boxVariantId, 'EPS-BOX');
  bulkOfferId = await makeOffer(bulkVariantId, 'EPS-BULK');
  await prisma.sellerInventory.create({
    data: { id: newId(), sellerAccountId, offerId: boxOfferId, locationId, availableQuantity: 15_000 },
  });
  await prisma.sellerOffer.update({ where: { id: boxOfferId }, data: { availableQuantity: 15_000 } });

  const { savePolicy, policyInputSchema } = await import('../../src/modules/preorders/policy.service.js');
  for (const offer of [boxOfferId, bulkOfferId]) {
    await savePolicy(
      seller,
      policyInputSchema.parse({
        scope: 'OFFER',
        offerId: offer,
        isEnabled: true,
        moqUnit: 'PIECE',
        moqQuantity: 10_000,
        incrementQuantity: 100,
        minLeadTimeDays: 10,
        pricingMode: 'FIXED',
        allowSplitDelivery: true,
        tiers: [{ minBaseUnits: 10_000, unitPriceMinor: '9000' }],
      }),
    );
  }

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAILS.buyer, password: PASSWORD },
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
// Phase 1: container capacity
// ---------------------------------------------------------------------------

describe('container loading in Seller Hub', () => {
  it('saves both sizes, derives the pieces and records who verified them', async () => {
    const view = await loading.saveContainerLoading(
      seller,
      boxOfferId,
      loading.containerLoadingInputSchema.parse({
        ...cartonBody,
        twentyFt: { cartonsPerContainer: 120, verified: true },
        fortyFt: { cartonsPerContainer: 250, verified: true },
      }),
      null,
    );
    expect(view.configured).toBe(true);
    const sizes = (view as { sizes: Record<string, { piecesPerContainer: number; source: string }> }).sizes;
    expect(sizes['CONTAINER_20_FT']).toMatchObject({ piecesPerContainer: 12_000, source: 'SELLER_VERIFIED' });
    expect(sizes['CONTAINER_40_FT']).toMatchObject({ piecesPerContainer: 25_000, source: 'SELLER_VERIFIED' });

    const audit = await prisma.sellerAuditLog.findFirst({
      where: { sellerAccountId, action: 'seller.container_loading.saved' },
    });
    expect(audit?.summary).toMatch(/12,000 pieces \(verified\)/);

    await loading.saveContainerLoading(
      seller,
      bulkOfferId,
      loading.containerLoadingInputSchema.parse({
        ...cartonBody,
        twentyFt: { cartonsPerContainer: 60, verified: true },
      }),
      null,
    );
  });

  it('refuses a payload above the configured container limit', async () => {
    const code = await errorCode(
      loading.saveContainerLoading(
        seller,
        bulkOfferId,
        loading.containerLoadingInputSchema.parse({
          ...cartonBody,
          twentyFt: { cartonsPerContainer: 3000, verified: true },
          expectedVersion: 1,
        }),
        null,
      ),
    );
    expect(code).toBe('CONTAINER_LOADING_INVALID');
  });

  it('refuses a save from a stale form', async () => {
    const code = await errorCode(
      loading.saveContainerLoading(
        seller,
        boxOfferId,
        loading.containerLoadingInputSchema.parse({
          ...cartonBody,
          twentyFt: { cartonsPerContainer: 120, verified: true },
          expectedVersion: 99,
        }),
        null,
      ),
    );
    expect(code).toBe('CONFLICT');
  });

  it('is invisible to another seller', async () => {
    expect(await errorCode(loading.readContainerLoading(rival, boxOfferId))).toBe('NOT_FOUND');
    expect(
      await errorCode(
        loading.saveContainerLoading(
          rival,
          boxOfferId,
          loading.containerLoadingInputSchema.parse({ ...cartonBody }),
          null,
        ),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('the Order in choice', () => {
  it('offers both container sizes with the variant’s own verified capacity', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${productId}&variantId=${boxVariantId}`,
    });
    const body = JSON.parse(response.body) as {
      eligibility: { containerOptions: { unit: string; available: boolean; piecesPerContainer: number | null }[] };
    };
    expect(body.eligibility.containerOptions).toEqual([
      expect.objectContaining({ unit: 'CONTAINER_20_FT', available: true, piecesPerContainer: 12_000 }),
      expect.objectContaining({ unit: 'CONTAINER_40_FT', available: true, piecesPerContainer: 25_000 }),
    ]);
  });

  it('changes capacity with the variant, and marks an unconfigured size unavailable with no figure', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/preorders/eligibility?productId=${productId}&variantId=${bulkVariantId}`,
    });
    const body = JSON.parse(response.body) as {
      eligibility: { containerOptions: { unit: string; available: boolean; piecesPerContainer: number | null; reason: string | null }[] };
    };
    expect(body.eligibility.containerOptions).toEqual([
      expect.objectContaining({ unit: 'CONTAINER_20_FT', available: true, piecesPerContainer: 6_000 }),
      expect.objectContaining({
        unit: 'CONTAINER_40_FT',
        available: false,
        piecesPerContainer: null,
        reason: 'NOT_CONFIGURED',
      }),
    ]);
  });
});

describe('a container preorder', () => {
  it('converts 2 x 20-ft to 24,000 pieces and prices every one of them', async () => {
    const preview = (await service.previewPreorder(
      buyer.customerProfileId,
      input({ orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 }),
    )) as { baseUnits: number; container: { piecesPerContainer: number; totalPieces: number }; goodsTotal: { minor: string } };
    expect(preview.baseUnits).toBe(24_000);
    expect(preview.container).toMatchObject({ piecesPerContainer: 12_000, totalPieces: 24_000 });
    expect(preview.goodsTotal.minor).toBe(String(24_000 * 9_000));
  });

  it('converts 1 x 40-ft to 25,000 pieces', async () => {
    const preview = (await service.previewPreorder(
      buyer.customerProfileId,
      input({ orderingUnit: 'CONTAINER_40_FT', unitQuantity: 1 }),
    )) as { baseUnits: number };
    expect(preview.baseUnits).toBe(25_000);
  });

  it('checks the minimum against the equivalent pieces', async () => {
    // 1 x 20-ft of "Bulk" is 6,000 pieces, under the 10,000 minimum.
    const code = await errorCode(
      service.previewPreorder(
        buyer.customerProfileId,
        input({ variantId: bulkVariantId, offerId: bulkOfferId, orderingUnit: 'CONTAINER_20_FT', unitQuantity: 1 }),
      ),
    );
    expect(code).toBe('PREORDER_BELOW_MINIMUM');
  });

  it('is refused in a size the seller has not configured', async () => {
    const code = await errorCode(
      service.previewPreorder(
        buyer.customerProfileId,
        input({ variantId: bulkVariantId, offerId: bulkOfferId, orderingUnit: 'CONTAINER_40_FT', unitQuantity: 2 }),
      ),
    );
    expect(code).toBe('PREORDER_CONTAINER_NOT_CONFIGURED');
  });

  it('refuses a capacity or a total the browser tries to supply', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/preorders/preview',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: {
        productId,
        variantId: boxVariantId,
        offerId: boxOfferId,
        orderingUnit: 'CONTAINER_20_FT',
        unitQuantity: 2,
        unitsPerPackage: 50_000,
        totalRequestedPieces: 100_000,
        requestedDeliveryDate: REQUESTED(),
        shippingAddressId: buyerAddressId,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps its own capacity snapshot when the seller changes the loading later', async () => {
    const submitted = await submit(buyer, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 });
    expect(submitted.container).toMatchObject({ piecesPerContainer: 12_000, totalPieces: 24_000, containers: 2 });

    // The seller re-specifies the 20-ft box without verifying it again.
    const current = await loading.readContainerLoading(seller, boxOfferId);
    await loading.saveContainerLoading(
      seller,
      boxOfferId,
      loading.containerLoadingInputSchema.parse({
        ...cartonBody,
        twentyFt: { cartonsPerContainer: 110, verified: false },
        fortyFt: { cartonsPerContainer: 250, verified: false },
        expectedVersion: current.version,
      }),
      null,
    );

    const after = await buyerView(buyer, submitted.id);
    expect(after.quantity).toMatchObject({ unitsPerPackage: 12_000, baseUnits: 24_000 });
    expect(after.container).toMatchObject({ piecesPerContainer: 12_000 });

    // And the changed, unverified figure is no longer offered to anybody.
    const code = await errorCode(
      service.previewPreorder(buyer.customerProfileId, input({ orderingUnit: 'CONTAINER_20_FT', unitQuantity: 1 })),
    );
    expect(code).toBe('PREORDER_CONTAINER_NOT_CONFIGURED');

    // Put the verified loading back for the rest of the suite.
    const reloaded = await loading.readContainerLoading(seller, boxOfferId);
    await loading.saveContainerLoading(
      seller,
      boxOfferId,
      loading.containerLoadingInputSchema.parse({
        ...cartonBody,
        twentyFt: { cartonsPerContainer: 120, verified: true },
        fortyFt: { cartonsPerContainer: 250, verified: true },
        expectedVersion: reloaded.version,
      }),
      null,
    );
    await service.buyerCancel(buyer, submitted.id, { reason: 'Test tidy-up' });
  });

  it('still takes a plain piece preorder exactly as before', async () => {
    const submitted = await submit(buyer, { orderingUnit: 'PIECE', unitQuantity: 12_000 });
    expect(submitted.quantity).toMatchObject({ orderingUnit: 'PIECE', unitsPerPackage: 1, baseUnits: 12_000 });
    expect(submitted.container).toBeNull();
    await service.buyerCancel(buyer, submitted.id, { reason: 'Test tidy-up' });
  });
});

// ---------------------------------------------------------------------------
// Phase 2: more than is available
// ---------------------------------------------------------------------------

describe('when the stock covers the request', () => {
  it('goes through the ordinary flow and holds no stock', async () => {
    await closeOpenRequests();
    await setStock(15_000);
    const submitted = await submit(buyer, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 1 });
    expect(submitted.availability.atSubmission).toEqual(
      expect.objectContaining({ sufficient: true, availableNow: 12_000, remaining: 0 }),
    );

    const current = await sellerView(submitted.id);
    const accepted = (await service.sellerAccept(responder(seller), submitted.id, {
      unitPriceMinor: null,
      freightMinor: '0',
      committedDeliveryDate: null,
      originLocationId: locationId,
      note: null,
      expectedVersion: current.version,
    })) as unknown as View;
    const done = await confirm(buyer, (await buyerView(buyer, accepted.id)));
    expect(done.status).toBe('PAYMENT_REQUIRED');
    expect(await stock()).toEqual({ available: 15_000, reserved: 0 });
    await service.buyerCancel(buyer, submitted.id, { reason: 'Test tidy-up' });
  });
});

describe('when the request is for more than is available', () => {
  it('says how much is available now and how much remains', async () => {
    await closeOpenRequests();
    await setStock(15_000);
    const submitted = await submit(buyer, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 });
    expect(submitted.availability.atSubmission).toEqual(
      expect.objectContaining({ sufficient: false, availableNow: 15_000, remaining: 9_000 }),
    );
    const alert = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId, subjectId: submitted.id, kind: 'PREORDER_REQUEST_RECEIVED' },
    });
    expect(alert?.body).toMatch(/Only 15,000 are available now/);
  });

  it('lets the seller offer the complete quantity on a later committed date', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SUBMITTED' },
    });
    const view = await propose(request.id, {
      kind: 'FULL_ON_REVISED_DATE',
      revisedDate: LATER(),
      installments: null,
    });
    expect(view.status).toBe('SELLER_COUNTERED');
    expect(view.currentOffer).toMatchObject({ kind: 'FULL_ON_REVISED_DATE', stockAllocationBaseUnits: 15_000 });
    expect(view.currentOffer?.installments).toEqual([
      expect.objectContaining({ sequence: 1, quantityBaseUnits: 24_000, status: 'PROPOSED' }),
    ]);
  });

  it('refuses a revised date that is not later than the date asked for', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_COUNTERED' },
    });
    const current = await sellerView(request.id);
    const code = await errorCode(
      service.sellerProposeAvailability(
        responder(seller),
        request.id,
        proposal(request.id, current.version, {
          kind: 'FULL_ON_REVISED_DATE',
          revisedDate: REQUESTED(),
          installments: null,
        }),
      ),
    );
    expect(code).toBe('PREORDER_PROPOSAL_INVALID');
  });

  it('lets the seller revise it into a split delivery, superseding the first', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_COUNTERED' },
    });
    const view = await propose(request.id);
    expect(view.currentOffer).toMatchObject({ kind: 'SPLIT_DELIVERY', stockAllocationBaseUnits: 15_000 });
    expect(view.currentOffer?.installments.map((part) => [part.quantityBaseUnits, part.source])).toEqual([
      [15_000, 'AVAILABLE_STOCK'],
      [9_000, 'FUTURE_SUPPLY'],
    ]);
    expect(view.offers.map((offer) => offer.state)).toEqual(['SUPERSEDED', 'PROPOSED']);
    // A price the buyer can read in full: goods, tax and total.
    expect(Number(view.currentOffer?.quote?.grandTotal.minor ?? 0)).toBeGreaterThan(24_000 * 9_000);
  });

  it('refuses a split that does not add up, starts above stock, or runs backwards', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_COUNTERED' },
    });
    const current = await sellerView(request.id);
    const tryIt = (installments: { date: string; baseUnits: number }[]) =>
      errorCode(
        service.sellerProposeAvailability(
          responder(seller),
          request.id,
          proposal(request.id, current.version, { installments }),
        ),
      );
    expect(await tryIt([{ date: REQUESTED(), baseUnits: 15_000 }, { date: LATER(), baseUnits: 8_000 }])).toBe(
      'PREORDER_PROPOSAL_INVALID',
    );
    expect(await tryIt([{ date: REQUESTED(), baseUnits: 16_000 }, { date: LATER(), baseUnits: 8_000 }])).toBe(
      'PREORDER_PROPOSAL_INVALID',
    );
    expect(await tryIt([{ date: LATER(), baseUnits: 15_000 }, { date: REQUESTED(), baseUnits: 9_000 }])).toBe(
      'PREORDER_PROPOSAL_INVALID',
    );
    expect(await tryIt([{ date: REQUESTED(), baseUnits: 24_000 }, { date: LATER(), baseUnits: 0 }])).toBe(
      'PREORDER_PROPOSAL_INVALID',
    );
  });

  it('creates no order, reserves nothing and charges nobody until the buyer accepts', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_COUNTERED' },
    });
    expect(request.convertedOrderId).toBeNull();
    expect(await prisma.order.count({ where: { customerProfileId: buyer.customerProfileId, status: { not: 'CANCELLED' } } })).toBe(0);
    expect(await stock()).toEqual({ available: 15_000, reserved: 0 });
  });

  it('is invisible to another buyer and cannot be answered by another seller', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_COUNTERED' },
    });
    expect(await errorCode(buyerView(buyerTwo, request.id))).toBe('NOT_FOUND');
    expect(
      await errorCode(
        service.sellerProposeAvailability(responder(rival), request.id, proposal(request.id, request.version)),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await errorCode(
        service.buyerConfirm(buyerTwo, request.id, {
          offerId: request.currentOfferId ?? '',
          termsHash: 'a'.repeat(64),
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('holds the stock, plans the rest and creates an unpaid order when the buyer accepts', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_COUNTERED' },
    });
    const done = await confirm(buyer, await buyerView(buyer, request.id));
    expect(done.status).toBe('PAYMENT_REQUIRED');
    expect(await stock()).toEqual({ available: 0, reserved: 15_000 });

    const holds = await prisma.preorderStockHold.findMany({ where: { requestId: request.id } });
    expect(holds).toEqual([expect.objectContaining({ quantityBaseUnits: 15_000, status: 'HELD', locationId })]);

    const plan = await prisma.preorderFulfilmentInstallment.findMany({
      where: { requestId: request.id, status: { not: 'CANCELLED' } },
      orderBy: { sequence: 'asc' },
    });
    expect(plan.map((part) => part.status)).toEqual(['STOCK_RESERVED', 'PLANNED']);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: done.order?.id ?? '' },
      include: { items: { include: { packaging: true } } },
    });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.items[0]).toMatchObject({ orderingUnit: 'CONTAINER', unitQuantity: 2, piecesPerUnitSnapshot: 12_000 });
    expect(order.items[0]?.packaging).toMatchObject({
      packageType: 'CONTAINER',
      containerType: 'DRY_20GP',
      packageQuantity: 2,
      unitsPerPackage: 12_000,
      cartonsPerContainer: 120,
    });
  });

  it('hands the hold to the order, and each later shipment reserves its own stock', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'PAYMENT_REQUIRED' },
    });
    const { transitionOrder } = await import('../../src/modules/orders/order.service.js');
    await transitionOrder({
      orderId: request.convertedOrderId ?? '',
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
      reason: 'Payment captured',
    });

    const group = await prisma.sellerOrderGroup.findFirstOrThrow({
      where: { orderId: request.convertedOrderId ?? '', sellerAccountId },
    });
    const { transitionSellerOrder, recordShipment } = await import('../../src/modules/seller/order.service.js');
    // Accepted with only the first shipment's 15,000 on the shelf.
    await transitionSellerOrder({ membership: seller, groupId: group.id, to: 'ACCEPTED', locationId });
    expect(await stock()).toEqual({ available: 0, reserved: 15_000 });
    const holds = await prisma.preorderStockHold.findMany({ where: { requestId: request.id } });
    expect(holds.map((hold) => hold.status)).toEqual(['TRANSFERRED']);

    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: request.convertedOrderId ?? '' } });
    await recordShipment({
      membership: seller,
      groupId: group.id,
      carrierName: 'Road',
      trackingNumber: 'PAV-1',
      contents: [{ orderItemId: item.id, quantity: 15_000 }],
    });
    expect(await stock()).toEqual({ available: 0, reserved: 0 });

    // The second shipment cannot go before its goods exist...
    expect(
      await errorCode(
        recordShipment({
          membership: seller,
          groupId: group.id,
          carrierName: 'Road',
          trackingNumber: 'PAV-2',
          contents: [{ orderItemId: item.id, quantity: 9_000 }],
        }),
      ),
    ).toBe('INSUFFICIENT_STOCK');

    // ...and goes once they are booked in, reserving and dispatching them.
    const { recordStockMovement } = await import('../../src/modules/seller/inventory.service.js');
    await recordStockMovement({
      membership: seller,
      offerId: boxOfferId,
      locationId,
      type: 'RECEIPT',
      quantityDelta: 9_000,
      reason: 'Production run',
    });
    await recordShipment({
      membership: seller,
      groupId: group.id,
      carrierName: 'Road',
      trackingNumber: 'PAV-3',
      contents: [{ orderItemId: item.id, quantity: 9_000 }],
    });
    expect(await stock()).toEqual({ available: 0, reserved: 0 });
    const line = await prisma.sellerOrderLine.findFirstOrThrow({ where: { orderGroupId: group.id } });
    expect(line.fulfilledQuantity).toBe(24_000);
  });
});

describe('the buyer’s answer', () => {
  async function counteredRequest(actor: BuyerActor): Promise<View> {
    const submitted = await submit(actor, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 });
    return propose(submitted.id);
  }

  it('can ask for a change, which goes back to the seller with the message', async () => {
    await closeOpenRequests();
    await setStock(15_000);
    const view = await counteredRequest(buyer);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/preorders/${view.id}/request-change`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { message: 'Can the second shipment come a week earlier?' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const after = await sellerView(view.id);
    expect(after.status).toBe('SELLER_REVIEW_REQUIRED');
    expect(after.offers.at(-1)).toMatchObject({
      state: 'DECLINED',
      responseNote: 'Can the second shipment come a week earlier?',
    });
    expect(await stock()).toEqual({ available: 15_000, reserved: 0 });
  });

  it('can reject the offer outright, which closes the preorder', async () => {
    const request = await prisma.preorderRequest.findFirstOrThrow({
      where: { customerProfileId: buyer.customerProfileId, status: 'SELLER_REVIEW_REQUIRED' },
    });
    const view = await propose(request.id);
    await service.buyerCancel(buyer, view.id, { reason: 'We found another supplier.' });
    expect((await sellerView(view.id)).status).toBe('CANCELLED');
  });

  it('gives the stock back when an accepted preorder is cancelled before payment', async () => {
    await setStock(15_000);
    const view = await counteredRequest(buyer);
    await confirm(buyer, await buyerView(buyer, view.id));
    expect(await stock()).toEqual({ available: 0, reserved: 15_000 });
    await service.buyerCancel(buyer, view.id, { reason: 'Budget withdrawn.' });
    expect(await stock()).toEqual({ available: 15_000, reserved: 0 });
    const holds = await prisma.preorderStockHold.findMany({ where: { requestId: view.id } });
    expect(holds.map((hold) => hold.status)).toEqual(['RELEASED']);
  });
});

describe('concurrency and stale offers', () => {
  it('never oversells when two buyers accept against the same stock at once', async () => {
    await closeOpenRequests();
    await setStock(15_000);
    const mine = await submit(buyer, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 });
    const theirs = await submit(buyerTwo, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 });
    await propose(mine.id);
    await propose(theirs.id);

    const results = await Promise.allSettled([
      confirm(buyer, await buyerView(buyer, mine.id)),
      confirm(buyerTwo, await buyerView(buyerTwo, theirs.id)),
    ]);
    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'PREORDER_STOCK_CHANGED' });

    expect(await stock()).toEqual({ available: 0, reserved: 15_000 });

    // The loser's offer is invalidated and the request is back with the seller.
    const loserId = results[0]?.status === 'rejected' ? mine.id : theirs.id;
    const loser = await sellerView(loserId);
    expect(loser.status).toBe('SELLER_REVIEW_REQUIRED');
    expect(loser.offers.at(-1)?.state).toBe('INVALIDATED');
    expect(loser.order).toBeNull();
  });

  it('warns the buyer before they accept when the stock has since gone, and refuses safely', async () => {
    await closeOpenRequests();
    await setStock(15_000);
    const submitted = await submit(buyer, { orderingUnit: 'CONTAINER_20_FT', unitQuantity: 2 });
    await propose(submitted.id);

    // The seller's stock drops after the offer was sent.
    await setStock(5_000);
    const view = await buyerView(buyer, submitted.id);
    expect(view.currentOffer?.stockStillAvailable).toBe(false);

    expect(await errorCode(confirm(buyer, view))).toBe('PREORDER_STOCK_CHANGED');
    expect(await stock()).toEqual({ available: 5_000, reserved: 0 });
    const after = await sellerView(submitted.id);
    expect(after.status).toBe('SELLER_REVIEW_REQUIRED');
    expect(after.order).toBeNull();

    const email = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'preorder.stock_changed', relatedId: submitted.id },
    });
    expect(email).not.toBeNull();
  });
});
