/**
 * What buyers thought of a product, scored four ways.
 *
 * A buyer who has received a product scores it from 1 to 5 for **quality**,
 * **delivery**, **experience** and **support**. Scores only - no comment. The
 * storefront shows the averages on the product page and a star line on every
 * card; staff can hide a review that breaks the rules and put it back.
 *
 * Five rules the whole file is arranged around.
 *
 * **Only somebody who received it.** A review needs an order of the
 * reviewer's own that contains the product and reached DELIVERED, or RETURNED,
 * which can only follow DELIVERED. Delivery and support cannot be scored by
 * somebody who was never sent anything, and a review anybody can write is a
 * review a competitor can write. `findQualifyingOrder` is the one place that
 * decides it, and both the form's eligibility and the write call it.
 *
 * **One per buyer per product.** Writing again replaces the scores - the
 * unique index enforces it and `upsert` relies on it, so two taps on a slow
 * connection cannot produce two voices in the average.
 *
 * **Published at once, hidden by a person.** There is no queue: a buyer who
 * has proved they bought the product has earned being heard. A member of
 * staff can hide a review afterwards, with a reason the buyer is shown. A
 * buyer editing a hidden review does not republish it - that would make
 * hiding a suggestion - so it stays hidden until staff put it back.
 *
 * **Averages are computed on every read.** Nothing stores a total, so an
 * edit, a hide or an erasure is reflected the next time anybody looks.
 *
 * **The public never learns who a buyer is.** A review is signed with a first
 * name and an initial. The company, the email and the order stay with staff.
 *
 * Added by JOURNEY-059:
 *
 * **A review counts towards the seller of the order line it rests on**
 * (`sellerAccountId`), which gives each seller a service score - delivery and
 * support - kept apart from the product's own rating. **The seller may answer
 * once, in public**, up to 1000 characters; staff can hide the answer without
 * touching the review. **Anti-fraud**: a seller's own team cannot review that
 * seller's sale, a buyer may write at most REVIEW_MAX_PER_DAY new reviews a
 * day, and both refusals raise a risk signal. **An inspection result is never
 * a rating**: no figure here is ever blended with one.
 */
