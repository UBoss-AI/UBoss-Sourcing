/**
 * Inspection over HTTP (checklist Master rows 23, 41, 45-55, 70, 94, 95).
 *
 * Every rule lives in `modules/inspection`: who may act, the job state
 * machine, conflict checks, the gate and the release. These routes only
 * authenticate the caller, parse the body and hand both to the service, so
 * the same rule can never be enforced in one place and forgotten in another.
 *
 *   /audit/agency/*        agency coordinators, inspectors and QA, signed in to the Audit Console
 *                          (an AUDIT session, its own cookie jar and audience - never a storefront login)
 *   /seller/inspection/*   the seller: readiness, CAPA, evidence
 *   /inspection/buyer/*    the buyer: timeline, report, request an inspection
 *   /admin/inspection/*    the operator: queue, booking, agencies, rules, plans, policy, release, invoices
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  createAgency,
  updateAgencyMember,
  type InspectionMembership,
} from '../../modules/inspection/agency.service.js';
import { readPolicy, type InspectionActor } from '../../modules/inspection/context.js';
import { readEvidenceBytes, type EvidenceViewer } from '../../modules/inspection/evidence.service.js';
import {
  acceptJob,
  assignInspector,
  bookInspection,
  bookInspectionAsBuyer,
  buyerAgencyChoices,
  declareConflict,
  declineJob,
  reclassifyDefect,
  recordCheck,
  recordDefect,
  recordSampling,
  returnReport,
  signReport,
  startJob,
  submitCapa,
  submitReadiness,
  submitReport,
  uploadAgencyEvidence,
  uploadSellerEvidence,
  cancelJob,
} from '../../modules/inspection/job.service.js';
import {
  createPlan,
  createRule,
  listPlans,
  listRules,
  planInputSchema,
  policyUpdateSchema,

  ruleInputSchema,
  setSupplierRisk,
  updatePolicy,
} from '../../modules/inspection/policy.service.js';
import {
  approveConditionalRelease,

  recordBinding,
  rejectConditionalRelease,
  requestConditionalRelease,

} from '../../modules/inspection/release.service.js';
import { decideInvoice, reevaluateRequirement, requestInspectionAsBuyer, submitInvoice } from '../../modules/inspection/requirement.service.js';
import {
  agencyCalendar,
  agencyDashboard,
  agencyJobDetail,
  agencyJobList,
  agencyMaySeeEvidence,
  buyerInspectionViews,
  buyerMaySeeEvidence,
  operatorInspectionView,
  operatorQueue,
  sellerInspectionView,
  sellerMaySeeEvidence,
} from '../../modules/inspection/views.service.js';
import { prisma } from '../../infra/prisma.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentAudit, requireAudit } from '../plugins/audit.js';
import { agencyOf, inviteToConsole, listConsolePeople, moveAgencyMemberToConsole, resendInvitation, memberLabel } from '../../modules/audit-console/membership.service.js';
import { InspectionAgencyPermission } from '../../domain/inspection-permissions.js';
import { forbidden } from '../../domain/errors.js';
import { addCustodyEvent, addLabSample, recordLabResult, recordQuantities } from '../../modules/inspection/measurement.service.js';
import { correctReport, loadReportFor, renderReportPdf, type ReportReader } from '../../modules/inspection/report-document.service.js';
import { decideSubLotRelease } from '../../modules/inspection/sublot.service.js';
import { storeEvidence } from '../../modules/inspection/evidence.service.js';
import { notifyAfterJobAction, notifyJobOffered } from '../../modules/audit-console/job-notifications.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';
import { sendAttachment } from './preorder-chats.js';

const id = z.string().length(26);
const idParam = z.object({ id });
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

const PURPOSES = ['GENERAL', 'CHECKLIST', 'SAMPLING', 'PACKAGING', 'MEASUREMENT', 'DEFECT', 'CAPA', 'RELEASE', 'BINDING', 'RECLASSIFICATION'] as const;

/** One uploaded file plus its fields (purpose, defect, check item, measurement, note, capture time). */
async function readEvidenceUpload(request: FastifyRequest): Promise<{ bytes: Buffer; fileName: string; fields: Record<string, string> }> {
  const file = await request.file({ limits: { fileSize: EVIDENCE_MAX_BYTES + 1, files: 1 } });
  if (file === undefined) throw badRequest(ErrorCode.VALIDATION_FAILED, 'No file was attached.', [{ field: 'file', code: 'REQUIRED' }]);
  const bytes = await file.toBuffer();
  if (file.file.truncated || bytes.length > EVIDENCE_MAX_BYTES) {
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, 'Evidence files can be up to 25 MB.', [{ field: 'file', code: 'FILE_TOO_LARGE' }]);
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(file.fields)) {
    const field = value as { value?: unknown } | undefined;
    if (field !== undefined && typeof field.value === 'string') fields[key] = field.value;
  }
  return { bytes, fileName: file.filename, fields };
}

