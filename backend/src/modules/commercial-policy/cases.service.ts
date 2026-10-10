/**
 * Case administration on top of disputes (Doc 07 s6-s8).
 *
 * The published dispute contract (statuses, reasons, resolutions) is left as
 * it is. A case profile beside each claim adds what the policy asks for: the
 * category, urgency, market, affected quantity and lots; late intake with its
 * reason; the acknowledgement, evidence-sufficiency, initial-decision and
 * appeal-review clocks on an explicit calendar; proportionate evidence
 * requests (including the buyer's chance to answer material contrary
 * evidence); independent testing with interim and final cost allocation;
 * a reasoned decision with its remedies; an independent appeal reviewer.
 *
 * Clocks never reset silently: the decision clock starts when a named person
 * records WHY the evidence is sufficient, and that record is kept.
 * Gloviaa administers the platform case; it is not a tribunal deciding final
 * legal liability, and every view says so.
 */
import { env } from '../../config/env.js';
import {
  CATEGORY_REASON_CODE,
  DEFAULT_CASE_CALENDAR,
  REMEDY_KINDS,
  classifyIntake,
  isIndependentAppealReviewer,
  reasonedDecisionProblems,
  recoveryOverlap,
  windowByKey,
  windowDeadline,
  type AdministrativeWindow,
  type BusinessCalendar,
  type CaseCategory,
  type IntakeOutcome,
  type RemedyKind,
  type SalesChannel,
} from '../../domain/commercial-policy.js';
import { AppError, ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { Permission } from '../../domain/permissions.js';
import { AdminNotificationKind, createAdminNotification } from '../notifications/admin-notification.service.js';
import { consoleDisputePath } from '../disputes/dispute-common.js';
import { activeSchedule } from './schedules.service.js';
import { audit, separationRefusal, serialise, type Client, type StaffActor } from './shared.js';

export const LEGAL_NOTICE = 'The marketplace administers this platform case. It is not an arbitral tribunal and does not decide final legal liability. Courts, arbitration, regulators and payment-provider routes remain open.';

export interface CaseIntake {
  category: CaseCategory;
  urgency?: 'NORMAL' | 'URGENT';
  statutoryBasis?: boolean;
  lateExplanation?: string | null;
  affectedQuantity?: number | null;
  lotsOrSerials?: string[] | null;
}

/** The windows and calendar in force: an ACTIVE CASE_WINDOWS schedule, else Doc 07's proposed targets. */
export async function caseRules(client: Client): Promise<{ windows: readonly AdministrativeWindow[]; calendar: BusinessCalendar; adopted: boolean }> {
  const schedule = await activeSchedule(client, 'CASE_WINDOWS', { country: null, channel: 'B2C', sellerAccountId: null });
  if (schedule !== null) {
    const body = schedule.bodyJson as { windows?: AdministrativeWindow[]; calendar?: BusinessCalendar };
    if (body.windows && body.windows.length > 0) return { windows: body.windows, calendar: body.calendar ?? DEFAULT_CASE_CALENDAR, adopted: true };
  }
  const { DOC07_ADMINISTRATIVE_WINDOWS } = await import('../../domain/commercial-policy.js');
  return { windows: DOC07_ADMINISTRATIVE_WINDOWS, calendar: DEFAULT_CASE_CALENDAR, adopted: false };
}

/** Late intake decision for a claim whose ordinary window has passed. */
export async function classifyLateClaim(client: Client, input: { intake: CaseIntake | undefined; deliveredAt: Date | null; channel: SalesChannel; now: Date }): Promise<IntakeOutcome | null> {
  if (input.intake === undefined) return null;
  const rules = await caseRules(client);
  return classifyIntake({ category: input.intake.category, deliveredAt: input.deliveredAt, now: input.now, channel: input.channel, statutoryBasis: input.intake.statutoryBasis === true, technicalAcceptanceUntil: null, calendar: rules.calendar, windows: rules.windows });
}

/** The reason code a category files under, keeping the published reason list unchanged. */
export function reasonCodeFor(category: CaseCategory): string {
  return CATEGORY_REASON_CODE[category];
}

export async function createCaseProfile(tx: Client, input: { disputeId: string; intake: CaseIntake; market: string | null; channel: SalesChannel; late: IntakeOutcome | null; now: Date }): Promise<void> {
  const rules = await caseRules(tx);
  const lateReason = input.late?.kind === 'LATE_ACCEPTED_FOR_REVIEW' ? input.late.reason : null;
  await tx.disputeCaseProfile.create({
    data: {
      id: newId(),
      disputeId: input.disputeId,
      category: input.intake.category,
      urgency: input.intake.category === 'SAFETY' ? 'URGENT' : (input.intake.urgency ?? 'NORMAL'),
      market: input.market,
      channel: input.channel,
      affectedQuantity: input.intake.affectedQuantity ?? null,
      lotsOrSerialsJson: (input.intake.lotsOrSerials ?? null) as never,
      lateIntake: lateReason !== null,
      lateIntakeReason: lateReason,
      lateExplanation: input.intake.lateExplanation ?? null,
      statutoryBasis: input.intake.statutoryBasis === true,
      calendarTimeZone: rules.calendar.timeZone,
      acknowledgementDueAt: windowDeadline(windowByKey('ACKNOWLEDGEMENT', rules.windows), input.now, rules.calendar),
    },
  });
}

/** After a SAFETY case is filed: route it to the safety officer at once. Containment stays a person's decision. */
export async function routeSafetyCase(disputeId: string, actorUserId: string): Promise<void> {
  const d = await prisma.dispute.findUnique({ where: { id: disputeId }, select: { reference: true, description: true, sellerAccountId: true, orderItemId: true, orderItem: { select: { sellerOfferId: true, productId: true } } } });
  if (d === null) return;
  const { openSafetyCase } = await import('./safety.service.js');
  const scope = [
    ...(d.orderItem?.sellerOfferId ? [{ kind: 'OFFER' as const, ref: d.orderItem.sellerOfferId }] : []),
    ...(d.orderItem?.productId ? [{ kind: 'PRODUCT' as const, ref: d.orderItem.productId }] : []),
  ];
  const { id } = await openSafetyCase({ title: `Safety report from claim ${d.reference}`, description: d.description ?? '', severity: 'HIGH', sourceType: 'DISPUTE', sourceId: disputeId, sellerAccountId: d.sellerAccountId, scope }, { userId: actorUserId, actorType: 'CUSTOMER' });
  await createAdminNotification({ kind: AdminNotificationKind.DISPUTE_SLA_BREACHED, variables: { reference: d.reference, which: 'SAFETY' }, linkPath: consoleDisputePath(disputeId), requiredPermission: Permission.DISPUTE_VIEW, relatedType: 'dispute', relatedId: disputeId, dedupeKey: `safety-route:${disputeId}:${id}` }).catch((error: unknown) => {
    logger.error({ err: error, disputeId }, 'safety case notification failed');
  });
}

async function profileOf(client: Client, disputeId: string) {
  const p = await client.disputeCaseProfile.findUnique({ where: { disputeId } });
  if (p !== null) return p;
  // A claim filed before this feature, or without a category: give it a profile now, never back-dating its clocks.
  const rules = await caseRules(client);
  const now = new Date();
  return client.disputeCaseProfile.create({ data: { id: newId(), disputeId, category: 'DEFECT', calendarTimeZone: rules.calendar.timeZone, acknowledgementDueAt: windowDeadline(windowByKey('ACKNOWLEDGEMENT', rules.windows), now, rules.calendar) } });
}

export async function readCaseControls(disputeId: string) {
  const d = await prisma.dispute.findUnique({ where: { id: disputeId }, select: { id: true, reference: true, status: true, orderId: true, currency: true, decidedById: true, approvedById: true, proposedById: true } });
  if (d === null) throw notFound('Dispute');
  const profile = await profileOf(prisma, disputeId);
  const [requests, remedies, testing, recoveries] = await Promise.all([
    prisma.disputeEvidenceRequest.findMany({ where: { disputeId }, orderBy: { createdAt: 'asc' } }),
    prisma.disputeRemedyAction.findMany({ where: { disputeId }, orderBy: { createdAt: 'asc' } }),
    prisma.disputeTestingRecord.findMany({ where: { disputeId }, orderBy: { createdAt: 'asc' } }),
    prisma.lossRecovery.findMany({ where: { orderId: d.orderId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const rules = await caseRules(prisma);
  return serialise({ dispute: d, profile, requests, remedies, testing, recoveries, windows: rules.windows, calendar: rules.calendar, windowsAdopted: rules.adopted, remedyKinds: REMEDY_KINDS, legalNotice: LEGAL_NOTICE, gateMode: env.DELIVERY_POLICY_GATES });
}

/** What a buyer or seller may see of the case controls: no internal notes, no staff ids. */
export async function readPartyCaseControls(disputeId: string, side: 'BUYER' | 'SELLER') {
  const p = await prisma.disputeCaseProfile.findUnique({ where: { disputeId } });
  const requests = await prisma.disputeEvidenceRequest.findMany({ where: { disputeId, requestedFrom: side }, orderBy: { createdAt: 'asc' }, select: { id: true, purpose: true, description: true, dueAt: true, status: true, respondedAt: true } });
  const remedies = await prisma.disputeRemedyAction.findMany({ where: { disputeId }, select: { kind: true, amountMinor: true, currency: true, payer: true, returnFreightPayer: true, quantity: true, expectedCompletionAt: true, status: true, completedAt: true } });
  return serialise({
    category: p?.category ?? null,
    urgency: p?.urgency ?? null,
    lateIntake: p?.lateIntake ?? false,
    acknowledgedAt: p?.acknowledgedAt ?? null,
    initialDecisionDueAt: p?.initialDecisionDueAt ?? null,
    appealReviewDueAt: p?.appealReviewDueAt ?? null,
    reasoning: (p?.reasonedDecisionJson as { reasoning?: string } | null)?.reasoning ?? null,
    requests,
    remedies,
    legalNotice: LEGAL_NOTICE,
  });
}

export async function acknowledgeCase(disputeId: string, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const p = await profileOf(tx, disputeId);
    if (p.acknowledgedAt !== null) return;
    await tx.disputeCaseProfile.update({ where: { id: p.id }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.userId } });
    await audit(tx, actor, AuditAction.CASE_CONTROL_RECORDED, 'dispute', disputeId, null, { action: 'ACKNOWLEDGED' });
  });
}

/** Record why the evidence is sufficient. Starts the initial-decision clock, once; a second record never moves it. */
export async function markEvidenceSufficient(disputeId: string, reason: string, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const p = await profileOf(tx, disputeId);
    if (p.evidenceSufficientAt !== null) throw conflict(ErrorCode.CONFLICT, 'Sufficiency is already recorded; the decision clock is not reset.', [{ code: 'ALREADY_RECORDED' }]);
    const rules = await caseRules(tx);
    const now = new Date();
    await tx.disputeCaseProfile.update({ where: { id: p.id }, data: { evidenceSufficientAt: now, evidenceSufficientById: actor.userId, evidenceSufficientReason: reason, initialDecisionDueAt: windowDeadline(windowByKey('INITIAL_DECISION', rules.windows), now, rules.calendar) } });
    await audit(tx, actor, AuditAction.CASE_CONTROL_RECORDED, 'dispute', disputeId, null, { action: 'EVIDENCE_SUFFICIENT', reason });
  });
}

export async function requestEvidence(disputeId: string, input: { requestedFrom: 'BUYER' | 'SELLER' | 'PROVIDER'; purpose: 'EVIDENCE' | 'MATERIAL_CONTRARY_EVIDENCE' | 'SELLER_RESPONSE'; description: string; proportionalityNote: string; dueAt?: Date | null }, actor: StaffActor) {
  if (/\b(passport|aadhaar|national id|identity card|driving licen[cs]e)\b/i.test(input.description)) {
    throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'Do not ask for an identity document unrelated to the dispute.', details: [{ field: 'description', code: 'IDENTITY_DOCUMENT' }] });
  }
  const rules = await caseRules(prisma);
  const now = new Date();
  const dueAt = input.dueAt ?? windowDeadline(windowByKey('SELLER_RESPONSE', rules.windows), now, rules.calendar);
  const id = newId();
  await prisma.disputeEvidenceRequest.create({ data: { id, disputeId, requestedFrom: input.requestedFrom, purpose: input.purpose, description: input.description, proportionalityNote: input.proportionalityNote, dueAt, requestedById: actor.userId } });
  await audit(prisma, actor, AuditAction.CASE_CONTROL_RECORDED, 'dispute', disputeId, null, { action: 'EVIDENCE_REQUESTED', ...input, dueAt });
  return { id };
}

