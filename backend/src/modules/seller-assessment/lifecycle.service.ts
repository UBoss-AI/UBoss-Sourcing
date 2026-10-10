/**
 * After (and around) release: policy versions and their adoption, suspension
 * notices and the placed orders they catch, appeals, change requests,
 * incidents, bank-account changes, surveillance, legacy sellers, retention and
 * legal holds.
 *
 * Nothing here restores selling by itself. Reinstatement is a new assessment
 * and a new independent release with a current certificate.
 */
import {
  ASSESSMENT_CAPABILITIES,
  CHANGE_KINDS,
  DRAFT_POLICY_DEFAULTS,
  HARD_STOPS,
  RETENTION_CATEGORIES,
  addBusinessDays,
  appealDeadline,
  canMoveApproval,
  dueReminders,
  policyConfigProblems,
  retentionYears,
  type AssessmentCapability,
  type AssessmentPolicyConfig,
  type ChangeKind,
  type DispositionStatus,
  type HardStop,
} from '../../domain/seller-assessment.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { seedRows } from './application.service.js';
import {
  independenceRefused,
  nextNumber,
  notAllowed,
  participants,
  policyInForce,
  requireCapability,
  toJsonValue,
  writeEvent,
  assertVersion,
  type AssessmentActor,
  type SellerActor,
} from './context.js';
import { evaluateScope, gateMode, holdForDisposition } from './purchase-gate.service.js';

// --- Policy versions ------------------------------------------------------------

export async function listPolicies() {
  const rows = await prisma.sellerAssessmentPolicy.findMany({ orderBy: { createdAt: 'desc' } });
  const inForce = await policyInForce(prisma);
  return { inForce: { version: inForce.version, status: inForce.status }, gateMode: gateMode(), versions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), effectiveFrom: r.effectiveFrom?.toISOString() ?? null, adoptedAt: r.adoptedAt?.toISOString() ?? null, disclosedAt: r.disclosedAt?.toISOString() ?? null, retiredAt: r.retiredAt?.toISOString() ?? null })) };
}

/** Draft a new version. Mandatory controls are not in the config and cannot be relaxed by one. */
export async function draftPolicy(actor: AssessmentActor, input: { version: string; config: AssessmentPolicyConfig; note: string }) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE');
  const config = { ...DRAFT_POLICY_DEFAULTS, ...input.config };
  const problems = policyConfigProblems(config);
  if (problems.length > 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'This policy relaxes a control past what the source document allows.', problems.map((p) => ({ field: 'config', code: p })));
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerAssessmentPolicy.create({ data: { id, version: input.version, status: 'DRAFT', configJson: toJsonValue(config), sourceDocument: 'Seller Assessment and Onboarding Process and Checklist', note: input.note, createdByUserId: actor.userId } });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_POLICY_CHANGED, resourceType: 'SellerAssessmentPolicy', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { version: input.version, status: 'DRAFT', capability } }, tx);
  });
  return { id };
}

/**
 * Record adoption. The software records who entered it and the reference to
 * the actual authority (board minute, policy register entry) - it never
 * invents a name, signature or approval.
 */
export async function adoptPolicy(actor: AssessmentActor, id: string, input: { adoptionReference: string; effectiveFrom: string; disclosureReference: string | null; disclosedAt: string | null }) {
  requireCapability(actor, 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerAssessmentPolicy.findUnique({ where: { id } });
    if (row === null) throw notFound('Policy');
    if (row.status !== 'DRAFT') notAllowed('Only a draft can be adopted.');
    if (row.createdByUserId === actor.userId) independenceRefused('Recording adoption of a policy version');
    await tx.sellerAssessmentPolicy.update({ where: { id }, data: { status: 'ADOPTED', adoptedByUserId: actor.userId, adoptedAt: new Date(), adoptionReference: input.adoptionReference, effectiveFrom: new Date(input.effectiveFrom), disclosureReference: input.disclosureReference, disclosedAt: input.disclosedAt === null ? null : new Date(input.disclosedAt) } });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_POLICY_CHANGED, resourceType: 'SellerAssessmentPolicy', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { version: row.version, status: 'ADOPTED', effectiveFrom: input.effectiveFrom, adoptionReference: input.adoptionReference } }, tx);
  });
}

export async function disclosePolicy(actor: AssessmentActor, id: string, input: { disclosureReference: string; disclosedAt: string }) {
  requireCapability(actor, 'HEAD_OF_ASSURANCE');
  const row = await prisma.sellerAssessmentPolicy.findUnique({ where: { id } });
  if (row === null) throw notFound('Policy');
  if (row.status !== 'ADOPTED') notAllowed('Only an adopted version is disclosed.');
  await prisma.sellerAssessmentPolicy.update({ where: { id }, data: { disclosureReference: input.disclosureReference, disclosedAt: new Date(input.disclosedAt) } });
  await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_POLICY_CHANGED, resourceType: 'SellerAssessmentPolicy', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { version: row.version, disclosed: input.disclosureReference } });
}

// --- Capabilities (granted by the Head of Seller Assurance) ------------------

