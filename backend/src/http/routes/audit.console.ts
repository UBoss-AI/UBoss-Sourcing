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
import { ErrorCode, forbidden, notFound } from '../../domain/errors.js';
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
import { getUserLanguage } from '../../modules/identity/language.service.js';
import { currentUser } from '../plugins/auth.js';
import { currentAudit, requireAudit, requireAuditAny, requireAuditSession } from '../plugins/audit.js';
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

  /** Sellers, with their qualification and document counts. */
  app.get('/sellers', { preHandler: requireAudit(AuditPermission.SELLER_READ) }, async (request, reply) => {
    const q = z.object({ search: z.string().trim().max(120).optional(), status: z.string().max(40).optional() }).parse(request.query);
    return noStore(reply).send({ sellers: await consoleSellers({ search: q.search ?? null, status: q.status ?? null }), backfill: await backfillList(100) });
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

  return Promise.resolve();
}
