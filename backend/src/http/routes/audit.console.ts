/**
 * The Audit Console over HTTP (`/api/v1/audit/*`).
 *
 * Sign-in, refresh, logout, password reset and invitation activation come
 * from the shared `authRoutes('AUDIT')` factory under `/audit/auth`. This file
 * adds the console's own boot response and second factor, and every screen's
 * data. The agency's job actions live in `inspection.ts` under
 * `/audit/agency`, where the inspection rules already are.
 *
 * Every route here is behind `requireAudit` (an AUDIT session, a console
 * membership, a passed second factor, and the named keys) except the three
 * that must work before the second factor: `/auth/me` and `/auth/mfa/*`.
 * Whose data a route returns comes from the session's membership - never
 * from an id in the request.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditPermission, InspectionAgencyPermission } from '../../domain/audit-console-permissions.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { listConsolePeople, memberLabel, type AuditMember } from '../../modules/audit-console/membership.service.js';
import {
  beginAuditMfaEnrolment,
  confirmAuditMfaEnrolment,
  readAuditMfaState,
  verifyAuditMfaChallenge,
} from '../../modules/audit-console/mfa.service.js';
import {
  listAuditNotifications,
  markAllAuditNotificationsRead,
  markAuditNotificationRead,
} from '../../modules/audit-console/notification.service.js';
import {
  consoleCalendar,
  consoleCorrectiveActions,
  consoleDashboard,
  consoleJobDetail,
  consoleJobList,
  consoleMaySeeEvidence,
  consoleReports,
  consoleSellerDetail,
  consoleSellers,
} from '../../modules/audit-console/views.service.js';
import {
  backfillList,
  caseDecisionInput,
  caseDetail,
  caseRequestInput,
  decideCase,
  determinationInput,
  determineApplicability,
  listCases,
  requestCase,
  type CaseAction,
} from '../../modules/compliance/case.service.js';
import {
  complianceDocumentDetail,
  documentDecisionInput,
  listComplianceDocuments,
  readComplianceFile,
  reviewComplianceDocument,
  type ReviewAction,
} from '../../modules/compliance/document.service.js';
import type { ComplianceActor } from '../../modules/compliance/events.js';
import {
  decideRequirement,
  draftRequirement,
  importResearchDrafts,
  listRequirements,
  requirementDetail,
  requirementInput,
  retireRequirement,
  reviseRequirement,
  ruleCoverage,
  submitRequirement,
  updateDraft,
} from '../../modules/compliance/requirement.service.js';
import { readEvidenceBytes } from '../../modules/inspection/evidence.service.js';
import { createPlan, listPlans, planInputSchema } from '../../modules/inspection/policy.service.js';
import { loadReportFor, renderReportPdf } from '../../modules/inspection/report-document.service.js';
import { cancelSubLotRelease, notifySubLotWaiting, requestSubLotRelease } from '../../modules/inspection/sublot.service.js';
import { qualityInsights } from '../../modules/audit-console/health.service.js';
import { getUserLanguage } from '../../modules/identity/language.service.js';
import { currentUser } from '../plugins/auth.js';
import { currentAudit, requireAudit, requireAuditAny, requireAuditSession } from '../plugins/audit.js';
import { approvalReadiness, recordScreening } from '../../modules/seller/application-review.service.js';
import { decideSellerDocument } from '../../modules/seller/document.service.js';
import { decideApplication, listApplications, readApplication } from '../../modules/seller/moderation.service.js';
import { decideTurnover, readTurnoverReview } from '../../modules/seller/turnover.service.js';
import {
  assertIndependentReviewer,
  readSellerDocumentForAudit,
  sellerOfCurrentDocument,
} from '../../modules/seller/verification.service.js';
import { assertStaffDataRegion } from '../plugins/data-region.js';
import { sendAttachment } from './preorder-chats.js';

const id = z.string().length(26);
const idParam = z.object({ id });
const text = (max: number) => z.string().trim().min(1).max(max);
const noStore = (reply: FastifyReply): FastifyReply => reply.header('Cache-Control', 'no-store');

function actorOf(request: FastifyRequest): ComplianceActor & { userId: string } {
  const member = currentAudit(request);
  return { type: 'AUDIT', userId: member.userId, label: memberLabel(member), correlationId: request.correlationId };
}

/** The boot payload: who, as what, and where their second factor stands. */
async function bootPayload(request: FastifyRequest) {
  const member = currentAudit(request);
  const auth = currentUser(request);
  return {
    user: { id: member.userId, email: member.email, fullName: member.fullName, language: await getUserLanguage(member.userId) },
    member: {
      kind: member.kind,
      role: member.role,
      agency: member.agency,
      permissions: [...member.permissions],
      assessmentCapabilities: [...member.capabilities],
    },
    mfa: await readAuditMfaState(member.userId, auth.sessionMfaVerifiedAt),
  };
}