/** A party answers a request addressed to it. */
export async function answerEvidenceRequest(requestId: string, side: 'BUYER' | 'SELLER', note: string, disputeScope: { disputeId: string }) {
  const r = await prisma.disputeEvidenceRequest.findUnique({ where: { id: requestId } });
  if (r === null || r.disputeId !== disputeScope.disputeId || r.requestedFrom !== side) throw notFound('Evidence request');
  if (r.status !== 'OPEN') throw conflict(ErrorCode.CONFLICT, 'This request has already been answered.');
  await prisma.disputeEvidenceRequest.update({ where: { id: requestId }, data: { status: 'ANSWERED', responseNote: note, respondedAt: new Date() } });
}

export async function recordTesting(disputeId: string, input: { id?: string; laboratory: string; protocol: string; agreedByBuyer: boolean; agreedBySeller: boolean; interimPayer: 'PLATFORM' | 'SELLER' | 'BUYER' | 'PROVIDER'; costMinor: bigint; currency: string; sampleCustody?: string | null; resultSummary?: string | null; finalPayer?: 'PLATFORM' | 'SELLER' | 'BUYER' | 'PROVIDER' | null; finalAllocationReason?: string | null }, actor: StaffActor) {
  if (input.finalPayer && (!input.finalAllocationReason || input.finalAllocationReason.trim().length < 10)) {
    throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'A final cost allocation states the fault or agreed term it rests on.', details: [{ field: 'finalAllocationReason', code: 'REQUIRED' }] });
  }
  const data = { laboratory: input.laboratory, protocol: input.protocol, agreedByBuyer: input.agreedByBuyer, agreedBySeller: input.agreedBySeller, interimPayer: input.interimPayer, costMinor: input.costMinor, currency: input.currency, sampleCustody: input.sampleCustody ?? null, resultSummary: input.resultSummary ?? null, finalPayer: input.finalPayer ?? null, finalAllocationReason: input.finalAllocationReason ?? null, status: input.finalPayer ? 'ALLOCATED' : input.resultSummary ? 'RESULT_RECEIVED' : 'PLANNED' };
  const id = input.id ?? newId();
  if (input.id) await prisma.disputeTestingRecord.update({ where: { id }, data });
  else await prisma.disputeTestingRecord.create({ data: { id, disputeId, ...data, recordedById: actor.userId } });
  await audit(prisma, actor, AuditAction.CASE_CONTROL_RECORDED, 'dispute', disputeId, null, { action: 'TESTING', ...data, costMinor: input.costMinor.toString() });
  return { id };
}

