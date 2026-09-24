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
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import { prisma } from '../../infra/prisma.js';
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
import { decideSellerCarrier } from '../../modules/seller/logistics-partner.service.js';
import {
  decideFulfilmentMethod,
  listMethodsAwaitingDecision,
} from '../../modules/seller/fulfilment-method.service.js';
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

  /**
   * List seller applications a page at a time, filtered by status or searched
   * by business name.
   */
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

  /**
   * One seller application in full, including internal notes the seller
   * never sees.
   */
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

  /**
   * The current certificates and licences a seller has uploaded, with the
   * review status of each.
   */
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

  /**
   * Seller listings submitted for review and waiting for a decision, a page
   * at a time.
   */
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

  /**
   * Sellers' requests for new brands still awaiting a decision, oldest first,
   * with how many listings are waiting on each.
   */
  app.get(
    '/brand-requests',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (_request, reply) => {
      const requests = await listBrandQueue();
      return reply.header('cache-control', 'no-store').status(200).send({ requests });
    },
  );

  /**
   * Approve, refuse or ask for more information about a seller's request to
   * add a brand, optionally approving it under a corrected spelling. Refused
   * if already decided. Notifies the seller and writes an audit entry.
   */
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

  // -------------------------------------------------------------------------
  // Seller delivery methods
  //
  // The approvals queue for how a seller's OWN goods get delivered, which is a
  // different question from which marketplace carrier they may hand work to
  // (that is the section below).
  //
  // What the marketplace is approving here is a CLAIM: that this seller's vans
  // can hold reagents at 2-8C, that their courier covers Bavaria, that they
  // can handle dangerous goods. Those claims decide which orders the
  // marketplace lets them accept, which is why they are reviewed. A seller's
  // own commercial account with DHL makes no such claim and is not reviewed.
  //
  // `CUSTOMER_STATUS_WRITE` for the same reason as below: approving one lets a
  // seller take on work they could otherwise not.
  // -------------------------------------------------------------------------

  /**
   * Sellers' delivery methods waiting for approval, oldest submission first.
   */
  app.get(
    '/fulfilment-methods/pending',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() })
        .parse(request.query);

      const methods = await listMethodsAwaitingDecision(query.limit ?? 50);

      return reply.header('cache-control', 'no-store').status(200).send({ methods });
    },
  );

  /**
   * Approve, refuse or ask for changes to a seller's own delivery method, and
   * decide whether it may ship across borders. Tells the seller and writes an
   * audit entry.
   */
  app.patch(
    '/fulfilment-methods/:methodId',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const params = z.object({ methodId: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          to: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED']),
          reason: z.string().trim().max(512).nullable().optional(),
          /**
           * Whether this method may carry a consignment across a border.
           *
           * The marketplace's call, not the seller's: it turns on customs
           * paperwork somebody here has looked at, and a parcel stopped at a
           * border is worse than one that was never offered the option.
           */
          allowsInternational: z.boolean().optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const method = await decideFulfilmentMethod({
        fulfilmentMethodId: params.methodId,
        to: body.to,
        decidedByUserId: auth.id,
        reason: body.reason ?? null,
        allowsInternational: body.allowsInternational,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ method });
    },
  );

  // Seller-to-carrier arrangements
  //
  // The approvals queue for the seller half of the fulfilment split. A seller
  // may ASK to use a carrier; only the marketplace may say yes, and only
  // through here.
  //
  // `CUSTOMER_STATUS_WRITE` rather than a read permission, because approving
  // an arrangement is what lets a seller create an obligation on a third
  // party. Every decision writes `decidedByUserId` and a reason, and the
  // service refuses an adverse decision that has no reason attached.
  // -------------------------------------------------------------------------

  /**
   * List the arrangements between sellers and carriers, filtered by status,
   * seller or carrier. Requests awaiting a decision are what this queue is
   * for.
   */
  app.get(
    '/seller-carriers',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          status: z
            .enum(['REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ENDED'])
            .optional(),
          sellerAccountId: z.string().length(26).optional(),
          logisticsPartnerId: z.string().length(26).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      const rows = await prisma.sellerLogisticsPartner.findMany({
        where: {
          archivedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.sellerAccountId === undefined
            ? {}
            : { sellerAccountId: query.sellerAccountId }),
          ...(query.logisticsPartnerId === undefined
            ? {}
            : { logisticsPartnerId: query.logisticsPartnerId }),
        },
        include: {
          sellerAccount: { select: { id: true, displayName: true, legalName: true } },
          logisticsPartner: { select: { id: true, displayName: true, partnerCode: true, status: true } },
        },
        orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
        take: query.limit,
      });

      return reply.header('cache-control', 'no-store').status(200).send({
        arrangements: rows.map((row: (typeof rows)[number]) => ({
          linkId: row.id,
          status: row.status,
          relationshipType: row.relationshipType,
          seller: row.sellerAccount,
          carrier: row.logisticsPartner,
          serviceCountries: row.serviceCountriesJson,
          approvedCapabilities: row.approvedCapabilitiesJson,
          sellerReference: row.sellerReference,
          statusReason: row.statusReason,
          requestedAt: row.requestedAt.toISOString(),
          decidedAt: row.decidedAt?.toISOString() ?? null,
          effectiveFrom: row.effectiveFrom.toISOString(),
          effectiveTo: row.effectiveTo?.toISOString() ?? null,
        })),
      });
    },
  );

  /**
   * Approve, refuse, suspend or end a seller's request to use a carrier, and
   * optionally narrow the countries, capabilities and dates it covers. An
   * adverse decision needs a reason. Writes an audit entry.
   */
  app.patch(
    '/seller-carriers/:id',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);
      const body = z
        .object({
          status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED', 'ENDED']),
          reason: z.string().trim().max(512).nullable().optional(),
          relationshipType: z
            .enum(['DIRECT_CONTRACT', 'MARKETPLACE_BROKERED', 'PREFERRED'])
            .optional(),
          /**
           * Narrows the arrangement. It can never widen what the carrier
           * itself covers - a seller cannot grant a carrier reach the carrier
           * does not have - which the eligibility check enforces separately.
           */
          serviceCountries: z.array(z.string().length(2)).nullable().optional(),
          approvedCapabilities: z.array(z.string().max(48)).nullable().optional(),
          effectiveFrom: z.coerce.date().optional(),
          effectiveTo: z.coerce.date().nullable().optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await decideSellerCarrier({
        linkId: params.id,
        to: body.status,
        decidedByUserId: auth.id,
        reason: body.reason ?? null,
        ...(body.relationshipType === undefined
          ? {}
          : { relationshipType: body.relationshipType }),
        ...(body.serviceCountries === undefined
          ? {}
          : { serviceCountries: body.serviceCountries }),
        ...(body.approvedCapabilities === undefined
          ? {}
          : { approvedCapabilities: body.approvedCapabilities }),
        ...(body.effectiveFrom === undefined ? {} : { effectiveFrom: body.effectiveFrom }),
        ...(body.effectiveTo === undefined ? {} : { effectiveTo: body.effectiveTo }),
      });

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
        action: AuditAction.SELLER_CARRIER_DECIDED,
        resourceType: 'seller_logistics_partner',
        resourceId: params.id,
        after: { status: body.status, reason: body.reason ?? null },
      });

      return reply.status(200).send(result);
    },
  );

  return Promise.resolve();
}