import type { Prisma, ProductReviewStatus } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { AppError, ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { RiskRuleCode, raiseRiskSignal } from '../risk/risk.service.js';
import { publicProductWhere } from './catalog.visibility.js';

/** The four things a buyer scores, in the order every screen shows them. */
export const RATING_CATEGORIES = ['quality', 'delivery', 'experience', 'support'] as const;
export type RatingCategory = (typeof RATING_CATEGORIES)[number];

/** The same ceiling as the column that holds a moderator's reason. */
export const MODERATION_REASON_MAX_LENGTH = 500;

/**
 * The order states that mean the buyer has the goods, or had them.
 *
 * RETURNED is here because it can only follow DELIVERED: the buyer held the
 * product, and somebody who sent it back is exactly who the next buyer wants
 * to hear from.
 */
const RECEIVED_STATUSES = ['DELIVERED', 'RETURNED'] as const;

export type RatingScores = Record<RatingCategory, number>;

/** The short form a card shows: one average and how many reviews it is over. */
export interface RatingBadge {
  /** Mean of the four category averages, two decimals. */
  average: number;
  count: number;
}

export interface RatingSummary extends RatingBadge {
  /** Each category's mean, two decimals. */
  categories: RatingScores;
  /**
   * How many reviews land on each whole star, from each review's own mean
   * rounded half up. Index 0 is one star, index 4 is five.
   */
  distribution: [number, number, number, number, number];
}

export interface PublicReview {
  id: string;
  /** First name and an initial, never more. */
  reviewerName: string;
  scores: RatingScores;
  /** This review's own mean, two decimals. */
  average: number;
  createdAt: string;
  /** Set when the buyer changed it after first writing it. */
  editedAt: string | null;
  /**
   * The seller's public answer, when one was written and staff have not
   * hidden it. Signed with the seller's trading name, never a person's.
   */
  response: { sellerName: string; body: string; at: string } | null;
}

export interface OwnReview {
  id: string;
  productId: string;
  scores: RatingScores;
  status: ProductReviewStatus;
  /** Why staff hid it. Null while published. */
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function meanOf(scores: RatingScores): number {
  return round2(
    (scores.quality + scores.delivery + scores.experience + scores.support) /
      RATING_CATEGORIES.length,
  );
}

interface ScoreColumns {
  qualityRating: number;
  deliveryRating: number;
  experienceRating: number;
  supportRating: number;
}

function scoresOf(row: ScoreColumns): RatingScores {
  return {
    quality: row.qualityRating,
    delivery: row.deliveryRating,
    experience: row.experienceRating,
    support: row.supportRating,
  };
}

/**
 * "Priya N." from whatever the profile holds.
 *
 * The structured names when both are there, otherwise the first and last
 * words of the full name. A single word stays a single word, and an empty
 * profile signs as nothing rather than as an email address.
 */
export function publicReviewerName(profile: {
  firstName: string | null;
  lastName: string | null;
  fullName: string;
}): string {
  const first = profile.firstName?.trim() ?? '';
  const last = profile.lastName?.trim() ?? '';

  if (first !== '') {
    return last === '' ? first : `${first} ${last.charAt(0).toUpperCase()}.`;
  }

  const words = profile.fullName
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return '';
  if (words.length === 1) return words[0] ?? '';

  return `${words[0] ?? ''} ${(words[words.length - 1] ?? '').charAt(0).toUpperCase()}.`;
}

function toOwnReview(
  row: {
    id: string;
    productId: string;
    status: ProductReviewStatus;
    moderationReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  } & ScoreColumns,
): OwnReview {
  return {
    id: row.id,
    productId: row.productId,
    scores: scoresOf(row),
    status: row.status,
    moderationReason: row.status === 'HIDDEN' ? row.moderationReason : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Averages
// ---------------------------------------------------------------------------

/**
 * One average per product, for a page of cards.
 *
 * One grouped query for the whole page, never one per card. A product with no
 * published review is absent from the map - the card shows nothing rather
 * than five empty stars, which would read as "rated zero".
 */
export async function ratingBadges(
  productIds: readonly string[],
): Promise<Map<string, RatingBadge>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Map();

  const groups = await prisma.productReview.groupBy({
    by: ['productId'],
    where: { productId: { in: ids }, status: 'PUBLISHED' },
    _avg: {
      qualityRating: true,
      deliveryRating: true,
      experienceRating: true,
      supportRating: true,
    },
    _count: { _all: true },
  });

  return new Map(
    groups.map((group) => [
      group.productId,
      {
        average: meanOf({
          quality: group._avg.qualityRating ?? 0,
          delivery: group._avg.deliveryRating ?? 0,
          experience: group._avg.experienceRating ?? 0,
          support: group._avg.supportRating ?? 0,
        }),
        count: group._count._all,
      },
    ]),
  );
}

/**
 * Attach `rating` to each product in a list the storefront is about to render.
 *
 * `null` where there are no reviews, or where reviews are switched off - the
 * storefront draws nothing in both cases, so it never has to know which.
 */
export async function withRatingBadges<T extends object>(
  products: readonly T[],
  enabled: boolean,
): Promise<(T & { rating: RatingBadge | null })[]> {
  if (!enabled || products.length === 0) {
    return products.map((product) => ({ ...product, rating: null }));
  }

  // The serialisers hand back loose records, so the id is read rather than
  // typed. A row without one simply gets no badge.
  const idOf = (product: T): string | null => {
    const id = (product as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  };

  const badges = await ratingBadges(products.map(idOf).filter((id): id is string => id !== null));
  return products.map((product) => {
    const id = idOf(product);
    return { ...product, rating: id === null ? null : (badges.get(id) ?? null) };
  });
}

/**
 * Everything the product page's summary panel draws: the overall figure, the
 * four category averages and the star distribution.
 *
 * Null when there is nothing published, so the panel can say "no reviews yet"
 * instead of drawing a row of zeros.
 */
export async function ratingSummary(productId: string): Promise<RatingSummary | null> {
  const aggregate = await prisma.productReview.aggregate({
    where: { productId, status: 'PUBLISHED' },
    _avg: {
      qualityRating: true,
      deliveryRating: true,
      experienceRating: true,
      supportRating: true,
    },
    _count: { _all: true },
  });

  const count = aggregate._count._all;
  if (count === 0) return null;

  const categories: RatingScores = {
    quality: round2(aggregate._avg.qualityRating ?? 0),
    delivery: round2(aggregate._avg.deliveryRating ?? 0),
    experience: round2(aggregate._avg.experienceRating ?? 0),
    support: round2(aggregate._avg.supportRating ?? 0),
  };

  /*
   * Which whole star each review lands on, counted in the database.
   *
   * A review's own mean can be a quarter-point (3.25, 3.5, 3.75), so it is
   * rounded half up - 3.5 is a four - which is what MariaDB's ROUND does to
   * an exact decimal. Counting here rather than fetching every row keeps the
   * read flat however many reviews a product collects.
   */
  const buckets = await prisma.$queryRaw<{ star: Prisma.Decimal | number; n: bigint | number }[]>`
    SELECT ROUND((qualityRating + deliveryRating + experienceRating + supportRating) / 4) AS star,
           COUNT(*) AS n
      FROM product_reviews
     WHERE productId = ${productId} AND status = 'PUBLISHED'
     GROUP BY star
  `;

  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const bucket of buckets) {
    const star = Number(bucket.star.toString());
    if (star >= 1 && star <= 5) distribution[star - 1] = Number(bucket.n);
  }

  return { average: meanOf(categories), count, categories, distribution };
}

// ---------------------------------------------------------------------------
// The public list
// ---------------------------------------------------------------------------

export type ReviewSort = 'recent' | 'highest' | 'lowest';

const SORT_ORDERS: Record<ReviewSort, Prisma.ProductReviewOrderByWithRelationInput[]> = {
  recent: [{ createdAt: 'desc' }, { id: 'desc' }],
  // The four columns in turn is not the same as sorting by the mean, and it
  // is close enough to read as "best first" without a computed column.
  highest: [
    { qualityRating: 'desc' },
    { experienceRating: 'desc' },
    { deliveryRating: 'desc' },
    { supportRating: 'desc' },
    { createdAt: 'desc' },
  ],
  lowest: [
    { qualityRating: 'asc' },
    { experienceRating: 'asc' },
    { deliveryRating: 'asc' },
    { supportRating: 'asc' },
    { createdAt: 'desc' },
  ],
};

/**
 * One page of a product's published reviews, plus the summary above them.
 *
 * Found by slug and through `publicProductWhere`, the same gate as the product
 * page, so the reviews of a product nobody may browse are not readable either.
 */
export async function listPublicReviews(
  slug: string,
  options: { page: number; limit: number; sort: ReviewSort },
): Promise<{
  productId: string;
  summary: RatingSummary | null;
  reviews: PublicReview[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const product = await prisma.product.findFirst({
    where: { slug, ...publicProductWhere() },
    select: { id: true },
  });

  if (product === null) throw notFound('Product');

  const where: Prisma.ProductReviewWhereInput = { productId: product.id, status: 'PUBLISHED' };

  const [summary, rows, total] = await Promise.all([
    ratingSummary(product.id),
    prisma.productReview.findMany({
      where,
      orderBy: SORT_ORDERS[options.sort],
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      select: {
        id: true,
        qualityRating: true,
        deliveryRating: true,
        experienceRating: true,
        supportRating: true,
        createdAt: true,
        updatedAt: true,
        customerProfile: { select: { firstName: true, lastName: true, fullName: true } },
        sellerResponse: true,
        sellerResponseStatus: true,
        sellerResponseAt: true,
        sellerAccount: { select: { displayName: true } },
      },
    }),
    prisma.productReview.count({ where }),
  ]);

  return {
    productId: product.id,
    summary,
    reviews: rows.map((row) => {
      const scores = scoresOf(row);
      // A second counts as an edit. Prisma writes both timestamps on create,
      // a few microseconds apart at most.
      const edited = row.updatedAt.getTime() - row.createdAt.getTime() > 1000;

      return {
        id: row.id,
        reviewerName: publicReviewerName(row.customerProfile),
        scores,
        average: meanOf(scores),
        createdAt: row.createdAt.toISOString(),
        editedAt: edited ? row.updatedAt.toISOString() : null,
        response:
          row.sellerResponse !== null &&
          row.sellerResponseStatus === 'PUBLISHED' &&
          row.sellerResponseAt !== null &&
          row.sellerAccount !== null
            ? { sellerName: row.sellerAccount.displayName, body: row.sellerResponse, at: row.sellerResponseAt.toISOString() }
            : null,
      };
    }),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}

// ---------------------------------------------------------------------------
// A buyer's own review
// ---------------------------------------------------------------------------

/**
 * The most recent order of this buyer's that puts this product in their hands.
 *
 * The one rule of eligibility, in one place. Null means they may not review.
 */
async function findQualifyingOrder(
  customerProfileId: string,
  productId: string,
): Promise<{ orderId: string; sellerAccountId: string | null } | null> {
  const line = await prisma.orderItem.findFirst({
    where: {
      productId,
      order: { customerProfileId, status: { in: [...RECEIVED_STATUSES] } },
    },
    orderBy: { order: { createdAt: 'desc' } },
    // Whose goods they were: the seller this review will count towards.
    select: { orderId: true, sellerOffer: { select: { sellerAccountId: true } } },
  });

  return line === null ? null : { orderId: line.orderId, sellerAccountId: line.sellerOffer?.sellerAccountId ?? null };
}

/**
 * What the product page's form needs: whether this buyer may review the
 * product, and what they wrote last time.
 *
 * `canReview` stays true for somebody who has already reviewed, because they
 * may edit. It is false only for somebody with no delivered order of it.
 */
export async function readOwnReview(
  customerProfileId: string,
  productId: string,
): Promise<{ canReview: boolean; review: OwnReview | null }> {
  const [row, qualifying] = await Promise.all([
    prisma.productReview.findUnique({
      where: { customerProfileId_productId: { customerProfileId, productId } },
    }),
    findQualifyingOrder(customerProfileId, productId),
  ]);

  return {
    canReview: row !== null || qualifying !== null,
    review: row === null ? null : toOwnReview(row),
  };
}

/**
 * Write or replace this buyer's review of a product.
 *
 * Refused with REVIEW_NOT_ELIGIBLE unless they hold a delivered order of it.
 * A buyer who already reviewed may always edit, even if that order was later
 * erased from under them - they qualified when they wrote it.
 */
export async function saveOwnReview(
  customerProfileId: string,
  input: { productId: string; scores: RatingScores },
  actor: { userId: string | null; email: string | null } = { userId: null, email: null },
): Promise<OwnReview> {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, ...publicProductWhere() },
    select: { id: true },
  });

  if (product === null) throw notFound('Product');

  const [existing, qualifying] = await Promise.all([
    prisma.productReview.findUnique({
      where: { customerProfileId_productId: { customerProfileId, productId: product.id } },
      select: { id: true, orderId: true, sellerAccountId: true },
    }),
    findQualifyingOrder(customerProfileId, product.id),
  ]);

  if (existing === null && qualifying === null) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.REVIEW_NOT_ELIGIBLE,
      message: 'You can review a product once an order containing it has been delivered to you.',
    });
  }

  const sellerAccountId = existing?.sellerAccountId ?? qualifying?.sellerAccountId ?? null;
  await assertNotSelfDealing(customerProfileId, sellerAccountId, product.id, actor);
  if (existing === null) await assertWithinDailyLimit(customerProfileId, actor);

  const columns = {
    qualityRating: input.scores.quality,
    deliveryRating: input.scores.delivery,
    experienceRating: input.scores.experience,
    supportRating: input.scores.support,
  };

  // The status is deliberately absent from `update`: editing a hidden review
  // does not republish it. See the file header.
  const row = await prisma.productReview.upsert({
    where: { customerProfileId_productId: { customerProfileId, productId: product.id } },
    update: { ...columns, orderId: existing?.orderId ?? qualifying?.orderId ?? null, sellerAccountId },
    create: {
      id: newId(),
      customerProfileId,
      productId: product.id,
      orderId: qualifying?.orderId ?? null,
      sellerAccountId,
      ...columns,
    },
  });

  return toOwnReview(row);
}