export async function setCapabilities(actor: AssessmentActor, staffUserId: string, capabilities: AssessmentCapability[]) {
  requireCapability(actor, 'HEAD_OF_ASSURANCE');
  const clean = ASSESSMENT_CAPABILITIES.filter((c) => capabilities.includes(c));
  // Nobody grants themselves a capability, and the last Head of Seller Assurance cannot remove their own.
  if (staffUserId === actor.userId) independenceRefused('Changing your own assessment capabilities');
  const member = await prisma.auditStaffMember.findUnique({ where: { userId: staffUserId } });
  if (member === null || member.status !== 'ACTIVE') throw notFound('Audit staff member');
  await prisma.auditStaffMember.update({ where: { userId: staffUserId }, data: { assessmentCapabilitiesJson: clean } });
  await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_CAPABILITY_CHANGED, resourceType: 'AuditStaffMember', resourceId: member.id, actorType: 'AUDIT', actorUserId: actor.userId, before: { capabilities: member.assessmentCapabilitiesJson ?? [] }, after: { capabilities: clean } });
}

export async function listStaffCapabilities() {
  const rows = await prisma.auditStaffMember.findMany({ where: { status: 'ACTIVE' }, select: { userId: true, fullName: true, role: true, assessmentCapabilitiesJson: true }, orderBy: { fullName: 'asc' } });
  return rows.map((r) => ({ userId: r.userId, fullName: r.fullName, role: r.role, capabilities: Array.isArray(r.assessmentCapabilitiesJson) ? r.assessmentCapabilitiesJson : [] }));
}

// --- Suspension and notices (Section 12) -----------------------------------------

/**
 * Suspend (all, or named scope rows). Unsafe or unauthorised scope is blocked
 * immediately. Keeping the rest active needs a documented risk-containment
 * note. Placed, undispatched orders in the blocked scope are held for a
 * disposition - not shipped, cancelled or refunded by the software.
 */
export async function suspend(
  actor: AssessmentActor,
  approvalId: string,
  input: { kind: 'SUSPENSION' | 'RESTRICTION' | 'REVOCATION'; hardStop: HardStop | null; scopeIds: string[] | null; reason: string; shareableEvidence: string; settlementTreatment: string; correctiveActions: string; reviewRoute: string; riskContainmentNote: string | null },
) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE', 'ASSESS', 'REGULATORY');
  if (input.hardStop !== null && !HARD_STOPS.includes(input.hardStop)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown hard stop.');
  if (input.scopeIds !== null && (input.riskContainmentNote ?? '').trim().length < 20) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Keeping other scope active needs a documented risk-containment note.', [{ field: 'riskContainmentNote', code: 'REQUIRED' }]);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM seller_trading_approvals WHERE id = ${approvalId} FOR UPDATE`;
    const approval = await tx.sellerTradingApproval.findUnique({ where: { id: approvalId }, include: { scopes: true } });
    if (approval === null) throw notFound('Trading approval');
    const whole = input.scopeIds === null;
    const target = whole ? approval.scopes : approval.scopes.filter((s) => input.scopeIds?.includes(s.id));
    if (target.length === 0) notAllowed('Name at least one scope row of this approval.');
    const now = new Date();
    await tx.sellerTradingApprovalScope.updateMany({ where: { id: { in: target.map((s) => s.id) } }, data: { status: 'BLOCKED', blockedAt: now, blockedReason: input.reason.slice(0, 2000) } });
    const to = input.kind === 'REVOCATION' ? 'REVOKED' : 'SUSPENDED';
    if (whole && canMoveApproval(approval.status, to)) await tx.sellerTradingApproval.update({ where: { id: approvalId }, data: { status: to, statusChangedAt: now, statusReason: input.reason.slice(0, 2000) } });
    const policy = await policyInForce(tx);
    // Placed seller orders not yet dispatched that carry a blocked offer.
    const offerIds = target.map((s) => s.offerId).filter((v): v is string => v !== null);
    const groups = await tx.sellerOrderGroup.findMany({
      where: { sellerAccountId: approval.sellerAccountId, status: { in: ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] }, ...(whole ? {} : { lines: { some: { offerId: { in: offerIds } } } }) },
      select: { id: true, orderId: true, order: { select: { orderNumber: true } } },
      take: 500,
    });
    const noticeId = newId();
    const number = await nextNumber(tx, 'SAN', 'seller-assessment-notice');
    await tx.sellerAssessmentNotice.create({
      data: {
        id: noticeId,
        number,
        sellerAccountId: approval.sellerAccountId,
        approvalId,
        assessmentId: approval.assessmentId,
        kind: input.kind,
        hardStop: input.hardStop,
        scopeIdsJson: target.map((s) => s.id),
        wholeSeller: whole,
        reason: input.reason,
        shareableEvidence: input.shareableEvidence,
        affectedOrdersJson: groups.map((g) => g.order.orderNumber),
        settlementTreatment: input.settlementTreatment,
        correctiveActions: input.correctiveActions,
        reviewRoute: input.reviewRoute,
        issuedByUserId: actor.userId,
        issuedAt: now,
        appealDeadline: appealDeadline(now, policy.config.appealWindowCalendarDays),
      },
    });
    for (const g of groups) await holdForDisposition(tx, { sellerOrderGroupId: g.id, orderId: g.orderId, sellerAccountId: approval.sellerAccountId, trigger: 'SUSPENSION', triggerKey: `notice:${noticeId}`, reason: `Notice ${number}: ${input.reason}`, noticeId });
    await writeEvent(tx, { sellerAccountId: approval.sellerAccountId, assessmentId: approval.assessmentId, subjectType: 'NOTICE', subjectId: noticeId, kind: 'SUSPENDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason, policyVersion: policy.version, data: { number, kind: input.kind, hardStop: input.hardStop, scopes: target.length, whole, riskContainment: input.riskContainmentNote, orders: groups.length } });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_SUSPENDED, resourceType: 'SellerTradingApproval', resourceId: approvalId, actorType: 'AUDIT', actorUserId: actor.userId, after: { notice: number, kind: input.kind, scopes: target.length, orders: groups.length } }, tx);
    await notifySeller({ sellerAccountId: approval.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `Notice ${number}: ${input.kind.toLowerCase()}`, body: `${input.reason.slice(0, 300)} You may appeal within ${String(policy.config.appealWindowCalendarDays)} days.`, linkPath: '/seller/assessment', severity: 'CRITICAL', tx });
    return { id: noticeId, number, heldOrders: groups.length };
  });
}