const evidenceFields = z.object({
  purpose: z.enum(PURPOSES).default('GENERAL'),
  defectId: id.nullable().optional(),
  checkItemCode: optionalText(64),
  measurement: optionalText(255),
  note: optionalText(1000),
  capturedAt: z.coerce.date().nullable().optional(),
  clientUploadId: optionalText(64),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

/** Who is reading a piece of evidence, for the audit log. */
function viewerOf(request: FastifyRequest, party: EvidenceViewer['party']): EvidenceViewer {
  const auth = currentUser(request);
  return { party, userId: auth.id, email: auth.email, ipAddress: request.ip, correlationId: request.correlationId };
}

function sendEvidence(reply: FastifyReply, file: { bytes: Buffer; contentType: string; fileName: string }): FastifyReply {
  return sendAttachment(reply.header('Cache-Control', 'no-store'), { body: file.bytes, contentType: file.contentType, fileName: file.fileName });
}

// ---------------------------------------------------------------------------
// Agency portal
// ---------------------------------------------------------------------------

async function membershipOf(request: FastifyRequest): Promise<InspectionMembership> {
  // The membership the audit guard resolved from the session. An agency
  // route reached by an audit STAFF member is refused here.
  return Promise.resolve(agencyOf(currentAudit(request)));
}

/** Send a report's PDF. */
async function sendReportPdf(reply: FastifyReply, reader: ReportReader, reportId: string): Promise<FastifyReply> {
  const report = await loadReportFor(reader, reportId);
  if (report === null) throw notFound('Inspection report');
  const pdf = await renderReportPdf(report.id, reader.kind === 'BUYER' ? 'BUYER' : 'FULL');
  return sendAttachment(reply.header('Cache-Control', 'no-store'), { body: pdf.bytes, contentType: 'application/pdf', fileName: pdf.fileName });
}

const decimalText = z.string().trim().regex(/^\d{1,15}(?:\.\d{1,3})?$/);
const UNITS = ['PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL', 'KILOGRAM', 'GRAM', 'LITRE', 'MILLILITRE', 'METRE', 'SQUARE_METRE'] as const;

/**
 * The agency's side of an inspection, in the Audit Console.
 *
 * Mounted under /audit/agency. Every route needs an AUDIT session with an
 * active agency membership and a passed second factor (`requireAudit`), and
 * every read is narrowed to the caller's agency - and, for an inspector, to
 * the jobs they are named on - by the services. Agency people used to reach
 * these with a storefront login; that path no longer exists.
 */
export function registerAgencyInspectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAudit(InspectionAgencyPermission.JOB_READ));

  // Who you are in your inspection agency, and what you may do there.
  app.get('/me', async (request, reply) => {
    const m = await membershipOf(request);
    return reply.header('Cache-Control', 'no-store').send({
      membership: { agencyId: m.agencyId, agencyName: m.agencyName, fullName: m.fullName, role: m.role, permissions: [...m.permissions] },
    });
  });

  // Your agency's work: jobs by status, SLA, inspectors, reports and invoices.
  app.get('/dashboard', async (request, reply) => reply.header('Cache-Control', 'no-store').send(await agencyDashboard(await membershipOf(request))));

  // Jobs you may see. An inspector sees only the jobs they are named on.
  app.get('/jobs', async (request, reply) => {
    const { status } = z.object({ status: z.string().max(40).optional() }).parse(request.query);
    return reply.header('Cache-Control', 'no-store').send({ jobs: await agencyJobList(await membershipOf(request), { status: status ?? null }) });
  });

  // Agency capacity and booked jobs by day.
  app.get('/calendar', async (request, reply) => {
    const q = z.object({ from: z.coerce.date().optional(), days: z.coerce.number().int().min(1).max(62).default(14) }).parse(request.query);
    return reply.send(await agencyCalendar(await membershipOf(request), q.from ?? new Date(), q.days));
  });

  // One job: scope, location, schedule, checklist, sampling, defects, evidence and report.
  app.get('/jobs/:id', async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    return reply.header('Cache-Control', 'no-store').send({ job: await agencyJobDetail(await membershipOf(request), jobId) });
  });

  const act = (path: string, run: (m: InspectionMembership, jobId: string, body: unknown, cid: string) => Promise<unknown>): void => {
    app.post(`/jobs/:id/${path}`, async (request, reply) => {
      const { id: jobId } = idParam.parse(request.params);
      const result = await run(await membershipOf(request), jobId, request.body ?? {}, request.correlationId);
      await notifyAfterJobAction(jobId, path);
      return reply.status(200).send(result ?? { ok: true });
    });
  };

  // Accept an assignment, confirming no conflict of interest.
  act('accept', (m, jobId, body, cid) =>
    acceptJob(m, jobId, z.object({ conflictStatement: text(2000), confirmNoConflict: z.literal(true) }).parse(body), cid));
  // Decline an assignment, with a reason.
  act('decline', (m, jobId, body, cid) => declineJob(m, jobId, z.object({ reason: text(1000) }).parse(body).reason, cid));
  // Name the qualified inspector (and an optional backup).
  act('assign', (m, jobId, body, cid) =>
    assignInspector(m, jobId, z.object({ inspectorMemberId: id, backupInspectorMemberId: id.nullable().optional() }).parse(body), cid));
  // The named inspector's own conflict declaration.
  act('conflict', (m, jobId, body, cid) =>
    declareConflict(m, jobId, z.object({ hasConflict: z.boolean(), details: optionalText(2000) }).parse(body), cid));
  // Start the inspection on site.
  act('start', (m, jobId, _body, cid) => startJob(m, jobId, cid));
  // Record one checklist line against the plan.
  act('checks', (m, jobId, body) =>
    recordCheck(
      m,
      jobId,
      z
        .object({
          itemCode: text(64),
          outcome: z.enum(['CONFORM', 'NONCONFORM', 'NOT_APPLICABLE']),
          measuredValue: optionalText(255),
          note: optionalText(1000),
          equipmentRef: optionalText(120),
          equipmentCalibratedUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          labReportEvidenceId: id.nullable().optional(),
        })
        .parse(body),
    ));
  // What was counted, weighed and tested, in exact decimals.
  act('quantities', (m, jobId, body, cid) =>
    recordQuantities(
      m,
      jobId,
      z
        .object({
          unit: z.enum(UNITS),
          orderedQuantity: decimalText.nullable().optional(),
          declaredQuantity: decimalText.nullable().optional(),
          verifiedQuantity: decimalText.nullable().optional(),
          countingMethod: z.enum(['FULL_COUNT', 'CARTON_COUNT', 'WEIGHED', 'MEASURED', 'DECLARED_ONLY']).nullable().optional(),
          countingNote: optionalText(1024),
          packaging: z.array(z.object({ unit: z.enum(UNITS), contains: decimalText, of: z.enum(UNITS) })).max(6).nullable().optional(),
          sampledQuantity: decimalText.nullable().optional(),
          functionallyTestedQuantity: decimalText.nullable().optional(),
          testedConformingQuantity: decimalText.nullable().optional(),
          testedNonconformingQuantity: decimalText.nullable().optional(),
          damagedQuantity: decimalText.nullable().optional(),
          packagingObservations: optionalText(4000),
          labelingObservations: optionalText(4000),
          damageObservations: optionalText(4000),
        })
        .parse(body),
      cid,
    ));
  // A sample taken for a laboratory, with its seal and the start of its chain of custody.
  act('lab-samples', (m, jobId, body, cid) =>
    addLabSample(
      m,
      jobId,
      z
        .object({
          sampleCode: text(64),
          description: text(1024),
          quantity: decimalText.nullable().optional(),
          unit: z.enum(UNITS).nullable().optional(),
          sealNumber: optionalText(64),
          takenAt: z.coerce.date(),
          laboratoryName: optionalText(255),
          laboratoryAccreditation: optionalText(255),
        })
        .parse(body),
      cid,
    ));
  // Record the lot, sample size and accepted/rejected units.
  act('sampling', (m, jobId, body) =>
    recordSampling(m, jobId, z.object({ lotReference: text(120), sampledQuantity: z.number().int().min(1), acceptedQuantity: z.number().int().min(0), rejectedQuantity: z.number().int().min(0), cartonsOpened: z.number().int().min(0).nullable().optional() }).parse(body)));
  // Log a critical, major or minor defect (an NCR).
  act('defects', (m, jobId, body, cid) =>
    recordDefect(
      m,
      jobId,
      z
        .object({
          severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
          requirementRef: text(255),
          description: text(4000),
          defectQuantity: z.number().int().min(0),
          unitRefs: z.array(z.string().trim().min(1).max(32)).max(500).nullable().optional(),
          checkItemCode: optionalText(48),
        })
        .parse(body),
      cid,
    ));
  // Submit the report for the agency's QA review.
  act('report/submit', (m, jobId, body, cid) =>
    submitReport(m, jobId, z.object({ summary: optionalText(4000), limitations: optionalText(4000) }).parse(body), cid));
  // QA sends the report back to the inspector, with a reason.
  act('report/return', (m, jobId, body, cid) => returnReport(m, jobId, z.object({ reason: text(2000) }).parse(body).reason, cid));
  // QA signs the report. The result (PASS or FAIL) is derived from the findings, never chosen.
  act('report/sign', (m, jobId, _body, cid) => signReport(m, jobId, cid));
  // Bind the inspected goods to a container and seal.
  act('binding', (m, jobId, body, cid) =>
    recordBinding(m, jobId, z.object({ logisticsShipmentId: id, containerNumber: optionalText(32), sealNumber: optionalText(32), stuffedQuantity: z.number().int().min(1), stuffedAt: z.coerce.date(), witnessName: optionalText(120) }).parse(body), cid));
  // The agency's invoice for this job. Never changes the technical result.
  act('invoice', (m, jobId, body, cid) => {
    const input = z.object({ invoiceNumber: text(64), amountMinor: z.string().regex(/^\d{1,18}$/), currency: z.string().length(3), note: optionalText(1000) }).parse(body);
    return submitInvoice(m, jobId, { ...input, amountMinor: BigInt(input.amountMinor) }, cid);
  });

  // Add one hand-over to a laboratory sample's chain of custody.
  app.post('/jobs/:id/lab-samples/:sampleId/custody', async (request, reply) => {
    const params = z.object({ id, sampleId: id }).parse(request.params);
    const input = z.object({ at: z.coerce.date(), from: text(160), to: text(160), note: optionalText(500) }).parse(request.body);
    await addCustodyEvent(await membershipOf(request), params.id, params.sampleId, input);
    return reply.send({ ok: true });
  });

  // The laboratory's report on a sample, held as evidence on this job.
  app.post('/jobs/:id/lab-samples/:sampleId/result', async (request, reply) => {
    const params = z.object({ id, sampleId: id }).parse(request.params);
    const input = z.object({ labReportEvidenceId: id, resultSummary: text(4000) }).parse(request.body);
    await recordLabResult(await membershipOf(request), params.id, params.sampleId, input);
    return reply.send({ ok: true });
  });

  // QA issues a correction of a signed report. The original is kept, superseded.
  app.post('/reports/:id/correct', async (request, reply) => {
    const { id: reportId } = idParam.parse(request.params);
    const input = z.object({ reason: text(2000), summary: optionalText(4000), limitations: optionalText(4000) }).parse(request.body);
    return reply.status(201).send(await correctReport(await membershipOf(request), reportId, input, request.correlationId));
  });

  // Download a signed report as a PDF: your agency's own, and an inspector's own jobs only.
  app.get('/reports/:id/pdf', async (request, reply) => {
    const { id: reportId } = idParam.parse(request.params);
    return sendReportPdf(reply, { kind: 'AGENCY', membership: await membershipOf(request) }, reportId);
  });

  // The agency's own people. Every member may read; an agency admin manages.
  app.get('/team', async (request, reply) => {
    const m = await membershipOf(request);
    return reply.header('Cache-Control', 'no-store').send({ people: await listConsolePeople({ agencyId: m.agencyId, includeStaff: false }) });
  });

  // An agency admin invites a person into their own agency. They get a console account and an activation email.
  app.post('/team/invitations', async (request, reply) => {
    const m = await membershipOf(request);
    if (!m.permissions.has(InspectionAgencyPermission.MEMBER_WRITE)) throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Only your agency admin can invite people.');
    const input = z
      .object({
        email: z.string().email().max(320),
        fullName: text(120),
        role: z.enum(['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER']),
        jobTitle: optionalText(120),
        idDocumentType: optionalText(40),
        idDocumentNumber: optionalText(64),
        competenceCategoryIds: z.array(id).max(200).nullable().optional(),
        credentials: optionalText(2000),
        credentialExpiresAt: z.coerce.date().nullable().optional(),
      })
      .parse(request.body);
    const { email, fullName, ...target } = input;
    const invited = await inviteToConsole(
      { party: 'AUDIT', userId: m.userId, label: memberLabel(currentAudit(request)), agencyId: m.agencyId, correlationId: request.correlationId },
      { email, fullName, target: { kind: 'AGENCY', agencyId: m.agencyId, ...target } },
    );
    return reply.status(201).send({ memberId: invited.memberId, expiresAt: invited.expiresAt.toISOString() });
  });

  // An agency admin changes a member's role, competence or status. Identity is verified only by the marketplace.
  app.patch('/team/members/:id', async (request, reply) => {
    const m = await membershipOf(request);
    if (!m.permissions.has(InspectionAgencyPermission.MEMBER_WRITE)) throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Only your agency admin can change people.');
    const { id: memberId } = idParam.parse(request.params);
    const input = z
      .object({
        role: z.enum(['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER']).optional(),
        jobTitle: optionalText(120),
        competenceCategoryIds: z.array(id).max(200).nullable().optional(),
        credentials: optionalText(2000),
        credentialExpiresAt: z.coerce.date().nullable().optional(),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
      })
      .parse(request.body);
    await updateAgencyMember({ kind: 'AGENCY', membership: m }, memberId, input);
    return reply.send({ ok: true });
  });

  // An agency admin sends a fresh activation link to somebody who has not activated yet.
  app.post('/team/members/:id/resend-invitation', async (request, reply) => {
    const m = await membershipOf(request);
    if (!m.permissions.has(InspectionAgencyPermission.MEMBER_WRITE)) throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Only your agency admin can do this.');
    const { id: memberId } = idParam.parse(request.params);
    const member = await prisma.inspectionAgencyMember.findFirst({ where: { id: memberId, agencyId: m.agencyId }, select: { userId: true } });
    if (member === null) throw notFound('Agency member');
    const sent = await resendInvitation({ party: 'AUDIT', userId: m.userId, label: m.fullName, agencyId: m.agencyId }, member.userId);
    return reply.send({ expiresAt: sent.expiresAt.toISOString() });
  });

  // Reclassify a defect's severity, with a reason and supporting evidence.
  app.post('/defects/:id/reclassify', async (request, reply) => {
    const { id: defectId } = idParam.parse(request.params);
    const input = z.object({ severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']), reason: text(2000), evidenceId: id }).parse(request.body);
    await reclassifyDefect(await membershipOf(request), defectId, input, request.correlationId);
    return reply.send({ ok: true });
  });

  // Upload timestamped evidence (photo, video, document, measurement) to a job. Stored privately and hashed.
  app.post('/jobs/:id/evidence', async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    const membership = await membershipOf(request);
    const upload = await readEvidenceUpload(request);
    const fields = evidenceFields.parse(upload.fields);
    const stored = await uploadAgencyEvidence(membership, jobId, { ...fields, fileName: upload.fileName, bytes: upload.bytes }, request.correlationId);
    return reply.status(201).send(stored);
  });

  // Download one evidence file you may see.
  app.get('/evidence/:id', async (request, reply) => {
    const { id: evidenceId } = idParam.parse(request.params);
    if (!(await agencyMaySeeEvidence(await membershipOf(request), evidenceId))) throw notFound('Evidence');
    return sendEvidence(reply, await readEvidenceBytes(evidenceId, viewerOf(request, 'AGENCY')));
  });

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Seller Hub
// ---------------------------------------------------------------------------

function sellerActor(request: FastifyRequest): InspectionActor & { sellerAccountId: string } {
  const seller = currentSeller(request);
  const auth = currentUser(request);
  return { party: 'SELLER', userId: auth.id, label: auth.email, email: auth.email, correlationId: request.correlationId, sellerAccountId: seller.sellerAccountId };
}

export function registerSellerInspectionRoutes(app: FastifyInstance): Promise<void> {
  // The inspection on one of your orders: requirement, jobs, report, NCRs and release.
  app.get('/inspection/orders/:id', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id: groupId } = idParam.parse(request.params);
    const view = await sellerInspectionView(currentSeller(request).sellerAccountId, groupId);
    return reply.header('Cache-Control', 'no-store').send({ inspection: view });
  });

  // Declare the lot ready: location, packing state, contact and a signed declaration.
  app.post('/inspection/jobs/:id/readiness', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    const input = z.object({
      lotReference: text(120), readyDate: z.string().date().nullable(), locationLabel: text(255), contactName: text(120), contactPhone: text(40),
      packedStatus: z.enum(['NOT_PACKED', 'PARTIALLY_PACKED', 'PACKED', 'SEALED']), declaration: z.literal(true), note: optionalText(2000),
    }).parse(request.body);
    await submitReadiness(sellerActor(request), jobId, input);
    return reply.send({ ok: true });
  });

  // Answer an NCR with a corrective action (CAPA).
  app.post('/inspection/defects/:id/capa', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => {
    const { id: defectId } = idParam.parse(request.params);
    const input = z.object({ sellerResponse: text(4000), correctiveAction: text(4000) }).parse(request.body);
    await submitCapa(sellerActor(request), defectId, input);
    return reply.send({ ok: true });
  });

  // Upload readiness or corrective evidence (packing list, photos). The approved report itself cannot be edited.
  app.post('/inspection/jobs/:id/evidence', { preHandler: requireSeller(SellerPermission.ORDER_FULFIL) }, async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    const upload = await readEvidenceUpload(request);
    const fields = z.object({ purpose: z.enum(['CAPA', 'GENERAL']).default('GENERAL'), defectId: id.nullable().optional(), note: optionalText(1000) }).parse(upload.fields);
    const stored = await uploadSellerEvidence(sellerActor(request), { jobId, ...fields, fileName: upload.fileName, bytes: upload.bytes });
    return reply.status(201).send(stored);
  });

  // Download one evidence file on your order.
  // Download a signed inspection report on one of your own orders, as a PDF.
  app.get('/inspection/reports/:id/pdf', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id: reportId } = idParam.parse(request.params);
    return sendReportPdf(reply, { kind: 'SELLER', sellerAccountId: currentSeller(request).sellerAccountId }, reportId);
  });

  app.get('/inspection/evidence/:id', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id: evidenceId } = idParam.parse(request.params);
    if (!(await sellerMaySeeEvidence(currentSeller(request).sellerAccountId, evidenceId))) throw notFound('Evidence');
    return sendEvidence(reply, await readEvidenceBytes(evidenceId, viewerOf(request, 'SELLER')));
  });

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Storefront buyer
// ---------------------------------------------------------------------------