export interface ReasonedDecisionInput {
  reasoning: string;
  remedies: { kind: RemedyKind; amountMinor: bigint | null; currency?: string | null; payer: 'SELLER' | 'PLATFORM' | 'PROVIDER' | 'BUYER' | 'INSURER'; quantity?: number | null; note?: string | null }[];
  returnFreightPayer: 'SELLER' | 'PLATFORM' | 'PROVIDER' | 'BUYER' | 'INSURER' | null;
  expectedCompletionAt: Date | null;
  aiGenerated?: boolean;
}

/** Record the reasoned decision and its remedies. Must name amounts, payers, return freight, completion and the appeal route; never AI alone. */
export async function recordReasonedDecision(disputeId: string, input: ReasonedDecisionInput, actor: StaffActor) {
  const problems = reasonedDecisionProblems({ reasoning: input.reasoning, remedies: input.remedies.map((r) => ({ kind: r.kind, amountMinor: r.amountMinor, payer: r.payer })), returnFreightPayer: input.returnFreightPayer, expectedCompletionAt: input.expectedCompletionAt, aiGenerated: input.aiGenerated === true });
  if (problems.length > 0) throw new AppError({ statusCode: 422, code: ErrorCode.CASE_DECISION_NOT_REASONED, message: 'The decision is not complete yet.', details: problems.map((code) => ({ code })) });
  await prisma.$transaction(async (tx) => {
    const d = await tx.dispute.findUnique({ where: { id: disputeId }, select: { currency: true, status: true, decidedById: true, approvedById: true, proposedById: true } });
    if (d === null) throw notFound('Dispute');
    const p = await profileOf(tx, disputeId);
    if (d.status === 'APPEALED' && !isIndependentAppealReviewer(actor.userId, [d.decidedById, d.approvedById, d.proposedById])) {
      throw separationRefusal('APPEAL_REVIEWER_NOT_INDEPENDENT', 'An appeal is decided by someone who took no part in the decision under appeal.');
    }
    await tx.disputeRemedyAction.deleteMany({ where: { disputeId, status: 'PLANNED' } });
    for (const r of input.remedies) {
      await tx.disputeRemedyAction.create({ data: { id: newId(), disputeId, kind: r.kind, amountMinor: r.amountMinor, currency: r.currency ?? d.currency, payer: r.payer, returnFreightPayer: r.kind === 'RETURN' ? input.returnFreightPayer : null, quantity: r.quantity ?? null, expectedCompletionAt: input.expectedCompletionAt ?? new Date(), note: r.note ?? null, decidedById: actor.userId } });
    }
    await tx.disputeCaseProfile.update({ where: { id: p.id }, data: { reasonedDecisionJson: { reasoning: input.reasoning, returnFreightPayer: input.returnFreightPayer, expectedCompletionAt: input.expectedCompletionAt?.toISOString() ?? null, decidedBy: actor.userId, at: new Date().toISOString(), appealRoute: LEGAL_NOTICE } } });
    await audit(tx, actor, AuditAction.CASE_DECISION_REASONED, 'dispute', disputeId, null, { reasoning: input.reasoning, remedies: input.remedies.map((r) => ({ ...r, amountMinor: r.amountMinor?.toString() ?? null })) });
  });
}