export async function decideDisposition(actor: AssessmentActor, id: string, input: { status: Exclude<DispositionStatus, 'PENDING_REVIEW'>; note: string }) {
  const capability = requireCapability(actor, 'REGULATORY', 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerOrderDisposition.findUnique({ where: { id } });
    if (row === null) throw notFound('Disposition');
    await tx.sellerOrderDisposition.update({ where: { id }, data: { status: input.status, decidedByUserId: actor.userId, decidedAt: new Date(), decisionNote: input.note } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, subjectType: 'DISPOSITION', subjectId: id, kind: 'DISPOSITION_DECIDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.note, data: { status: input.status, orderId: row.orderId } });
    await recordAudit({ action: AuditAction.SELLER_ORDER_DISPOSITION_DECIDED, resourceType: 'SellerOrderDisposition', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { status: input.status } }, tx);
  });
}

export async function listDispositions(status: string | null) {
  const rows = await prisma.sellerOrderDisposition.findMany({ where: status ? { status } : { status: { not: 'RELEASE_APPROVED' } }, orderBy: { createdAt: 'desc' }, take: 200 });
  const groups = await prisma.sellerOrderGroup.findMany({ where: { id: { in: rows.map((r) => r.sellerOrderGroupId) } }, select: { id: true, sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, sellerOrderNumber: groups.find((g) => g.id === r.sellerOrderGroupId)?.sellerOrderNumber ?? null, seller: groups.find((g) => g.id === r.sellerOrderGroupId)?.sellerAccount.displayName ?? null }));
}

// --- Appeals --------------------------------------------------------------------

export async function submitAppeal(seller: SellerActor, noticeId: string, input: { grounds: string; evidenceRef: string | null }) {
  return prisma.$transaction(async (tx) => {
    const notice = await tx.sellerAssessmentNotice.findFirst({ where: { id: noticeId, sellerAccountId: seller.sellerAccountId } });
    if (notice === null) throw notFound('Notice');
    if (Date.now() > notice.appealDeadline.getTime()) notAllowed('The appeal window for this notice has closed.', [{ field: 'noticeId', code: 'APPEAL_WINDOW_CLOSED' }]);
    const open = await tx.sellerAssessmentAppeal.findFirst({ where: { noticeId, status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } });
    if (open !== null) return { id: open.id };
    const policy = await policyInForce(tx);
    const now = new Date();
    const id = newId();
    await tx.sellerAssessmentAppeal.create({ data: { id, noticeId, sellerAccountId: seller.sellerAccountId, grounds: input.grounds, evidenceRef: input.evidenceRef, submittedByProfileId: seller.profileId, submittedAt: now, targetBy: addBusinessDays(now, policy.config.appealTargetBusinessDays) } });
    await writeEvent(tx, { sellerAccountId: seller.sellerAccountId, assessmentId: notice.assessmentId, subjectType: 'APPEAL', subjectId: id, kind: 'APPEAL_SUBMITTED', actorUserId: seller.profileId, actorRole: 'SELLER', reason: input.grounds });
    return { id };
  });
}

/**
 * Decided by somebody uninvolved in the original decision. An appeal never
 * restores selling: an upheld appeal says reinstatement needs revalidation and
 * a current certificate - i.e. a new reassessment and release.
 */
export async function decideAppeal(actor: AssessmentActor, id: string, input: { status: 'UPHELD' | 'OVERTURNED' | 'PARTIALLY_UPHELD'; outcomeReason: string }) {
  const capability = requireCapability(actor, 'APPEAL_REVIEW');
  await prisma.$transaction(async (tx) => {
    const appeal = await tx.sellerAssessmentAppeal.findUnique({ where: { id }, include: { notice: true } });
    if (appeal === null) throw notFound('Appeal');
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(appeal.status)) notAllowed('This appeal is decided.');
    const involved = appeal.notice.assessmentId === null ? new Set<string>() : await participants(tx, appeal.notice.assessmentId);
    involved.add(appeal.notice.issuedByUserId);
    if (involved.has(actor.userId)) independenceRefused('The appeal reviewer');
    await tx.sellerAssessmentAppeal.update({ where: { id }, data: { status: input.status, outcomeReason: input.outcomeReason, reviewerUserId: actor.userId, decidedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: appeal.sellerAccountId, assessmentId: appeal.notice.assessmentId, subjectType: 'APPEAL', subjectId: id, kind: 'APPEAL_DECIDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.outcomeReason, data: { status: input.status, restoresSelling: false } });
    await notifySeller({ sellerAccountId: appeal.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `Appeal on ${appeal.notice.number}: ${input.status.toLowerCase().replace('_', ' ')}`, body: `${input.outcomeReason.slice(0, 300)} Selling is restored only after revalidation and a current independent certificate.`, linkPath: '/seller/assessment', tx });
  });
}

// --- Change requests and incidents (Section 6) ---------------------------------

export async function submitChange(seller: SellerActor, input: { kind: ChangeKind; description: string; plannedFrom: string | null }) {
  if (!CHANGE_KINDS.includes(input.kind)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown change.');
  const approval = await prisma.sellerTradingApproval.findFirst({ where: { sellerAccountId: seller.sellerAccountId, status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' } });
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerAssessmentChangeRequest.create({ data: { id, sellerAccountId: seller.sellerAccountId, approvalId: approval?.id ?? null, kind: input.kind, description: input.description, plannedFrom: input.plannedFrom === null ? null : new Date(`${input.plannedFrom}T00:00:00Z`), submittedByProfileId: seller.profileId } });
    await writeEvent(tx, { sellerAccountId: seller.sellerAccountId, subjectType: 'CHANGE', subjectId: id, kind: 'CHANGE_SUBMITTED', actorUserId: seller.profileId, actorRole: 'SELLER', reason: input.description, data: { kind: input.kind } });
  });
  return { id };
}

/** Audit records a change it found that was never notified - itself a hard stop. */
export async function recordUndisclosedChange(actor: AssessmentActor, sellerAccountId: string, input: { kind: ChangeKind; description: string }) {
  const capability = requireCapability(actor, 'ASSESS', 'REGULATORY', 'HEAD_OF_ASSURANCE');
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerAssessmentChangeRequest.create({ data: { id, sellerAccountId, kind: input.kind, description: input.description, undisclosed: true, recordedByUserId: actor.userId, status: 'NEEDS_REASSESSMENT' } });
    await writeEvent(tx, { sellerAccountId, subjectType: 'CHANGE', subjectId: id, kind: 'UNDISCLOSED_CHANGE_RECORDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.description, data: { kind: input.kind, hardStop: 'UNDISCLOSED_MANUFACTURING_CHANGE' } });
  });
  return { id };
}

/** Approving a change never adds scope: a new product or country needs an EXTENSION assessment. */
export async function decideChange(actor: AssessmentActor, id: string, input: { status: 'APPROVED' | 'REJECTED' | 'NEEDS_REASSESSMENT'; reason: string }) {
  const capability = requireCapability(actor, 'ASSESS', 'REGULATORY', 'HEAD_OF_ASSURANCE');
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerAssessmentChangeRequest.findUnique({ where: { id } });
    if (row === null) throw notFound('Change request');
    if ((row.kind === 'NEW_PRODUCT' || row.kind === 'COUNTRY') && input.status === 'APPROVED') notAllowed('A new product or country needs a documented extension assessment, not a change approval.');
    await tx.sellerAssessmentChangeRequest.update({ where: { id }, data: { status: input.status, reviewerUserId: actor.userId, decisionReason: input.reason, decidedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, subjectType: 'CHANGE', subjectId: id, kind: 'CHANGE_DECIDED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason, data: { status: input.status } });
  });
}

export async function reportIncident(seller: SellerActor, input: { severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; description: string; affectedProducts: string | null; awareAt: string; statutoryDeadlineHours: number | null }) {
  const policy = await policyInForce(prisma);
  const aware = new Date(input.awareAt);
  const now = new Date();
  if (aware.getTime() > now.getTime()) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Awareness time cannot be in the future.', [{ field: 'awareAt', code: 'FUTURE' }]);
  // A shorter statutory deadline controls.
  const deadline = Math.min(policy.config.incidentReportHours, input.statutoryDeadlineHours ?? Number.POSITIVE_INFINITY);
  const late = now.getTime() - aware.getTime() > deadline * 3_600_000;
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerIncidentReport.create({ data: { id, sellerAccountId: seller.sellerAccountId, severity: input.severity, description: input.description, affectedProducts: input.affectedProducts, awareAt: aware, reportedAt: now, deadlineHours: deadline, statutoryDeadlineHours: input.statutoryDeadlineHours, late, submittedByProfileId: seller.profileId } });
    await writeEvent(tx, { sellerAccountId: seller.sellerAccountId, subjectType: 'INCIDENT', subjectId: id, kind: 'INCIDENT_REPORTED', actorUserId: seller.profileId, actorRole: 'SELLER', reason: input.description, data: { severity: input.severity, late, deadlineHours: deadline } });
  });
  return { id, late, deadlineHours: deadline };
}

export async function reviewIncident(actor: AssessmentActor, id: string, input: { status: 'UNDER_REVIEW' | 'CLOSED'; note: string }) {
  const capability = requireCapability(actor, 'ASSESS', 'REGULATORY', 'HEAD_OF_ASSURANCE');
  const row = await prisma.sellerIncidentReport.findUnique({ where: { id } });
  if (row === null) throw notFound('Incident');
  await prisma.$transaction(async (tx) => {
    await tx.sellerIncidentReport.update({ where: { id }, data: { status: input.status, reviewNote: input.note, reviewerUserId: actor.userId, reviewedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, subjectType: 'INCIDENT', subjectId: id, kind: 'INCIDENT_REVIEWED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.note, data: { status: input.status } });
  });
}

// --- Bank beneficiary change: independent contact + dual approval --------------

export async function requestBankChange(seller: SellerActor, input: { beneficiaryName: string; accountLast4: string; bankCode: string; evidenceRef: string | null }) {
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerBankChangeRequest.create({ data: { id, sellerAccountId: seller.sellerAccountId, ...input, requestedByProfileId: seller.profileId, requestedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: seller.sellerAccountId, subjectType: 'BANK_CHANGE', subjectId: id, kind: 'BANK_CHANGE_REQUESTED', actorUserId: seller.profileId, actorRole: 'SELLER', data: { accountLast4: input.accountLast4 } });
  });
  return { id };
}

/**
 * Step 1 confirm the change with a contact known independently of the request
 * (never a number or address given in it). Steps 2 and 3: two different
 * Finance approvers. Payout details themselves are changed in the payment
 * provider; this records that the change was verified.
 */
export async function decideBankChange(actor: AssessmentActor, id: string, input: { step: 'CONFIRM_CONTACT' | 'APPROVE' | 'REJECT'; knownContactName?: string; knownContactSource?: string; reason: string; expectedVersion: number }) {
  const capability = requireCapability(actor, 'FINANCE');
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerBankChangeRequest.findUnique({ where: { id } });
    if (row === null) throw notFound('Bank change');
    assertVersion(row, input.expectedVersion);
    if (['APPROVED', 'REJECTED'].includes(row.status)) notAllowed('This change is decided.');
    const now = new Date();
    let data: Record<string, unknown>;
    if (input.step === 'REJECT') data = { status: 'REJECTED', reason: input.reason };
    else if (input.step === 'CONFIRM_CONTACT') {
      if (!input.knownContactName || !input.knownContactSource) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Name the known contact and where the contact details came from.', [{ field: 'knownContactSource', code: 'REQUIRED' }]);
      data = { knownContactName: input.knownContactName, knownContactSource: input.knownContactSource, contactConfirmedByUserId: actor.userId, contactConfirmedAt: now, status: 'CONTACT_CONFIRMED' };
    } else if (row.contactConfirmedAt === null) notAllowed('Confirm the change with the known independent contact first.');
    else if (row.firstApproverUserId === null) data = { firstApproverUserId: actor.userId, firstApprovedAt: now, status: 'FIRST_APPROVED' };
    else {
      if (row.firstApproverUserId === actor.userId) independenceRefused('The second approver of a bank change');
      data = { secondApproverUserId: actor.userId, secondApprovedAt: now, status: 'APPROVED' };
    }
    await tx.sellerBankChangeRequest.update({ where: { id }, data: { ...data!, version: { increment: 1 } } });
    await writeEvent(tx, { sellerAccountId: row.sellerAccountId, subjectType: 'BANK_CHANGE', subjectId: id, kind: `BANK_CHANGE_${input.step}`, actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.reason });
    await recordAudit({ action: AuditAction.SELLER_BANK_CHANGE_DECIDED, resourceType: 'SellerBankChangeRequest', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { step: input.step, status: (data! as { status: string }).status } }, tx);
  });
}

// --- Surveillance sweep (daily job) ------------------------------------------------

/**
 * Idempotent: every task and reminder has a dedupe key. Expiry is reported
 * here; it is enforced at the purchase gate on every request regardless.
 * Sanctions re-screening is a task for a person (or a configured provider) -
 * this never records a screening as clear.
 */
export async function sweepSurveillance(now = new Date()) {
  const policy = await policyInForce(prisma);
  const c = policy.config;
  let created = 0;
  const task = async (t: { sellerAccountId: string; approvalId: string | null; kind: string; subjectRef?: string | null; dueAt: Date; dedupeKey: string; note?: string }) => {
    const res = await prisma.sellerSurveillanceTask.createMany({ data: [{ id: newId(), sellerAccountId: t.sellerAccountId, approvalId: t.approvalId, kind: t.kind, subjectRef: t.subjectRef ?? null, dueAt: t.dueAt, dedupeKey: t.dedupeKey.slice(0, 160), note: t.note ?? null }], skipDuplicates: true });
    created += res.count;
    return res.count === 1;
  };
  const month = now.toISOString().slice(0, 7);
  const approvals = await prisma.sellerTradingApproval.findMany({ where: { status: 'ACTIVE' }, include: { scopes: { select: { productKey: true, scopeItemId: true } } } });
  let expired = 0;
  for (const a of approvals) {
    if (a.validUntil.getTime() <= now.getTime()) {
      const r = await prisma.sellerTradingApproval.updateMany({ where: { id: a.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', statusChangedAt: now, statusReason: 'Validity ended. No grace period for mandatory evidence.' } });
      expired += r.count;
      continue;
    }
    for (const days of dueReminders(a.validUntil, now, c.reminderDaysBeforeExpiry, [])) {
      if (await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'EXPIRY_REMINDER', subjectRef: `approval:${String(days)}`, dueAt: a.validUntil, dedupeKey: `reminder:approval:${a.id}:${String(days)}` })) {
        await notifySeller({ sellerAccountId: a.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `Trading approval ${a.number} ends in ${String(days)} days or fewer`, body: 'Start your renewal so your approved products stay purchasable.', linkPath: '/seller/assessment' });
      }
    }
    const cert = await prisma.sellerExternalCertification.findUnique({ where: { id: a.externalCertificationId } });
    if (cert?.expiresOn) for (const days of dueReminders(cert.expiresOn, now, c.reminderDaysBeforeExpiry, [])) await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'EXPIRY_REMINDER', subjectRef: `certificate:${String(days)}`, dueAt: cert.expiresOn, dedupeKey: `reminder:cert:${cert.id}:${String(days)}` });
    await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'CERTIFICATE_EXPIRY_CHECK', dueAt: now, dedupeKey: `cert-check:${a.id}:${month}` });
    await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'INSURANCE_EXPIRY_CHECK', dueAt: now, dedupeKey: `insurance-check:${a.id}:${month}` });
    const annual = new Date(Math.max(now.getTime(), a.validUntil.getTime() - 90 * 86_400_000));
    await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'TURNOVER_REVALIDATION', dueAt: annual, dedupeKey: `turnover:${a.id}` });
    await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'OWNERSHIP_REVALIDATION', dueAt: annual, dedupeKey: `ownership:${a.id}` });
    const period = Math.floor(now.getTime() / (c.sanctionsRescreenDays * 86_400_000));
    await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'SANCTIONS_SCREENING', dueAt: now, dedupeKey: `sanctions:${a.sellerAccountId}:${String(period)}`, note: 'Manual screening unless a provider is configured. Record the lists and outcome.' });
    const items = await prisma.sellerAssessmentScopeItem.findMany({ where: { id: { in: a.scopes.map((s) => s.scopeItemId) } }, select: { catalogueCategory: true } });
    for (const cat of new Set(items.map((i) => i.catalogueCategory ?? '*'))) {
      const months = c.surveillanceMonthsByCategory[cat] ?? c.surveillanceMonthsByCategory['*'] ?? 12;
      const due = new Date(a.issuedAt.getTime() + months * 30 * 86_400_000);
      await task({ sellerAccountId: a.sellerAccountId, approvalId: a.id, kind: 'CATEGORY_SURVEILLANCE', subjectRef: cat.slice(0, 64), dueAt: due, dedupeKey: `surveillance:${a.id}:${cat}`.slice(0, 160) });
    }
  }
  const overdue = await prisma.sellerSurveillanceTask.updateMany({ where: { status: 'OPEN', dueAt: { lt: now }, kind: { not: 'EXPIRY_REMINDER' } }, data: { status: 'OVERDUE' } });
  return { created, expired, overdue: overdue.count };
}

