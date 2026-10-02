/**
 * Product reviews, for all three audiences.
 *
 * - **Public** (`/catalog`): a product's summary and its published reviews.
 * - **Customer** (`/account`): read, write, edit and delete your own review,
 *   and list what you have received but not yet rated.
 * - **Staff** (`/admin`): every review, with who wrote it, and hide or restore.
 *
 * The rules live in `product-review.service.ts`; this file only validates and
 * routes. `FEATURE_PRODUCT_REVIEWS` switches the public and customer routes
 * off. The staff routes stay on, so reviews already written can still be read
 * and moderated while the storefront shows none.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  MODERATION_REASON_MAX_LENGTH,
  SELLER_RESPONSE_MAX_LENGTH,
  deleteOwnReview,
  listOwnReviews,
  listPublicReviews,
  listReviewsForAdmin,
  listSellerReviews,
  moderateReview,
  moderateReviewResponse,
  readOwnReview,
  respondToReview,
  reviewedProductIds,
  saveOwnReview,
} from '../../modules/catalog/product-review.service.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

/** Refused the same way whichever storefront route is asked. */
function assertReviewsEnabled(): void {
  if (!env.FEATURE_PRODUCT_REVIEWS) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.FEATURE_DISABLED,
      message: 'Product reviews are not enabled for this store.',
    });
  }
}

const score = z.number().int().min(1).max(5);

const scoresSchema = z.object({
  quality: score,
  delivery: score,
  experience: score,
  support: score,
});

const productIdParams = z.object({ productId: z.string().length(26) });

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

const publicListQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  sort: z.enum(['recent', 'highest', 'lowest']).default('recent'),
});