export async function completeRemedy(remedyId: string, input: { refundId?: string | null; note?: string | null }, actor: StaffActor) {
  const r = await prisma.disputeRemedyAction.findUnique({ where: { id: remedyId } });
  if (r === null) throw notFound('Remedy');
  await prisma.disputeRemedyAction.update({ where: { id: remedyId }, data: { status: 'COMPLETED', completedAt: new Date(), refundId: input.refundId ?? r.refundId, note: input.note ?? r.note } });
  await audit(prisma, actor, AuditAction.CASE_CONTROL_RECORDED, 'dispute', r.disputeId, null, { action: 'REMEDY_COMPLETED', remedyId });
}

/** Assign the independent appeal reviewer and start the appeal-review clock. */
export async function assignAppealReviewer(disputeId: string, reviewerUserId: string, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const d = await tx.dispute.findUnique({ where: { id: disputeId }, select: { status: true, decidedById: true, approvedById: true, proposedById: true } });
    if (d === null) throw notFound('Dispute');
    if (d.status !== 'APPEALED') throw conflict(ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED, 'Only an appealed claim has an appeal reviewer.');
    if (!isIndependentAppealReviewer(reviewerUserId, [d.decidedById, d.approvedById, d.proposedById])) throw separationRefusal('APPEAL_REVIEWER_NOT_INDEPENDENT', 'Choose a reviewer who took no part in the decision under appeal.');
    const p = await profileOf(tx, disputeId);
    const rules = await caseRules(tx);
    await tx.disputeCaseProfile.update({ where: { id: p.id }, data: { appealReviewerId: reviewerUserId, appealReviewDueAt: windowDeadline(windowByKey('APPEAL_REVIEW', rules.windows), new Date(), rules.calendar), decisionParticipantsJson: [d.decidedById, d.approvedById, d.proposedById] as never } });
    await audit(tx, actor, AuditAction.CASE_CONTROL_RECORDED, 'dispute', disputeId, null, { action: 'APPEAL_REVIEWER_ASSIGNED', reviewerUserId });
  });
}

