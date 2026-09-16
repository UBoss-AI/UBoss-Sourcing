/**
 * Marketplace operations: the operator reviewing sellers, listings and brands.
 *
 * Guarded by the operator's own permission catalogue (`domain/permissions.ts`),
 * not the seller one. The two are deliberately separate - see the header of
 * `domain/seller-permissions.ts` - and a route that accepted either would be
 * the route through which a seller reached another seller's application.
 *
 * The permissions reused here are the closest existing ones rather than new
 * marketplace-specific keys: reviewing a seller's business documents is
 * customer-status work, moderating a listing is product-publish work. That
 * keeps the role matrix an operator already configured meaningful instead of
 * adding seven keys nobody has granted to anyone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  createAdminDocumentLink,
  decideSellerDocument,
  listDocumentsForReview,
  redeemDocumentLink,
} from '../../modules/seller/document.service.js';
import { readSellerInsight } from '../../modules/seller/insight.service.js';
import {
  decideApplication,
  decideBrandRequest,
  decideListing,
  listApplications,
  listBrandQueue,
  listReviewQueue,
  readApplication,
  readListingForReview,
  setSellerCommission,
} from '../../modules/seller/moderation.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Quotes, newlines and control characters are stripped rather than escaped: a
 * newline in this header is response splitting, and the seller's own filename
 * is decoration on a download nobody needs to round-trip exactly.
 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'document';
}

export function registerAdminSellerRoutes(app: FastifyInstance): Promise<void> {
  // --- Applications -------------------------------------------------------

  app.get(
    '/sellers',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          status: z
            .enum([
              'DRAFT',
              'SUBMITTED',
              'UNDER_REVIEW',
              'ACTION_REQUIRED',
              'APPROVED',
              'REJECTED',
              'SUSPENDED',
            ])
            .nullish(),
          search: z.string().trim().max(200).nullish(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);

      const result = await listApplications(query);
      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  app.get(
    '/sellers/:id',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const application = await readApplication(params.id);
      return reply.header('cache-control', 'no-store').status(200).send(application);
    },
  );

  /**
   * How this seller is doing, and where its goods are.
   *
   * Fed by the Companies screen, which loads it only for a company somebody has
   * actually opened — a directory page holding forty companies must not run
   * forty of these.
   *
   * No cache header for the same reason the seller's own dashboard has none:
   * every figure on it is the reason somebody opened the panel.
   */
  app.get(
    '/sellers/:id/insight',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const insight = await readSellerInsight(params.id);
      return reply.header('cache-control', 'no-store').status(200).send(insight);
    },
  );

  /**
   * Decide an application.
   *
   * `CUSTOMER_STATUS_WRITE` rather than `CUSTOMER_WRITE`: approving a seller is
   * the same kind of authority as activating or suspending an account, and the
   * operator's role matrix already separates those two for exactly this reason.
   */
  app.post(
    '/sellers/:id/decision',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const body = z
        .object({
          status: z.enum([
            'UNDER_REVIEW',
            'ACTION_REQUIRED',
            'APPROVED',
            'REJECTED',
            'SUSPENDED',
          ]),
          /** Seller-visible. The machine requires it on every refusal and stop. */
          reason: z.string().trim().max(4000).nullable().optional(),
          /** Operator-only. Never serialised to a seller route. */
          internalNote: z.string().trim().max(4000).nullable().optional(),
          resubmissionAllowed: z.boolean().optional(),
          /** Refuses the write if another administrator decided it meanwhile. */
          expectedVersion: z.number().int().min(0).nullable().optional(),
        })
        .parse(request.body);

      await decideApplication({
        sellerAccountId: params.id,
        to: body.status,
        reason: body.reason ?? null,
        internalNote: body.internalNote ?? null,
        adminUserId: auth.id,
        ...(body.resubmissionAllowed === undefined
          ? {}
          : { resubmissionAllowed: body.resubmissionAllowed }),
        correlationId: request.correlationId,
        expectedVersion: body.expectedVersion ?? null,
      });

      return reply.status(204).send();
    },
  );

  /**
   * One seller's own commission rate.
   *
   * `SETTINGS_WRITE` rather than a customer permission: this is what the
   * marketplace charges, which is the same kind of authority as setting the
   * standard rate in Settings, and the person who decides a commercial term is
   * not necessarily the person who reviews applications.
   */
  app.patch(
    '/sellers/:id/commission',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const body = z
        .object({
          /** Basis points, or null to follow the marketplace's own rate. */
          commissionBasisPoints: z.number().int().min(0).max(10_000).nullable(),
        })
        .parse(request.body);

      await setSellerCommission({
        sellerAccountId: params.id,
        basisPoints: body.commissionBasisPoints,
        adminUserId: auth.id,
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  // --- A seller's evidence ------------------------------------------------
  //
  // The certificates and licences behind the application. `CUSTOMER_READ` to
  // see the list and `CUSTOMER_STATUS_WRITE` to decide one - the same split as
  // the application itself, and for the same reason: accepting a CE
  // certificate is part of deciding whether a business may sell here, which is
  // not work a catalogue assistant does.

  app.get(
    '/sellers/:id/documents',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const documents = await listDocumentsForReview(params.id);

      return reply.header('cache-control', 'no-store').status(200).send({ documents });
    },
  );

  /**
   * A link to read one back.
   *
   * A POST rather than a GET, because it MINTS something - a single-use token
   * with a life of minutes - and because a GET that has a side effect is a GET
   * a browser may make twice on its own initiative, spending the token before
   * the operator has clicked anything.
   */
  app.post(
    '/seller-documents/:id/link',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const link = await createAdminDocumentLink(auth.id, params.id, request.correlationId);

      return reply.header('cache-control', 'no-store').status(200).send(link);
    },
  );

  /**
   * Redeem it.
   *
   * Served as an ATTACHMENT with `nosniff`, never inline: a PDF rendered in the
   * page would be a PDF running in the console's own origin.
   */
  app.get(
    '/seller-documents/:id/download',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const query = z.object({ token: z.string().min(1).max(256) }).parse(request.query);
      const auth = currentUser(request);

      // Null for the seller scope: an operator may read any seller's document,
      // and which one this is has already been decided by the id in the token.
      const file = await redeemDocumentLink('admin', auth.id, params.id, query.token, null);

      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${safeFileName(file.fileName)}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .status(200)
        .send(file.body);
    },
  );

  /**
   * Accept or refuse one.
   *
   * A refusal must carry a reason and the service enforces it, not the form:
   * "your certificate was not accepted" with no reason is a seller who uploads
   * the same file again, and a queue that grows.
   */
  app.post(
    '/seller-documents/:id/decision',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const body = z
        .object({
          decision: z.enum(['APPROVED', 'REJECTED']),
          /** Seller-visible, and required on a refusal. */
          reason: z.string().trim().max(2000).nullable().optional(),
        })
        .parse(request.body);

      await decideSellerDocument({
        documentId: params.id,
        decision: body.decision,
        reason: body.reason ?? null,
        adminUserId: auth.id,
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  // --- Listing moderation -------------------------------------------------

  app.get(
    '/seller-listings/review-queue',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);

      const result = await listReviewQueue(query);
      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  /**
   * One submitted listing, in full.
   *
   * `PRODUCT_READ`, the same as the queue: reading a listing somebody has
   * offered the marketplace is reading the catalogue. Deciding it needs more.
   */
  app.get(
    '/seller-listings/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const listing = await readListingForReview(params.id);
      return reply.header('cache-control', 'no-store').status(200).send(listing);
    },
  );

  /**
   * Approve, refuse or send back a listing.
   *
   * `PRODUCT_PUBLISH`, because approving one is what makes a medical device
   * buyable on this marketplace - the same authority as publishing the
   * operator's own product, and deliberately not `PRODUCT_WRITE`, which a
   * catalogue assistant may hold.
   */
  app.post(
    '/seller-listings/:id/decision',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const body = z
        .object({
          status: z.enum(['APPROVED', 'ACTION_REQUIRED', 'REJECTED']),
          comment: z.string().trim().max(4000).nullable().optional(),
          /**
           * Comments attached to individual fields.
           *
           * The difference between a review a seller can act on and one they
           * cannot. Capped at fifty because a review with more than fifty
           * separate objections is a rejection.
           */
          fieldComments: z
            .array(
              z.object({
                section: z
                  .enum([
                    'PRODUCT_PHOTOS',
                    'PRICE_STOCK_SHIPPING',
                    'PRODUCT_DESCRIPTION',
                    'ADDITIONAL_INFORMATION',
                    'MEDICAL_COMPLIANCE',
                  ])
                  .nullable()
                  .optional(),
                attributeKey: z.string().trim().max(64).nullable().optional(),
                message: z.string().trim().min(1).max(512),
              }),
            )
            .max(50)
            .optional(),
          /**
           * The submitted revision this moderator read.
           *
           * Sent by the review screen from what it was given. The decision is
           * refused if the listing has moved on since - a seller resubmitting
           * a newer version, or another administrator deciding first. Optional
           * so an older client is not broken by it, and every current one
           * sends it.
           */
          expectedVersion: z.number().int().min(0).nullable().optional(),
        })
        .parse(request.body);

      const result = await decideListing({
        draftId: params.id,
        to: body.status,
        comment: body.comment ?? null,
        ...(body.fieldComments === undefined ? {} : { fieldComments: body.fieldComments }),
        adminUserId: auth.id,
        expectedVersion: body.expectedVersion ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(200).send(result);
    },
  );

  // --- Brands -------------------------------------------------------------

  app.get(
    '/brand-requests',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (_request, reply) => {
      const requests = await listBrandQueue();
      return reply.header('cache-control', 'no-store').status(200).send({ requests });
    },
  );

  app.post(
    '/brand-requests/:id/decision',
    { preHandler: requireAdmin(Permission.PRODUCT_PUBLISH) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const body = z
        .object({
          decision: z.enum(['APPROVED', 'REJECTED', 'INFORMATION_REQUESTED']),
          reason: z.string().trim().max(2000).nullable().optional(),
          /** Approve under a corrected spelling of the requested name. */
          correctedName: z.string().trim().max(160).nullable().optional(),
        })
        .parse(request.body);

      await decideBrandRequest({
        requestId: params.id,
        decision: body.decision,
        reason: body.reason ?? null,
        correctedName: body.correctedName ?? null,
        adminUserId: auth.id,
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  return Promise.resolve();
}
