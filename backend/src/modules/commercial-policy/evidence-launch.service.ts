/**
 * Product compliance evidence (Doc 08 s7-s10), country launch readiness
 * (Doc 08 s10-s11), return authorisations (Doc 07 s9) and the bespoke
 * payment plan (Doc 08 s5).
 *
 * Product evidence is the Audit Console's to verify: it is recorded per exact
 * SKU/version, site and country, and is kept apart from Gloviaa's own trading
 * approval. Required evidence that is withdrawn, suspended or past an expiry
 * the issuer set blocks purchase and dispatch at once - read live by the
 * purchase gate, never only by a job. No annual expiry is invented.
 *
 * A country is enabled only when every applicable decision is approved, with
 * evidence, by someone other than its owner, and current. Nothing is enabled
 * by default, and mentioning a country in a guide enables nothing.
 */
import {
  DOC08_ASSURANCE_MATRIX,
  DOC08_DEPARTMENT_SLUGS,
  EVIDENCE_LIMITS,
  EXPIRY_ALERT_DAYS,
  evidenceBlocksTrading,
  launchBlockers,
  launchDecisionsFor,
  paymentPlanProblems,
  splitByMilestones,
  BESPOKE_B2B_PAYMENT_PLAN,
  type ProductEvidenceKind,
  type ProductEvidenceStatus,
  type ReadinessStatus,
} from '../../domain/commercial-policy.js';
import { AppError, ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { activeSchedule } from './schedules.service.js';
import { audit, separationRefusal, serialise, type Client, type StaffActor } from './shared.js';

const DAY_MS = 86_400_000;

// --- Product evidence ----------------------------------------------------------

export interface EvidenceInput {
  sellerAccountId: string;
  offerId?: string | null;
  productKey: string;
  productVersion: string;
  facilityRef: string;
  countryCode: string;
  departmentSlug?: string | null;
  kind: ProductEvidenceKind;
  scheme: string;
  issuer: string;
  accreditation?: string | null;
  scope: string;
  certificateNumber?: string | null;
  issuedOn?: Date | null;
  expiresOn?: Date | null;
  changeConditions?: string | null;
  surveillanceDueAt?: Date | null;
  requiredForTrading: boolean;
  existingAccepted?: boolean;
  gapAssessment?: string | null;
}

export async function recordEvidence(input: EvidenceInput, actor: StaffActor) {
  if (input.existingAccepted === true && (input.gapAssessment ?? '').trim().length < 10) {
    throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'An existing certification is accepted after authentication and a recorded gap assessment.', details: [{ field: 'gapAssessment', code: 'REQUIRED' }] });
  }
  const id = newId();
  await prisma.productComplianceEvidence.create({ data: { id, ...input, offerId: input.offerId ?? null, countryCode: input.countryCode.toUpperCase(), departmentSlug: input.departmentSlug ?? null, accreditation: input.accreditation ?? null, certificateNumber: input.certificateNumber ?? null, issuedOn: input.issuedOn ?? null, expiresOn: input.expiresOn ?? null, changeConditions: input.changeConditions ?? null, surveillanceDueAt: input.surveillanceDueAt ?? null, existingAccepted: input.existingAccepted === true, gapAssessment: input.gapAssessment ?? null, recordedById: actor.userId } });
  await audit(prisma, actor, AuditAction.PRODUCT_EVIDENCE_CHANGED, 'product_evidence', id, null, { ...input, action: 'RECORDED' });
  return { id, limit: EVIDENCE_LIMITS[input.kind] };
}

/** Verify against the issuer's register, suspend, withdraw. Verification is by someone other than the recorder. */
export async function setEvidenceStatus(id: string, input: { status: ProductEvidenceStatus; method?: string | null; evidence?: string | null; reason?: string | null }, actor: StaffActor) {
  const row = await prisma.productComplianceEvidence.findUnique({ where: { id } });
  if (row === null) throw notFound('Product evidence');
  if (input.status === 'VERIFIED') {
    if (row.recordedById === actor.userId) throw separationRefusal('VERIFIER_IS_RECORDER', 'The person who recorded this evidence cannot verify it.');
    if (!input.method || !input.evidence) throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'Record how the evidence was checked with its issuer, and what the check showed.' });
  }
  await prisma.productComplianceEvidence.update({ where: { id }, data: { status: input.status, statusReason: input.reason ?? null, ...(input.status === 'VERIFIED' ? { verificationMethod: input.method ?? null, verificationEvidence: input.evidence ?? null, verifiedById: actor.userId, verifiedAt: new Date() } : {}) } });
  await audit(prisma, actor, AuditAction.PRODUCT_EVIDENCE_CHANGED, 'product_evidence', id, { status: row.status }, input);
}