export function registerBuyerInspectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  // The inspection timeline for your order: booked, inspector assigned, started, report, NCR, release.
  app.get('/orders/:id', async (request, reply) => {
    const { id: orderId } = idParam.parse(request.params);
    const views = await buyerInspectionViews(currentUser(request).customerProfileId ?? '', orderId);
    return reply.header('Cache-Control', 'no-store').send({ inspections: views });
  });

  // Ask for an inspection on your order before it ships.
  app.post('/orders/:id/request', async (request, reply) => {
    const { id: orderId } = idParam.parse(request.params);
    const auth = currentUser(request);
    const input = z.object({ sellerOrderGroupId: id, note: optionalText(2000) }).parse(request.body);
    const result = await requestInspectionAsBuyer(
      { party: 'BUYER', userId: auth.id, label: auth.email, email: auth.email, correlationId: request.correlationId, customerProfileId: auth.customerProfileId ?? '' },
      { orderId, ...input },
    );
    return reply.status(201).send(result ?? { ok: true });
  });

  // The inspection agencies you may choose for one part of your order, on a day and in a country.
  app.get('/orders/:id/agencies', async (request, reply) => {
    const { id: orderId } = idParam.parse(request.params);
    const query = z
      .object({ sellerOrderGroupId: id, country: z.string().length(2).optional(), scheduledFor: z.coerce.date() })
      .parse(request.query);
    const agencies = await buyerAgencyChoices(currentUser(request).customerProfileId ?? '', {
      orderId,
      sellerOrderGroupId: query.sellerOrderGroupId,
      country: query.country ?? null,
      scheduledFor: query.scheduledFor,
    });
    return reply.header('Cache-Control', 'no-store').send({ agencies });
  });

  // Book an inspection on your order before it ships: agency, date, inspection point and who pays.
  app.post('/orders/:id/book', async (request, reply) => {
    const { id: orderId } = idParam.parse(request.params);
    const auth = currentUser(request);
    const input = bookingSchema
      .omit({ reinspectionOfJobId: true, payer: true })
      .extend({ payer: z.enum(['BUYER', 'SELLER']) })
      .parse(request.body);
    const result = await bookInspectionAsBuyer(
      { party: 'BUYER', userId: auth.id, label: auth.email, email: auth.email, correlationId: request.correlationId, customerProfileId: auth.customerProfileId ?? '' },
      { orderId, ...input },
    );
    return reply.status(201).send(result);
  });

  // Download a signed inspection report on your order as a PDF, when the operator's policy lets buyers see it.
  app.get('/reports/:id/pdf', async (request, reply) => {
    const { id: reportId } = idParam.parse(request.params);
    return sendReportPdf(reply, { kind: 'BUYER', customerProfileId: currentUser(request).customerProfileId ?? '' }, reportId);
  });

  // Download one evidence file the buyer may see under the report-visibility policy.
  app.get('/evidence/:id', async (request, reply) => {
    const { id: evidenceId } = idParam.parse(request.params);
    if (!(await buyerMaySeeEvidence(currentUser(request).customerProfileId ?? '', evidenceId))) throw notFound('Evidence');
    return sendEvidence(reply, await readEvidenceBytes(evidenceId, viewerOf(request, 'BUYER')));
  });

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Admin console
// ---------------------------------------------------------------------------

