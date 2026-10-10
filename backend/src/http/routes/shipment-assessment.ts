/**
 * Shipment Assessment over HTTP, one register function per audience:
 *
 *   /audit/shipment-assessments...   the Audit Team decides (Audit Console)
 *   /admin/shipment-assessments...   the admin panel reads, never writes
 *   /seller/shipment-assessments...  the seller contributes and reads its own
 *   /logistics/shipment-assessments... the carrier holding L2: release state and loading checks
 *   /orders/:id/shipment-assessments the buyer: released documents of its own order
 *
 * Every write names its permission; every read is scoped in the service.
 * The L2 gate itself is not here: it sits inside the leg and consignment
 * transitions, so no route - old, new or bulk - can step round it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditPermission } from '../../domain/audit-console-permissions.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { BADGE_TIERS } from '../../domain/shipment-assessment.js';
import { prisma } from '../../infra/prisma.js';
import {
  badgeHistory,
  decideWaiver,
  holdShipment,
  listAssessments,
  openWaiverReview,
  publishPolicy,
  qaDecide,
  readAssessment,
  readEvidence,
  readPolicy,
  recordChecks,
  recordQuantities,
  requireReassessment,
  resolveException,
  sellerDocuments,
  sellerUpdate,
  setBadge,
  startRound,
  submitRound,
  uploadEvidence,
  waiverHistory,
  type AuditActor,
} from '../../modules/shipment-assessment/assessment.service.js';
import { issueSellerCertificate, readDocumentPdf, revokeDocument } from '../../modules/shipment-assessment/documents.service.js';
import { currentAudit, requireAudit, requireAuditAny } from '../plugins/audit.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentLogistics, requireLogistics } from '../plugins/logistics.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });
const docParam = z.object({ id: z.string().length(26), documentId: z.string().length(26) });
const evidenceParam = z.object({ id: z.string().length(26), evidenceId: z.string().length(26) });
const WRITE_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };

const listQuery = z.object({
  queue: z.string().trim().max(24).optional(),
  search: z.string().trim().max(80).optional(),
  rollout: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const checkBody = z.object({
  checks: z
    .array(
      z.object({
        itemCode: z.string().trim().min(1).max(48),
        outcome: z.enum(['PASS', 'FAIL', 'HOLD', 'NOT_APPLICABLE']),
        note: z.string().trim().max(2000).nullable().optional(),
        measuredValue: z.string().trim().max(255).nullable().optional(),
        sampled: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
});

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

function sendFile(reply: FastifyReply, file: { fileName: string; bytes: Buffer; contentType?: string }) {
  return noStore(reply)
    .header('content-type', file.contentType ?? 'application/pdf')
    .header('content-disposition', `attachment; filename="${file.fileName.replace(/["\r\n]/g, '')}"`)
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

function auditActor(request: FastifyRequest): AuditActor {
  const member = currentAudit(request);
  return { userId: member.userId, fullName: member.fullName, role: member.role };
}

async function readUpload(request: FastifyRequest) {
  const file = await request.file();
  if (file === undefined) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach a file.', [{ field: 'file', code: 'REQUIRED' }]);
  const field = (name: string): string | null => {
    const raw = file.fields[name];
    return typeof raw === 'object' && raw !== null && 'value' in raw ? String((raw as { value: unknown }).value).trim() || null : null;
  };
  return { fileName: file.filename, bytes: await file.toBuffer(), itemCode: field('itemCode'), note: field('note') };
}

const deadlineFields = {
  dispatchDeadline: z.string().datetime().nullable().optional(),
  deadlineJustification: z.string().trim().max(1000).nullable().optional(),
};

// --- Audit Console --------------------------------------------------------------------

export function registerAuditShipmentAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // The Shipment Assessment queues: one per status group, a count for each, search by assessment, order, seller order or seller.
  app.get('/shipment-assessments', { preHandler: requireAudit(AuditPermission.SHIPMENT_READ) }, async (request, reply) => {
    const q = listQuery.parse(request.query);
    return noStore(reply).send(await listAssessments({ queue: q.queue ?? null, search: q.search ?? null, rollout: q.rollout === 'true', page: q.page, pageSize: q.pageSize }));
  });

  // The badge policy in force and its earlier versions.
  app.get('/shipment-assessments/policy', { preHandler: requireAudit(AuditPermission.SHIPMENT_READ) }, async (_request, reply) => noStore(reply).send(await readPolicy()));

  // Publish a new badge-policy version. Supervisors only; decisions keep the version they were made under.
  app.post('/shipment-assessments/policy', { preHandler: requireAudit(AuditPermission.SHIPMENT_POLICY), config: WRITE_LIMIT }, async (request, reply) => {
    const rule = z.enum(['WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED']);
    const body = z
      .object({
        platinumRule: rule,
        goldRule: rule,
        silverRule: rule,
        bronzeRule: rule,
        unbadgedRule: rule,
        defaultDispatchDays: z.number().int().nullable(),
        maxDispatchDays: z.number().int().nullable(),
        sellerCertificateMonths: z.number().int(),
        note: z.string().trim().min(10).max(4000),
      })
      .parse(request.body);
    return reply.status(201).send(await publishPolicy(auditActor(request), body));
  });

  // One case in full: overview, checklist rounds, evidence, findings, history, waivers, releases, exceptions and documents.
  app.get('/shipment-assessments/:id', { preHandler: requireAudit(AuditPermission.SHIPMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ assessment: await readAssessment(id, 'AUDIT') });
  });

  // The seller history a waiver reviewer must look at: recent inspection results, earlier assessments, unresolved complaints. No score is computed.
  app.get('/shipment-assessments/:id/waiver-history', { preHandler: requireAudit(AuditPermission.SHIPMENT_WAIVE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = await prisma.shipmentAssessment.findUnique({ where: { id }, select: { sellerAccountId: true } });
    if (row === null) throw notFound('Shipment assessment');
    return noStore(reply).send(await waiverHistory(prisma, row.sellerAccountId, id));
  });

  // Start a physical assessment round. Needs L1 handed over; a reassessment starts a new round and keeps the old one.
  app.post('/shipment-assessments/:id/rounds', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().min(0) }).parse(request.body);
    await startRound(auditActor(request), id, body.expectedVersion);
    return reply.status(204).send();
  });

  // Record checklist results: Pass, Fail, Hold / not verified, or N/A with a reason. Each item stands on its own.
  app.post('/shipment-assessments/:id/checks', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = checkBody.parse(request.body);
    await recordChecks({ userId: currentAudit(request).userId, role: 'AUDIT' }, id, body.checks);
    return reply.status(204).send();
  });

  // Record the round's quantities: ordered, declared, presented, counted, sampled, approved, packages, weights and methods.
  app.put('/shipment-assessments/:id/quantities', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const int = z.number().int().min(0).max(1_000_000_000).nullable().optional();
    const text = (max: number) => z.string().trim().max(max).nullable().optional();
    const body = z
      .object({
        declaredQuantity: int,
        presentedQuantity: int,
        countedQuantity: int,
        sampledQuantity: int,
        approvedQuantity: int,
        unitsPerPackage: int,
        packagesDeclared: int,
        packagesCounted: int,
        sellingUnit: text(32),
        countingMethod: text(255),
        samplingMethod: text(255),
        sampleCoverageNote: text(1000),
        inspectionLocation: text(255),
        grossWeightDeclaredGrams: z.string().regex(/^\d{1,15}$/).nullable().optional(),
        grossWeightMeasuredGrams: z.string().regex(/^\d{1,15}$/).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    await recordQuantities(auditActor(request), id, body);
    return reply.status(204).send();
  });

  // Attach a photo or PDF to the assessment, optionally against one checklist item. Stored privately.
  app.post('/shipment-assessments/:id/evidence', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const upload = await readUpload(request);
    return reply.status(201).send(await uploadEvidence({ userId: currentAudit(request).userId, role: 'AUDIT' }, id, upload));
  });

  // Download one evidence file of a case.
  app.get('/shipment-assessments/:id/evidence/:evidenceId', { preHandler: requireAudit(AuditPermission.SHIPMENT_READ) }, async (request, reply) => {
    const { id, evidenceId } = evidenceParam.parse(request.params);
    return sendFile(reply, await readEvidence({ id: evidenceId, assessmentIds: [id] }));
  });

  // Submit the round. Missing results, evidence or N/A reasons refuse it; any Fail or Hold blocks the whole shipment and issues a findings report.
  app.post('/shipment-assessments/:id/submit', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ findingsSummary: z.string().trim().min(3).max(10000), expectedVersion: z.number().int().min(0) }).parse(request.body);
    await submitRound(auditActor(request), id, body);
    return reply.status(204).send();
  });

  // QA: a second person approves (release + Shipment Assessment Certificate, with a dispatch deadline) or returns the round.
  app.post('/shipment-assessments/:id/qa', { preHandler: requireAudit(AuditPermission.SHIPMENT_QA), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ decision: z.enum(['APPROVED', 'RETURNED']), note: z.string().trim().max(4000).nullable().optional(), expectedVersion: z.number().int().min(0), ...deadlineFields })
      .parse(request.body);
    await qaDecide(auditActor(request), id, { decision: body.decision, note: body.note ?? null, dispatchDeadline: body.dispatchDeadline ?? null, deadlineJustification: body.deadlineJustification ?? null, expectedVersion: body.expectedVersion });
    return reply.status(204).send();
  });

  // Move an eligible shipment into waiver review (for example after a badge upgrade). It does not waive anything.
  app.post('/shipment-assessments/:id/waiver-review', { preHandler: requireAudit(AuditPermission.SHIPMENT_WAIVE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().min(0) }).parse(request.body);
    await openWaiverReview(auditActor(request), id, body.expectedVersion);
    return reply.status(204).send();
  });

  // Approve or reject a badge-based waiver. Gold needs a written review of the history shown; mandatory inspections can never be waived.
  app.post('/shipment-assessments/:id/waiver', { preHandler: requireAudit(AuditPermission.SHIPMENT_WAIVE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED']),
        reason: z.string().trim().min(10).max(4000),
        historyReviewNote: z.string().trim().max(8000).nullable().optional(),
        evidenceRefs: z.array(z.string().trim().max(120)).max(50).default([]),
        expectedVersion: z.number().int().min(0),
        ...deadlineFields,
      })
      .parse(request.body);
    await decideWaiver(auditActor(request), id, {
      decision: body.decision,
      reason: body.reason,
      historyReviewNote: body.historyReviewNote ?? null,
      evidenceRefs: body.evidenceRefs,
      dispatchDeadline: body.dispatchDeadline ?? null,
      deadlineJustification: body.deadlineJustification ?? null,
      expectedVersion: body.expectedVersion,
    });
    return reply.status(204).send();
  });

  // Put the whole shipment on hold. Any unused release is withdrawn.
  app.post('/shipment-assessments/:id/hold', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(5).max(1000), expectedVersion: z.number().int().min(0) }).parse(request.body);
    await holdShipment(auditActor(request), id, body.reason, body.expectedVersion);
    return reply.status(204).send();
  });

  // Require corrective action and a new assessment round. Earlier rounds and reports are kept unchanged.
  app.post('/shipment-assessments/:id/reassessment', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(5).max(4000), expectedVersion: z.number().int().min(0) }).parse(request.body);
    await requireReassessment(auditActor(request), id, body.reason, body.expectedVersion);
    return reply.status(204).send();
  });

  // Record what was done about a carrier-reported departure during a hold. The departure itself stays on record.
  app.post('/shipment-assessments/exceptions/:id/resolve', { preHandler: requireAudit(AuditPermission.SHIPMENT_ASSESS), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ note: z.string().trim().min(5).max(4000) }).parse(request.body);
    await resolveException(auditActor(request), id, body.note);
    return reply.status(204).send();
  });

  // Download a certificate, waiver or findings report PDF of a case.
  app.get('/shipment-assessments/:id/documents/:documentId', { preHandler: requireAudit(AuditPermission.SHIPMENT_READ) }, async (request, reply) => {
    const { id, documentId } = docParam.parse(request.params);
    return sendFile(reply, await readDocumentPdf(prisma, { id: documentId, assessmentIdIn: [id] }));
  });

  // Revoke an issued document with a reason. A revoked release document withdraws its unused release.
  app.post('/audit-documents/:id/revoke', { preHandler: requireAudit(AuditPermission.CERTIFICATE_ISSUE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(5).max(1000) }).parse(request.body);
    const actor = auditActor(request);
    await revokeDocument({ userId: actor.userId, name: actor.fullName, role: actor.role }, id, body.reason);
    return reply.status(204).send();
  });

  // A seller's Audit badge and its history.
  app.get('/sellers/:id/badge', { preHandler: requireAuditAny(AuditPermission.SELLER_READ, AuditPermission.SHIPMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send(await badgeHistory(id));
  });

  // Set or clear a seller's Audit badge, with a reason. A downgrade withdraws unused waivers; an upgrade creates none.
  app.put('/sellers/:id/badge', { preHandler: requireAudit(AuditPermission.SELLER_BADGE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ tier: z.enum(BADGE_TIERS).nullable(), reason: z.string().trim().min(10).max(2000), expectedVersion: z.number().int().min(0) }).parse(request.body);
    await setBadge(auditActor(request), id, body.tier, body.reason, body.expectedVersion);
    return reply.status(204).send();
  });

  // A seller's verification certificates, newest first, with status.
  app.get('/seller-verification/:id/certificates', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ certificates: await sellerDocuments(id) });
  });

  // Issue a Seller Verification Certificate (a new version if one exists) after final approval, with an explicit scope.
  app.post('/seller-verification/:id/certificates', { preHandler: requireAudit(AuditPermission.CERTIFICATE_ISSUE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        categories: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
        markets: z.array(z.string().trim().min(2).max(60)).min(1).max(60),
        scopeNote: z.string().trim().min(10).max(2000),
        siteLocationId: z.string().length(26).nullable().optional(),
      })
      .parse(request.body);
    const actor = auditActor(request);
    return reply.status(201).send(await issueSellerCertificate({ userId: actor.userId, name: actor.fullName, role: actor.role }, id, { ...body, siteLocationId: body.siteLocationId ?? null }));
  });

  // Download a seller verification certificate PDF.
  app.get('/seller-verification/:id/certificates/:documentId', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const { id, documentId } = docParam.parse(request.params);
    return sendFile(reply, await readDocumentPdf(prisma, { id: documentId, sellerAccountId: id, kinds: ['SELLER_VERIFICATION_CERTIFICATE'] }));
  });

  return Promise.resolve();
}

// --- Admin panel: read only -----------------------------------------------------------

export function registerAdminShipmentAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // Shipment Assessment queues, read-only. Decisions are made in the Audit Console.
  app.get('/shipment-assessments', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const q = listQuery.parse(request.query);
    return noStore(reply).send(await listAssessments({ queue: q.queue ?? null, search: q.search ?? null, rollout: q.rollout === 'true', page: q.page, pageSize: q.pageSize }));
  });

  // The badge policy, read-only.
  app.get('/shipment-assessments/policy', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (_request, reply) => noStore(reply).send(await readPolicy()));

  // One case in full, read-only.
  app.get('/shipment-assessments/:id', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ assessment: await readAssessment(id, 'ADMIN') });
  });

  // Download a case's evidence file, read-only.
  app.get('/shipment-assessments/:id/evidence/:evidenceId', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id, evidenceId } = evidenceParam.parse(request.params);
    return sendFile(reply, await readEvidence({ id: evidenceId, assessmentIds: [id] }));
  });

  // Download a case's certificate, waiver or report, read-only.
  app.get('/shipment-assessments/:id/documents/:documentId', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id, documentId } = docParam.parse(request.params);
    return sendFile(reply, await readDocumentPdf(prisma, { id: documentId, assessmentIdIn: [id] }));
  });

  // A seller's Audit badge, history and verification certificates, read-only.
  app.get('/sellers/:id/audit-badge', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ ...(await badgeHistory(id)), certificates: await sellerDocuments(id) });
  });

  return Promise.resolve();
}

// --- Seller Hub --------------------------------------------------------------------------

export function registerSellerShipmentAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // This seller's shipment assessments, by queue.
  app.get('/shipment-assessments', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const q = listQuery.parse(request.query);
    return noStore(reply).send(await listAssessments({ queue: q.queue ?? null, search: q.search ?? null, rollout: false, sellerAccountId: currentSeller(request).sellerAccountId, page: q.page, pageSize: q.pageSize }));
  });

  // The assessment of one of this seller's orders, if it has one yet.
  app.get('/orders/:id/shipment-assessment', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const sellerAccountId = currentSeller(request).sellerAccountId;
    const row = await prisma.shipmentAssessment.findFirst({ where: { sellerOrderGroupId: id, sellerAccountId }, select: { id: true } });
    return noStore(reply).send({ assessment: row === null ? null : await readAssessment(row.id, 'SELLER', { sellerAccountId }) });
  });

  // One of this seller's assessments: findings, checks, quantities and documents. Read-only for findings.
  app.get('/shipment-assessments/:id', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ assessment: await readAssessment(id, 'SELLER', { sellerAccountId: currentSeller(request).sellerAccountId }) });
  });

  // Submit readiness information, or answer a corrective action. Cannot change a finding or a decision.
  app.post('/shipment-assessments/:id/response', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ readinessNote: z.string().trim().min(3).max(10000).optional(), correctiveResponse: z.string().trim().min(3).max(10000).optional() }).refine((value) => value.readinessNote !== undefined || value.correctiveResponse !== undefined).parse(request.body);
    await sellerUpdate(currentSeller(request).sellerAccountId, currentUser(request).id, id, body);
    return reply.status(204).send();
  });

  // Upload a packing photo, document or other evidence for the Audit Team.
  app.post('/shipment-assessments/:id/evidence', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const own = await prisma.shipmentAssessment.findFirst({ where: { id, sellerAccountId: currentSeller(request).sellerAccountId }, select: { id: true } });
    if (own === null) throw notFound('Shipment assessment');
    const upload = await readUpload(request);
    return reply.status(201).send(await uploadEvidence({ userId: currentUser(request).id, role: 'SELLER' }, id, upload));
  });

  // Download a certificate, waiver or findings report of this seller's shipment.
  app.get('/shipment-assessments/:id/documents/:documentId', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id, documentId } = docParam.parse(request.params);
    const sellerAccountId = currentSeller(request).sellerAccountId;
    return sendFile(reply, await readDocumentPdf(prisma, { id: documentId, sellerAccountId, assessmentIdIn: [id] }));
  });

  // This seller's verification certificates.
  app.get('/audit-certificates', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => noStore(reply).send({ certificates: await sellerDocuments(currentSeller(request).sellerAccountId) }));

  // Download one of this seller's verification certificates.
  app.get('/audit-certificates/:id', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return sendFile(reply, await readDocumentPdf(prisma, { id, sellerAccountId: currentSeller(request).sellerAccountId, kinds: ['SELLER_VERIFICATION_CERTIFICATE'] }));
  });

  return Promise.resolve();
}

// --- Carrier portal ------------------------------------------------------------------------

export function registerLogisticsShipmentAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // Release or hold state, handling needs and the final loading checks for an L2 leg this carrier holds. It cannot lift a hold.
  app.get('/legs/:id/shipment-assessment', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const partnerId = currentLogistics(request).logisticsPartnerId;
    const row = await prisma.shipmentAssessment.findFirst({ where: { l2LegId: id }, select: { id: true } });
    if (row === null) return noStore(reply).send({ assessment: null });
    return noStore(reply).send({ assessment: await readAssessment(row.id, 'LOGISTICS', { partnerId }) });
  });

  // Record the final loading checks (vehicle, securing, count, seals, documents) after release.
  app.post('/legs/:id/shipment-assessment/checks', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const partnerId = currentLogistics(request).logisticsPartnerId;
    const leg = await prisma.shipmentLeg.findFirst({ where: { id, logisticsPartnerId: partnerId, level: 'L2' }, select: { id: true } });
    const row = leg === null ? null : await prisma.shipmentAssessment.findFirst({ where: { l2LegId: leg.id }, select: { id: true } });
    if (row === null) throw notFound('Shipment assessment');
    const body = checkBody.parse(request.body);
    await recordChecks({ userId: currentUser(request).id, role: 'LOGISTICS' }, row.id, body.checks);
    return reply.status(204).send();
  });

  // Attach loading evidence (photos of the container, seals, documents).
  app.post('/legs/:id/shipment-assessment/evidence', { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE), config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const partnerId = currentLogistics(request).logisticsPartnerId;
    const leg = await prisma.shipmentLeg.findFirst({ where: { id, logisticsPartnerId: partnerId, level: 'L2' }, select: { id: true } });
    const row = leg === null ? null : await prisma.shipmentAssessment.findFirst({ where: { l2LegId: leg.id }, select: { id: true } });
    if (row === null) throw notFound('Shipment assessment');
    const upload = await readUpload(request);
    return reply.status(201).send(await uploadEvidence({ userId: currentUser(request).id, role: 'LOGISTICS' }, row.id, upload));
  });

  return Promise.resolve();
}

// --- Buyer -----------------------------------------------------------------------------------

export function registerBuyerShipmentAssessmentRoutes(app: FastifyInstance): Promise<void> {
  async function ownOrder(request: FastifyRequest, orderId: string): Promise<string[]> {
    const order = await prisma.order.findFirst({ where: { id: orderId, customerProfileId: currentUser(request).customerProfileId ?? '' }, select: { id: true } });
    if (order === null) throw notFound('Order');
    return [order.id];
  }

  // The released shipment assessment summaries of one of the buyer's own orders: status, dispatch deadline and released documents only.
  app.get('/orders/:id/shipment-assessments', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const orderIds = await ownOrder(request, id);
    const rows = await prisma.shipmentAssessment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    const items = await Promise.all(rows.map((row) => readAssessment(row.id, 'BUYER', { orderIds })));
    return noStore(reply).send({ items });
  });

  // Download a released certificate or waiver of the buyer's own order. Findings reports are not shared.
  app.get('/orders/:id/shipment-assessments/:documentId', { preHandler: requireCustomer }, async (request, reply) => {
    const { id, documentId } = z.object({ id: z.string().length(26), documentId: z.string().length(26) }).parse(request.params);
    const orderIds = await ownOrder(request, id);
    const rows = await prisma.shipmentAssessment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    return sendFile(reply, await readDocumentPdf(prisma, { id: documentId, assessmentIdIn: rows.map((row) => row.id), kinds: ['SHIPMENT_ASSESSMENT_CERTIFICATE', 'SHIPMENT_WAIVER_AUTHORIZATION'] }));
  });

  return Promise.resolve();
}