export async function listEvidence(filter: { sellerAccountId?: string; offerId?: string; countryCode?: string }) {
  const now = new Date();
  const rows = await prisma.productComplianceEvidence.findMany({ where: { ...(filter.sellerAccountId ? { sellerAccountId: filter.sellerAccountId } : {}), ...(filter.offerId ? { offerId: filter.offerId } : {}), ...(filter.countryCode ? { countryCode: filter.countryCode.toUpperCase() } : {}) }, orderBy: [{ expiresOn: 'asc' }, { createdAt: 'desc' }], take: 500 });
  return serialise(rows.map((r) => ({ ...r, blocksTrading: evidenceBlocksTrading({ requiredForTrading: r.requiredForTrading, status: r.status as ProductEvidenceStatus, expiresOn: r.expiresOn }, now), limit: EVIDENCE_LIMITS[r.kind as ProductEvidenceKind] ?? null, daysToExpiry: r.expiresOn === null ? null : Math.ceil((r.expiresOn.getTime() - now.getTime()) / DAY_MS) })));
}

/** For the purchase gate: offers whose required evidence for this country blocks trading right now. */
export async function offersBlockedByEvidence(client: Client, offerIds: readonly string[], countryCode: string, now = new Date()): Promise<Set<string>> {
  if (offerIds.length === 0) return new Set();
  const rows = await client.productComplianceEvidence.findMany({ where: { offerId: { in: [...offerIds] }, countryCode: countryCode.toUpperCase(), requiredForTrading: true }, select: { offerId: true, status: true, expiresOn: true, requiredForTrading: true } });
  return new Set(rows.filter((r) => evidenceBlocksTrading({ requiredForTrading: r.requiredForTrading, status: r.status as ProductEvidenceStatus, expiresOn: r.expiresOn }, now)).map((r) => r.offerId).filter((v): v is string => v !== null));
}

/** The Doc 08 s8 reviewer prompts for a department: prompts, not a list of what every product needs. */
export function assurancePrompts(departmentSlug: string | null) {
  const department = Object.entries(DOC08_DEPARTMENT_SLUGS).find(([, slug]) => slug === departmentSlug)?.[0];
  const row = DOC08_ASSURANCE_MATRIX.find((r) => r.department === department) ?? null;
  return { row, notice: 'Product-specific review triggers and proposed platform controls - not a declaration that every item legally requires every named standard. A regulatory reviewer records the actual route, law, test method, issuer and dates per SKU and country.' };
}

/** 90/60/30-day reminders for product evidence with an issuer-set expiry. Idempotent per threshold. */
export async function sweepEvidenceExpiry(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + Math.max(...EXPIRY_ALERT_DAYS) * DAY_MS);
  const rows = await prisma.productComplianceEvidence.findMany({ where: { expiresOn: { not: null, lte: horizon }, status: { in: ['VERIFIED', 'UNVERIFIED'] } }, select: { id: true, sellerAccountId: true, expiresOn: true, remindersSentJson: true, scheme: true, countryCode: true, status: true } });
  let sent = 0;
  const { notifySeller } = await import('../seller/notification.service.js');
  for (const r of rows) {
    if (r.expiresOn === null) continue;
    const days = Math.ceil((r.expiresOn.getTime() - now.getTime()) / DAY_MS);
    if (days <= 0) {
      if (r.status !== 'EXPIRED') await prisma.productComplianceEvidence.update({ where: { id: r.id }, data: { status: 'EXPIRED', statusReason: 'Past the expiry the issuer set.' } });
      continue;
    }
    const already = (r.remindersSentJson ?? []) as number[];
    const due = EXPIRY_ALERT_DAYS.filter((t) => days <= t && !already.includes(t)).sort((a, b) => a - b)[0];
    if (due === undefined) continue;
    await notifySeller({ sellerAccountId: r.sellerAccountId, kind: 'SELLER_ASSESSMENT', title: `${r.scheme} evidence for ${r.countryCode} expires in ${String(days)} days`, body: 'Renew it with the issuer before it expires. Purchases and dispatch for the affected products stop on the expiry date - there is no grace period.', linkPath: '/seller/assessment', severity: due <= 30 ? 'WARNING' : 'INFO', subjectType: 'product_evidence', subjectId: r.id, dedupeKey: `evidence-expiry:${r.id}:${String(due)}` });
    await prisma.productComplianceEvidence.update({ where: { id: r.id }, data: { remindersSentJson: [...already, ...EXPIRY_ALERT_DAYS.filter((t) => days <= t)] as never } });
    sent += 1;
  }
  return sent;
}