export async function completeTask(actor: AssessmentActor, id: string, input: { outcome: 'SATISFACTORY' | 'ISSUE_FOUND'; note: string }) {
  const task = await prisma.sellerSurveillanceTask.findUnique({ where: { id } });
  if (task === null) throw notFound('Surveillance task');
  const capability = requireCapability(actor, ...(task.kind === 'TURNOVER_REVALIDATION' || task.kind === 'INSURANCE_EXPIRY_CHECK' ? (['FINANCE'] as const) : (['ASSESS', 'FINANCE', 'REGULATORY'] as const)));
  if (task.status === 'DONE') notAllowed('This task is done.');
  await prisma.$transaction(async (tx) => {
    await tx.sellerSurveillanceTask.update({ where: { id }, data: { status: 'DONE', outcome: input.outcome, note: input.note, completedByUserId: actor.userId, completedAt: new Date() } });
    await writeEvent(tx, { sellerAccountId: task.sellerAccountId, subjectType: 'SURVEILLANCE', subjectId: id, kind: 'SURVEILLANCE_DONE', actorUserId: actor.userId, actorRole: 'AUDIT', capability, reason: input.note, data: { kind: task.kind, outcome: input.outcome } });
  });
}

export async function listTasks(q: { status: string | null; sellerAccountId: string | null }) {
  const rows = await prisma.sellerSurveillanceTask.findMany({ where: { ...(q.status ? { status: q.status } : { status: { in: ['OPEN', 'OVERDUE'] } }), ...(q.sellerAccountId ? { sellerAccountId: q.sellerAccountId } : {}) }, orderBy: { dueAt: 'asc' }, take: 300 });
  return rows.map((r) => ({ ...r, dueAt: r.dueAt.toISOString(), createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null }));
}

