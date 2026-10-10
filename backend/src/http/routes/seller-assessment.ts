/**
 * Seller Assessment and Onboarding over HTTP, one register function per audience:
 *
 *   /audit/seller-assessments...   the Audit Team assesses, decides and releases
 *   /admin/seller-assessments...   the Admin Panel reads - there is no write here
 *   /seller/assessment...          the seller applies, answers findings, appeals
 *
 * A route proves who is calling; the capability for the exact step, the
 * assignment, independence and every precondition are checked in the
 * services. The purchase gate itself is not here - it sits inside cart,
 * checkout, preorder, RFQ, capture and dispatch.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditPermission } from '../../domain/audit-console-permissions.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { CHANGE_KINDS, DIMENSIONS, HARD_STOPS, WORKPAPER_KINDS, type DimensionCode, type GateNumber } from '../../domain/seller-assessment.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import { acceptFile, requestCorrection, saveApplication, sellerAssessment, startApplication, submitApplication, uploadSellerEvidence } from '../../modules/seller-assessment/application.service.js';
import { ADMIN_WITHHELD_CATEGORIES, EVIDENCE_CATEGORIES, readEvidenceBytes, type AssessmentActor, type SellerActor } from '../../modules/seller-assessment/context.js';
import {
  activationImpact,
  adoptPolicy,
  auditRegisters,
  completeTask,
  decideAppeal,
  decideBankChange,
  decideChange,
  decideDisposition,
  disclosePolicy,
  draftPolicy,
  listDispositions,
  listPolicies,
  listStaffCapabilities,
  listTasks,
  recordUndisclosedChange,
  reportIncident,
  requestBankChange,
  retentionReport,
  reviewIncident,
  sellerOverview,
  setCapabilities,
  setLegalHold,
  startLegacyReassessments,
  submitAppeal,
  submitChange,
  suspend,
} from '../../modules/seller-assessment/lifecycle.service.js';
import { decide, evidenceRow, listAssessments, readAssessment, release, releaseGaps } from '../../modules/seller-assessment/release.service.js';
import {
  appointCertificationBody,
  approveNotApplicable,
  assign,
  certSchema,
  classificationSchema,
  classifyScope,
  closeFinding,
  decideGate,
  raiseFinding,
  rateDimension,
  recordCertificate,
  recordHardStop,
  recordWorkpaper,
  respondToFinding,
  reviewChecklistItem,
  uploadAuditEvidence,
  withdrawCertificate,
} from '../../modules/seller-assessment/review.service.js';
import { readDocumentPdf } from '../../modules/shipment-assessment/documents.service.js';
import { prisma } from '../../infra/prisma.js';
import { currentAudit, requireAudit } from '../plugins/audit.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const id26 = z.string().length(26);
const idParam = z.object({ id: id26 });
const WRITE = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const reason = z.string().trim().min(5).max(8000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

function actor(request: FastifyRequest): AssessmentActor {
  const m = currentAudit(request);
  return { userId: m.userId, fullName: m.fullName, role: m.role, capabilities: m.capabilities };
}

function seller(request: FastifyRequest): SellerActor {
  const m = currentSeller(request);
  return { sellerAccountId: m.sellerAccountId, profileId: m.customerProfileId };
}

async function readUpload(request: FastifyRequest) {
  const file = await request.file();
  if (file === undefined) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach a file.', [{ field: 'file', code: 'REQUIRED' }]);
  const field = (name: string): string => {
    const raw = file.fields[name];
    return typeof raw === 'object' && raw !== null && 'value' in raw ? String((raw as { value: unknown }).value).trim() : '';
  };
  const meta = z.object({ category: z.enum(EVIDENCE_CATEGORIES), evidenceKey: z.string().min(1).max(64), label: z.string().min(1).max(255) }).parse({ category: field('category'), evidenceKey: field('evidenceKey'), label: field('label') || file.filename });
  return { ...meta, fileName: file.filename, bytes: await file.toBuffer() };
}

const listQuery = z.object({
  queue: z.string().trim().max(24).optional(),
  search: z.string().trim().max(80).optional(),
  owner: id26.optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  expiringDays: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function listArgs(request: FastifyRequest) {
  const q = listQuery.parse(request.query);
  return { queue: q.queue ?? null, search: q.search ?? null, ownerUserId: q.owner ?? null, risk: q.risk ?? null, overdue: q.overdue === 'true', expiringDays: q.expiringDays ?? null, page: q.page, pageSize: q.pageSize };
}

const policyConfig = z.object({
  turnoverMinimumMinor: z.string().regex(/^\d{1,18}$/),
  turnoverCurrency: z.string().length(3),
  releaseScoreMinimum: z.number().int(),
  remediationScoreMinimum: z.number().int(),
  dimensionRatingMinimum: z.number().int(),
  adminReviewTargetBusinessDays: z.number().int(),
  majorPlanDays: z.number().int(),
  majorClosureDays: z.number().int(),
  minorClosureDays: z.number().int(),
  approvalValidityMonths: z.number().int(),
  reminderDaysBeforeExpiry: z.array(z.number().int()),
  appealWindowCalendarDays: z.number().int(),
  appealTargetBusinessDays: z.number().int(),
  incidentReportHours: z.number().int(),
  retentionYearsDefault: z.number().int(),
  surveillanceMonthsByCategory: z.record(z.string(), z.number().int()),
  sanctionsRescreenDays: z.number().int(),
});

// --- Audit Console ------------------------------------------------------------

export function registerAuditSellerAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // The seller assessment queue: search, owner, stage, risk, overdue and expiry filters, with a count per status.
  app.get('/seller-assessments', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => noStore(reply).send(await listAssessments(listArgs(request))));

  // Policy versions, the version in force, and the purchase-gate mode.
  app.get('/seller-assessments/policies', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (_request, reply) => noStore(reply).send(await listPolicies()));

  // Draft a new policy version. Head of Seller Assurance; a version can only tighten the document's controls.
  app.post('/seller-assessments/policies', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const body = z.object({ version: z.string().trim().regex(/^\d{1,3}\.\d{1,3}$/), config: policyConfig, note: reason }).parse(request.body);
    return reply.status(201).send(await draftPolicy(actor(request), body));
  });

  // Record adoption of a draft version: the authority's reference and the effective date. Never by its drafter.
  app.post('/seller-assessments/policies/:id/adopt', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ adoptionReference: z.string().trim().min(3).max(255), effectiveFrom: z.string().datetime(), disclosureReference: z.string().trim().max(255).nullable(), disclosedAt: z.string().datetime().nullable() }).parse(request.body);
    await adoptPolicy(actor(request), id, body);
    return reply.status(204).send();
  });

  // Record disclosure of an adopted version. Until disclosed, it is not in force.
  app.post('/seller-assessments/policies/:id/disclose', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await disclosePolicy(actor(request), id, z.object({ disclosureReference: z.string().trim().min(3).max(255), disclosedAt: z.string().datetime() }).parse(request.body));
    return reply.status(204).send();
  });

  // Who holds which assessment capability.
  app.get('/seller-assessments/capabilities', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (_request, reply) => noStore(reply).send({ staff: await listStaffCapabilities() }));

  // Grant or remove assessment capabilities for another staff member. Head of Seller Assurance only.
  app.put('/seller-assessments/capabilities/:id', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ capabilities: z.array(z.string()).max(8) }).parse(request.body);
    await setCapabilities(actor(request), id, body.capabilities as never);
    return reply.status(204).send();
  });

  // What switching the purchase gate to enforce would block today, per seller.
  app.get('/seller-assessments/impact', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (_request, reply) => noStore(reply).send(await activationImpact()));

  // Open a legacy reassessment for every seller approved under the earlier process. Nothing is converted into an approval.
  app.post('/seller-assessments/legacy-reassessments', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => reply.send(await startLegacyReassessments(actor(request))));

  // Notices, appeals, change requests, incidents and bank changes across every seller.
  app.get('/seller-assessments/registers', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (_request, reply) => noStore(reply).send(await auditRegisters()));

  // Surveillance and revalidation tasks, open and overdue by default.
  app.get('/seller-assessments/tasks', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => {
    const q = z.object({ status: z.enum(['OPEN', 'OVERDUE', 'DONE']).optional(), seller: id26.optional() }).parse(request.query);
    return noStore(reply).send({ tasks: await listTasks({ status: q.status ?? null, sellerAccountId: q.seller ?? null }) });
  });

  // Complete a surveillance task with its outcome. A sanctions task is never completed by the software.
  app.post('/seller-assessments/tasks/:id/complete', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await completeTask(actor(request), id, z.object({ outcome: z.enum(['SATISFACTORY', 'ISSUE_FOUND']), note: reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Placed seller orders held for a safety and legal disposition.
  app.get('/seller-assessments/dispositions', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => {
    const q = z.object({ status: z.string().max(24).optional() }).parse(request.query);
    return noStore(reply).send({ dispositions: await listDispositions(q.status ?? null) });
  });

  // Record a disposition for a held seller order: release, keep holding, recommend cancellation, or recall.
  app.post('/seller-assessments/dispositions/:id', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await decideDisposition(actor(request), id, z.object({ status: z.enum(['HOLD', 'RELEASE_APPROVED', 'CANCEL_RECOMMENDED', 'RECALL']), note: reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Evidence categories, files and legal holds, with the configured retention years per category.
  app.get('/seller-assessments/retention', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (_request, reply) => noStore(reply).send({ categories: await retentionReport() }));

  // Place or lift a legal hold on one evidence file.
  app.post('/seller-assessments/evidence/:id/legal-hold', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await setLegalHold(actor(request), id, z.object({ hold: z.boolean(), reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Decide an appeal. The reviewer must be uninvolved in the original decision; an appeal never restores selling.
  app.post('/seller-assessments/appeals/:id/decision', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await decideAppeal(actor(request), id, z.object({ status: z.enum(['UPHELD', 'OVERTURNED', 'PARTIALLY_UPHELD']), outcomeReason: reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Decide a seller's change request. A new product or country needs an extension assessment.
  app.post('/seller-assessments/changes/:id/decision', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await decideChange(actor(request), id, z.object({ status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_REASSESSMENT']), reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Record a change the seller did not disclose.
  app.post('/seller-assessments/sellers/:id/undisclosed-changes', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(201).send(await recordUndisclosedChange(actor(request), id, z.object({ kind: z.enum(CHANGE_KINDS), description: reason }).parse(request.body)));
  });

  // Review an incident report.
  app.post('/seller-assessments/incidents/:id/review', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await reviewIncident(actor(request), id, z.object({ status: z.enum(['UNDER_REVIEW', 'CLOSED']), note: reason }).parse(request.body));
    return reply.status(204).send();
  });

  // One step of a bank-beneficiary change: confirm with the known contact, then two different Finance approvals.
  app.post('/seller-assessments/bank-changes/:id', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ step: z.enum(['CONFIRM_CONTACT', 'APPROVE', 'REJECT']), knownContactName: z.string().trim().max(160).optional(), knownContactSource: z.string().trim().max(255).optional(), reason, expectedVersion: z.number().int().min(0) }).parse(request.body);
    await decideBankChange(actor(request), id, body);
    return reply.status(204).send();
  });

  // Suspend, restrict or revoke a trading approval (all or named scope rows) with a full notice. Held orders get a disposition.
  app.post('/seller-assessments/approvals/:id/suspend', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        kind: z.enum(['SUSPENSION', 'RESTRICTION', 'REVOCATION']),
        hardStop: z.enum(HARD_STOPS).nullable(),
        scopeIds: z.array(id26).max(500).nullable(),
        reason,
        shareableEvidence: reason,
        settlementTreatment: reason,
        correctiveActions: reason,
        reviewRoute: reason,
        riskContainmentNote: z.string().trim().max(4000).nullable(),
      })
      .parse(request.body);
    return reply.status(201).send(await suspend(actor(request), id, body));
  });

  // One assessment in full: application, gates, checklist, score, scope matrix, findings, workpapers, certification, approvals and timeline.
  app.get('/seller-assessments/:id', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ assessment: await readAssessment(id, 'AUDIT') });
  });

  // Everything that still blocks release, listed together.
  app.get('/seller-assessments/:id/release-gaps', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      const { gaps, score } = await releaseGaps(prisma, id, null);
      return noStore(reply).send({ gaps, score: score.display, band: score.band, policyAdopted: true });
    } catch (error) {
      if ((error as { code?: string }).code === ErrorCode.SELLER_ASSESSMENT_POLICY_NOT_ADOPTED) return noStore(reply).send({ gaps: ['POLICY_NOT_ADOPTED'], score: null, band: null, policyAdopted: false });
      throw error;
    }
  });

  // Download one evidence file. Every view is recorded.
  app.get('/seller-assessments/:id/evidence/:evidenceId', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => {
    const p = z.object({ id: id26, evidenceId: id26 }).parse(request.params);
    const row = await evidenceRow(p.evidenceId, { assessmentId: p.id });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_EVIDENCE_VIEWED, resourceType: 'SellerAssessmentEvidence', resourceId: row.id, actorType: 'AUDIT', actorUserId: currentAudit(request).userId, after: { assessmentId: p.id, category: row.category, version: row.evidenceVersion } });
    return sendFile(reply, await readEvidenceBytes(row));
  });

  // Attach a reviewer's evidence file (site photos, lab report, issuer confirmation). Stored privately, scanned, versioned.
  app.post('/seller-assessments/:id/evidence', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(201).send(await uploadAuditEvidence(actor(request), id, await readUpload(request)));
  });

  // Name the assessment owner, the risk level and a reviewer per gate. Head of Seller Assurance.
  app.post('/seller-assessments/:id/assign', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ ownerUserId: id26.nullable().optional(), riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(), gates: z.array(z.object({ gate: z.number().int().min(1).max(8), userId: id26.nullable() })).max(8).optional() }).parse(request.body);
    await assign(actor(request), id, body as never);
    return reply.status(204).send();
  });

  // Return the application to the seller with corrections to make. Gate 1.
  app.post('/seller-assessments/:id/correction', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await requestCorrection(actor(request), id, z.object({ note: reason, expectedVersion: z.number().int().min(0).optional() }).parse(request.body));
    return reply.status(204).send();
  });

  // Accept the complete file: Gate 1 passes, the review target starts, the scope matrix is laid out.
  app.post('/seller-assessments/:id/accept-file', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await acceptFile(actor(request), id, z.object({ reason, expectedVersion: z.number().int().min(0).optional() }).parse(request.body));
    return reply.status(204).send();
  });

  // Decide gate 2-7: passed, failed, in progress or correction requested. Prerequisites and the gate's own evidence are checked.
  app.post('/seller-assessments/:id/gates/:gate', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const p = z.object({ id: id26, gate: z.coerce.number().int().min(1).max(8) }).parse(request.params);
    await decideGate(actor(request), p.id, p.gate as GateNumber, z.object({ status: z.enum(['IN_PROGRESS', 'CORRECTION_REQUESTED', 'PASSED', 'FAILED']), reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Review one applicant checklist item: Pass, Fail, or Not applicable with a reason; evidence, expiry and comment.
  app.put('/seller-assessments/:id/checklist/:code', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const p = z.object({ id: id26, code: z.string().regex(/^C\d{2}$/) }).parse(request.params);
    const body = z.object({ outcome: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']), evidenceRef: z.string().trim().min(1).max(255), comment: z.string().trim().max(4000).nullable(), expiresOn: day.nullable(), naReason: z.string().trim().max(4000).nullable() }).parse(request.body);
    await reviewChecklistItem(actor(request), p.id, p.code, body);
    return reply.status(204).send();
  });

  // Approve a not-applicable item. A second person with the Head of Seller Assurance capability.
  app.post('/seller-assessments/:id/checklist/:code/approve-na', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const p = z.object({ id: id26, code: z.string().regex(/^C\d{2}$/) }).parse(request.params);
    await approveNotApplicable(actor(request), p.id, p.code, z.object({ note: reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Rate one scoring dimension 0-5 with its evidence and reasoning.
  app.put('/seller-assessments/:id/scores/:dimension', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const p = z.object({ id: id26, dimension: z.enum(DIMENSIONS.map((d) => d.code) as [DimensionCode, ...DimensionCode[]]) }).parse(request.params);
    await rateDimension(actor(request), p.id, p.dimension, z.object({ rating: z.number().int().min(0).max(5), evidenceRef: z.string().trim().min(1).max(255), reasoning: reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Classify one product x site x country x channel combination (Gate 3) and approve or block it.
  app.put('/seller-assessments/:id/scope/:scopeId', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const p = z.object({ id: id26, scopeId: id26 }).parse(request.params);
    await classifyScope(actor(request), p.id, p.scopeId, classificationSchema.parse(request.body));
    return reply.status(204).send();
  });

  // Raise a finding: critical, major or minor, with its requirement and evidence. A critical one records a hard stop.
  app.post('/seller-assessments/:id/findings', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ classification: z.enum(['CRITICAL', 'MAJOR', 'MINOR']), requirement: reason, evidence: reason, ownerName: z.string().trim().max(160).nullable() }).parse(request.body);
    return reply.status(201).send(await raiseFinding(actor(request), id, body));
  });

  // Close (on effectiveness evidence) or reopen a finding. Auditors only.
  app.post('/seller-assessments/findings/:id/close', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await closeFinding(actor(request), id, z.object({ effectivenessVerification: reason, decision: z.enum(['CLOSE', 'REOPEN']), expectedVersion: z.number().int().min(0) }).parse(request.body));
    return reply.status(204).send();
  });

  // Record a workpaper: site audit, sample plan and custody, lab competence, contract, mock order, identity, bank, sanctions, specialist review or AI output.
  app.post('/seller-assessments/:id/workpapers', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ kind: z.enum(WORKPAPER_KINDS), subjectRef: z.string().trim().max(64).nullable(), payload: z.unknown() }).parse(request.body);
    return reply.status(201).send(await recordWorkpaper(actor(request), id, body.kind, body.payload, body.subjectRef));
  });

  // Record a hard stop. It blocks release whatever the score; there is no route that clears one.
  app.post('/seller-assessments/:id/hard-stops', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await recordHardStop(actor(request), id, z.object({ stop: z.enum(HARD_STOPS), reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Appoint the independent certification body the marketplace engages and pays (Gate 5).
  app.post('/seller-assessments/:id/certifications', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(201).send(await appointCertificationBody(actor(request), id, certSchema.parse(request.body)));
  });

  // Record the certificate the body issued and how its authenticity was checked with the issuer.
  app.put('/seller-assessments/certifications/:id', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ certificateNumber: z.string().trim().min(1).max(128), issuer: z.string().trim().min(2).max(255), issuedOn: day, expiresOn: day, authenticityMethod: z.string().trim().max(255), authenticityReference: z.string().trim().max(512), accreditationVerified: z.boolean(), independenceVerified: z.boolean(), status: z.enum(['ISSUED_UNVERIFIED', 'AUTHENTICATED']), expectedVersion: z.number().int().min(0) }).parse(request.body);
    await recordCertificate(actor(request), id, body);
    return reply.status(204).send();
  });

  // Record a withdrawal or suspension by the issuer. The purchase gate stops at once.
  app.post('/seller-assessments/certifications/:id/withdraw', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await withdrawCertificate(actor(request), id, z.object({ status: z.enum(['WITHDRAWN', 'SUSPENDED']), reason }).parse(request.body));
    return reply.status(204).send();
  });

  // Decline, send to remediation, or return to review after remediation.
  app.post('/seller-assessments/:id/decision', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await decide(actor(request), id, z.object({ decision: z.enum(['DECLINED', 'REMEDIATION', 'REASSESS']), reason, expectedVersion: z.number().int().min(0) }).parse(request.body));
    return reply.status(204).send();
  });

  // Gate 8: independent release of exactly the named scope rows. Creates the trading approval and its PDF.
  app.post('/seller-assessments/:id/release', { preHandler: requireAudit(AuditPermission.ASSESSMENT_WORK), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ scopeItemIds: z.array(id26).min(1).max(500), reason, nextReviewAt: z.string().datetime().nullable(), expectedVersion: z.number().int().min(0) }).parse(request.body);
    return reply.status(201).send(await release(actor(request), id, body));
  });

  // The trading approval PDF.
  app.get('/seller-assessments/approvals/:id/pdf', { preHandler: requireAudit(AuditPermission.ASSESSMENT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const approval = await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id }, select: { auditDocumentId: true } });
    if (approval.auditDocumentId === null) throw badRequest(ErrorCode.VALIDATION_FAILED, 'No document.');
    return sendFile(reply, await readDocumentPdf(prisma, { id: approval.auditDocumentId, kinds: ['SELLER_TRADING_APPROVAL'] }));
  });
  return Promise.resolve();
}

// --- Admin Panel: read-only -------------------------------------------------------

export function registerAdminSellerAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // Seller assessments, read-only. Decisions belong to the Audit Console.
  app.get('/seller-assessments', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (request, reply) => noStore(reply).send(await listAssessments(listArgs(request))));

  // One assessment summary, read-only: no internal reviewer notes, no identity or banking file names.
  app.get('/seller-assessments/:id', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return noStore(reply).send({ assessment: await readAssessment(id, 'ADMIN') });
  });

  // Download an evidence file the Admin Panel may see. Identity, ownership and banking evidence stay with Audit.
  app.get('/seller-assessments/:id/evidence/:evidenceId', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (request, reply) => {
    const p = z.object({ id: id26, evidenceId: id26 }).parse(request.params);
    const row = await evidenceRow(p.evidenceId, { assessmentId: p.id, notCategories: [...ADMIN_WITHHELD_CATEGORIES] });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_EVIDENCE_VIEWED, resourceType: 'SellerAssessmentEvidence', resourceId: row.id, actorType: 'ADMIN', actorUserId: currentUser(request).id, after: { assessmentId: p.id, category: row.category } });
    return sendFile(reply, await readEvidenceBytes(row));
  });

  // What switching the purchase gate to enforce would block, read-only.
  app.get('/seller-assessments-impact', { preHandler: requireAdmin(Permission.CUSTOMER_READ) }, async (_request, reply) => noStore(reply).send(await activationImpact()));
  return Promise.resolve();
}

// --- Seller Hub -------------------------------------------------------------------

export function registerSellerAssessmentRoutes(app: FastifyInstance): Promise<void> {
  // The seller's assessments, approvals and scope, notices and appeals, changes, incidents and bank changes.
  app.get('/assessment', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const s = seller(request);
    const latest = await sellerAssessment(s);
    return noStore(reply).send({ overview: await sellerOverview(s), current: latest === null ? null : await readAssessment(latest.id, 'SELLER', s.sellerAccountId) });
  });

  // Start an application, an extension, a renewal or a reassessment. Returns the open one if there is one.
  app.post('/assessment', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: WRITE }, async (request, reply) => {
    const body = z.object({ kind: z.enum(['INITIAL', 'EXTENSION', 'RENEWAL', 'REASSESSMENT']).default('INITIAL') }).parse(request.body ?? {});
    const row = await startApplication(seller(request), body.kind);
    return reply.status(201).send({ id: row.id, number: row.number });
  });

  // Save application sections (save and resume). Only while it is a draft or returned for correction.
  app.patch('/assessment/:id/application', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ patch: z.unknown(), expectedRevision: z.number().int().min(0) }).parse(request.body);
    return reply.send(await saveApplication(seller(request), id, body));
  });

  // Upload an evidence file for the application or a finding. Scanned, stored privately, versioned.
  app.post('/assessment/:id/evidence', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(201).send(await uploadSellerEvidence(seller(request), id, await readUpload(request)));
  });

  // Download a file this seller uploaded.
  app.get('/assessment/:id/evidence/:evidenceId', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const p = z.object({ id: id26, evidenceId: id26 }).parse(request.params);
    const row = await evidenceRow(p.evidenceId, { assessmentId: p.id, sellerAccountId: seller(request).sellerAccountId, uploadedByRole: 'SELLER' });
    return sendFile(reply, await readEvidenceBytes(row));
  });

  // Submit the application. Gaps and ineligibility are listed, never hidden.
  app.post('/assessment/:id/submit', { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await submitApplication(seller(request), id);
    return reply.status(204).send();
  });

  // Answer a finding: containment, root cause, corrective and preventive action, owner and evidence. Only an auditor closes it.
  app.put('/assessment/findings/:id', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const t = z.string().trim().max(8000).nullable();
    const body = z.object({ containment: t, rootCause: t, correctiveAction: t, preventiveAction: t, ownerName: z.string().trim().max(160).nullable(), closureEvidenceIds: z.array(id26).max(30), expectedVersion: z.number().int().min(0) }).parse(request.body);
    await respondToFinding(seller(request), id, body);
    return reply.status(204).send();
  });

  // Appeal a notice within its window.
  app.post('/assessment/notices/:id/appeal', { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT), config: WRITE }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(201).send(await submitAppeal(seller(request), id, z.object({ grounds: reason, evidenceRef: z.string().trim().max(512).nullable() }).parse(request.body)));
  });

  // Notify a change before making it: facility, entity, ownership, brand rights, subcontractor, materials, formulation, design, process, intended use, safety software, labels, country.
  app.post('/assessment/changes', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: WRITE }, async (request, reply) => {
    const body = z.object({ kind: z.enum(CHANGE_KINDS), description: reason, plannedFrom: day.nullable() }).parse(request.body);
    return reply.status(201).send(await submitChange(seller(request), body));
  });

  // Report an incident. The deadline is the policy's hours or a shorter statutory one.
  app.post('/assessment/incidents', { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: WRITE }, async (request, reply) => {
    const body = z.object({ severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), description: reason, affectedProducts: z.string().trim().max(4000).nullable(), awareAt: z.string().datetime(), statutoryDeadlineHours: z.number().int().min(1).max(720).nullable() }).parse(request.body);
    return reply.status(201).send(await reportIncident(seller(request), body));
  });

  // Ask to change the bank beneficiary. Verified by Finance through a known contact and approved by two people.
  app.post('/assessment/bank-changes', { preHandler: requireSeller(SellerPermission.ACCOUNT_SUBMIT), config: WRITE }, async (request, reply) => {
    const body = z.object({ beneficiaryName: z.string().trim().min(2).max(255), accountLast4: z.string().regex(/^\d{4}$/), bankCode: z.string().trim().min(4).max(16), evidenceRef: z.string().trim().max(512).nullable() }).parse(request.body);
    return reply.status(201).send(await requestBankChange(seller(request), body));
  });

  // The seller's own trading approval PDF.
  app.get('/assessment/approvals/:id/pdf', { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const s = seller(request);
    const approval = await prisma.sellerTradingApproval.findFirstOrThrow({ where: { id, sellerAccountId: s.sellerAccountId }, select: { auditDocumentId: true } });
    if (approval.auditDocumentId === null) throw badRequest(ErrorCode.VALIDATION_FAILED, 'No document.');
    return sendFile(reply, await readDocumentPdf(prisma, { id: approval.auditDocumentId, sellerAccountId: s.sellerAccountId, kinds: ['SELLER_TRADING_APPROVAL'] }));
  });
  return Promise.resolve();
}