/**
 * A seller's own people cannot rate that seller's sale (JOURNEY-059).
 *
 * Decided against the seller of the QUALIFYING ORDER LINE, not whoever sells
 * the product today: what is being rated is that transaction. Refused with
 * REVIEW_SELF_DEALING, audited, and raised as a risk signal - somebody buying
 * their own goods to rate them is worth a person's look even when the review
 * never got written.
 */
async function assertNotSelfDealing(
  customerProfileId: string,
  sellerAccountId: string | null,
  productId: string,
  actor: { userId: string | null; email: string | null },
): Promise<void> {
  if (sellerAccountId === null) return;
  const member = await prisma.sellerMember.findUnique({
    where: { customerProfileId },
    select: { sellerAccountId: true },
  });
  if (member?.sellerAccountId !== sellerAccountId) return;

  await recordAudit({
    action: AuditAction.PRODUCT_REVIEW_REFUSED,
    resourceType: 'product',
    resourceId: productId,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { reason: 'SELF_DEALING', sellerAccountId },
  });
  await raiseRiskSignal({
    ruleCode: RiskRuleCode.REVIEW_SELF_DEALING,
    subjectType: 'SELLER_ACCOUNT',
    subjectId: sellerAccountId,
    facts: { customerProfileId, productId },
  });
  throw new AppError({
    statusCode: 403,
    code: ErrorCode.REVIEW_SELF_DEALING,
    message: "A seller's own team cannot review that seller's goods.",
  });
}