// --- Legacy sellers and activation impact --------------------------------------

/**
 * Open a LEGACY_REASSESSMENT for every seller approved under the old process
 * that has no trading approval. Their history stays; nothing is converted into
 * a compliant approval and no certificate or reviewer evidence is invented.
 */
export async function startLegacyReassessments(actor: AssessmentActor) {
  const capability = requireCapability(actor, 'HEAD_OF_ASSURANCE');
  const sellers = await prisma.sellerAccount.findMany({ where: { status: 'APPROVED', archivedAt: null, tradingApprovals: { none: {} }, assessments: { none: { status: { notIn: ['DECLINED', 'WITHDRAWN'] } } } }, select: { id: true, legalName: true, approvedAt: true, kind: true } });
  const policy = await policyInForce(prisma);
  let opened = 0;
  for (const s of sellers) {
    await prisma.$transaction(async (tx) => {
      const id = newId();
      await tx.sellerAssessment.create({ data: { id, number: await nextNumber(tx, 'SAO', 'seller-assessment'), sellerAccountId: s.id, kind: 'LEGACY_REASSESSMENT', policyVersion: policy.version, applicationJson: toJsonValue({ entity: { legalName: s.legalName, country: 'IN' } }), legacyNote: `Approved under the earlier process on ${s.approvedAt?.toISOString().slice(0, 10) ?? 'unknown date'} as ${s.kind}. That decision is preserved in the seller history and is NOT a trading approval under policy ${policy.version}: no independent certificate or reviewer evidence is assumed.` } });
      await seedRows(tx, id);
      await writeEvent(tx, { sellerAccountId: s.id, assessmentId: id, subjectType: 'ASSESSMENT', subjectId: id, kind: 'LEGACY_REASSESSMENT_OPENED', actorUserId: actor.userId, actorRole: 'AUDIT', capability, policyVersion: policy.version });
      await notifySeller({ sellerAccountId: s.id, kind: 'SELLER_ASSESSMENT', title: 'Seller reassessment required', body: 'The marketplace has introduced a new seller assessment. Complete the application so your products stay purchasable once it is enforced.', linkPath: '/seller/assessment', tx });
    });
    opened += 1;
  }
  return { opened };
}