function operator(request: FastifyRequest): { userId: string; email: string; correlationId: string } {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email, correlationId: request.correlationId };
}
function operatorActor(request: FastifyRequest): InspectionActor & { party: 'OPERATOR'; userId: string } {
  const o = operator(request);
  return { party: 'OPERATOR', userId: o.userId, label: o.email, email: o.email, correlationId: o.correlationId };
}

const bookingSchema = z.object({
  sellerOrderGroupId: id,
  agencyId: id.nullable().optional(),
  scheduledFor: z.coerce.date(),
  inspectionPointType: z.enum(['SELLER_PREMISES', 'WAREHOUSE', 'PORT', 'OTHER']),
  inspectionPoint: z.object({ label: text(120), addressLine: text(255), city: text(120), country: z.string().length(2), portCode: optionalText(16), contactName: optionalText(120), contactPhone: optionalText(40) }),
  payer: z.enum(['BUYER', 'SELLER', 'PLATFORM']),
  language: optionalText(10),
  poReference: optionalText(120),
  referenceSample: optionalText(2000),
  specialRequirements: optionalText(4000),
  reinspectionOfJobId: id.nullable().optional(),
  stage: z.enum(['RAW_MATERIAL', 'DURING_PRODUCTION', 'PRE_SHIPMENT', 'RECEIVING']).optional(),
  scopeMethod: z.enum(['FULL', 'SAMPLE']).optional(),
  timezone: optionalText(64),
});

