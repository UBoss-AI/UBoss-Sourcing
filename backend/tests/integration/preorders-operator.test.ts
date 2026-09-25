/**
 * A preorder on the OPERATOR's own product, end to end.
 *
 * Preorders are open on every product (`PREORDER_OPEN_TO_ALL`). A product the
 * operator sells itself has no seller and no seller offer, so the request is
 * answered by the operator's staff in the admin console. The claims:
 *
 *   - it can be submitted, with no seller on the request;
 *   - the admin bell asks staff to answer, and closes when they do;
 *   - no seller can see or answer it, and staff cannot answer a seller's;
 *   - the buyer's confirmation makes an ordinary operator order (no seller
 *     offer on the line), confirmed only by the payment's confirmation;
 *   - staff starting to fulfil that order hands the preorder over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';
import type * as RequestService from '../../src/modules/preorders/request.service.js';
import type * as Supplier from '../../src/modules/preorders/supplier.js';

let prisma: typeof PrismaClient;
let newId: typeof NewId;
let service: typeof RequestService;
let supplier: typeof Supplier;

const PREFIX = 'pop-';
const BUYER = 'pop-buyer@test.local';
const STAFF = 'pop-staff@test.local';
const RIVAL = 'pop-rival@test.local';
const EMAILS = [BUYER, STAFF, RIVAL];

let productId = '';
let buyerProfileId = '';
let buyerUserId = '';
let addressId = '';
let staffUserId = '';
let rivalSellerAccountId = '';
let requestId = '';

function kolkataToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
function plusDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function cleanUp(): Promise<void> {
  const profiles = { user: { emailNormalized: { in: EMAILS } } };
  const requests = await prisma.preorderRequest.findMany({
    where: { customerProfile: profiles },
    select: { id: true, convertedOrderId: true },
  });
  const orderIds = requests.flatMap((row) =>
    row.convertedOrderId === null ? [] : [row.convertedOrderId],
  );
  await prisma.adminNotification.deleteMany({
    where: { relatedId: { in: requests.map((row) => row.id) } },
  });
  await prisma.preorderRequest.deleteMany({ where: { customerProfile: profiles } });
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { order: { customerProfile: profiles } } });
  await prisma.orderStatusHistory.deleteMany({ where: { order: { customerProfile: profiles } } });
  await prisma.order.deleteMany({ where: { customerProfile: profiles } });
  await prisma.sellerMember.deleteMany({
    where: { sellerAccount: { slug: { startsWith: PREFIX } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.address.deleteMany({ where: { customerProfile: profiles } });
  await prisma.customerProfile.deleteMany({ where: profiles });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

beforeAll(async () => {
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  service = await import('../../src/modules/preorders/request.service.js');
  supplier = await import('../../src/modules/preorders/supplier.js');
  await cleanUp();

  const buyer = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: BUYER,
      emailNormalized: BUYER,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  buyerUserId = buyer.id;
  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: buyer.id,
      fullName: 'Hospital buyer',
      organization: 'City Hospital Trust',
      activatedAt: new Date(),
    },
  });
  buyerProfileId = profile.id;
  addressId = (
    await prisma.address.create({
      data: {
        id: newId(),
        customerProfileId: profile.id,
        contactName: 'Stores',
        contactPhone: '+919800000001',
        line1: '1 Hospital Road',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        country: 'IN',
        timezone: 'Asia/Kolkata',
        isDefaultShipping: true,
      },
    })
  ).id;

  staffUserId = (
    await prisma.user.create({
      data: {
        id: newId(),
        type: 'ADMIN',
        email: STAFF,
        emailNormalized: STAFF,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    })
  ).id;

  const rivalOwner = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: RIVAL,
      emailNormalized: RIVAL,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const rivalProfile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: rivalOwner.id,
      fullName: 'Rival',
      organization: 'Rival Ltd',
      activatedAt: new Date(),
    },
  });
  rivalSellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: rivalSellerAccountId,
      legalName: 'Rival Ltd',
      displayName: 'Rival',
      displayNameNormalized: 'pop rival',
      slug: `${PREFIX}rival`,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: {
      id: newId(),
      sellerAccountId: rivalSellerAccountId,
      customerProfileId: rivalProfile.id,
      role: 'OWNER',
    },
  });

  const taxClass =
    (await prisma.taxClass.findFirst({ select: { id: true } })) ??
    (await prisma.taxClass.create({
      data: { id: newId(), code: 'POP0', name: 'Zero', ratePercent: '0.000000', isActive: true },
      select: { id: true },
    }));
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Operator', slug: `${PREFIX}category`, isActive: true },
  });
  productId = (
    await prisma.product.create({
      data: {
        id: newId(),
        categoryId: category.id,
        taxClassId: taxClass.id,
        name: 'Store-brand gauze',
        slug: `${PREFIX}gauze`,
        sku: 'POP-GAUZE',
        basePriceMinor: 5_000n,
        currency: 'INR',
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(),
        isMarketplaceProduct: false,
        isStockTracked: false,
        minOrderQty: 1,
        qtyIncrement: 1,
      },
    })
  ).id;
});

afterAll(async () => {
  await cleanUp();
});

describe('a preorder on the operator’s own product', () => {
  it('is open, priced at the product’s own price, and supplied by the store', async () => {
    const { evaluateEligibility } = await import('../../src/modules/preorders/policy.service.js');
    const eligibility = await evaluateEligibility({
      productId,
      variantId: null,
      destinationCountry: 'IN',
      timezone: 'Asia/Kolkata',
    });
    expect(eligibility.available).toBe(true);
    if (!eligibility.available) return;
    expect(eligibility.offer.id).toBeNull();
    expect(eligibility.offer.sellerAccountId).toBeNull();
    expect(eligibility.policy.scope).toBe('PLATFORM_DEFAULT');
    expect(eligibility.policy.tiers[0]?.unitPriceMinor).toBe(5_000n);
  });

  it('is submitted with no seller, and asks staff to answer it on the admin bell', async () => {
    const input = service.preorderInputSchema.parse({
      productId,
      orderingUnit: 'PIECE',
      unitQuantity: 2_000,
      requestedDeliveryDate: plusDays(kolkataToday(), 45),
      shippingAddressId: addressId,
      acceptTerms: true,
    });
    const { acknowledgePreorderInfo } =
      await import('../../src/modules/preorders/acknowledgement.service.js');
    await acknowledgePreorderInfo({
      userId: buyerUserId,
      email: BUYER,
      policyVersion: 'PREORDER_INFO_V1',
    });
    const submitted = (await service.submitPreorder(
      { userId: buyerUserId, email: BUYER, customerProfileId: buyerProfileId },
      input,
    )) as { id: string; seller: { id: string | null } };
    requestId = submitted.id;
    expect(submitted.seller.id).toBeNull();

    const row = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.sellerAccountId).toBeNull();
    expect(row.offerId).toBeNull();
    expect(row.policyId).toBeNull();
    expect(row.indicativeTotalMinor).toBe(10_000_000n);

    const alert = await prisma.adminNotification.findFirst({
      where: { relatedId: requestId, status: 'ACTIVE' },
    });
    expect(alert?.kind).toBe('preorder.awaiting_operator');
    expect(alert?.linkPath).toBe(`/preorders/${requestId}`);
  });

  it('cannot be seen or answered by a seller, and staff cannot answer a seller’s', async () => {
    await expect(service.getSellerPreorder(rivalSellerAccountId, requestId)).rejects.toMatchObject({
      statusCode: 404,
    });
    const rival = {
      kind: 'SELLER' as const,
      sellerAccountId: rivalSellerAccountId,
      displayName: 'Rival',
      userId: null,
      staffEmail: null,
    };
    await expect(
      service.sellerReject(rival, requestId, { reason: 'Not ours to refuse' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('is answered by staff, which closes the bell alert and records who acted', async () => {
    const staff = await supplier.operatorResponder({ id: staffUserId, email: STAFF });
    const accepted = (await service.sellerAccept(staff, requestId, {
      unitPriceMinor: null,
      freightMinor: '50000',
      committedDeliveryDate: null,
      originLocationId: null,
      note: null,
      expectedVersion: (
        await prisma.preorderRequest.findUniqueOrThrow({ where: { id: requestId } })
      ).version,
    })) as { status: string; currentOffer: { id: string; termsHash: string } };
    expect(accepted.status).toBe('SELLER_ACCEPTED');

    const alert = await prisma.adminNotification.findFirst({
      where: { relatedId: requestId, kind: 'preorder.awaiting_operator' },
    });
    expect(alert?.status).not.toBe('ACTIVE');

    const history = await prisma.preorderStatusHistory.findFirstOrThrow({
      where: { requestId, toStatus: 'SELLER_ACCEPTED' },
    });
    expect(history.actorType).toBe('ADMIN');
    expect(history.actorLabel).toContain(STAFF);

    // The buyer confirms the store's terms: one ordinary operator order.
    await service.buyerConfirm(
      { userId: buyerUserId, email: BUYER, customerProfileId: buyerProfileId },
      requestId,
      { offerId: accepted.currentOffer.id, termsHash: accepted.currentOffer.termsHash },
    );
    const row = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('PAYMENT_REQUIRED');
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: row.convertedOrderId ?? '' },
    });
    expect(item.sellerOfferId).toBeNull();
    expect(item.unitPriceMinor).toBe(5_000n);
    expect(item.quantity).toBe(2_000);
  });

  it('is confirmed by the payment, made by staff, and handed over when staff fulfil the order', async () => {
    const { transitionOrder } = await import('../../src/modules/orders/order.service.js');
    const row = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: requestId } });
    const orderId = row.convertedOrderId ?? '';

    await transitionOrder({
      orderId,
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
      reason: 'Payment captured',
    });
    expect(
      (await prisma.preorderRequest.findUniqueOrThrow({ where: { id: requestId } })).status,
    ).toBe('CONFIRMED');

    const staff = await supplier.operatorResponder({ id: staffUserId, email: STAFF });
    await service.sellerAdvanceProduction(staff, requestId, 'IN_PRODUCTION', null);
    await service.sellerAdvanceProduction(staff, requestId, 'READY_FOR_FULFILLMENT', null);

    await transitionOrder({
      orderId,
      to: 'PROCESSING',
      actor: { userId: staffUserId, email: STAFF, type: 'ADMIN', permissions: ['order.fulfil'] },
    });
    const done = await prisma.preorderRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(done.status).toBe('CONVERTED_TO_ORDER');
    expect(
      await prisma.adminNotification.count({
        where: { relatedId: requestId, status: 'ACTIVE', class: 'ALERT' },
      }),
    ).toBe(0);
  });

  it('is listed for staff under “answered by us”', async () => {
    const list = (await service.listAdminPreorders({ status: null, supplier: 'OPERATOR' })) as {
      preorders: { id: string; supplier: string }[];
    };
    expect(
      list.preorders.some((entry) => entry.id === requestId && entry.supplier === 'OPERATOR'),
    ).toBe(true);
    const sellers = (await service.listAdminPreorders({ status: null, supplier: 'SELLER' })) as {
      preorders: { id: string }[];
    };
    expect(sellers.preorders.some((entry) => entry.id === requestId)).toBe(false);
  });
});
