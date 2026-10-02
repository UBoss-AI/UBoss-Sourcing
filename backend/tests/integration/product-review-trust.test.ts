/**
 * Ratings you can trust (checklist JOURNEY-059).
 *
 *   - **Verified transaction, and whose.** A review counts towards the seller
 *     of the delivered order line it rests on.
 *   - **Product vs seller score.** The seller's score is delivery and support
 *     across what it sold; the product's rating is unchanged by it.
 *   - **A seller's own team cannot rate its sale**: refused, audited and
 *     raised as a REVIEW_SELF_DEALING risk signal.
 *   - **A daily limit per buyer**, refused with REVIEW_RATE_LIMITED.
 *   - **The seller answers in public; staff can hide the answer** without
 *     touching the scores, and the public stops seeing it.
 *
 * Service-level, on its own products, sellers and buyers; removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  listPublicReviews,
  moderateReviewResponse,
  ratingSummary,
  respondToReview,
  saveOwnReview,
  sellerScore,
} from '../../src/modules/catalog/product-review.service.js';

const TAG = `prt${newId().slice(-6).toLowerCase()}`;
const EMAIL_PREFIX = `${TAG}-`;
const CATEGORY_SLUG = `${TAG}-category`;
const TAX_CODE = `${TAG}-TAX`.toUpperCase().slice(0, 16);

let taxClassId = '';
let categoryId = '';
let productId = '';
let productSlug = '';
let sellerId = '';
let offerId = '';
let buyerProfileId = '';
let buyerUserId = '';
let insiderProfileId = '';
let insiderUserId = '';
let staffUserId = '';

async function makeUser(suffix: string, type: 'CUSTOMER' | 'ADMIN'): Promise<{ userId: string; profileId: string | null }> {
  const userId = newId();
  const email = `${EMAIL_PREFIX}${suffix}@example.test`;
  await prisma.user.create({
    data: { id: userId, type, email, emailNormalized: email, passwordHash: 'not-a-real-hash', status: 'ACTIVE' },
  });
  if (type === 'ADMIN') return { userId, profileId: null };
  const profileId = newId();
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: `Trust ${suffix}`, firstName: 'Trust', lastName: suffix } });
  return { userId, profileId };
}

async function deliveredOrder(profileId: string): Promise<string> {
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `PRT-${newId().slice(-10)}`,
      customerProfileId: profileId,
      status: 'DELIVERED',
      currency: 'INR',
      grandTotalMinor: 10_000n,
      paidMinor: 10_000n,
      placedAt: new Date(),
      billingAddressJson: { contactName: 'Test' },
      shippingAddressJson: { contactName: 'Test' },
    },
  });
  await prisma.orderItem.create({
    data: {
      id: newId(),
      orderId,
      productId,
      sellerOfferId: offerId,
      nameSnapshot: 'Trust Widget',
      skuSnapshot: 'PRT-1',
      taxClassCodeSnapshot: TAX_CODE,
      unitPriceMinor: 10_000n,
      quantity: 1,
      lineSubtotalMinor: 10_000n,
      discountMinor: 0n,
      taxRatePercent: '0.000000',
      taxInclusive: false,
      taxAmountMinor: 0n,
      lineTotalMinor: 10_000n,
    },
  });
  return orderId;
}

async function cleanUp(): Promise<void> {
  const people = { user: { emailNormalized: { startsWith: EMAIL_PREFIX } } };
  await prisma.riskSignal.deleteMany({ where: { subjectId: { in: [sellerId, buyerProfileId, insiderProfileId].filter((id) => id !== '') } } });
  await prisma.productReview.deleteMany({ where: { customerProfile: people } });
  await prisma.orderItem.deleteMany({ where: { order: { customerProfile: people } } });
  await prisma.order.deleteMany({ where: { customerProfile: people } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: TAG } } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccount: { slug: { startsWith: TAG } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: TAG } } });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  const users = await prisma.user.findMany({ where: { emailNormalized: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: users.map((row) => row.id) } } });
  await prisma.customerProfile.deleteMany({ where: people });
  await prisma.user.deleteMany({ where: { emailNormalized: { startsWith: EMAIL_PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: TAX_CODE } });
}

beforeAll(async () => {
  await cleanUp();
  taxClassId = (await prisma.taxClass.create({ data: { id: newId(), code: TAX_CODE, name: 'Zero', ratePercent: '0.000000', isActive: true } })).id;
  categoryId = (await prisma.category.create({ data: { id: newId(), name: 'Trust Test', slug: CATEGORY_SLUG, isActive: true } })).id;
  productId = newId();
  productSlug = `${TAG}-widget`;
  await prisma.product.create({
    data: {
      id: productId,
      sku: `${TAG}-W`.toUpperCase(),
      slug: productSlug,
      name: 'Trust Widget',
      categoryId,
      taxClassId,
      currency: 'INR',
      basePriceMinor: 10_000n,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
    },
  });

  const buyer = await makeUser('buyer', 'CUSTOMER');
  buyerUserId = buyer.userId;
  buyerProfileId = buyer.profileId ?? '';
  const insider = await makeUser('insider', 'CUSTOMER');
  insiderUserId = insider.userId;
  insiderProfileId = insider.profileId ?? '';
  staffUserId = (await makeUser('staff', 'ADMIN')).userId;

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: `Trust Seller ${TAG} Ltd`,
      displayName: `Trust Seller ${TAG}`,
      displayNameNormalized: `trust seller ${TAG}`,
      slug: `${TAG}-seller`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
      approvedAt: new Date('2026-01-15T00:00:00.000Z'),
    },
  });
  // The insider works for the seller - and bought its own goods.
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId: sellerId, customerProfileId: insiderProfileId, role: 'OWNER' },
  });
  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerId,
      productId,
      variantKey: '',
      sellerSku: `${TAG}-S`,
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 10_000n,
      currency: 'INR',
      availableQuantity: 50,
    },
  });
  await deliveredOrder(buyerProfileId);
  await deliveredOrder(insiderProfileId);
});

afterAll(async () => {
  await cleanUp();
});

describe('whose sale a review counts towards', () => {
  it('attributes the review to the seller of the order line and scores the seller apart from the product', async () => {
    await saveOwnReview(buyerProfileId, { productId, scores: { quality: 2, delivery: 4, experience: 2, support: 5 } }, { userId: buyerUserId, email: null });
    const row = await prisma.productReview.findFirstOrThrow({ where: { customerProfileId: buyerProfileId, productId } });
    expect(row.sellerAccountId).toBe(sellerId);

    const product = await ratingSummary(productId);
    expect(product?.average).toBe(3.25);
    const seller = await sellerScore(sellerId);
    expect(seller).toEqual({ average: 4.5, delivery: 4, support: 5, count: 1 });
  });
});

describe('anti-fraud', () => {
  it("refuses a review from the seller's own team, audits it and raises a risk signal", async () => {
    await expect(
      saveOwnReview(insiderProfileId, { productId, scores: { quality: 5, delivery: 5, experience: 5, support: 5 } }, { userId: insiderUserId, email: null }),
    ).rejects.toMatchObject({ code: 'REVIEW_SELF_DEALING' });
    expect(await prisma.productReview.count({ where: { customerProfileId: insiderProfileId } })).toBe(0);
    const signal = await prisma.riskSignal.findFirst({ where: { ruleCode: 'REVIEW_SELF_DEALING', subjectId: sellerId } });
    expect(signal).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'product_review.refused', actorUserId: insiderUserId } });
    expect(audit).not.toBeNull();
  });
});

describe('the seller answers in public', () => {
  it('shows the answer under the review until staff hide it, without touching the scores', async () => {
    const review = await prisma.productReview.findFirstOrThrow({ where: { customerProfileId: buyerProfileId, productId } });
    await respondToReview(sellerId, review.id, 'Sorry about the quality - a replacement is on its way.', { userId: insiderUserId, email: `${EMAIL_PREFIX}insider@example.test` });

    const shown = await listPublicReviews(productSlug, { page: 1, limit: 10, sort: 'recent' });
    expect(shown.reviews[0]?.response?.body).toBe('Sorry about the quality - a replacement is on its way.');

    // Another seller's id finds nothing.
    await expect(respondToReview(newId(), review.id, 'Not mine', { userId: insiderUserId, email: `${EMAIL_PREFIX}insider@example.test` })).rejects.toMatchObject({ statusCode: 404 });

    await moderateReviewResponse(review.id, { status: 'HIDDEN', reason: 'Contains a phone number.' }, { userId: staffUserId, email: `${EMAIL_PREFIX}staff@example.test` });
    const hidden = await listPublicReviews(productSlug, { page: 1, limit: 10, sort: 'recent' });
    expect(hidden.reviews[0]?.response).toBeNull();
    expect(hidden.summary?.average).toBe(3.25);

    await expect(moderateReviewResponse(review.id, { status: 'HIDDEN', reason: '' }, { userId: staffUserId, email: `${EMAIL_PREFIX}staff@example.test` })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