/**
 * Called by `decideDispute` before any decision is applied. An appeal is
 * decided only by someone independent of the decision under appeal (always).
 * Under `DELIVERY_POLICY_GATES=enforce` a reasoned decision must be on file.
 */
export async function assertDecisionControls(client: Client, dispute: { id: string; status: string; decidedById: string | null; approvedById: string | null; proposedById: string | null }, actorUserId: string): Promise<void> {
  if (dispute.status === 'APPEALED') {
    const p = await client.disputeCaseProfile.findUnique({ where: { disputeId: dispute.id }, select: { appealReviewerId: true } });
    if (!isIndependentAppealReviewer(actorUserId, [dispute.decidedById, dispute.approvedById, dispute.proposedById])) {
      throw separationRefusal('APPEAL_REVIEWER_NOT_INDEPENDENT', 'An appeal is decided by someone who took no part in the decision under appeal.');
    }
    if (p?.appealReviewerId && p.appealReviewerId !== actorUserId) throw separationRefusal('NOT_ASSIGNED_APPEAL_REVIEWER', 'This appeal is assigned to another reviewer.');
  }
  if (env.DELIVERY_POLICY_GATES !== 'enforce') return;
  const p = await client.disputeCaseProfile.findUnique({ where: { disputeId: dispute.id }, select: { reasonedDecisionJson: true } });
  if (p?.reasonedDecisionJson === null || p?.reasonedDecisionJson === undefined) {
    throw new AppError({ statusCode: 422, code: ErrorCode.CASE_DECISION_NOT_REASONED, message: 'Record the reasoned decision and remedies before deciding.', details: [{ code: 'REASONING_MISSING' }] });
  }
}