/** What switching the gate to 'enforce' would block today, per seller. Read before activation. */
export async function activationImpact() {
  const offers = await prisma.sellerOffer.findMany({ where: { status: 'ACTIVE', archivedAt: null, sellerAccount: { status: 'APPROVED' } }, select: { id: true, sellerAccountId: true, sellerAccount: { select: { displayName: true } } }, take: 5000 });
  const approvals = await prisma.sellerTradingApproval.findMany({ where: { status: 'ACTIVE', validUntil: { gt: new Date() } }, select: { sellerAccountId: true, scopes: { where: { status: 'ACTIVE' }, select: { offerId: true } } } });
  const bySeller = new Map<string, { seller: string; offers: number; covered: number; hasApproval: boolean }>();
  for (const o of offers) {
    const entry = bySeller.get(o.sellerAccountId) ?? { seller: o.sellerAccount.displayName, offers: 0, covered: 0, hasApproval: approvals.some((a) => a.sellerAccountId === o.sellerAccountId) };
    entry.offers += 1;
    if (approvals.some((a) => a.sellerAccountId === o.sellerAccountId && a.scopes.some((s) => s.offerId === o.id))) entry.covered += 1;
    bySeller.set(o.sellerAccountId, entry);
  }
  const rows = [...bySeller.entries()].map(([sellerAccountId, v]) => ({ sellerAccountId, ...v, wouldBlock: v.offers - v.covered }));
  const policy = await policyInForce(prisma);
  return { gateMode: gateMode(), policy: { version: policy.version, status: policy.status }, sellers: rows.length, activeOffers: offers.length, offersWithSomeScope: rows.reduce((n, r) => n + r.covered, 0), offersThatWouldBlock: rows.reduce((n, r) => n + r.wouldBlock, 0), note: 'Coverage is per offer; each offer is purchasable only for the exact countries and channels in its scope.', rows: rows.sort((a, b) => b.wouldBlock - a.wouldBlock) };
}