// --- Country launch ------------------------------------------------------------

export async function readLaunch(countryCode: string, now = new Date()) {
  const cc = countryCode.toUpperCase();
  const country = await prisma.country.findUnique({ where: { code: cc }, select: { code: true, name: true, isEuVat: true, isActive: true } });
  if (country === null) throw notFound('Country');
  const required = launchDecisionsFor(cc, country.isEuVat);
  const items = await prisma.launchReadinessItem.findMany({ where: { countryCode: cc } });
  const launch = await prisma.countryLaunch.findUnique({ where: { countryCode: cc } });
  const blockers = launchBlockers(items.map((i) => ({ ...i, status: i.status as ReadinessStatus })), required, now);
  return serialise({
    country,
    launch: launch ?? { countryCode: cc, status: 'DISABLED' },
    decisions: required.map((d) => ({ ...d, item: items.find((i) => i.key === d.key) ?? null, blocker: blockers.find((b) => b.key === d.key)?.reason ?? null })),
    blockers,
    notice: 'Country launch evidence is confidential and internal. Human sign-offs, live provider validation and real rehearsals stay pending until actually performed.',
  });
}

export async function listLaunches() {
  const countries = await prisma.country.findMany({ where: { isActive: true }, select: { code: true, name: true, isEuVat: true }, orderBy: { name: 'asc' } });
  const [items, launches] = await Promise.all([prisma.launchReadinessItem.findMany(), prisma.countryLaunch.findMany()]);
  const now = new Date();
  return serialise(countries.map((c) => {
    const required = launchDecisionsFor(c.code, c.isEuVat);
    const blockers = launchBlockers(items.filter((i) => i.countryCode === c.code).map((i) => ({ ...i, status: i.status as ReadinessStatus })), required, now);
    return { ...c, status: launches.find((l) => l.countryCode === c.code)?.status ?? 'DISABLED', required: required.length, open: blockers.length };
  }));
}

export async function saveLaunchItem(countryCode: string, key: string, input: { status: ReadinessStatus; ownerName?: string | null; ownerUserId?: string | null; scope?: string | null; evidence?: string | null; expiresAt?: Date | null; blockingReason?: string | null; sourceCheckedOn?: Date | null; sourceNote?: string | null }, actor: StaffActor) {
  const cc = countryCode.toUpperCase();
  const country = await prisma.country.findUnique({ where: { code: cc }, select: { isEuVat: true } });
  if (country === null) throw notFound('Country');
  if (!launchDecisionsFor(cc, country.isEuVat).some((d) => d.key === key)) throw notFound('Launch decision');
  if (input.status === 'APPROVED' || input.status === 'REJECTED') throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'Approval is recorded by a reviewer through the review step.', details: [{ field: 'status', code: 'USE_REVIEW' }] });
  const existing = await prisma.launchReadinessItem.findUnique({ where: { countryCode_key: { countryCode: cc, key } } });
  const data = { status: input.status, ownerName: input.ownerName ?? existing?.ownerName ?? null, ownerUserId: input.ownerUserId ?? existing?.ownerUserId ?? actor.userId, scope: input.scope ?? existing?.scope ?? null, evidence: input.evidence ?? existing?.evidence ?? null, expiresAt: input.expiresAt !== undefined ? input.expiresAt : (existing?.expiresAt ?? null), blockingReason: input.blockingReason ?? null, sourceCheckedOn: input.sourceCheckedOn ?? existing?.sourceCheckedOn ?? null, sourceNote: input.sourceNote ?? existing?.sourceNote ?? null, reviewerUserId: null, reviewedAt: null, updatedById: actor.userId };
  await prisma.launchReadinessItem.upsert({ where: { countryCode_key: { countryCode: cc, key } }, create: { id: newId(), countryCode: cc, key, ...data }, update: data });
  await audit(prisma, actor, AuditAction.LAUNCH_READINESS_CHANGED, 'launch_readiness_item', `${cc}:${key}`, existing, data);
}