/** At most REVIEW_MAX_PER_DAY new reviews per buyer in 24 hours. */
async function assertWithinDailyLimit(
  customerProfileId: string,
  actor: { userId: string | null; email: string | null },
): Promise<void> {
  const since = new Date(Date.now() - 86_400_000);
  const written = await prisma.productReview.count({ where: { customerProfileId, createdAt: { gte: since } } });
  if (written < env.REVIEW_MAX_PER_DAY) return;

  await raiseRiskSignal({
    ruleCode: RiskRuleCode.REVIEW_VELOCITY,
    subjectType: 'CUSTOMER_PROFILE',
    subjectId: customerProfileId,
    observed: written + 1,
    facts: { reviewsInLastDay: written, limit: env.REVIEW_MAX_PER_DAY, actorUserId: actor.userId },
  });
  throw new AppError({
    statusCode: 429,
    code: ErrorCode.REVIEW_RATE_LIMITED,
    message: 'You have written the most reviews allowed in one day. Try again tomorrow.',
  });
}

/**
 * Take a review back.
 *
 * Scoped by the profile in the `where`, so another buyer's review is not found
 * rather than deleted - the same reasoning as the wishlist's removal.
 */
export async function deleteOwnReview(customerProfileId: string, reviewId: string): Promise<void> {
  const removed = await prisma.productReview.deleteMany({
    where: { id: reviewId, customerProfileId },
  });

  if (removed.count === 0) throw notFound('Review');
}