export { evaluateScope };

// --- Retention and legal holds (Section 7) ---------------------------------------

/**
 * Categories and their configured years. A category with no configured legal
 * value is reported as a configuration dependency; nothing is deleted on a
 * guessed date, and nothing under legal hold is ever deleted.
 */
export async function retentionReport() {
  const policy = await policyInForce(prisma);
  const counts = await prisma.sellerAssessmentEvidence.groupBy({ by: ['retentionCategory', 'legalHold'], _count: { _all: true } });
  return RETENTION_CATEGORIES.map((category) => {
    const years = retentionYears(category, policy.config, {});
    return {
      category,
      years,
      dependency: years === null ? 'Legal retention value not configured for this deployment: records are kept until it is.' : null,
      files: counts.filter((c) => c.retentionCategory === category).reduce((n, c) => n + c._count._all, 0),
      onLegalHold: counts.filter((c) => c.retentionCategory === category && c.legalHold).reduce((n, c) => n + c._count._all, 0),
    };
  });
}

export async function setLegalHold(actor: AssessmentActor, evidenceId: string, input: { hold: boolean; reason: string }) {
  requireCapability(actor, 'HEAD_OF_ASSURANCE', 'LEGAL');
  const row = await prisma.sellerAssessmentEvidence.findUnique({ where: { id: evidenceId } });
  if (row === null) throw notFound('Evidence');
  await prisma.$transaction(async (tx) => {
    await tx.sellerAssessmentEvidence.update({ where: { id: evidenceId }, data: { legalHold: input.hold, legalHoldReason: input.reason, legalHoldByUserId: actor.userId } });
    await recordAudit({ action: AuditAction.SELLER_ASSESSMENT_LEGAL_HOLD, resourceType: 'SellerAssessmentEvidence', resourceId: evidenceId, actorType: 'AUDIT', actorUserId: actor.userId, after: { hold: input.hold, reason: input.reason } }, tx);
  });
}

// --- Seller-facing lists ----------------------------------------------------------