/** A reviewer other than the owner approves (or rejects) a submitted decision. */
export async function reviewLaunchItem(countryCode: string, key: string, input: { approve: boolean; note: string }, actor: StaffActor) {
  const cc = countryCode.toUpperCase();
  const item = await prisma.launchReadinessItem.findUnique({ where: { countryCode_key: { countryCode: cc, key } } });
  if (item === null) throw notFound('Launch decision');
  if (item.ownerUserId === actor.userId || item.updatedById === actor.userId) throw separationRefusal('REVIEWER_IS_OWNER', 'The owner of a launch decision cannot approve it.');
  if (input.approve && (item.evidence ?? '').trim() === '') throw conflict(ErrorCode.COUNTRY_LAUNCH_BLOCKED, 'Record the evidence before approval.', [{ code: 'EVIDENCE_MISSING' }]);
  await prisma.launchReadinessItem.update({ where: { id: item.id }, data: { status: input.approve ? 'APPROVED' : 'REJECTED', reviewerUserId: actor.userId, reviewedAt: new Date(), blockingReason: input.approve ? null : input.note } });
  await audit(prisma, actor, AuditAction.LAUNCH_READINESS_CHANGED, 'launch_readiness_item', `${cc}:${key}`, { status: item.status }, { status: input.approve ? 'APPROVED' : 'REJECTED', note: input.note });
}

/** Enable one country. Refused while any applicable decision is open. */
export async function enableCountry(countryCode: string, note: string, actor: StaffActor) {
  const cc = countryCode.toUpperCase();
  const view = (await readLaunch(cc)) as { blockers: { key: string; reason: string }[] };
  if (view.blockers.length > 0) throw conflict(ErrorCode.COUNTRY_LAUNCH_BLOCKED, `${cc} cannot be enabled yet.`, view.blockers.map((b) => ({ field: b.key, code: b.reason })));
  const now = new Date();
  await prisma.countryLaunch.upsert({ where: { countryCode: cc }, create: { id: newId(), countryCode: cc, status: 'ENABLED', enabledById: actor.userId, enabledAt: now, note }, update: { status: 'ENABLED', enabledById: actor.userId, enabledAt: now, note } });
  await audit(prisma, actor, AuditAction.COUNTRY_LAUNCH_CHANGED, 'country_launch', cc, null, { status: 'ENABLED', note });
}

export async function disableCountry(countryCode: string, note: string, actor: StaffActor) {
  const cc = countryCode.toUpperCase();
  const now = new Date();
  await prisma.countryLaunch.upsert({ where: { countryCode: cc }, create: { id: newId(), countryCode: cc, status: 'DISABLED', disabledById: actor.userId, disabledAt: now, note }, update: { status: 'DISABLED', disabledById: actor.userId, disabledAt: now, note } });
  await audit(prisma, actor, AuditAction.COUNTRY_LAUNCH_CHANGED, 'country_launch', cc, null, { status: 'DISABLED', note });
}

// --- Return authorisation ------------------------------------------------------

export async function issueReturnAuthorization(returnRequestId: string, input: { returnRoute: string; freightPayer: 'SELLER' | 'BUYER' | 'PLATFORM' | 'PROVIDER'; payerReason: string; carrier?: string | null; trackingNumber?: string | null; returnBy?: Date | null }, actor: StaffActor & { sellerAccountId?: string }) {
  const r = await prisma.returnRequest.findUnique({ where: { id: returnRequestId }, select: { id: true, status: true, sellerOrderGroupId: true, sellerOrderGroup: { select: { sellerAccountId: true } } } });
  if (r === null || (actor.sellerAccountId !== undefined && r.sellerOrderGroup?.sellerAccountId !== actor.sellerAccountId)) throw notFound('Return');
  if (!['APPROVED', 'RECEIVED', 'INSPECTED'].includes(r.status)) throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'A return authorisation is issued once the return is approved.');
  const existing = await prisma.returnAuthorization.findUnique({ where: { returnRequestId } });
  const data = { returnRoute: input.returnRoute, freightPayer: input.freightPayer, payerReason: input.payerReason, carrier: input.carrier ?? null, trackingNumber: input.trackingNumber ?? null, returnBy: input.returnBy ?? null };
  const id = existing?.id ?? newId();
  if (existing === null) await prisma.returnAuthorization.create({ data: { id, returnRequestId, rmaNumber: `RMA-${id.slice(-10)}`, ...data, issuedById: actor.userId } });
  else await prisma.returnAuthorization.update({ where: { id }, data });
  await audit(prisma, actor, AuditAction.CASE_CONTROL_RECORDED, 'return_authorization', id, existing, data);
  return { id };
}