export interface ReviewableProduct {
  productId: string;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  /** When the order that qualified them was placed. */
  orderedAt: string;
  orderNumber: string;
}

/**
 * The "My reviews" page: what this buyer has written, and what they have
 * received but not yet rated.
 *
 * The waiting list is built from delivered order lines, newest order first,
 * one entry per product, and only for products still on sale - a review of
 * something nobody can buy any more helps nobody.
 */
export async function listOwnReviews(
  customerProfileId: string,
  options: { language: string | null },
): Promise<{
  reviews: (OwnReview & { productName: string; productSlug: string; imageUrl: string | null })[];
  awaiting: ReviewableProduct[];
}> {
  const productSelect = {
    id: true,
    name: true,
    slug: true,
    media: {
      select: { media: { select: { url: true } } },
      orderBy: [{ isPrimary: 'desc' as const }, { sortOrder: 'asc' as const }],
      take: 1,
    },
    translations:
      options.language === null
        ? false
        : { where: { language: options.language }, select: { name: true } },
  } satisfies Prisma.ProductSelect;

  const reviews = await prisma.productReview.findMany({
    where: { customerProfileId },
    orderBy: { updatedAt: 'desc' },
    include: { product: { select: productSelect } },
  });

  const reviewed = new Set(reviews.map((review) => review.productId));

  const lines = await prisma.orderItem.findMany({
    where: {
      order: { customerProfileId, status: { in: [...RECEIVED_STATUSES] } },
      product: publicProductWhere(),
      ...(reviewed.size === 0 ? {} : { productId: { notIn: [...reviewed] } }),
    },
    orderBy: { order: { createdAt: 'desc' } },
    // Enough to fill the page with distinct products after de-duplication,
    // without reading a large buyer's whole history.
    take: 200,
    select: {
      productId: true,
      order: { select: { orderNumber: true, placedAt: true, createdAt: true } },
      product: { select: productSelect },
    },
  });

  const awaiting: ReviewableProduct[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.productId)) continue;
    seen.add(line.productId);
    awaiting.push({
      productId: line.productId,
      productName: line.product.translations?.[0]?.name ?? line.product.name,
      productSlug: line.product.slug,
      imageUrl: line.product.media[0]?.media.url ?? null,
      orderedAt: (line.order.placedAt ?? line.order.createdAt).toISOString(),
      orderNumber: line.order.orderNumber,
    });
    if (awaiting.length === 50) break;
  }

  return {
    reviews: reviews.map((review) => ({
      ...toOwnReview(review),
      productName: review.product.translations?.[0]?.name ?? review.product.name,
      productSlug: review.product.slug,
      imageUrl: review.product.media[0]?.media.url ?? null,
    })),
    awaiting,
  };
}