export async function sellerOverview(seller: SellerActor) {
  const [assessments, approvals, notices, changes, incidents, bankChanges] = await Promise.all([
    prisma.sellerAssessment.findMany({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, kind: true, status: true, createdAt: true, correctionNote: true } }),
    prisma.sellerTradingApproval.findMany({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { issuedAt: 'desc' }, include: { scopes: true } }),
    prisma.sellerAssessmentNotice.findMany({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { issuedAt: 'desc' }, include: { appeals: true } }),
    prisma.sellerAssessmentChangeRequest.findMany({ where: { sellerAccountId: seller.sellerAccountId, undisclosed: false }, orderBy: { createdAt: 'desc' } }),
    prisma.sellerIncidentReport.findMany({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { reportedAt: 'desc' } }),
    prisma.sellerBankChangeRequest.findMany({ where: { sellerAccountId: seller.sellerAccountId }, orderBy: { requestedAt: 'desc' }, select: { id: true, beneficiaryName: true, accountLast4: true, status: true, requestedAt: true } }),
  ]);
  const now = Date.now();
  return {
    gateMode: gateMode(),
    assessments: assessments.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    approvals: approvals.map((a) => ({ id: a.id, number: a.number, status: a.status, issuedAt: a.issuedAt.toISOString(), validUntil: a.validUntil.toISOString(), nextReviewAt: a.nextReviewAt.toISOString(), renewalDue: a.validUntil.getTime() - now < 90 * 86_400_000, auditDocumentId: a.auditDocumentId, scopes: a.scopes.map((s) => ({ id: s.id, productKey: s.productKey, productVersion: s.productVersion, offerId: s.offerId, facilityRef: s.facilityRef, countryCode: s.countryCode, channel: s.channel, status: s.validUntil.getTime() <= now ? 'EXPIRED' : s.status, validUntil: s.validUntil.toISOString(), blockedReason: s.blockedReason })) })),
    notices: notices.map((n) => ({ id: n.id, number: n.number, kind: n.kind, reason: n.reason, shareableEvidence: n.shareableEvidence, affectedOrders: n.affectedOrdersJson ?? [], settlementTreatment: n.settlementTreatment, correctiveActions: n.correctiveActions, reviewRoute: n.reviewRoute, issuedAt: n.issuedAt.toISOString(), appealDeadline: n.appealDeadline.toISOString(), appealOpen: now <= n.appealDeadline.getTime(), appeals: n.appeals.map((a) => ({ id: a.id, status: a.status, submittedAt: a.submittedAt.toISOString(), targetBy: a.targetBy.toISOString(), outcomeReason: a.outcomeReason })) })),
    changes: changes.map((c) => ({ id: c.id, kind: c.kind, description: c.description, status: c.status, decisionReason: c.decisionReason, createdAt: c.createdAt.toISOString() })),
    incidents: incidents.map((i) => ({ id: i.id, severity: i.severity, description: i.description, reportedAt: i.reportedAt.toISOString(), late: i.late, deadlineHours: i.deadlineHours, status: i.status })),
    bankChanges: bankChanges.map((b) => ({ ...b, requestedAt: b.requestedAt.toISOString() })),
  };
}

export async function auditRegisters() {
  const [notices, appeals, changes, incidents, bankChanges] = await Promise.all([
    prisma.sellerAssessmentNotice.findMany({ orderBy: { issuedAt: 'desc' }, take: 200 }),
    prisma.sellerAssessmentAppeal.findMany({ orderBy: { submittedAt: 'desc' }, take: 200, include: { notice: { select: { number: true } } } }),
    prisma.sellerAssessmentChangeRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.sellerIncidentReport.findMany({ orderBy: { reportedAt: 'desc' }, take: 200 }),
    prisma.sellerBankChangeRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 200 }),
  ]);
  const sellers = await prisma.sellerAccount.findMany({ where: { id: { in: [...new Set([...notices, ...appeals, ...changes, ...incidents, ...bankChanges].map((r) => r.sellerAccountId))] } }, select: { id: true, displayName: true } });
  const sellerName = (id: string) => sellers.find((s) => s.id === id)?.displayName ?? id;
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    notices: notices.map((n) => ({ id: n.id, number: n.number, seller: sellerName(n.sellerAccountId), kind: n.kind, hardStop: n.hardStop, reason: n.reason, issuedAt: iso(n.issuedAt), appealDeadline: iso(n.appealDeadline), affectedOrders: n.affectedOrdersJson ?? [] })),
    appeals: appeals.map((a) => ({ id: a.id, notice: a.notice.number, seller: sellerName(a.sellerAccountId), grounds: a.grounds, status: a.status, submittedAt: iso(a.submittedAt), targetBy: iso(a.targetBy), overdue: ['SUBMITTED', 'UNDER_REVIEW'].includes(a.status) && a.targetBy.getTime() < Date.now() })),
    changes: changes.map((c) => ({ id: c.id, seller: sellerName(c.sellerAccountId), kind: c.kind, description: c.description, undisclosed: c.undisclosed, status: c.status, createdAt: iso(c.createdAt) })),
    incidents: incidents.map((i) => ({ id: i.id, seller: sellerName(i.sellerAccountId), severity: i.severity, description: i.description, late: i.late, deadlineHours: i.deadlineHours, status: i.status, reportedAt: iso(i.reportedAt) })),
    bankChanges: bankChanges.map((b) => ({ id: b.id, seller: sellerName(b.sellerAccountId), beneficiaryName: b.beneficiaryName, accountLast4: b.accountLast4, status: b.status, version: b.version, contactConfirmedAt: iso(b.contactConfirmedAt), firstApprovedAt: iso(b.firstApprovedAt), requestedAt: iso(b.requestedAt) })),
  };
}

export async function scopeCheck(lines: { sellerAccountId: string; offerId: string }[], countryCode: string, channel: 'B2B' | 'B2C') {
  const blocks = await evaluateScope(prisma, lines, countryCode, channel);
  return lines.map((l) => ({ ...l, block: blocks.get(l.offerId) ?? null }));
}
