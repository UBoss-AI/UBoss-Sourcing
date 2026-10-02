/**
 * The operator's review of suppliers' factories and certificates (checklist
 * Master row 13). Under `/admin`.
 *
 * Reading is `customer.read`, deciding is `customer.status.write` - the same
 * split as a seller application, because verifying a supplier's plant is the
 * same kind of authority as approving the supplier. Evidence files are opened
 * through the existing, audited seller-document link; nothing here returns a
 * file's contents.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import {
  certificationDecisionInput,
  decideCertification,
  listCertificationsForReview,
} from '../../modules/trust/certification.service.js';
import {
  decideFactory,
  factoryDecisionInput,
  listFactoriesForReview,
  trustTimings,
} from '../../modules/trust/factory.service.js';
import {
  companyChangeDecisionInput,
  decideCompanyChange,
  listCompanyChangesForReview,
} from '../../modules/seller/company-change.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

export function registerAdminFactoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One seller's factories (machines, evidence metadata, current status and
   * every check with its reviewer and reason) and certificates.
   */
  app.get(
    '/sellers/:id/factories',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const [factories, certifications, timings] = await Promise.all([
        listFactoriesForReview(id),
        listCertificationsForReview(id),
        trustTimings(),
      ]);
      return reply
        .header('cache-control', 'no-store')
        .send({ factories, certifications, reverificationDays: timings.reverificationDays });
    },
  );

  /**
   * Verify or refuse a factory, or withdraw a verification. A refusal needs a
   * reason the seller is shown. Refused as STALE if the factory moved since
   * the reviewer opened it. Audited.
   */
  app.post(
    '/seller-factories/:id/decision',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = factoryDecisionInput.parse(request.body);
      const auth = currentUser(request);
      const factory = await decideFactory({
        factoryId: id,
        decision: body.decision,
        expectedCheckId: body.expectedCheckId,
        reason: body.reason ?? null,
        internalNote: body.internalNote ?? null,
        validUntil: body.validUntil ?? null,
        actor: { userId: auth.id, email: auth.email, correlationId: request.correlationId },
      });
      return reply.send({ factory });
    },
  );

  /**
   * Verify or refuse a certificate, or withdraw a verification. A refusal
   * needs a reason the seller is shown. Refused as STALE if it moved since the
   * reviewer opened it. Audited.
   */
  app.post(
    '/seller-certifications/:id/decision',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = certificationDecisionInput.parse(request.body);
      const auth = currentUser(request);
      const certification = await decideCertification({
        certificationId: id,
        decision: body.decision,
        expectedState: body.expectedState,
        reason: body.reason ?? null,
        actor: { userId: auth.id, email: auth.email, correlationId: request.correlationId },
      });
      return reply.send({ certification });
    },
  );

  // The queue of sellers' change requests for verified company details, pending first; filter by status or seller.
  app.get(
    '/seller-company-changes',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN']).optional(),
          sellerAccountId: z.string().length(26).optional(),
        })
        .parse(request.query);
      const changes = await listCompanyChangesForReview({
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.sellerAccountId === undefined ? {} : { sellerAccountId: query.sellerAccountId }),
      });
      return reply.header('cache-control', 'no-store').send({ changes });
    },
  );

  // Approve or reject a seller's company details change. Approval applies it and re-opens verification for a material change. Audited.
  app.post(
    '/seller-company-changes/:id/decision',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = companyChangeDecisionInput.parse(request.body);
      const auth = currentUser(request);
      const change = await decideCompanyChange({
        changeId: id,
        decision: body.decision,
        reason: body.reason ?? null,
        actor: { userId: auth.id, email: auth.email, correlationId: request.correlationId },
      });
      return reply.send({ change });
    },
  );

  return Promise.resolve();
}