/**
 * Which of these products this buyer has already reviewed, for the order page
 * to say "Edit your review" rather than "Rate".
 */
export async function reviewedProductIds(
  customerProfileId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();

  const rows = await prisma.productReview.findMany({
    where: { customerProfileId, productId: { in: [...new Set(productIds)] } },
    select: { productId: true },
  });

  return new Set(rows.map((row) => row.productId));
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export interface AdminReview {
  id: string;
  product: { id: string; name: string; sku: string; slug: string };
  customer: { id: string; name: string; email: string };
  orderId: string | null;
  orderNumber: string | null;
  scores: RatingScores;
  average: number;
  status: ProductReviewStatus;
  moderationReason: string | null;
  moderatedAt: string | null;
  moderatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The seller this review counts towards; null for the marketplace's own stock. */
  seller: { id: string; name: string } | null;
  /** The seller's answer and whether staff hid it. */
  response: {
    body: string;
    status: ProductReviewStatus;
    at: string | null;
    hiddenReason: string | null;
  } | null;
}

const ADMIN_INCLUDE = {
  product: { select: { id: true, name: true, sku: true, slug: true } },
  customerProfile: { select: { id: true, fullName: true, user: { select: { email: true } } } },
  order: { select: { orderNumber: true } },
  moderatedBy: { select: { email: true } },
  sellerAccount: { select: { id: true, displayName: true } },
} satisfies Prisma.ProductReviewInclude;

type AdminRow = Prisma.ProductReviewGetPayload<{ include: typeof ADMIN_INCLUDE }>;

function toAdminReview(row: AdminRow): AdminReview {
  const scores = scoresOf(row);

  return {
    id: row.id,
    product: row.product,
    customer: {
      id: row.customerProfile.id,
      name: row.customerProfile.fullName,
      email: row.customerProfile.user.email,
    },
    orderId: row.orderId,
    orderNumber: row.order?.orderNumber ?? null,
    scores,
    average: meanOf(scores),
    status: row.status,
    moderationReason: row.moderationReason,
    moderatedAt: row.moderatedAt?.toISOString() ?? null,
    moderatedBy: row.moderatedBy?.email ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    seller: row.sellerAccount === null ? null : { id: row.sellerAccount.id, name: row.sellerAccount.displayName },
    response:
      row.sellerResponse === null
        ? null
        : {
            body: row.sellerResponse,
            status: row.sellerResponseStatus ?? 'PUBLISHED',
            at: row.sellerResponseAt?.toISOString() ?? null,
            hiddenReason: row.sellerResponseHiddenReason,
          },
  };
}

/**
 * Every review, newest first, for the moderation screen.
 *
 * `search` matches the product's name or SKU, or the reviewer's name, so a
 * member of staff chasing a complaint can find it from whichever they have.
 * `maxAverage` narrows to the low scores, which is where most moderation
 * starts; it is compared per category, so "2 or below" finds a review with
 * any category at 2 or below.
 */
export async function listReviewsForAdmin(options: {
  status?: ProductReviewStatus;
  search?: string;
  maxScore?: number;
  page: number;
  limit: number;
}): Promise<{
  reviews: AdminReview[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const search = options.search?.trim() ?? '';
  const where: Prisma.ProductReviewWhereInput = {
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(search === ''
      ? {}
      : {
          OR: [
            { product: { name: { contains: search } } },
            { product: { sku: { contains: search } } },
            { customerProfile: { fullName: { contains: search } } },
          ],
        }),
    ...(options.maxScore === undefined
      ? {}
      : {
          AND: [
            {
              OR: [
                { qualityRating: { lte: options.maxScore } },
                { deliveryRating: { lte: options.maxScore } },
                { experienceRating: { lte: options.maxScore } },
                { supportRating: { lte: options.maxScore } },
              ],
            },
          ],
        }),
  };

  const [rows, total] = await Promise.all([
    prisma.productReview.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      include: ADMIN_INCLUDE,
    }),
    prisma.productReview.count({ where }),
  ]);

  return {
    reviews: rows.map(toAdminReview),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}

/**
 * Hide a review or put it back, and say who and why.
 *
 * A reason is required to hide - the buyer is shown it, and "hidden" with no
 * reason is a decision nobody can learn from or challenge. Putting one back
 * clears the reason. Returns the row before and after, for the audit trail.
 */
export async function moderateReview(
  reviewId: string,
  input: { status: ProductReviewStatus; reason?: string | null },
  actorUserId: string,
): Promise<{ before: AdminReview; after: AdminReview }> {
  const existing = await prisma.productReview.findUnique({
    where: { id: reviewId },
    include: ADMIN_INCLUDE,
  });

  if (existing === null) throw notFound('Review');

  const reason = input.reason?.trim() ?? '';
  if (input.status === 'HIDDEN' && reason === '') {
    throw new AppError({
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Say why the review is being hidden. The buyer who wrote it is shown the reason.',
      details: [{ field: 'reason', code: 'REQUIRED' }],
    });
  }

  const updated = await prisma.productReview.update({
    where: { id: reviewId },
    data: {
      status: input.status,
      moderationReason:
        input.status === 'HIDDEN' ? reason.slice(0, MODERATION_REASON_MAX_LENGTH) : null,
      moderatedByUserId: actorUserId,
      moderatedAt: new Date(),
    },
    include: ADMIN_INCLUDE,
  });

  return { before: toAdminReview(existing), after: toAdminReview(updated) };
}


// ---------------------------------------------------------------------------
// Seller score (JOURNEY-059)
// ---------------------------------------------------------------------------

/**
 * How buyers rated a seller's SERVICE: the mean of the delivery and support
 * scores on every published review of goods that seller sold, and how many.
 *
 * Separate from a product's rating on purpose. A product's figure is about
 * the thing (all four scores, whoever sold it); a seller's is about how that
 * seller delivered and answered, across everything they sold. Neither is ever
 * blended with an inspection result: an inspection is a measured fact about a
 * consignment, a rating is a buyer's opinion, and the screens show them side
 * by side, never averaged.
 *
 * Null when the seller has no published review, so a new seller is not shown
 * "0 stars".
 */
export interface SellerScore {
  /** Mean of delivery and support, two decimals. */
  average: number;
  delivery: number;
  support: number;
  count: number;
}

export async function sellerScores(sellerAccountIds: readonly string[]): Promise<Map<string, SellerScore>> {
  const ids = [...new Set(sellerAccountIds)];
  if (ids.length === 0) return new Map();
  const groups = await prisma.productReview.groupBy({
    by: ['sellerAccountId'],
    where: { sellerAccountId: { in: ids }, status: 'PUBLISHED' },
    _avg: { deliveryRating: true, supportRating: true },
    _count: { _all: true },
  });
  return new Map(
    groups
      .filter((group) => group.sellerAccountId !== null)
      .map((group) => {
        const delivery = round2(group._avg.deliveryRating ?? 0);
        const support = round2(group._avg.supportRating ?? 0);
        return [
          group.sellerAccountId as string,
          { average: round2((delivery + support) / 2), delivery, support, count: group._count._all },
        ];
      }),
  );
}

export async function sellerScore(sellerAccountId: string): Promise<SellerScore | null> {
  return (await sellerScores([sellerAccountId])).get(sellerAccountId) ?? null;
}

// ---------------------------------------------------------------------------
// Seller responses (JOURNEY-059)
// ---------------------------------------------------------------------------

/** The longest answer a seller may publish under a review. */
export const SELLER_RESPONSE_MAX_LENGTH = 1000;

export interface SellerReviewView {
  id: string;
  product: { name: string; slug: string };
  reviewerName: string;
  scores: RatingScores;
  average: number;
  status: ProductReviewStatus;
  createdAt: string;
  response: { body: string; status: ProductReviewStatus; at: string | null; hiddenReason: string | null } | null;
}

/** Reviews of goods this seller sold, newest first, with its own answers. */
export async function listSellerReviews(
  sellerAccountId: string,
  options: { page: number; limit: number },
): Promise<{ reviews: SellerReviewView[]; score: SellerScore | null; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const where: Prisma.ProductReviewWhereInput = { sellerAccountId, status: 'PUBLISHED' };
  const [rows, total, score] = await Promise.all([
    prisma.productReview.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      include: {
        product: { select: { name: true, slug: true } },
        customerProfile: { select: { firstName: true, lastName: true, fullName: true } },
      },
    }),
    prisma.productReview.count({ where }),
    sellerScore(sellerAccountId),
  ]);
  return {
    score,
    reviews: rows.map((row) => {
      const scores = scoresOf(row);
      return {
        id: row.id,
        product: row.product,
        reviewerName: publicReviewerName(row.customerProfile),
        scores,
        average: meanOf(scores),
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        response:
          row.sellerResponse === null
            ? null
            : {
                body: row.sellerResponse,
                status: row.sellerResponseStatus ?? 'PUBLISHED',
                at: row.sellerResponseAt?.toISOString() ?? null,
                // The seller is told why staff hid its answer.
                hiddenReason: row.sellerResponseHiddenReason,
              },
      };
    }),
    pagination: { page: options.page, limit: options.limit, total, totalPages: Math.ceil(total / options.limit) },
  };
}

