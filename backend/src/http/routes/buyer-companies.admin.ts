/**
 * Buyer-company verification, in the admin console.
 *
 * Three grants: `buyer_company.read` to see the queue, an application, its
 * checks and its documents; `buyer_company.review` to decide; and
 * `buyer_company.suspend` to stop, or restart, a company that is already
 * buying. Each route names its own - there is no shared guard constant here,
 * because a guard defined once and passed around is invisible to the
 * reference-docs generator, which then lists the route as public.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BuyerCompanyStatusValues } from '../../domain/buyer-company-state.js';
import { Permission } from '../../domain/permissions.js';
import { companyAccessForStaff } from '../../modules/access-review/admin-access-review.service.js';
import {
  addInternalNote,
  approveCompany,
  assignReviewer,
  listReviewQueue,
  listReviewers,
  readForReview,
  rejectCompany,
  REJECTION_REASON_CODES,
  requestMoreInformation,
  requestReverification,
  rerunChecks,
  startReview,
  suspendCompany,
  type Reviewer,
} from '../../modules/buyer-companies/review.service.js';
import {
  createDocumentLink,
  decideCompanyDocument,
  redeemDocumentLink,
} from '../../modules/buyer-companies/documents.service.js';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  criticalActionApprovalRequired,
  requestPendingAction,
} from '../../modules/governance/pending-action.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import { staffActorFrom } from './governance.admin.js';
import { assertStaffDataRegion } from '../plugins/data-region.js';

const idParam = z.object({ id: z.string().length(26) });

const queueQuery = z.object({
  status: z.string().max(400).optional(),
  country: z.string().length(2).optional(),
  search: z.string().max(120).optional(),
  assignee: z.string().max(26).optional(),
  risk: z.enum(['NONE', 'LOW', 'ELEVATED', 'HIGH']).optional(),
  sort: z.enum(['oldest', 'newest', 'recent_activity', 'risk']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const versioned = z.object({ expectedVersion: z.number().int().min(0) });
const reasonText = z.string().trim().max(1000);

const infoSchema = versioned.extend({
  message: z.string().trim().min(1).max(5000),
  documentKinds: z.array(z.string().max(48)).max(8).default([]),
});

const approveSchema = versioned.extend({ reason: reasonText.nullable().optional() });

const rejectSchema = versioned.extend({
  reasonCode: z.enum(REJECTION_REASON_CODES),
  reason: reasonText.min(1),
  resubmissionAllowed: z.boolean().default(true),
});

const suspendSchema = versioned.extend({
  reason: reasonText.min(1),
  reasonCode: z.string().max(48).nullable().optional(),
});

const reverifySchema = versioned.extend({
  reason: reasonText.min(1),
  documentKinds: z.array(z.string().max(48)).max(8).default([]),
});

function reviewerOf(request: FastifyRequest): Reviewer {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    permissions: new Set(auth.permissions),
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminBuyerCompanyRoutes(app: FastifyInstance): Promise<void> {
  /** The review queue: filter by status, country, reviewer and risk; search by name, reference, number or email. */
  app.get(
    '/buyer-companies',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_READ) },
    async (request, reply) => {
      const query = queueQuery.parse(request.query);
      const statuses = (query.status ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is (typeof BuyerCompanyStatusValues)[number] =>
          (BuyerCompanyStatusValues as readonly string[]).includes(value),
        );
      return reply.status(200).send(
        await listReviewQueue(reviewerOf(request), {
          statuses,
          ...(query.country !== undefined ? { country: query.country } : {}),
          ...(query.search !== undefined ? { search: query.search } : {}),
          ...(query.assignee !== undefined ? { assignee: query.assignee } : {}),
          ...(query.risk !== undefined ? { risk: query.risk } : {}),
          ...(query.sort !== undefined ? { sort: query.sort } : {}),
          page: query.page,
          pageSize: query.pageSize,
        }),
      );
    },
  );

  /** Staff who may be assigned a company review. */
  app.get(
    '/buyer-companies/reviewers',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_READ) },
    async (_request, reply) => {
      return reply.status(200).send({ reviewers: await listReviewers() });
    },
  );

  /** One application with everything a reviewer needs: details, checks, duplicates, documents, notes and history. */
  app.get(
    '/buyer-companies/:id',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send(await readForReview(reviewerOf(request), id));
    },
  );

  /** Who can act for this company, read-only: roles, joining dates, who invited whom, last sign-in and activity, open invitations and recent access reviews. */
  app.get(
    '/buyer-companies/:id/access-review',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.header('cache-control', 'no-store').status(200).send(await companyAccessForStaff(id));
    },
  );

  /** Open a submitted application for review and take it if nobody has. */
  app.post(
    '/buyer-companies/:id/start-review',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ expectedVersion: z.number().int().min(0).optional() })
        .parse(request.body ?? {});
      return reply
        .status(200)
        .send(await startReview(reviewerOf(request), id, body.expectedVersion));
    },
  );

  /** Give the review to a colleague who may review, or unassign it. */
  app.post(
    '/buyer-companies/:id/assign',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ reviewerId: z.string().length(26).nullable() }).parse(request.body);
      return reply.status(200).send(await assignReviewer(reviewerOf(request), id, body.reviewerId));
    },
  );

  /** Add an internal note. Never shown to the applicant. */
  app.post(
    '/buyer-companies/:id/notes',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ note: z.string().trim().min(1).max(5000) }).parse(request.body);
      return reply.status(200).send(await addInternalNote(reviewerOf(request), id, body.note));
    },
  );

  /** Send the application back to the applicant with a question, optionally asking for named documents. */
  app.post(
    '/buyer-companies/:id/request-information',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = infoSchema.parse(request.body);
      return reply.status(200).send(
        await requestMoreInformation(reviewerOf(request), {
          companyId: id,
          expectedVersion: body.expectedVersion,
          reason: body.message,
          documentKinds: body.documentKinds,
        }),
      );
    },
  );

  /**
   * Approve the company, or restore a suspended or re-verified one. Restoring
   * a suspended company also needs `buyer_company.suspend`.
   */
  app.post(
    '/buyer-companies/:id/approve',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = approveSchema.parse(request.body);
      return reply
        .status(200)
        .send(
          await approveCompany(reviewerOf(request), {
            companyId: id,
            expectedVersion: body.expectedVersion,
            reason: body.reason ?? null,
          }),
        );
    },
  );

  /** Refuse the application with a reason code and a reason the applicant reads. */
  app.post(
    '/buyer-companies/:id/reject',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = rejectSchema.parse(request.body);
      return reply.status(200).send(
        await rejectCompany(reviewerOf(request), {
          companyId: id,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          reasonCode: body.reasonCode,
          resubmissionAllowed: body.resubmissionAllowed,
        }),
      );
    },
  );

  /** Stop an approved company buying, immediately. */
  app.post(
    '/buyer-companies/:id/suspend',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_SUSPEND) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = suspendSchema.parse(request.body);

      // Maker-checker (JOURNEY-061): with `critical_action_approval` on, the
      // suspension waits for a second member of staff. 202: nothing changed yet.
      if (await criticalActionApprovalRequired()) {
        const company = await prisma.buyerCompany.findUnique({
          where: { id },
          select: { legalName: true, applicationReference: true },
        });
        if (company === null) throw notFound('Company');
        const pending = await requestPendingAction(
          {
            kind: 'BUYER_COMPANY_SUSPEND',
            resourceType: 'buyer_company',
            resourceId: id,
            resourceLabel: company.legalName ?? company.applicationReference,
            payload: { expectedVersion: body.expectedVersion, reasonCode: body.reasonCode ?? null },
            reason: body.reason,
          },
          staffActorFrom(request),
        );
        return reply.status(202).send({ pending });
      }

      return reply.status(200).send(
        await suspendCompany(reviewerOf(request), {
          companyId: id,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          reasonCode: body.reasonCode ?? null,
        }),
      );
    },
  );

  /** Ask an approved company to confirm its details again. Purchasing stops until it is approved again. */
  app.post(
    '/buyer-companies/:id/reverify',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = reverifySchema.parse(request.body);
      return reply.status(200).send(
        await requestReverification(reviewerOf(request), {
          companyId: id,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          documentKinds: body.documentKinds,
        }),
      );
    },
  );

  /** Ask every registry again now. The earlier results are kept. */
  app.post(
    '/buyer-companies/:id/checks',
    {
      preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send(await rerunChecks(reviewerOf(request), id));
    },
  );

  /** A single-use download link for one company document, valid for a few minutes. */
  app.post(
    '/buyer-company-documents/:id/link',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      assertStaffDataRegion(request);
      return reply.status(200).send(await createDocumentLink(currentUser(request).id, id));
    },
  );

  /** Download a company document with a link from the route above. Served as an attachment; audited. */
  app.get(
    '/buyer-company-documents/:id/download',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { token } = z.object({ token: z.string().min(16).max(128) }).parse(request.query);
      assertStaffDataRegion(request);
      const file = await redeemDocumentLink(
        currentUser(request).id,
        id,
        token,
        request.correlationId,
      );

      return reply
        .status(200)
        .header('content-type', file.contentType)
        .header(
          'content-disposition',
          `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        )
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('cache-control', 'no-store')
        .send(file.body);
    },
  );

  /** Accept or refuse one document. A refusal needs a reason the applicant reads. */
  app.post(
    '/buyer-company-documents/:id/decision',
    { preHandler: requireAdmin(Permission.BUYER_COMPANY_REVIEW) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          decision: z.enum(['ACCEPTED', 'REJECTED']),
          reason: z.string().trim().max(1000).nullable().optional(),
        })
        .parse(request.body);
      const { companyId } = await decideCompanyDocument({
        adminUserId: currentUser(request).id,
        documentId: id,
        decision: body.decision,
        reason: body.reason ?? null,
        correlationId: request.correlationId,
      });
      return reply.status(200).send(await readForReview(reviewerOf(request), companyId));
    },
  );

  return Promise.resolve();
}