export function registerPublicProductReviewRoutes(app: FastifyInstance): Promise<void> {
  // A product's rating summary and one page of its published reviews.
  app.get('/products/:slug/reviews', async (request, reply) => {
    assertReviewsEnabled();
    const { slug } = z.object({ slug: z.string().min(1).max(255) }).parse(request.params);
    const query = publicListQuery.parse(request.query);

    const result = await listPublicReviews(slug, query);
    return reply.status(200).send(result);
  });

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

const saveBody = z.object({
  scores: scoresSchema,
});

export function registerCustomerProductReviewRoutes(app: FastifyInstance): Promise<void> {
  // Your reviews, and the delivered products still waiting for one.
  app.get('/product-reviews', { preHandler: requireCustomer }, async (request, reply) => {
    assertReviewsEnabled();
    const auth = currentUser(request);
    const { language } = z
      .object({ language: z.string().trim().min(2).max(10).optional() })
      .parse(request.query);

    const result = await listOwnReviews(auth.customerProfileId ?? '', {
      language: language ?? null,
    });
    return reply.header('Cache-Control', 'no-store').status(200).send(result);
  });

  // Which of these products you have already reviewed. For the order page.
  app.get('/product-reviews/reviewed', { preHandler: requireCustomer }, async (request, reply) => {
    assertReviewsEnabled();
    const auth = currentUser(request);
    const { productIds } = z
      .object({
        productIds: z
          .string()
          .max(26 * 100 + 99)
          .default(''),
      })
      .parse(request.query);

    const ids = productIds
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length === 26);

    const reviewed = await reviewedProductIds(auth.customerProfileId ?? '', ids);
    return reply
      .header('Cache-Control', 'no-store')
      .status(200)
      .send({ productIds: [...reviewed] });
  });

  // Whether you may review this product, and your review if you wrote one.
  app.get(
    '/products/:productId/review',
    { preHandler: requireCustomer },
    async (request, reply) => {
      assertReviewsEnabled();
      const auth = currentUser(request);
      const { productId } = productIdParams.parse(request.params);

      const result = await readOwnReview(auth.customerProfileId ?? '', productId);
      return reply.header('Cache-Control', 'no-store').status(200).send(result);
    },
  );

  // Write your review of a product, or replace the one you wrote.
  app.put(
    '/products/:productId/review',
    { preHandler: requireCustomer },
    async (request, reply) => {
      assertReviewsEnabled();
      const auth = currentUser(request);
      const { productId } = productIdParams.parse(request.params);
      const body = saveBody.parse(request.body);

      const review = await saveOwnReview(
        auth.customerProfileId ?? '',
        { productId, scores: body.scores },
        { userId: auth.id, email: auth.email },
      );
      return reply.status(200).send({ review });
    },
  );

  // Take your review back.
  app.delete(
    '/product-reviews/:reviewId',
    { preHandler: requireCustomer },
    async (request, reply) => {
      assertReviewsEnabled();
      const auth = currentUser(request);
      const { reviewId } = z.object({ reviewId: z.string().length(26) }).parse(request.params);

      await deleteOwnReview(auth.customerProfileId ?? '', reviewId);
      return reply.status(200).send({ removed: true });
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

const adminListQuery = z.object({
  status: z.enum(['PUBLISHED', 'HIDDEN']).optional(),
  search: z.string().trim().max(120).optional(),
  maxScore: z.coerce.number().int().min(1).max(5).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const moderateBody = z.object({
  status: z.enum(['PUBLISHED', 'HIDDEN']),
  reason: z.string().max(MODERATION_REASON_MAX_LENGTH).nullable().optional(),
});

export function registerAdminProductReviewRoutes(app: FastifyInstance): Promise<void> {
  // Every review, newest first, with who wrote it. Filter by status, score or text.
  app.get(
    '/product-reviews',
    { preHandler: requireAdmin(Permission.REVIEW_READ) },
    async (request, reply) => {
      const query = adminListQuery.parse(request.query);

      const result = await listReviewsForAdmin({
        page: query.page,
        limit: query.limit,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.maxScore === undefined ? {} : { maxScore: query.maxScore }),
      });
      return reply.header('Cache-Control', 'no-store').status(200).send(result);
    },
  );

  // Hide a review from the storefront (a reason is required) or put it back.
  app.post(
    '/product-reviews/:reviewId/moderation',
    { preHandler: requireAdmin(Permission.REVIEW_MODERATE) },
    async (request, reply) => {
      const auth = currentUser(request);
      const { reviewId } = z.object({ reviewId: z.string().length(26) }).parse(request.params);
      const body = moderateBody.parse(request.body);

      const { before, after } = await moderateReview(
        reviewId,
        { status: body.status, reason: body.reason ?? null },
        auth.id,
      );

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
        action:
          after.status === 'HIDDEN'
            ? AuditAction.PRODUCT_REVIEW_HIDDEN
            : AuditAction.PRODUCT_REVIEW_PUBLISHED,
        resourceType: 'product_review',
        resourceId: reviewId,
        before: { status: before.status, moderationReason: before.moderationReason },
        after: { status: after.status, moderationReason: after.moderationReason },
      });

      return reply.status(200).send({ review: after });
    },
  );

  // Hide a seller's answer under a review (a reason is required) or put it back. The review is untouched; audited.
  app.post(
    '/product-reviews/:reviewId/response/moderation',
    { preHandler: requireAdmin(Permission.REVIEW_MODERATE) },
    async (request, reply) => {
      const auth = currentUser(request);
      const { reviewId } = z.object({ reviewId: z.string().length(26) }).parse(request.params);
      const body = moderateBody.parse(request.body);
      const review = await moderateReviewResponse(
        reviewId,
        { status: body.status, reason: body.reason ?? null },
        { userId: auth.id, email: auth.email },
      );
      return reply.status(200).send({ review });
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Seller Hub (JOURNEY-059)
// ---------------------------------------------------------------------------

/**
 * A seller's view of the reviews of goods it sold, and its public answers.
 * Registered under /seller. Off with FEATURE_PRODUCT_REVIEWS, like the
 * storefront routes.
 */
export function registerSellerProductReviewRoutes(app: FastifyInstance): Promise<void> {
  // Reviews of goods you sold, newest first, with your service score and your answers.
  app.get(
    '/product-reviews',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      assertReviewsEnabled();
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(1000).default(1),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .parse(request.query);
      const result = await listSellerReviews(currentSeller(request).sellerAccountId, query);
      return reply.header('Cache-Control', 'no-store').status(200).send(result);
    },
  );

  // Write or replace your public answer under a review of your sale, up to 1000 characters. Audited.
  app.put(
    '/product-reviews/:reviewId/response',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      assertReviewsEnabled();
      const auth = currentUser(request);
      const { reviewId } = z.object({ reviewId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({ body: z.string().trim().min(1).max(SELLER_RESPONSE_MAX_LENGTH) })
        .strict()
        .parse(request.body);
      const response = await respondToReview(currentSeller(request).sellerAccountId, reviewId, body.body, {
        userId: auth.id,
        email: auth.email,
      });
      return reply.status(200).send({ response });
    },
  );

  return Promise.resolve();
}