export function registerAdminInspectionRoutes(app: FastifyInstance): Promise<void> {

  // Download any signed inspection report as a PDF.
  app.get('/inspection/reports/:id/pdf', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id: reportId } = idParam.parse(request.params);
    return sendReportPdf(reply, { kind: 'ADMIN' }, reportId);
  });

  // Download one evidence file on any inspection. Every read is audited.
  app.get('/inspection/evidence/:id', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id: evidenceId } = idParam.parse(request.params);
    return sendEvidence(reply, await readEvidenceBytes(evidenceId, viewerOf(request, 'OPERATOR')));
  });

  // Attach the evidence a conditional release rests on (purpose RELEASE). The release request then names it.
  app.post('/inspection/requirements/:id/evidence', { preHandler: requireAdmin(Permission.INSPECTION_RELEASE) }, async (request, reply) => {
    const { id: requirementId } = idParam.parse(request.params);
    const upload = await readEvidenceUpload(request);
    const fields = evidenceFields.parse(upload.fields);
    if (fields.purpose !== 'RELEASE') {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'The operator attaches evidence for a release only.', [{ field: 'purpose', code: 'RELEASE_ONLY' }]);
    }
    const actor = operatorActor(request);
    const stored = await storeEvidence(actor, {
      requirementId,
      jobId: null,
      purpose: 'RELEASE',
      fileName: upload.fileName,
      bytes: upload.bytes,
      capturedAt: fields.capturedAt ?? null,
      clientUploadId: fields.clientUploadId ?? null,
      note: fields.note ?? null,
    });
    return reply.status(201).send(stored);
  });

  // Sub-lot releases waiting for, or past, a decision.
  app.get('/inspection/sublot-releases', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const q = z.object({ state: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() }).parse(request.query);
    const rows = await prisma.inspectionSubLotRelease.findMany({
      where: q.state === undefined ? {} : { state: q.state },
      orderBy: { requestedAt: 'desc' },
      take: 200,
      include: { requirement: { select: { orderId: true, sellerOrderGroup: { select: { sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } } } } },
    });
    return reply.header('Cache-Control', 'no-store').send({
      releases: rows.map((row) => ({
        id: row.id,
        jobId: row.jobId,
        subLotCode: row.subLotCode,
        lotReference: row.lotReference,
        quantity: row.quantity.toString(),
        unit: row.unit,
        lines: row.linesJson,
        reason: row.reason,
        state: row.state,
        requestedByLabel: row.requestedByLabel,
        requestedAt: row.requestedAt.toISOString(),
        decidedByLabel: row.decidedByLabel,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        consumedAt: row.consumedAt?.toISOString() ?? null,
        sellerOrderNumber: row.requirement.sellerOrderGroup.sellerOrderNumber,
        sellerName: row.requirement.sellerOrderGroup.sellerAccount.displayName,
      })),
    });
  });

  // Approve or reject a sub-lot release requested in the Audit Console. Never by the person who asked.
  app.post('/inspection/sublot-releases/:id/decision', { preHandler: requireAdmin(Permission.INSPECTION_RELEASE) }, async (request, reply) => {
    const { id: releaseId } = idParam.parse(request.params);
    const input = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: optionalText(1024) }).parse(request.body);
    await decideSubLotRelease(operatorActor(request), releaseId, input);
    return reply.send({ ok: true });
  });

  // Move an agency member who signs in with a storefront account onto their own Audit Console account.
  app.post('/inspection/members/:id/move-to-console', { preHandler: requireAdmin(Permission.AUDIT_CONSOLE_MANAGE) }, async (request, reply) => {
    const { id: memberId } = idParam.parse(request.params);
    const input = z.object({ email: z.string().email().max(320) }).parse(request.body);
    const o = operator(request);
    const moved = await moveAgencyMemberToConsole({ party: 'ADMIN', userId: o.userId, label: o.email, correlationId: o.correlationId }, memberId, input);
    return reply.status(201).send({ userId: moved.userId, expiresAt: moved.expiresAt.toISOString() });
  });

  // Every agency's people, with how they sign in.
  app.get('/inspection/agencies/:id/members', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id: agencyId } = idParam.parse(request.params);
    return reply.header('Cache-Control', 'no-store').send({ people: await listConsolePeople({ agencyId, includeStaff: false }) });
  });

  // Every inspection requirement, filterable by status, with search.
  app.get('/inspection/queue', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const q = z.object({ status: z.string().max(40).optional(), search: z.string().trim().max(120).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(request.query);
    return reply.header('Cache-Control', 'no-store').send(await operatorQueue({ status: q.status ?? null, search: q.search ?? null, page: q.page, limit: q.limit }));
  });

  // One inspection requirement in full.
  app.get('/inspection/requirements/:id', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (request, reply) => {
    const { id: requirementId } = idParam.parse(request.params);
    return reply.header('Cache-Control', 'no-store').send({ inspection: await operatorInspectionView(requirementId) });
  });

  // Recompute whether inspection is required for this order under today's rules.
  app.post('/inspection/requirements/:id/reevaluate', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const { id: requirementId } = idParam.parse(request.params);
    return reply.send(await reevaluateRequirement(operatorActor(request), requirementId));
  });

  // Book an inspection: stage, scope method, timing, point, agency and payer. Agency eligibility and conflicts are checked.
  app.post('/inspection/jobs', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const booked = await bookInspection(operatorActor(request), bookingSchema.parse(request.body));
    await notifyJobOffered(booked.jobId);
    return reply.status(201).send(booked);
  });

  // Cancel a job, with a reason.
  app.post('/inspection/jobs/:id/cancel', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    await cancelJob(operatorActor(request), jobId, z.object({ reason: text(1000) }).parse(request.body).reason, 'OPERATOR');
    return reply.send({ ok: true });
  });

  // Ask for a conditional release (manual override): named authority, reason, evidence.
  app.post('/inspection/requirements/:id/conditional-release', { preHandler: requireAdmin(Permission.INSPECTION_RELEASE) }, async (request, reply) => {
    const { id: requirementId } = idParam.parse(request.params);
    const input = z.object({ reason: text(2000), riskNote: optionalText(2000), evidenceIds: z.array(id).max(20) }).parse(request.body);
    return reply.status(201).send(await requestConditionalRelease(operatorActor(request), requirementId, input));
  });

  // Approve a colleague's conditional release. Never your own.
  app.post('/inspection/releases/:id/approve', { preHandler: requireAdmin(Permission.INSPECTION_RELEASE) }, async (request, reply) => {
    const { id: releaseId } = idParam.parse(request.params);
    await approveConditionalRelease(operatorActor(request), releaseId);
    return reply.send({ ok: true });
  });

  // Reject a conditional release, with a reason.
  app.post('/inspection/releases/:id/reject', { preHandler: requireAdmin(Permission.INSPECTION_RELEASE) }, async (request, reply) => {
    const { id: releaseId } = idParam.parse(request.params);
    await rejectConditionalRelease(operatorActor(request), releaseId, z.object({ reason: text(2000) }).parse(request.body).reason);
    return reply.send({ ok: true });
  });

  // The inspection agencies.
  app.get('/inspection/agencies', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (_request, reply) =>
    reply.send({ agencies: await prisma.inspectionAgency.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, legalName: true, country: true, status: true, contactEmail: true, dailyCapacity: true } }) }));

  // Register an independent agency. A name matching a seller is refused.
  app.post('/inspection/agencies', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const input = z.object({
      name: text(120), legalName: text(200), registrationNumber: optionalText(64), country: z.string().length(2), contactEmail: z.string().email().max(320),
      contactPhone: optionalText(40), accreditation: optionalText(255), categoryIds: z.array(id).max(200).nullable().optional(), countries: z.array(z.string().length(2)).max(100).nullable().optional(),
      affiliatedSellerIds: z.array(id).max(100).nullable().optional(), independenceStatement: optionalText(4000), dailyCapacity: z.number().int().min(1).max(1000).optional(),
    }).parse(request.body);
    return reply.status(201).send(await createAgency(operator(request), input));
  });

  // Invite an agency admin, coordinator, inspector or QA reviewer. They get their own Audit Console account and an activation email.
  app.post('/inspection/agencies/:id/members', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const { id: agencyId } = idParam.parse(request.params);
    const input = z.object({
      email: z.string().email().max(320), role: z.enum(['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER']), fullName: text(120), jobTitle: optionalText(120),
      idDocumentType: optionalText(40), idDocumentNumber: optionalText(64), competenceCategoryIds: z.array(id).max(200).nullable().optional(),
      credentials: optionalText(2000), credentialExpiresAt: z.coerce.date().nullable().optional(),
    }).parse(request.body);
    const o = operator(request);
    const { email, fullName, ...target } = input;
    const invited = await inviteToConsole(
      { party: 'ADMIN', userId: o.userId, label: o.email, correlationId: o.correlationId },
      { email, fullName, target: { kind: 'AGENCY', agencyId, ...target } },
    );
    return reply.status(201).send({ id: invited.memberId, userId: invited.userId, expiresAt: invited.expiresAt.toISOString() });
  });

  // Update a member: verify their identity after checking the ID document, change role or competence, or disable them.
  app.patch('/inspection/members/:id', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const { id: memberId } = idParam.parse(request.params);
    const input = z.object({
      role: z.enum(['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER']).optional(), fullName: text(120).optional(),
      competenceCategoryIds: z.array(id).max(200).nullable().optional(), credentials: optionalText(2000),
      credentialExpiresAt: z.coerce.date().nullable().optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), verifyIdentity: z.boolean().optional(),
    }).parse(request.body);
    await updateAgencyMember({ kind: 'OPERATOR', actor: operator(request) }, memberId, input);
    return reply.send({ ok: true });
  });

  // The inspection policy: defaults, buyer visibility, override rules.
  app.get('/inspection/policy', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (_request, reply) => reply.send({ policy: await readPolicy() }));
  // Save the inspection policy.
  app.put('/inspection/policy', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    await updatePolicy(operator(request), policyUpdateSchema.parse(request.body));
    return reply.send({ policy: await readPolicy() });
  });

  // The rules engine: when inspection is mandatory, risk-triggered or optional.
  app.get('/inspection/rules', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (_request, reply) => reply.send({ rules: await listRules() }));
  // Add a rule (category, value, destination, supplier risk, buyer request).
  app.post('/inspection/rules', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) =>
    reply.status(201).send(await createRule(operator(request), ruleInputSchema.parse(request.body))));

  // Inspection plans: the checklist and sampling for a category.
  app.get('/inspection/plans', { preHandler: requireAdmin(Permission.INSPECTION_READ) }, async (_request, reply) => reply.send({ plans: await listPlans() }));
  // Add a plan.
  app.post('/inspection/plans', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) =>
    reply.status(201).send(await createPlan(operator(request), planInputSchema.parse(request.body))));

  // Set a supplier's inspection risk tier, with a reason.
  app.put('/inspection/supplier-risk/:id', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const { id: sellerAccountId } = idParam.parse(request.params);
    await setSupplierRisk(operator(request), sellerAccountId, z.object({ tier: z.enum(['LOW', 'MEDIUM', 'HIGH']), reason: text(1000) }).parse(request.body));
    return reply.send({ ok: true });
  });

  // Approve, pay, dispute or void an agency invoice. The technical result never changes.
  app.post('/inspection/invoices/:id/decision', { preHandler: requireAdmin(Permission.INSPECTION_MANAGE) }, async (request, reply) => {
    const { id: invoiceId } = idParam.parse(request.params);
    await decideInvoice(operator(request), invoiceId, z.object({ status: z.enum(['APPROVED', 'PAID', 'DISPUTED', 'VOID']), note: optionalText(1000) }).parse(request.body));
    return reply.send({ ok: true });
  });

  return Promise.resolve();
}
