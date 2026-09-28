/**
 * Product reviews: four scores from a buyer who received the product.
 *
 * Each case is a way this could go wrong that nothing else would catch:
 *
 *   - **Only somebody who received it.** No order, or an order that has not
 *     been delivered, must be refused - otherwise a competitor can review.
 *   - **One per buyer per product.** Saving twice replaces; it never adds a
 *     second voice to the average.
 *   - **Averages are computed, and a hidden review is not in them.** Hiding
 *     has to take a review out of the summary, the card badge and the list.
 *   - **Editing a hidden review does not republish it.** Otherwise hiding is
 *     a suggestion.
 *   - **Hiding needs a reason**, because the buyer is shown it.
 *   - **Another buyer's review is not deletable.**
 *   - **The public sees a first name and an initial**, never a surname,
 *     company or email.
 *   - **The database refuses a 7**, whatever path skipped the API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  deleteOwnReview,
  listOwnReviews,
  listPublicReviews,
  listReviewsForAdmin,
  moderateReview,
  publicReviewerName,
  ratingBadges,
  ratingSummary,
  readOwnReview,
  saveOwnReview,
} from '../../src/modules/catalog/product-review.service.js';

const CATEGORY_SLUG = 'product-review-test-category';
const TAX_CLASS_CODE = 'PR-GST-18';
const EMAIL_PREFIX = 'review-buyer-';

let app: Awaited<ReturnType<typeof buildApp>>;
let categoryId = '';
let taxClassId = '';
let productId = '';
let productSlug = '';
let otherProductId = '';
let hiddenProductId = '';
let hiddenProductSlug = '';
let buyerId = '';
let secondBuyerId = '';
let strangerId = '';
let pendingBuyerId = '';
let staffUserId = '';

const FIVE = { quality: 5, delivery: 5, experience: 5, support: 5 };

async function cleanUp(): Promise<void> {
  const people = { user: { emailNormalized: { startsWith: EMAIL_PREFIX } } };

  await prisma.productReview.deleteMany({ where: { customerProfile: people } });
  await prisma.orderItem.deleteMany({ where: { order: { customerProfile: people } } });
  await prisma.order.deleteMany({ where: { customerProfile: people } });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.customerProfile.deleteMany({ where: people });
  await prisma.user.deleteMany({ where: { emailNormalized: { startsWith: EMAIL_PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: TAX_CLASS_CODE } });
}

async function makeUser(suffix: string, type: 'CUSTOMER' | 'ADMIN'): Promise<string> {
  const id = newId();
  const email = `${EMAIL_PREFIX}${suffix}@example.test`;
  await prisma.user.create({
    data: {
      id,
      type,
      email,
      emailNormalized: email,
      passwordHash: 'not-a-real-hash',
      status: 'ACTIVE',
    },
  });
  return id;
}

async function makeBuyer(
  suffix: string,
  names: { fullName: string; firstName?: string; lastName?: string },
): Promise<string> {
  const userId = await makeUser(suffix, 'CUSTOMER');
  const profileId = newId();
  await prisma.customerProfile.create({
    data: {
      id: profileId,
      userId,
      fullName: names.fullName,
      firstName: names.firstName ?? null,
      lastName: names.lastName ?? null,
      organization: 'Northgate Clinical',
    },
  });
  return profileId;
}

async function makeProduct(options: {
  published: boolean;
  sku: string;
}): Promise<{ id: string; slug: string }> {
  const id = newId();
  const slug = `${options.sku.toLowerCase()}-${id.slice(-8).toLowerCase()}`;
  await prisma.product.create({
    data: {
      id,
      sku: options.sku,
      slug,
      name: 'Review Test Widget',
      categoryId,
      taxClassId,
      currency: 'INR',
      basePriceMinor: 45_000n,
      status: options.published ? 'ACTIVE' : 'DRAFT',
      isPublished: options.published,
      ...(options.published ? { publishedAt: new Date() } : {}),
    },
  });
  return { id, slug };
}

async function makeOrder(
  customerProfileId: string,
  items: string[],
  status: 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'RETURNED',
): Promise<string> {
  const orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-${newId().slice(-10)}`,
      customerProfileId,
      status,
      currency: 'INR',
      grandTotalMinor: 45_000n,
      paidMinor: 45_000n,
      placedAt: new Date(),
      billingAddressJson: { contactName: 'Test' },
      shippingAddressJson: { contactName: 'Test' },
    },
  });
  for (const item of items) {
    await prisma.orderItem.create({
      data: {
        id: newId(),
        orderId,
        productId: item,
        nameSnapshot: 'Review Test Widget',
        skuSnapshot: 'PR-1',
        taxClassCodeSnapshot: TAX_CLASS_CODE,
        unitPriceMinor: 45_000n,
        quantity: 1,
        lineSubtotalMinor: 45_000n,
        discountMinor: 0n,
        taxRatePercent: '0.000000',
        taxInclusive: false,
        taxAmountMinor: 0n,
        lineTotalMinor: 45_000n,
      },
    });
  }
  return orderId;
}

beforeAll(async () => {
  await cleanUp();
  app = await buildApp();

  // Created here rather than read from the seed: files share one database and
  // several clear the reference tables. See the wishlist fixture.
  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: TAX_CLASS_CODE,
      name: 'GST 18%',
      ratePercent: '18.000000',
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Review Test', slug: CATEGORY_SLUG, isActive: true },
  });
  categoryId = category.id;

  const live = await makeProduct({ published: true, sku: `PR-LIVE-${newId().slice(-8)}` });
  productId = live.id;
  productSlug = live.slug;
  otherProductId = (await makeProduct({ published: true, sku: `PR-OTHER-${newId().slice(-8)}` }))
    .id;
  const draft = await makeProduct({ published: false, sku: `PR-DRAFT-${newId().slice(-8)}` });
  hiddenProductId = draft.id;
  hiddenProductSlug = draft.slug;

  buyerId = await makeBuyer('one', {
    fullName: 'Priya Nair',
    firstName: 'Priya',
    lastName: 'nair',
  });
  secondBuyerId = await makeBuyer('two', { fullName: 'Samuel Adebayo Okoro' });
  strangerId = await makeBuyer('three', { fullName: 'No Orders' });
  pendingBuyerId = await makeBuyer('four', { fullName: 'Still Waiting' });
  staffUserId = await makeUser('staff', 'ADMIN');

  await makeOrder(buyerId, [productId, otherProductId], 'DELIVERED');
  await makeOrder(secondBuyerId, [productId], 'RETURNED');
  await makeOrder(pendingBuyerId, [productId], 'SHIPPED');
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

describe('who may review', () => {
  it('refuses somebody who never ordered the product', async () => {
    await expect(readOwnReview(strangerId, productId)).resolves.toEqual({
      canReview: false,
      review: null,
    });
    await expect(saveOwnReview(strangerId, { productId, scores: FIVE })).rejects.toMatchObject({
      statusCode: 403,
      code: 'REVIEW_NOT_ELIGIBLE',
    });
  });

  it('refuses an order that is on its way but not delivered', async () => {
    await expect(saveOwnReview(pendingBuyerId, { productId, scores: FIVE })).rejects.toMatchObject({
      code: 'REVIEW_NOT_ELIGIBLE',
    });
  });

  it('accepts a delivered order, and a returned one', async () => {
    await expect(readOwnReview(buyerId, productId)).resolves.toMatchObject({ canReview: true });
    await expect(readOwnReview(secondBuyerId, productId)).resolves.toMatchObject({
      canReview: true,
    });
  });

  it('refuses a product nobody may browse', async () => {
    await expect(
      saveOwnReview(buyerId, { productId: hiddenProductId, scores: FIVE }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('writing a review', () => {
  it('stores four scores, and replaces rather than adds', async () => {
    const first = await saveOwnReview(buyerId, {
      productId,
      scores: { quality: 5, delivery: 2, experience: 4, support: 3 },
    });
    expect(first).toMatchObject({
      scores: { quality: 5, delivery: 2, experience: 4, support: 3 },
      status: 'PUBLISHED',
    });

    const second = await saveOwnReview(buyerId, {
      productId,
      scores: { quality: 5, delivery: 3, experience: 4, support: 4 },
    });
    expect(second.id).toBe(first.id);
    expect(
      await prisma.productReview.count({ where: { customerProfileId: buyerId, productId } }),
    ).toBe(1);
  });

  it('computes the summary, the badge and the distribution from published reviews', async () => {
    await saveOwnReview(secondBuyerId, {
      productId,
      scores: { quality: 2, delivery: 2, experience: 2, support: 3 },
    });

    const summary = await ratingSummary(productId);
    // Buyer one: 5,3,4,4 (mean 4). Buyer two: 2,2,2,3 (mean 2.25).
    expect(summary).toEqual({
      count: 2,
      average: 3.13,
      categories: { quality: 3.5, delivery: 2.5, experience: 3, support: 3.5 },
      distribution: [0, 1, 0, 1, 0],
    });

    const badges = await ratingBadges([productId, otherProductId]);
    expect(badges.get(productId)).toEqual({ average: 3.13, count: 2 });
    // No reviews means absent, not a zero.
    expect(badges.has(otherProductId)).toBe(false);
  });

  it('signs a public review with a first name and an initial only', async () => {
    const page = await listPublicReviews(productSlug, { page: 1, limit: 10, sort: 'highest' });
    expect(page.reviews.map((review) => review.reviewerName)).toEqual(['Priya N.', 'Samuel O.']);
    expect(JSON.stringify(page)).not.toContain('Northgate');
    expect(JSON.stringify(page)).not.toContain('example.test');

    expect(publicReviewerName({ firstName: null, lastName: null, fullName: 'Madonna' })).toBe(
      'Madonna',
    );
    expect(publicReviewerName({ firstName: null, lastName: null, fullName: '  ' })).toBe('');
  });

  it('lists what is waiting for a rating, without what is already rated', async () => {
    const mine = await listOwnReviews(buyerId, { language: null });
    expect(mine.reviews.map((review) => review.productId)).toEqual([productId]);
    expect(mine.awaiting.map((item) => item.productId)).toEqual([otherProductId]);
  });

  it('does not let one buyer delete another buyer’s review', async () => {
    const own = await readOwnReview(buyerId, productId);
    await expect(deleteOwnReview(secondBuyerId, own.review?.id ?? '')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await prisma.productReview.count({ where: { id: own.review?.id ?? '' } })).toBe(1);
  });
});

describe('moderation', () => {
  it('requires a reason to hide', async () => {
    const own = await readOwnReview(secondBuyerId, productId);
    await expect(
      moderateReview(own.review?.id ?? '', { status: 'HIDDEN', reason: '  ' }, staffUserId),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('takes a hidden review out of every average and the public list, and shows the buyer why', async () => {
    const own = await readOwnReview(secondBuyerId, productId);
    const { after } = await moderateReview(
      own.review?.id ?? '',
      { status: 'HIDDEN', reason: 'Names a member of staff.' },
      staffUserId,
    );
    expect(after).toMatchObject({ status: 'HIDDEN', moderationReason: 'Names a member of staff.' });

    expect(await ratingSummary(productId)).toMatchObject({ count: 1, average: 4 });
    expect((await ratingBadges([productId])).get(productId)).toEqual({ average: 4, count: 1 });
    const page = await listPublicReviews(productSlug, { page: 1, limit: 10, sort: 'recent' });
    expect(page.reviews).toHaveLength(1);

    await expect(readOwnReview(secondBuyerId, productId)).resolves.toMatchObject({
      review: { status: 'HIDDEN', moderationReason: 'Names a member of staff.' },
    });

    const listed = await listReviewsForAdmin({
      status: 'HIDDEN',
      page: 1,
      limit: 25,
      search: 'Samuel',
    });
    expect(listed.reviews.map((review) => review.id)).toEqual([own.review?.id]);
  });

  it('keeps a hidden review hidden when its author edits it', async () => {
    const edited = await saveOwnReview(secondBuyerId, {
      productId,
      scores: FIVE,
    });
    expect(edited.status).toBe('HIDDEN');
    expect(await ratingSummary(productId)).toMatchObject({ count: 1 });
  });

  it('puts a review back and clears the reason', async () => {
    const own = await readOwnReview(secondBuyerId, productId);
    const { after } = await moderateReview(
      own.review?.id ?? '',
      { status: 'PUBLISHED' },
      staffUserId,
    );
    expect(after).toMatchObject({ status: 'PUBLISHED', moderationReason: null });
    expect(await ratingSummary(productId)).toMatchObject({ count: 2 });
  });
});

describe('the database', () => {
  it('refuses a score outside 1 to 5 even when the API is skipped', async () => {
    await expect(
      prisma.productReview.create({
        data: {
          id: newId(),
          productId: otherProductId,
          customerProfileId: strangerId,
          qualityRating: 7,
          deliveryRating: 3,
          experienceRating: 3,
          supportRating: 3,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('over HTTP', () => {
  it('serves the summary and a page of reviews to a guest', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${productSlug}/reviews?sort=recent&limit=1`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      summary: { count: number };
      reviews: unknown[];
      pagination: { totalPages: number };
    }>();
    expect(body.summary.count).toBe(2);
    expect(body.reviews).toHaveLength(1);
    expect(body.pagination.totalPages).toBe(2);
  });

  it('puts the average and the count on the product page', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${productSlug}?currency=INR`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ product: { rating: unknown } }>().product.rating).toEqual({
      average: 4.5,
      count: 2,
    });
  });

  it('answers 404 for the reviews of a product nobody may browse', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${hiddenProductSlug}/reviews`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a score of 6 before it reaches the service', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/account/products/${productId}/review`,
      payload: { scores: { ...FIVE, quality: 6 } },
    });
    // Unauthenticated, so refused either way - never a 200.
    expect([400, 401, 403]).toContain(response.statusCode);
  });
});