const JOB_READERS = [InspectionAgencyPermission.JOB_READ, AuditPermission.JOB_OVERSEE] as const;

export function registerAuditConsoleRoutes(app: FastifyInstance): Promise<void> {
  // --- Before the second factor ---------------------------------------------

  /** Everything the console needs to start: the person, their membership and permissions, and their second factor. */
  app.get('/auth/me', { preHandler: requireAuditSession }, async (request, reply) => noStore(reply).send(await bootPayload(request)));

  /** Start setting up two-step sign-in: a secret for an authenticator app and recovery codes, shown this once. */
  app.post('/auth/mfa/setup', { preHandler: requireAuditSession }, async (request, reply) => {
    const auth = currentUser(request);
    if (auth.mfaEnabled && auth.sessionMfaVerifiedAt === null) {
      throw forbidden(ErrorCode.AUDIT_MFA_CHALLENGE_REQUIRED, 'Confirm your existing two-step code first.');
    }
    return noStore(reply).send(await beginAuditMfaEnrolment(auth.id));
  });

  /** Check a two-step code: to finish setting it up, or to pass this session's challenge. */
  app.post('/auth/mfa/verify', { preHandler: requireAuditSession, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = z.object({ code: z.string().trim().min(6).max(16), mode: z.enum(['ENROL', 'CHALLENGE']).default('CHALLENGE') }).parse(request.body);
    const auth = currentUser(request);
    const context = { userId: auth.id, sessionId: auth.sessionId, code: body.code, ipAddress: request.ip, correlationId: request.correlationId };
    if (body.mode === 'ENROL') {
      await confirmAuditMfaEnrolment(context);
      return noStore(reply).send({ verified: true, usedRecoveryCode: false });
    }
    return noStore(reply).send({ verified: true, ...(await verifyAuditMfaChallenge(context)) });
  });

  // --- Every member ---------------------------------------------------------

  /** Your notifications, newest first, with the unread count. */
  app.get('/notifications', { preHandler: requireAudit() }, async (request, reply) =>
    noStore(reply).send(await listAuditNotifications(currentAudit(request).userId)));

  /** Mark one of your notifications read. */
  app.post('/notifications/:id/read', { preHandler: requireAudit() }, async (request, reply) => {
    const { id: notificationId } = idParam.parse(request.params);
    if (!(await markAuditNotificationRead(currentAudit(request).userId, notificationId))) throw notFound('Notification');
    return reply.send({ ok: true });
  });

  /** Mark all your notifications read. */
  app.post('/notifications/read-all', { preHandler: requireAudit() }, async (request, reply) =>
    reply.send({ marked: await markAllAuditNotificationsRead(currentAudit(request).userId) }));

  /** The dashboard: an agency's own work, or the audit team's queues. */
  app.get('/dashboard', { preHandler: requireAudit(AuditPermission.DASHBOARD_READ) }, async (request, reply) =>
    noStore(reply).send(await consoleDashboard(currentAudit(request))));

  /** Quality insights: pass/fail by month, defects, top findings, best and worst suppliers, agency performance. */
  app.get('/insights', { preHandler: requireAudit(AuditPermission.JOB_OVERSEE) }, async (request, reply) =>
    noStore(reply).send(await qualityInsights({ includeHealth: currentAudit(request).permissions.has(AuditPermission.SELLER_READ) })));

  // --- Inspections ----------------------------------------------------------

  /** Inspection jobs: your agency's (an inspector's own), or every agency's for the audit team. */
  app.get('/jobs', { preHandler: requireAuditAny(...JOB_READERS) }, async (request, reply) => {
    const q = z
      .object({
        status: z.string().max(40).optional(),
        stage: z.enum(['RAW_MATERIAL', 'DURING_PRODUCTION', 'PRE_SHIPMENT', 'RECEIVING']).optional(),
        agencyId: id.optional(),
        search: z.string().trim().max(120).optional(),
        overdue: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    const member = currentAudit(request);
    return noStore(reply).send({
      jobs: await consoleJobList(member, {
        status: q.status ?? null,
        stage: q.stage ?? null,
        // An agency member's list is their own agency's whatever they ask for.
        agencyId: member.kind === 'STAFF' ? q.agencyId ?? null : null,
        search: q.search ?? null,
        overdue: q.overdue === 'true',
      }),
    });
  });

  /** One job: scope, checklist, quantities, sampling, defects, laboratory samples, evidence, reports and sub-lots. */
  app.get('/jobs/:id', { preHandler: requireAuditAny(...JOB_READERS) }, async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    return noStore(reply).send(await consoleJobDetail(currentAudit(request), jobId));
  });

  /** Your agency's capacity and booked jobs by day. */
  app.get('/calendar', { preHandler: requireAudit(InspectionAgencyPermission.JOB_READ) }, async (request, reply) => {
    const q = z.object({ from: z.coerce.date().optional(), days: z.coerce.number().int().min(1).max(62).default(14) }).parse(request.query);
    return noStore(reply).send(await consoleCalendar(currentAudit(request), q.from ?? new Date(), q.days));
  });

  /** Signed inspection reports, with corrections and superseded revisions marked. */
  app.get('/reports', { preHandler: requireAuditAny(...JOB_READERS) }, async (request, reply) => {
    const q = z.object({ result: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']).optional(), search: z.string().trim().max(120).optional() }).parse(request.query);
    return noStore(reply).send({ reports: await consoleReports(currentAudit(request), { result: q.result ?? null, search: q.search ?? null }) });
  });

  /** A signed report as a PDF, for those who may read its job. */
  app.get('/reports/:id/pdf', { preHandler: requireAuditAny(...JOB_READERS) }, async (request, reply) => {
    const { id: reportId } = idParam.parse(request.params);
    const member = currentAudit(request);
    const report = await loadReportFor(member.inspection === null ? { kind: 'STAFF' } : { kind: 'AGENCY', membership: member.inspection }, reportId);
    if (report === null) throw notFound('Inspection report');
    const pdf = await renderReportPdf(report.id, 'FULL');
    return sendAttachment(noStore(reply), { body: pdf.bytes, contentType: 'application/pdf', fileName: pdf.fileName });
  });

  /** Non-conformances, the seller's corrective actions, and the re-inspections that close them. */
  app.get('/corrective-actions', { preHandler: requireAuditAny(...JOB_READERS) }, async (request, reply) => {
    const q = z.object({ status: z.enum(['OPEN', 'CAPA_SUBMITTED', 'VERIFIED_CLOSED']).optional() }).parse(request.query);
    return noStore(reply).send({ items: await consoleCorrectiveActions(currentAudit(request), { status: q.status ?? null }) });
  });

  /** One evidence file, for those who may read its job. Every read is audited. */
  app.get('/evidence/:id', { preHandler: requireAuditAny(...JOB_READERS) }, async (request, reply) => {
    const { id: evidenceId } = idParam.parse(request.params);
    const member = currentAudit(request);
    if (!(await consoleMaySeeEvidence(member, evidenceId))) throw notFound('Evidence');
    const file = await readEvidenceBytes(evidenceId, {
      party: member.kind === 'STAFF' ? 'STAFF' : 'AGENCY',
      userId: member.userId,
      email: member.email,
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });
    return sendAttachment(noStore(reply), { body: file.bytes, contentType: file.contentType, fileName: file.fileName });
  });

  /** Ask for a clearly identified part of a held lot to be released. Somebody else approves it in the Admin Panel. */
  app.post('/jobs/:id/sublot-releases', { preHandler: requireAudit(AuditPermission.RELEASE_REQUEST) }, async (request, reply) => {
    const { id: jobId } = idParam.parse(request.params);
    const input = z
      .object({
        subLotCode: text(64),
        lotReference: text(64),
        quantity: z.string().trim().regex(/^\d{1,15}(?:\.\d{1,3})?$/),
        unit: z.enum(['PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL', 'KILOGRAM', 'GRAM', 'LITRE', 'MILLILITRE', 'METRE', 'SQUARE_METRE']),
        lines: z.array(z.object({ orderItemId: id, quantity: z.number().int().min(1) })).min(1).max(100),
        reason: text(4000),
      })
      .parse(request.body);
    const actor = actorOf(request);
    const created = await requestSubLotRelease({ party: 'OPERATOR', userId: actor.userId, label: actor.label, correlationId: request.correlationId }, { jobId, ...input });
    await notifySubLotWaiting(created.id);
    return reply.status(201).send(created);
  });

  /** Cancel your own sub-lot request before it is used. */
  app.post('/sublot-releases/:id/cancel', { preHandler: requireAudit(AuditPermission.RELEASE_REQUEST) }, async (request, reply) => {
    const { id: releaseId } = idParam.parse(request.params);
    await cancelSubLotRelease({ userId: currentAudit(request).userId }, releaseId);
    return reply.send({ ok: true });
  });

  /** Checklist and sampling plans by category. */
  app.get('/checklists', { preHandler: requireAudit(AuditPermission.CHECKLIST_MANAGE) }, async (_request, reply) =>
    noStore(reply).send({ plans: await listPlans() }));

  /** Add a plan version for a category: inspection level, AQL per severity, and the checklist (kinds, mandatory lines, lab and instrument needs). */
  app.post('/checklists', { preHandler: requireAudit(AuditPermission.CHECKLIST_MANAGE) }, async (request, reply) => {
    const member = currentAudit(request);
    return reply.status(201).send(await createPlan({ userId: member.userId, email: member.email, correlationId: request.correlationId }, planInputSchema.parse(request.body)));
  });

  /** People: your agency's (any agency member), or every agency's and the audit team (audit staff). */
  app.get('/team', { preHandler: requireAuditAny(AuditPermission.TEAM_READ, InspectionAgencyPermission.JOB_READ) }, async (request, reply) => {
    const member: AuditMember = currentAudit(request);
    const people =
      member.kind === 'STAFF'
        ? await listConsolePeople({ agencyId: null, includeStaff: true })
        : await listConsolePeople({ agencyId: member.agency?.id ?? '', includeStaff: false });
    const agencies =
      member.kind === 'STAFF'
        ? await prisma.inspectionAgency.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, kind: true, status: true, country: true, accreditation: true } })
        : [];
    return noStore(reply).send({ people, agencies, canManage: member.permissions.has(InspectionAgencyPermission.MEMBER_WRITE) });
  });

  // --- Module A: sellers, cases, documents, rules ---------------------------

  /** Sellers, with their qualification and document counts and their health rating; filter by band, sort by risk. */
  app.get('/sellers', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        status: z.string().max(40).optional(),
        health: z.enum(['HEALTHY', 'AT_RISK', 'UNHEALTHY']).optional(),
        sort: z.enum(['name', 'risk']).default('name'),
      })
      .parse(request.query);
    return noStore(reply).send({
      sellers: await consoleSellers({ search: q.search ?? null, status: q.status ?? null, health: q.health ?? null, sort: q.sort }),
      backfill: await backfillList(100),
    });
  });

  /** One seller: business identity (read-only), category qualifications, product cases and documents - kept apart. */
  app.get('/sellers/:id', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const { id: sellerAccountId } = idParam.parse(request.params);
    return noStore(reply).send(await consoleSellerDetail(sellerAccountId));
  });

  /** Qualification and product cases, filterable by level, status, seller and category. */
  app.get('/cases', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const q = z
      .object({
        level: z.enum(['SELLER_CATEGORY', 'PRODUCT']).optional(),
        status: z.string().max(40).optional(),
        sellerAccountId: id.optional(),
        categoryId: id.optional(),
        search: z.string().trim().max(120).optional(),
      })
      .parse(request.query);
    return noStore(reply).send({ cases: await listCases({ level: q.level ?? null, status: q.status ?? null, sellerAccountId: q.sellerAccountId ?? null, categoryId: q.categoryId ?? null, search: q.search ?? null }) });
  });

  /** Product compliance cases only. */
  app.get('/products', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const q = z.object({ status: z.string().max(40).optional(), search: z.string().trim().max(120).optional() }).parse(request.query);
    return noStore(reply).send({ cases: await listCases({ level: 'PRODUCT', status: q.status ?? null, search: q.search ?? null }) });
  });

  /** One case with its live evaluation, requirement by requirement, and its history. */
  app.get('/cases/:id', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const { id: caseId } = idParam.parse(request.params);
    return noStore(reply).send(await caseDetail(caseId, 'staff'));
  });

  /** Open a case for a seller - the backfill review of a seller already trading. Asking twice returns the same case. */
  app.post('/cases', { preHandler: requireAudit(AuditPermission.CASE_REVIEW) }, async (request, reply) => {
    const input = caseRequestInput.extend({ sellerAccountId: id }).parse(request.body);
    const { sellerAccountId, ...rest } = input;
    const actor = actorOf(request);
    const opened = await requestCase({ party: 'AUDIT', sellerAccountId, userId: actor.userId, label: actor.label, correlationId: request.correlationId }, rest);
    return reply.status(opened.created ? 201 : 200).send(opened);
  });

  const caseAction = (action: CaseAction) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: caseId } = idParam.parse(request.params);
    return reply.send(await decideCase(actorOf(request), caseId, action, caseDecisionInput.parse(request.body ?? {})));
  };
  const caseGuard = { preHandler: requireAudit(AuditPermission.CASE_REVIEW) };
  /** Take a case for review. */
  app.post('/cases/:id/start', caseGuard, caseAction('START'));
  /** Ask the seller for more or different evidence, with a message they see. */
  app.post('/cases/:id/request-changes', caseGuard, caseAction('REQUEST_CHANGES'));
  /** Qualify: only when every applicable mandatory requirement is satisfied and every conditional one determined. */
  app.post('/cases/:id/approve', caseGuard, caseAction('APPROVE'));
  /** Refuse the case, with a message the seller sees. */
  app.post('/cases/:id/reject', caseGuard, caseAction('REJECT'));
  /** Suspend a qualification, with a message the seller sees. */
  app.post('/cases/:id/suspend', caseGuard, caseAction('SUSPEND'));

  /** Record whether a conditional or unresolved requirement applies to this case, with the reason. */
  app.post('/cases/:id/determinations', { preHandler: requireAudit(AuditPermission.CASE_REVIEW) }, async (request, reply) => {
    const { id: caseId } = idParam.parse(request.params);
    await determineApplicability(actorOf(request), caseId, determinationInput.parse(request.body));
    return reply.send({ ok: true });
  });

  /** Compliance documents, filterable by status and by approaching expiry. */
  app.get('/documents', { preHandler: requireAudit(AuditPermission.DOCUMENT_READ) }, async (request, reply) => {
    const q = z
      .object({
        status: z.string().max(40).optional(),
        sellerAccountId: id.optional(),
        expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
        search: z.string().trim().max(120).optional(),
      })
      .parse(request.query);
    return noStore(reply).send({
      documents: await listComplianceDocuments({ status: q.status ?? null, sellerAccountId: q.sellerAccountId ?? null, expiringWithinDays: q.expiringWithinDays ?? null, search: q.search ?? null }),
    });
  });

  /** One document with its versions and review history. */
  app.get('/documents/:id', { preHandler: requireAudit(AuditPermission.DOCUMENT_READ) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    return noStore(reply).send(await complianceDocumentDetail(documentId, 'staff'));
  });

  /** The document's file, for preview. Private storage, scanned files only, every read audited. */
  app.get('/documents/:id/file', { preHandler: requireAudit(AuditPermission.DOCUMENT_READ) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    const member = currentAudit(request);
    const file = await readComplianceFile(documentId, { userId: member.userId, actorType: 'AUDIT', ipAddress: request.ip, correlationId: request.correlationId });
    return sendAttachment(noStore(reply), { body: file.body, contentType: file.contentType, fileName: file.fileName });
  });

  const documentAction = (action: ReviewAction) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: documentId } = idParam.parse(request.params);
    await reviewComplianceDocument(actorOf(request), documentId, action, documentDecisionInput.parse(request.body ?? {}));
    return reply.send({ ok: true });
  };
  const documentGuard = { preHandler: requireAudit(AuditPermission.CASE_REVIEW) };
  /** Take a document for review. */
  app.post('/documents/:id/start', documentGuard, documentAction('START'));
  /** Ask the seller to correct or replace a document, with a message they see. */
  app.post('/documents/:id/request-changes', documentGuard, documentAction('REQUEST_CHANGES'));
  /** Approve a document, recording how it was checked and the scope it covers. A mismatch can never be approved. */
  app.post('/documents/:id/approve', documentGuard, documentAction('APPROVE'));
  /** Refuse a document, with a message the seller sees. */
  app.post('/documents/:id/reject', documentGuard, documentAction('REJECT'));
  /** Suspend an approved document. Qualifications that relied on it go back for review. */
  app.post('/documents/:id/suspend', documentGuard, documentAction('SUSPEND'));

  /** The requirement matrix: every rule version in force or being drafted. */
  app.get('/rules', { preHandler: requireAudit(AuditPermission.RULE_READ) }, async (request, reply) => {
    const q = z.object({ status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETIRED']).optional(), categoryId: id.optional(), search: z.string().trim().max(120).optional() }).parse(request.query);
    return noStore(reply).send({ rules: await listRequirements({ status: q.status ?? null, categoryId: q.categoryId ?? null, search: q.search ?? null }) });
  });

  /** Rule coverage by real category: approved, waiting and unresolved rules, and categories that still need review. */
  app.get('/rules/coverage', { preHandler: requireAudit(AuditPermission.RULE_READ) }, async (_request, reply) =>
    noStore(reply).send({ categories: await ruleCoverage() }));

  /** One rule version, its other versions and its approval history. */
  app.get('/rules/:id', { preHandler: requireAudit(AuditPermission.RULE_READ) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    return noStore(reply).send(await requirementDetail(ruleId));
  });

  /** Draft a new rule. It decides nothing until a supervisor who did not draft it approves it. */
  app.post('/rules', { preHandler: requireAudit(AuditPermission.RULE_DRAFT) }, async (request, reply) =>
    reply.status(201).send(await draftRequirement(actorOf(request), requirementInput.parse(request.body))));

  /** Load the dated regulatory research as draft rules, once. Codes already present are left alone. */
  app.post('/rules/import-research', { preHandler: requireAudit(AuditPermission.RULE_DRAFT) }, async (request, reply) =>
    reply.send(await importResearchDrafts(actorOf(request))));

  /** Change a draft. */
  app.put('/rules/:id', { preHandler: requireAudit(AuditPermission.RULE_DRAFT) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    const body = requirementInput.extend({ lockVersion: z.number().int().min(0) }).parse(request.body);
    const { lockVersion, ...input } = body;
    await updateDraft(actorOf(request), ruleId, input, lockVersion);
    return reply.send({ ok: true });
  });

  /** Send a draft for approval. */
  app.post('/rules/:id/submit', { preHandler: requireAudit(AuditPermission.RULE_DRAFT) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    await submitRequirement(actorOf(request), ruleId);
    return reply.send({ ok: true });
  });

  /** Approve a submitted rule (never one you drafted). Retires the version it replaces. */
  app.post('/rules/:id/approve', { preHandler: requireAudit(AuditPermission.RULE_APPROVE) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    await decideRequirement(actorOf(request), ruleId, { decision: 'APPROVE', note: z.object({ note: text(4000) }).parse(request.body).note });
    return reply.send({ ok: true });
  });

  /** Reject a submitted rule, with what is wrong. */
  app.post('/rules/:id/reject', { preHandler: requireAudit(AuditPermission.RULE_APPROVE) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    await decideRequirement(actorOf(request), ruleId, { decision: 'REJECT', note: z.object({ note: text(4000) }).parse(request.body).note });
    return reply.send({ ok: true });
  });

  /** Draft a new version of a rule. */
  app.post('/rules/:id/revise', { preHandler: requireAudit(AuditPermission.RULE_DRAFT) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    return reply.status(201).send(await reviseRequirement(actorOf(request), ruleId));
  });

  /** Withdraw a rule, with the reason. */
  app.post('/rules/:id/retire', { preHandler: requireAudit(AuditPermission.RULE_APPROVE) }, async (request, reply) => {
    const { id: ruleId } = idParam.parse(request.params);
    await retireRequirement(actorOf(request), ruleId, z.object({ reason: text(2000) }).parse(request.body).reason);
    return reply.send({ ok: true });
  });

  // --- Seller verification ---------------------------------------------------
  //
  // The Audit Team owns seller onboarding verification. Reads need
  // audit.seller.read; every decision needs audit.seller.verify, which only
  // audit staff roles carry - never an inspection agency. The decisions run
  // through the same services the Admin Panel used to call, so the state
  // machine, the evidence gate and the audit trail are unchanged; each one is
  // recorded with actor type AUDIT and the reviewer's own user id. The Admin
  // Panel reads the same records and is refused every write.

  const applicationStatus = z.enum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED']);

  // Seller applications a page at a time, oldest submission first, with a count per status. resubmitted=true is the queue of applications sent back after corrections.
  app.get('/seller-verification', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const q = z
      .object({
        status: applicationStatus.nullish(),
        resubmitted: z.enum(['true', 'false']).optional(),
        search: z.string().trim().max(200).nullish(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);
    return noStore(reply).send(
      await listApplications({ status: q.status ?? null, search: q.search ?? null, resubmitted: q.resubmitted === 'true', page: q.page, pageSize: q.pageSize }),
    );
  });

  // One application in full: business details, documents, ownership and screenings, turnover, what approval is still waiting for, and the verification history with who decided each step.
  app.get('/seller-verification/:id', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const { id: sellerAccountId } = idParam.parse(request.params);
    const [application, readiness, turnover] = await Promise.all([
      readApplication(sellerAccountId),
      approvalReadiness(sellerAccountId),
      readTurnoverReview(sellerAccountId),
    ]);
    return noStore(reply).send({ application, readiness, turnover });
  });

  // Decide an application: take it for review, ask for corrections, approve or reject. A reason the seller sees is required to ask for corrections or reject; the version read is required so a decision made meanwhile is never overwritten. Approval still runs the evidence gate.
  app.post('/seller-verification/:id/decision', { preHandler: requireAudit(AuditPermission.SELLER_VERIFY) }, async (request, reply) => {
    const { id: sellerAccountId } = idParam.parse(request.params);
    const member = currentAudit(request);
    const body = z
      .object({
        status: z.enum(['UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED']),
        /** Seller-visible. */
        reason: z.string().trim().max(4000).nullable().optional(),
        /** Never serialised to a seller route. */
        internalNote: z.string().trim().max(4000).nullable().optional(),
        resubmissionAllowed: z.boolean().optional(),
        expectedVersion: z.number().int().min(0),
      })
      .parse(request.body);

    if ((body.status === 'ACTION_REQUIRED' || body.status === 'REJECTED') && (body.reason ?? '').trim().length < 3) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the reason the seller will see.', [{ field: 'reason', code: 'REQUIRED' }]);
    }
    const current = await prisma.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { status: true } });
    if (current === null) throw notFound('Seller application');
    // Lifting a suspension is an operational control that stays in the Admin Panel.
    if (current.status === 'SUSPENDED' && body.status === 'APPROVED') {
      throw conflict(ErrorCode.SELLER_APPLICATION_TRANSITION_NOT_ALLOWED, 'A suspension is lifted in the Admin Panel, not here.');
    }
    await assertIndependentReviewer(sellerAccountId, member.email);

    await decideApplication({
      sellerAccountId,
      to: body.status,
      reason: body.reason ?? null,
      internalNote: body.internalNote ?? null,
      adminUserId: member.userId,
      actorType: 'AUDIT',
      ...(body.resubmissionAllowed === undefined ? {} : { resubmissionAllowed: body.resubmissionAllowed }),
      correlationId: request.correlationId,
      expectedVersion: body.expectedVersion,
    });
    return reply.status(204).send();
  });

  // Record a manual sanctions / restricted-party screening of the business or one owner: which lists were checked, the result and a note. Always recorded as a person's check, never an automated one.
  app.post('/seller-verification/:id/screening', { preHandler: requireAudit(AuditPermission.SELLER_VERIFY) }, async (request, reply) => {
    const { id: sellerAccountId } = idParam.parse(request.params);
    const member = currentAudit(request);
    const body = z
      .object({
        subjectType: z.enum(['ENTITY', 'BENEFICIAL_OWNER']),
        beneficialOwnerId: id.nullable().optional(),
        result: z.enum(['CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH']),
        listsChecked: z.string().trim().min(2).max(512),
        note: z.string().trim().max(4000).nullable().optional(),
      })
      .parse(request.body);
    await assertIndependentReviewer(sellerAccountId, member.email);
    const screening = await recordScreening({
      sellerAccountId,
      subjectType: body.subjectType,
      beneficialOwnerId: body.beneficialOwnerId ?? null,
      result: body.result,
      listsChecked: body.listsChecked,
      note: body.note ?? null,
      adminUserId: member.userId,
      actorType: 'AUDIT',
      correlationId: request.correlationId,
    });
    return noStore(reply).status(201).send(screening);
  });

  // Verify or refuse the seller's current turnover declaration, with a reason the seller sees. Refused when the seller changed it, or another reviewer decided it, since it was loaded. Never approves the seller.
  app.post('/seller-verification/:id/turnover/decision', { preHandler: requireAudit(AuditPermission.SELLER_VERIFY) }, async (request, reply) => {
    const { id: sellerAccountId } = idParam.parse(request.params);
    const member = currentAudit(request);
    const body = z
      .object({
        declarationId: id,
        decision: z.enum(['VERIFIED', 'FAILED']),
        reason: z.string().trim().min(3).max(4000),
        internalNote: z.string().trim().max(4000).nullable().optional(),
        /** The state on the reviewer's screen. A declaration decided since is refused. */
        expectedVerificationState: z.string().trim().min(1).max(40),
      })
      .parse(request.body);
    await assertIndependentReviewer(sellerAccountId, member.email);
    const review = await decideTurnover({
      sellerAccountId,
      declarationId: body.declarationId,
      decision: body.decision,
      reason: body.reason,
      internalNote: body.internalNote ?? null,
      adminUserId: member.userId,
      adminEmail: member.email,
      actorType: 'AUDIT',
      expectedVerificationState: body.expectedVerificationState,
      correlationId: request.correlationId,
    });
    return noStore(reply).send(review);
  });

  // One onboarding document's file, as an attachment. Scanned files only; every read is audited.
  app.get('/seller-verification/documents/:id/file', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    assertStaffDataRegion(request);
    const file = await readSellerDocumentForAudit(documentId, { userId: currentAudit(request).userId, correlationId: request.correlationId });
    return sendAttachment(noStore(reply), file);
  });

  // Accept or refuse one onboarding document. A refusal needs a reason the seller sees; a document decided by somebody else meanwhile is refused with SELLER_STALE_VERSION.
  app.post('/seller-verification/documents/:id/decision', { preHandler: requireAudit(AuditPermission.SELLER_VERIFY) }, async (request, reply) => {
    const { id: documentId } = idParam.parse(request.params);
    const member = currentAudit(request);
    const body = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED']),
        reason: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(request.body);
    await assertIndependentReviewer(await sellerOfCurrentDocument(documentId), member.email);
    await decideSellerDocument({
      documentId,
      decision: body.decision,
      reason: body.reason ?? null,
      adminUserId: member.userId,
      actorType: 'AUDIT',
      correlationId: request.correlationId,
    });
    return reply.status(204).send();
  });

  return Promise.resolve();
}