/** Record a recovery of a loss (carrier, insurer, chargeback, refund, seller). Overlaps are flagged for investigation, never blocked. */
export async function recordLossRecovery(input: { orderId: string; sellerOrderGroupId?: string | null; disputeId?: string | null; lossKey: string; lossMinor: bigint; source: 'CHARGEBACK' | 'REFUND' | 'CARRIER' | 'INSURER' | 'SELLER' | 'OTHER'; sourceReference: string; amountMinor: bigint; currency: string }, actor: StaffActor | null) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.lossRecovery.findUnique({ where: { source_sourceReference: { source: input.source, sourceReference: input.sourceReference } } });
    if (existing !== null) return serialise({ id: existing.id, duplicate: true, status: existing.status });
    const others = await tx.lossRecovery.findMany({ where: { orderId: input.orderId, lossKey: input.lossKey } });
    const overlap = recoveryOverlap(input.lossMinor, [...others.map((o) => ({ source: o.source, amountMinor: o.amountMinor })), { source: input.source, amountMinor: input.amountMinor }]);
    const status = overlap.excessMinor > 0n ? 'INVESTIGATE' : 'RECORDED';
    const id = newId();
    await tx.lossRecovery.create({ data: { id, orderId: input.orderId, sellerOrderGroupId: input.sellerOrderGroupId ?? null, disputeId: input.disputeId ?? null, lossKey: input.lossKey, lossMinor: input.lossMinor, source: input.source, sourceReference: input.sourceReference, amountMinor: input.amountMinor, currency: input.currency, status, overlapNote: status === 'INVESTIGATE' ? `Recovered ${overlap.excessMinor.toString()} more than the loss across ${overlap.sources.join(', ')}. Investigate before any further recovery; the buyer's remedy is not affected.` : null, recordedById: actor?.userId ?? null } });
    if (status === 'INVESTIGATE') await tx.lossRecovery.updateMany({ where: { orderId: input.orderId, lossKey: input.lossKey }, data: { status: 'INVESTIGATE' } });
    if (actor) await audit(tx, actor, AuditAction.CASE_CONTROL_RECORDED, 'loss_recovery', id, null, { ...input, lossMinor: input.lossMinor.toString(), amountMinor: input.amountMinor.toString(), status });
    return serialise({ id, duplicate: false, status, excessMinor: overlap.excessMinor });
  });
}

/** Overdue sweep: acknowledgements, evidence requests, initial decisions and appeal reviews past their targets are escalated to staff. Idempotent. */
export async function sweepCaseClocks(now = new Date()): Promise<{ escalated: number }> {
  const late = await prisma.disputeCaseProfile.findMany({
    where: {
      escalatedOverdueAt: null,
      OR: [
        { acknowledgedAt: null, acknowledgementDueAt: { lt: now } },
        { initialDecisionDueAt: { lt: now } },
        { appealReviewDueAt: { lt: now } },
      ],
    },
    select: { id: true, disputeId: true },
    take: 500,
  });
  let escalated = 0;
  for (const p of late) {
    const d = await prisma.dispute.findUnique({ where: { id: p.disputeId }, select: { reference: true, status: true } });
    if (d === null || ['RESOLVED', 'REJECTED', 'WITHDRAWN'].includes(d.status)) continue;
    await createAdminNotification({ kind: AdminNotificationKind.DISPUTE_SLA_BREACHED, variables: { reference: d.reference, which: 'CASE_CLOCK' }, linkPath: consoleDisputePath(p.disputeId), requiredPermission: Permission.DISPUTE_VIEW, relatedType: 'dispute', relatedId: p.disputeId, dedupeKey: `case-clock:${p.disputeId}` });
    await prisma.disputeCaseProfile.update({ where: { id: p.id }, data: { escalatedOverdueAt: now } });
    escalated += 1;
  }
  await prisma.disputeEvidenceRequest.updateMany({ where: { status: 'OPEN', dueAt: { lt: now } }, data: { status: 'OVERDUE' } });
  return { escalated };
}