/** Receipt and inspection evidence. A deduction for buyer-caused damage needs evidence and a stated legal basis. */
export async function recordReturnEvidence(returnRequestId: string, input: { receivedEvidence?: string | null; inspectionEvidence?: string | null; deductionMinor?: bigint | null; deductionBasis?: string | null }, actor: StaffActor & { sellerAccountId?: string }) {
  const ra = await prisma.returnAuthorization.findUnique({ where: { returnRequestId } });
  if (ra === null) throw notFound('Return authorisation');
  if (actor.sellerAccountId !== undefined) {
    const r = await prisma.returnRequest.findUnique({ where: { id: returnRequestId }, select: { sellerOrderGroup: { select: { sellerAccountId: true } } } });
    if (r?.sellerOrderGroup?.sellerAccountId !== actor.sellerAccountId) throw notFound('Return');
  }
  if ((input.deductionMinor ?? 0n) > 0n && ((input.deductionBasis ?? '').trim().length < 10 || (input.inspectionEvidence ?? ra.inspectionEvidence ?? '').trim() === '')) {
    throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'A deduction needs inspection evidence and a stated legal basis.', details: [{ field: 'deductionBasis', code: 'REQUIRED' }] });
  }
  await prisma.returnAuthorization.update({ where: { id: ra.id }, data: { receivedEvidence: input.receivedEvidence ?? ra.receivedEvidence, inspectionEvidence: input.inspectionEvidence ?? ra.inspectionEvidence, deductionMinor: input.deductionMinor ?? ra.deductionMinor, deductionBasis: input.deductionBasis ?? ra.deductionBasis } });
  await audit(prisma, actor, AuditAction.CASE_CONTROL_RECORDED, 'return_authorization', ra.id, null, { ...input, deductionMinor: input.deductionMinor?.toString() ?? null });
}

export async function readReturnAuthorization(returnRequestId: string) {
  return serialise(await prisma.returnAuthorization.findUnique({ where: { returnRequestId } }));
}

// --- Bespoke payment plan ------------------------------------------------------

export async function proposePaymentPlan(orderId: string, actor: StaffActor) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { grandTotalMinor: true, buyerContextKind: true } });
  if (order === null) throw notFound('Order');
  const schedule = await activeSchedule(prisma, 'PAYMENT_PLAN', { country: null, channel: 'B2B', sellerAccountId: null });
  if (schedule === null) throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE, 'The bespoke payment plan has not been adopted.', [{ code: 'SCHEDULE_NOT_ACTIVE' }]);
  if (order.buyerContextKind !== 'COMPANY') throw conflict(ErrorCode.VALIDATION_FAILED, 'The bespoke payment plan is for business orders only.', [{ code: 'NOT_B2B' }]);
  const milestones = splitByMilestones(order.grandTotalMinor, BESPOKE_B2B_PAYMENT_PLAN).map((m) => ({ ...m, trigger: BESPOKE_B2B_PAYMENT_PLAN.find((x) => x.code === m.code)?.trigger ?? '' }));
  const id = newId();
  await prisma.orderPaymentPlan.create({ data: { id, orderId, scheduleId: schedule.id, milestonesJson: serialise(milestones) as never, recordedById: actor.userId } });
  await audit(prisma, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'order_payment_plan', id, null, { orderId, action: 'PROPOSED' });
  return { id };
}

export async function recordPaymentPlanAgreement(orderId: string, input: { party: 'SELLER' | 'BUYER' | 'PROVIDER'; providerConfirmationRef?: string | null }, actor: StaffActor) {
  const plan = await prisma.orderPaymentPlan.findUnique({ where: { orderId } });
  if (plan === null) throw notFound('Payment plan');
  const now = new Date();
  const next = {
    sellerAgreedAt: input.party === 'SELLER' ? now : plan.sellerAgreedAt,
    buyerAgreedAt: input.party === 'BUYER' ? now : plan.buyerAgreedAt,
    providerConfirmationRef: input.party === 'PROVIDER' ? (input.providerConfirmationRef ?? null) : plan.providerConfirmationRef,
  };
  const problems = paymentPlanProblems({ ...next, channel: 'B2B' });
  await prisma.orderPaymentPlan.update({ where: { id: plan.id }, data: { ...next, status: problems.length === 0 ? 'APPROVED' : 'PROPOSED' } });
  await audit(prisma, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'order_payment_plan', plan.id, null, { party: input.party, outstanding: problems });
  return { status: problems.length === 0 ? 'APPROVED' : 'PROPOSED', outstanding: problems };
}