/**
 * Write or replace this seller's public answer under one review.
 *
 * Only a review of this seller's own sale - anything else is "not found".
 * Plain text, at most 1000 characters. Published at once, like the review; an
 * answer staff have hidden stays hidden when edited, for the same reason an
 * edited hidden review does - otherwise hiding would be a suggestion. The
 * scores are never touched. Audited.
 */
export async function respondToReview(
  sellerAccountId: string,
  reviewId: string,
  body: string,
  actor: { userId: string; email: string },
): Promise<SellerReviewView['response']> {
  const text = body.trim();
  if (text === '' || text.length > SELLER_RESPONSE_MAX_LENGTH) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Write an answer of up to 1000 characters.', [
      { field: 'body', code: ErrorCode.VALIDATION_FAILED },
    ]);
  }
  const existing = await prisma.productReview.findFirst({
    where: { id: reviewId, sellerAccountId, status: 'PUBLISHED' },
    select: { id: true, sellerResponse: true, sellerResponseStatus: true },
  });
  if (existing === null) throw notFound('Review');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productReview.update({
      where: { id: reviewId },
      data: {
        sellerResponse: text,
        sellerResponseStatus: existing.sellerResponseStatus ?? 'PUBLISHED',
        sellerResponseAt: new Date(),
        sellerResponseByUserId: actor.userId,
      },
      select: { sellerResponse: true, sellerResponseStatus: true, sellerResponseAt: true, sellerResponseHiddenReason: true },
    });
    await recordAudit(
      {
        action: AuditAction.PRODUCT_REVIEW_RESPONDED,
        resourceType: 'product_review',
        resourceId: reviewId,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { response: existing.sellerResponse },
        after: { response: text },
      },
      tx,
    );
    return row;
  });

  return {
    body: updated.sellerResponse ?? text,
    status: updated.sellerResponseStatus ?? 'PUBLISHED',
    at: updated.sellerResponseAt?.toISOString() ?? null,
    hiddenReason: updated.sellerResponseHiddenReason,
  };
}

/**
 * Staff hide a seller's answer (a reason is required; the seller is shown it)
 * or put it back. The review and its scores are untouched. Audited.
 */
export async function moderateReviewResponse(
  reviewId: string,
  input: { status: ProductReviewStatus; reason?: string | null },
  actor: { userId: string; email: string },
): Promise<AdminReview> {
  const existing = await prisma.productReview.findUnique({ where: { id: reviewId }, include: ADMIN_INCLUDE });
  if (existing?.sellerResponse === null || existing === null) throw notFound('Response');

  const reason = input.reason?.trim() ?? '';
  if (input.status === 'HIDDEN' && reason === '') {
    throw new AppError({
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: "Say why the seller's answer is being hidden. The seller is shown the reason.",
      details: [{ field: 'reason', code: 'REQUIRED' }],
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productReview.update({
      where: { id: reviewId },
      data: {
        sellerResponseStatus: input.status,
        sellerResponseHiddenReason: input.status === 'HIDDEN' ? reason.slice(0, MODERATION_REASON_MAX_LENGTH) : null,
      },
      include: ADMIN_INCLUDE,
    });
    await recordAudit(
      {
        action:
          input.status === 'HIDDEN'
            ? AuditAction.PRODUCT_REVIEW_RESPONSE_HIDDEN
            : AuditAction.PRODUCT_REVIEW_RESPONSE_PUBLISHED,
        resourceType: 'product_review',
        resourceId: reviewId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { responseStatus: existing.sellerResponseStatus },
        after: { responseStatus: input.status, reason: input.status === 'HIDDEN' ? reason : null },
      },
      tx,
    );
    return row;
  });
  return toAdminReview(updated);
}
