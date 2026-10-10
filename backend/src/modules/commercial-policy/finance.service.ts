/**
 * Money controls from Doc 07 s9-s10 and Doc 08 s2, s4, s6.
 *
 *  - Commission reversal: every succeeded refund proposes a proportionate
 *    reversal of the commission on the goods it refunds. Finance applies it
 *    against a credit-note reference; nothing posts on its own.
 *  - Certification recovery: a seller/programme ledger of verified third-party
 *    cost, recovered from buyers at up to the adopted rate, capped by what is
 *    still unrecovered. Reservations are taken under a row lock on the
 *    programme, so two checkouts at once can never exceed the cap; a quote's
 *    reserved amount is what the buyer accepted and can only fall.
 *  - Security schedules: proposed reserve or guarantee per seller, never
 *    stacked without a documented exposure, activated only with provider
 *    permission, reviewed monthly (and quarterly), never forfeited
 *    automatically.
 *  - Insurance register: verified per policy; a purchased limit never
 *    approves a category.
 */
import {
  SECURITY_MONTHLY_REVIEW_DAYS,
  SECURITY_PROPOSALS,
  SECURITY_QUARTERLY_REVIEW_DAYS,
  SECURITY_REDUCTION_AFTER_SATISFACTORY_MONTHS,
  certificationAllocation,
  commissionReversal,
  excessHeld,
  insuranceGaps,
  proportion,
  refundDisplayState,
  securityStackProblem,
  unrecoveredBalance,
  DOC08_INSURANCE_RISK_GROUPS,
  type SecurityTier,
} from '../../domain/commercial-policy.js';
import { AppError, ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { activeSchedule } from './schedules.service.js';
import { audit, separationRefusal, serialise, type Client, type StaffActor } from './shared.js';

const DAY_MS = 86_400_000;

// --- Refund view and commission reversal ----------------------------------------

/** What staff, sellers and buyers see of an order's refunds: instruction date and the provider's actual status, nothing invented. */
export async function refundStatusView(orderId: string) {
  const refunds = await prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, select: { id: true, amountMinor: true, currency: true, status: true, providerRefundId: true, failureCode: true, createdAt: true, completedAt: true } });
  return serialise(
    refunds.map((r) => ({
      id: r.id,
      amountMinor: r.amountMinor,
      currency: r.currency,
      instructedAt: r.createdAt,
      providerConfirmedAt: r.status === 'SUCCEEDED' ? r.completedAt : null,
      state: r.failureCode === 'OUTCOME_UNKNOWN' && r.status === 'REQUESTED' ? 'PENDING_PROVIDER' : refundDisplayState(r.status, r.providerRefundId),
      outcomeUnknown: r.failureCode === 'OUTCOME_UNKNOWN',
      note: 'Bank-credit timing depends on the payment provider and the buyer’s bank; it is not promised here.',
    })),
  );
}

/**
 * Propose the commission reversal for every succeeded refund on an order that
 * has none yet. Each line's refunded goods = line goods x refund / order total
 * (half-up): a proportionate share, since a refund is not tied to one line.
 * Idempotent per refund and line.
 */
export async function proposeCommissionReversals(client: Client, orderId: string): Promise<number> {
  const refunds = await client.refund.findMany({ where: { orderId, status: 'SUCCEEDED' }, select: { id: true, amountMinor: true, currency: true } });
  if (refunds.length === 0) return 0;
  const order = await client.order.findUnique({ where: { id: orderId }, select: { grandTotalMinor: true } });
  if (order === null || order.grandTotalMinor <= 0n) return 0;
  const lines = await client.orderLineCommercialSnapshot.findMany({ where: { orderId, commissionMinor: { gt: 0n } }, select: { orderItemId: true, sellerOrderGroupId: true, commissionBaseMinor: true, commissionMinor: true } });
  if (lines.length === 0) return 0;
  const existing = await client.commissionAdjustment.findMany({ where: { refundId: { in: refunds.map((r) => r.id) } }, select: { refundId: true, orderItemId: true, reversedMinor: true } });
  const disputes = await client.disputeRemedyAction.findMany({ where: { refundId: { in: refunds.map((r) => r.id) } }, select: { refundId: true, payer: true } });
  let created = 0;
  for (const refund of refunds) {
    for (const line of lines) {
      if (existing.some((e) => e.refundId === refund.id && e.orderItemId === line.orderItemId)) continue;
      const refundedGoods = proportion(line.commissionBaseMinor, refund.amountMinor, order.grandTotalMinor);
      const already = existing.filter((e) => e.orderItemId === line.orderItemId).reduce((s, e) => s + e.reversedMinor, 0n);
      const reversed = commissionReversal({ lineBaseMinor: line.commissionBaseMinor, lineCommissionMinor: line.commissionMinor, refundedGoodsMinor: refundedGoods, alreadyReversedMinor: already });
      if (reversed <= 0n) continue;
      const payer = disputes.find((d) => d.refundId === refund.id)?.payer ?? null;
      await client.commissionAdjustment.create({ data: { id: newId(), refundId: refund.id, orderItemId: line.orderItemId, sellerOrderGroupId: line.sellerOrderGroupId, refundedGoodsMinor: refundedGoods, reversedMinor: reversed, currency: refund.currency, basis: 'PROPORTIONATE_TO_REFUNDED_GOODS', fault: payer === 'SELLER' ? 'SELLER' : payer === null ? 'UNSPECIFIED' : payer } });
      existing.push({ refundId: refund.id, orderItemId: line.orderItemId, reversedMinor: reversed });
      created += 1;
    }
  }
  return created;
}

export async function listCommissionAdjustments(filter: { status?: string; sellerOrderGroupId?: string }) {
  return serialise(await prisma.commissionAdjustment.findMany({ where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.sellerOrderGroupId ? { sellerOrderGroupId: filter.sellerOrderGroupId } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 }));
}

/** Finance applies a proposed reversal against the credit note it issued. */
export async function applyCommissionAdjustment(id: string, input: { creditNoteReference: string }, actor: StaffActor) {
  const row = await prisma.commissionAdjustment.findUnique({ where: { id } });
  if (row === null) throw notFound('Commission adjustment');
  if (row.status !== 'PROPOSED') throw conflict(ErrorCode.CONFLICT, 'This adjustment is already applied or declined.');
  await prisma.commissionAdjustment.update({ where: { id }, data: { status: 'APPLIED', appliedById: actor.userId, appliedAt: new Date() } });
  await audit(prisma, actor, AuditAction.COMMISSION_ADJUSTMENT_APPLIED, 'commission_adjustment', id, { status: row.status }, { status: 'APPLIED', creditNoteReference: input.creditNoteReference });
}

// --- Certification recovery ----------------------------------------------------

export async function createProgramme(input: { sellerAccountId: string; title: string; currency: string; capBps?: number; periodStart: Date; periodEnd: Date; fxPolicy?: string | null }, actor: StaffActor) {
  const id = newId();
  const reference = `CRP-${id.slice(-8)}`;
  await prisma.certificationProgramme.create({ data: { id, reference, sellerAccountId: input.sellerAccountId, title: input.title, currency: input.currency, capBps: input.capBps ?? 100, periodStart: input.periodStart, periodEnd: input.periodEnd, fxPolicy: input.fxPolicy ?? null, createdById: actor.userId } });
  await audit(prisma, actor, AuditAction.CERTIFICATION_RECOVERY_CHANGED, 'certification_programme', id, null, { ...input, action: 'CREATED' });
  return { id, reference };
}

/** Record a third-party cost (or a credit). The reference is unique across every programme, so one invoice is never recovered twice. */
export async function recordProgrammeCost(programmeId: string, input: { kind: 'COST' | 'CREDIT' | 'SELLER_DEDUCTION'; externalReference: string; supplierName: string; amountMinor: bigint; currency: string; originalAmountMinor?: bigint | null; originalCurrency?: string | null; fxRate?: string | null; evidence: string }, actor: StaffActor) {
  const programme = await prisma.certificationProgramme.findUnique({ where: { id: programmeId } });
  if (programme === null) throw notFound('Certification programme');
  if (input.currency !== programme.currency) throw conflict(ErrorCode.VALIDATION_FAILED, `Record the cost in the programme currency (${programme.currency}), with the original amount, currency and FX rate beside it.`);
  const dup = await prisma.certificationCostEntry.findUnique({ where: { externalReference: input.externalReference } });
  if (dup !== null) throw conflict(ErrorCode.CERTIFICATION_COST_DUPLICATE, 'This cost is already recorded and cannot be recovered twice.', [{ code: 'DUPLICATE', meta: { programmeId: dup.programmeId } }]);
  const id = newId();
  await prisma.certificationCostEntry.create({ data: { id, programmeId, kind: input.kind, externalReference: input.externalReference, supplierName: input.supplierName, amountMinor: input.amountMinor, currency: input.currency, originalAmountMinor: input.originalAmountMinor ?? null, originalCurrency: input.originalCurrency ?? null, fxRate: input.fxRate ?? null, evidence: input.evidence, recordedById: actor.userId } });
  await audit(prisma, actor, AuditAction.CERTIFICATION_RECOVERY_CHANGED, 'certification_cost', id, null, { ...input, amountMinor: input.amountMinor.toString(), originalAmountMinor: input.originalAmountMinor?.toString() ?? null });
  return { id };
}

/** Verify a cost as eligible. Only verified eligible costs count toward what may be recovered; a seller deduction is a credit against it. */
export async function verifyProgrammeCost(costId: string, eligible: boolean, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const cost = await tx.certificationCostEntry.findUnique({ where: { id: costId } });
    if (cost === null) throw notFound('Certification cost');
    if (cost.recordedById === actor.userId) throw separationRefusal('VERIFIER_IS_RECORDER', 'The person who recorded this cost cannot verify it.');
    if (cost.verifiedAt !== null) throw conflict(ErrorCode.CONFLICT, 'This cost is already verified.');
    await tx.$queryRaw`SELECT id FROM certification_programmes WHERE id = ${cost.programmeId} FOR UPDATE`;
    await tx.certificationCostEntry.update({ where: { id: costId }, data: { eligible, verifiedById: actor.userId, verifiedAt: new Date() } });
    if (eligible) {
      const field = cost.kind === 'COST' ? 'eligibleCostMinor' : 'creditedMinor';
      await tx.certificationProgramme.update({ where: { id: cost.programmeId }, data: { [field]: { increment: cost.amountMinor }, version: { increment: 1 } } });
    }
    await audit(tx, actor, AuditAction.CERTIFICATION_RECOVERY_CHANGED, 'certification_cost', costId, null, { eligible });
  });
}

export async function setProgrammeStatus(programmeId: string, status: 'ACTIVE' | 'PAUSED' | 'CLOSED', actor: StaffActor) {
  const p = await prisma.certificationProgramme.findUnique({ where: { id: programmeId } });
  if (p === null) throw notFound('Certification programme');
  if (status === 'ACTIVE') {
    const schedule = await activeSchedule(prisma, 'CERTIFICATION_RECOVERY', { country: null, channel: 'B2B', sellerAccountId: p.sellerAccountId });
    if (schedule === null) throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE, 'Certification recovery has not been adopted. Activate the certification-recovery schedule first.', [{ code: 'SCHEDULE_NOT_ACTIVE' }]);
    await prisma.certificationProgramme.update({ where: { id: programmeId }, data: { status, scheduleId: schedule.id } });
  } else {
    await prisma.certificationProgramme.update({ where: { id: programmeId }, data: { status } });
  }
  await audit(prisma, actor, AuditAction.CERTIFICATION_RECOVERY_CHANGED, 'certification_programme', programmeId, { status: p.status }, { status });
}

function unrecovered(p: { eligibleCostMinor: bigint; confirmedMinor: bigint; reservedMinor: bigint; refundedMinor: bigint; creditedMinor: bigint }): bigint {
  return unrecoveredBalance(p);
}

/**
 * Quote and reserve the certification charge for a buyer's line. Shown before
 * purchase. Under the programme row lock: the amount can never push recovery
 * past the documented unrecovered cost, however many checkouts run at once.
 * Re-quoting the same key never raises the amount the buyer already saw.
 */
export async function reserveCertificationCharge(input: { sellerAccountId: string; quoteKey: string; netGoodsMinor: bigint; currency: string; holdMinutes?: number; now?: Date }): Promise<{ allocationId: string; amountMinor: bigint; programmeReference: string; basis: string } | null> {
  const now = input.now ?? new Date();
  // Found outside the transaction: under REPEATABLE READ the first plain read in
  // a transaction fixes its snapshot, so the row lock must be the transaction's
  // FIRST statement - otherwise the totals read after it are stale and two
  // concurrent checkouts can both see the same unrecovered balance.
  const programme = await prisma.certificationProgramme.findFirst({ where: { sellerAccountId: input.sellerAccountId, status: 'ACTIVE', currency: input.currency, periodStart: { lte: now }, periodEnd: { gt: now } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (programme === null) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM certification_programmes WHERE id = ${programme.id} FOR UPDATE`;
    const p = await tx.certificationProgramme.findUniqueOrThrow({ where: { id: programme.id } });
    if (p.status !== 'ACTIVE') return null;
    const prior = await tx.certificationRecoveryAllocation.findUnique({ where: { programmeId_quoteKey: { programmeId: p.id, quoteKey: input.quoteKey } } });
    const heldUntil = new Date(now.getTime() + (input.holdMinutes ?? 30) * 60_000);
    const priorReserved = prior !== null && prior.status === 'RESERVED' ? prior.amountMinor : 0n;
    const room = unrecovered(p) + priorReserved;
    const fresh = certificationAllocation(input.netGoodsMinor, p.capBps, room);
    // The buyer's accepted figure can only fall on a re-quote, never rise.
    const amount = prior !== null && prior.status === 'RESERVED' && fresh > prior.amountMinor ? prior.amountMinor : fresh;
    if (prior !== null && prior.status !== 'RESERVED') return null;
    if (prior === null) {
      if (amount <= 0n) return null;
      const id = newId();
      await tx.certificationRecoveryAllocation.create({ data: { id, programmeId: p.id, quoteKey: input.quoteKey, netGoodsMinor: input.netGoodsMinor, amountMinor: amount, currency: input.currency, reservedUntil: heldUntil } });
      await tx.certificationProgramme.update({ where: { id: p.id }, data: { reservedMinor: { increment: amount }, version: { increment: 1 } } });
      return { allocationId: id, amountMinor: amount, programmeReference: p.reference, basis: `Up to ${String(p.capBps / 100)}% of net goods, capped by the programme's unrecovered certification cost` };
    }
    await tx.certificationRecoveryAllocation.update({ where: { id: prior.id }, data: { amountMinor: amount, netGoodsMinor: input.netGoodsMinor, reservedUntil: heldUntil } });
    await tx.certificationProgramme.update({ where: { id: p.id }, data: { reservedMinor: { increment: amount - prior.amountMinor }, version: { increment: 1 } } });
    return { allocationId: prior.id, amountMinor: amount, programmeReference: p.reference, basis: `Up to ${String(p.capBps / 100)}% of net goods, capped by the programme's unrecovered certification cost` };
  });
}

/**
 * The allocation as it is NOW, under a row lock. A locking read always sees
 * the latest committed row, whatever snapshot the caller's transaction holds,
 * so two refunds or confirmations at once cannot both act on a stale amount.
 */
async function lockedAllocation(client: Client, allocationId: string): Promise<{ id: string; programmeId: string; status: string; amountMinor: bigint; refundedMinor: bigint } | null> {
  const rows = await client.$queryRaw<{ id: string; programmeId: string; status: string; amountMinor: bigint; refundedMinor: bigint }[]>`SELECT id, programmeId, status, amountMinor, refundedMinor FROM certification_recovery_allocations WHERE id = ${allocationId} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) return null;
  await client.$queryRaw`SELECT id FROM certification_programmes WHERE id = ${row.programmeId} FOR UPDATE`;
  return { ...row, amountMinor: BigInt(row.amountMinor), refundedMinor: BigInt(row.refundedMinor) };
}

/** Confirm reserved allocations when the order is confirmed. */
export async function confirmCertificationCharge(client: Client, allocationId: string, link: { orderId: string; orderItemId: string | null }): Promise<void> {
  const a = await lockedAllocation(client, allocationId);
  if (a === null || a.status !== 'RESERVED') return;
  await client.certificationRecoveryAllocation.update({ where: { id: a.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), orderId: link.orderId, orderItemId: link.orderItemId } });
  await client.certificationProgramme.update({ where: { id: a.programmeId }, data: { reservedMinor: { decrement: a.amountMinor }, confirmedMinor: { increment: a.amountMinor }, version: { increment: 1 } } });
}

/** Release a reservation (cancellation, expiry, basket change). */
export async function releaseCertificationCharge(client: Client, allocationId: string): Promise<void> {
  const a = await lockedAllocation(client, allocationId);
  if (a === null || a.status !== 'RESERVED') return;
  await client.certificationRecoveryAllocation.update({ where: { id: a.id }, data: { status: 'RELEASED', releasedAt: new Date() } });
  await client.certificationProgramme.update({ where: { id: a.programmeId }, data: { reservedMinor: { decrement: a.amountMinor }, version: { increment: 1 } } });
}

/** A refund of a line gives back its certification charge proportionately; the recovered balance falls by the same amount. */
export async function refundCertificationCharge(client: Client, allocationId: string, refundedMinor: bigint): Promise<void> {
  const a = await lockedAllocation(client, allocationId);
  if (a === null || a.status !== 'CONFIRMED') return;
  const left = a.amountMinor - a.refundedMinor;
  const amount = refundedMinor > left ? left : refundedMinor;
  if (amount <= 0n) return;
  await client.certificationRecoveryAllocation.update({ where: { id: a.id }, data: { refundedMinor: { increment: amount }, ...(amount === left ? { status: 'REFUNDED' } : {}) } });
  await client.certificationProgramme.update({ where: { id: a.programmeId }, data: { refundedMinor: { increment: amount }, version: { increment: 1 } } });
}

/** Release every reservation past its hold. Idempotent. */
export async function sweepCertificationReservations(now = new Date()): Promise<number> {
  const stale = await prisma.certificationRecoveryAllocation.findMany({ where: { status: 'RESERVED', reservedUntil: { lt: now }, orderId: null }, select: { id: true }, take: 500 });
  for (const s of stale) await prisma.$transaction(async (tx) => releaseCertificationCharge(tx, s.id));
  return stale.length;
}

export async function readProgramme(id: string) {
  const p = await prisma.certificationProgramme.findUnique({ where: { id } });
  if (p === null) throw notFound('Certification programme');
  const [costs, allocations] = await Promise.all([
    prisma.certificationCostEntry.findMany({ where: { programmeId: id }, orderBy: { createdAt: 'asc' } }),
    prisma.certificationRecoveryAllocation.findMany({ where: { programmeId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ]);
  return serialise({ ...p, unrecoveredMinor: unrecovered(p), costs, allocations, accounting: { costRecovery: 'Recovered certification cost - not service revenue, not an advance.' } });
}

export async function listProgrammes(sellerAccountId?: string) {
  const rows = await prisma.certificationProgramme.findMany({ where: sellerAccountId ? { sellerAccountId } : {}, orderBy: { createdAt: 'desc' } });
  return serialise(rows.map((p) => ({ ...p, unrecoveredMinor: unrecovered(p) })));
}

// --- Security schedules ---------------------------------------------------------

export async function proposeSecuritySchedule(input: { sellerAccountId: string; tier: SecurityTier; form: 'RESERVE' | 'GUARANTEE' | 'DEPOSIT' | 'COMBINED'; reserveBps?: number; holdDays?: number; guaranteeMinor?: bigint; depositMinor?: bigint; capMinor?: bigint | null; currency: string; exposureBasis: string; documentedExposureMinor?: bigint | null; permittedUses: string[]; noticeTerms?: string | null; disputeRoute?: string | null; scheduleReference?: string | null }, actor: StaffActor) {
  const proposal = SECURITY_PROPOSALS[input.tier];
  const reserveBps = input.form === 'GUARANTEE' || input.form === 'DEPOSIT' ? 0 : (input.reserveBps ?? proposal.reserveBps);
  const holdDays = input.holdDays ?? proposal.holdDays;
  const guarantee = input.guaranteeMinor ?? 0n;
  const deposit = input.depositMinor ?? 0n;
  const stack = securityStackProblem({ reserveCapMinor: reserveBps > 0 ? (input.capMinor ?? 1n) : 0n, guaranteeMinor: guarantee, depositMinor: deposit, documentedExposureMinor: input.documentedExposureMinor ?? null });
  if (stack !== null) throw conflict(ErrorCode.SECURITY_EXPOSURE_REQUIRED, stack === 'NO_EXPOSURE_CALCULATION' ? 'More than one form of security needs a documented exposure calculation.' : 'The security exceeds the documented exposure.', [{ code: stack }]);
  const id = newId();
  await prisma.sellerSecuritySchedule.create({ data: { id, sellerAccountId: input.sellerAccountId, tier: input.tier, form: input.form, reserveBps, holdDays, guaranteeMinor: guarantee, depositMinor: deposit, capMinor: input.capMinor ?? null, currency: input.currency, exposureBasis: input.exposureBasis, documentedExposureMinor: input.documentedExposureMinor ?? null, permittedUsesJson: input.permittedUses as never, noticeTerms: input.noticeTerms ?? null, disputeRoute: input.disputeRoute ?? null, scheduleReference: input.scheduleReference ?? null, preparedById: actor.userId } });
  await audit(prisma, actor, AuditAction.SECURITY_SCHEDULE_CHANGED, 'seller_security_schedule', id, null, { ...input, guaranteeMinor: guarantee.toString(), depositMinor: deposit.toString(), capMinor: input.capMinor?.toString() ?? null, documentedExposureMinor: input.documentedExposureMinor?.toString() ?? null });
  return { id };
}

/** Approve and activate: a second person, the provider's written permission, a signed schedule, and an adopted SECURITY schedule. */
export async function activateSecuritySchedule(id: string, input: { providerPermissionRef: string }, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerSecuritySchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Security schedule');
    if (row.preparedById === actor.userId) throw separationRefusal('APPROVER_IS_PREPARER', 'The person who proposed this security cannot activate it.');
    const adopted = await activeSchedule(tx, 'SECURITY', { country: null, channel: 'B2B', sellerAccountId: row.sellerAccountId });
    const problems = [...(adopted === null ? ['SCHEDULE_NOT_ACTIVE'] : []), ...(input.providerPermissionRef.trim() === '' ? ['PROVIDER_PERMISSION_MISSING'] : []), ...(row.scheduleReference === null ? ['SIGNED_SCHEDULE_REFERENCE_MISSING'] : []), ...(row.status !== 'PROPOSED' ? ['NOT_PROPOSED'] : [])];
    if (problems.length > 0) throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE, 'This security cannot be activated yet.', problems.map((code) => ({ code })));
    const now = new Date();
    await tx.sellerSecuritySchedule.update({ where: { id }, data: { status: 'ACTIVE', providerPermissionRef: input.providerPermissionRef, approvedById: actor.userId, approvedAt: now, activatedAt: now, nextMonthlyReviewAt: new Date(now.getTime() + SECURITY_MONTHLY_REVIEW_DAYS * DAY_MS), nextQuarterlyReviewAt: new Date(now.getTime() + SECURITY_QUARTERLY_REVIEW_DAYS * DAY_MS), satisfactorySince: now } });
    await audit(tx, actor, AuditAction.SECURITY_SCHEDULE_CHANGED, 'seller_security_schedule', id, { status: row.status }, { status: 'ACTIVE', providerPermissionRef: input.providerPermissionRef });
  });
}

/** The reserve an active schedule asks of a seller's order, for the escrow allocation. Null when none is active. */
export async function activeReserveTerms(client: Client, sellerAccountId: string): Promise<{ reserveBps: number; holdDays: number; capMinor: bigint | null; scheduleId: string } | null> {
  const row = await client.sellerSecuritySchedule.findFirst({ where: { sellerAccountId, status: 'ACTIVE', reserveBps: { gt: 0 } }, orderBy: { activatedAt: 'desc' } });
  return row === null ? null : { reserveBps: row.reserveBps, holdDays: row.holdDays, capMinor: row.capMinor, scheduleId: row.id };
}

/** Create the monthly and quarterly reviews that have fallen due. Idempotent per period. */
export async function sweepSecurityReviews(now = new Date()): Promise<number> {
  const due = await prisma.sellerSecuritySchedule.findMany({ where: { status: 'ACTIVE', OR: [{ nextMonthlyReviewAt: { lte: now } }, { nextQuarterlyReviewAt: { lte: now } }] } });
  let created = 0;
  for (const s of due) {
    const held = await prisma.sellerFundHold.aggregate({ where: { sellerAccountId: s.sellerAccountId, reserveReleasedAt: null }, _sum: { reserveMinor: true } }).catch(() => ({ _sum: { reserveMinor: null } }));
    for (const kind of ['MONTHLY', 'QUARTERLY'] as const) {
      const at = kind === 'MONTHLY' ? s.nextMonthlyReviewAt : s.nextQuarterlyReviewAt;
      if (at === null || at.getTime() > now.getTime()) continue;
      const periodKey = kind === 'MONTHLY' ? at.toISOString().slice(0, 7) : `${String(at.getUTCFullYear())}-Q${String(Math.floor(at.getUTCMonth() / 3) + 1)}`;
      const r = await prisma.securityReview.createMany({ data: [{ id: newId(), scheduleId: s.id, kind, periodKey, heldMinor: held._sum.reserveMinor ?? 0n, dueAt: at }], skipDuplicates: true });
      created += r.count;
      await prisma.sellerSecuritySchedule.update({ where: { id: s.id }, data: kind === 'MONTHLY' ? { nextMonthlyReviewAt: new Date(at.getTime() + SECURITY_MONTHLY_REVIEW_DAYS * DAY_MS) } : { nextQuarterlyReviewAt: new Date(at.getTime() + SECURITY_QUARTERLY_REVIEW_DAYS * DAY_MS) } });
    }
  }
  return created;
}

/**
 * A person completes a review: current exposure recorded, any excess proposed
 * for release, reduction considered after six satisfactory months. Nothing is
 * forfeited or released by the review itself.
 */
export async function completeSecurityReview(reviewId: string, input: { exposureMinor: bigint; outcome: 'NO_CHANGE' | 'REDUCE_EXCESS' | 'CONSIDER_REDUCTION' | 'ISSUE_FOUND'; note: string }, actor: StaffActor) {
  const r = await prisma.securityReview.findUnique({ where: { id: reviewId } });
  if (r === null) throw notFound('Security review');
  const s = await prisma.sellerSecuritySchedule.findUniqueOrThrow({ where: { id: r.scheduleId } });
  const excess = excessHeld(r.heldMinor ?? 0n, input.exposureMinor);
  const satisfactoryMonths = s.satisfactorySince === null ? 0 : Math.floor((Date.now() - s.satisfactorySince.getTime()) / (30 * DAY_MS));
  if (input.outcome === 'CONSIDER_REDUCTION' && satisfactoryMonths < SECURITY_REDUCTION_AFTER_SATISFACTORY_MONTHS) {
    throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: `Reduction is considered after ${String(SECURITY_REDUCTION_AFTER_SATISFACTORY_MONTHS)} months of satisfactory history.`, details: [{ code: 'TOO_EARLY', meta: { satisfactoryMonths } }] });
  }
  await prisma.securityReview.update({ where: { id: reviewId }, data: { exposureMinor: input.exposureMinor, excessMinor: excess, outcome: input.outcome, note: input.note, reviewedById: actor.userId, reviewedAt: new Date() } });
  if (input.outcome === 'ISSUE_FOUND') await prisma.sellerSecuritySchedule.update({ where: { id: s.id }, data: { satisfactorySince: new Date() } });
  await audit(prisma, actor, AuditAction.SECURITY_SCHEDULE_CHANGED, 'security_review', reviewId, null, { ...input, exposureMinor: input.exposureMinor.toString(), excessMinor: excess.toString() });
  return serialise({ excessMinor: excess, satisfactoryMonths });
}

export async function listSecurity(sellerAccountId?: string) {
  const schedules = await prisma.sellerSecuritySchedule.findMany({ where: sellerAccountId ? { sellerAccountId } : {}, orderBy: { createdAt: 'desc' } });
  const reviews = await prisma.securityReview.findMany({ where: { scheduleId: { in: schedules.map((s) => s.id) } }, orderBy: { dueAt: 'desc' }, take: 500 });
  return serialise({ proposals: SECURITY_PROPOSALS, schedules, reviews });
}

// --- Insurance register ---------------------------------------------------------

export async function saveInsurancePolicy(input: { id?: string; holderType: 'SELLER' | 'PLATFORM'; sellerAccountId?: string | null; coverType: string; riskGroup?: string | null; insurer: string; policyNumber: string; insuredEntity: string; additionalInsured?: string | null; sites: string[]; products: string[]; territories: string[]; currency: string; perOccurrenceMinor?: bigint | null; aggregateMinor?: bigint | null; deductibleMinor?: bigint | null; exclusions?: string | null; claimsMadeRetroDate?: Date | null; effectiveFrom: Date; expiresAt: Date; cancellationNoticeDays?: number | null; brokerName?: string | null; brokerReviewedAt?: Date | null; brokerReviewRef?: string | null }, actor: StaffActor) {
  if (input.holderType === 'SELLER' && !input.sellerAccountId) throw new AppError({ statusCode: 422, code: ErrorCode.VALIDATION_FAILED, message: 'Seller cover names the seller.' });
  const id = input.id ?? newId();
  const data = { holderType: input.holderType, sellerAccountId: input.holderType === 'SELLER' ? (input.sellerAccountId ?? null) : null, coverType: input.coverType, riskGroup: input.riskGroup ?? null, insurer: input.insurer, policyNumber: input.policyNumber, insuredEntity: input.insuredEntity, additionalInsured: input.additionalInsured ?? null, sitesJson: input.sites as never, productsJson: input.products as never, territoriesJson: input.territories as never, currency: input.currency, perOccurrenceMinor: input.perOccurrenceMinor ?? null, aggregateMinor: input.aggregateMinor ?? null, deductibleMinor: input.deductibleMinor ?? null, exclusions: input.exclusions ?? null, claimsMadeRetroDate: input.claimsMadeRetroDate ?? null, effectiveFrom: input.effectiveFrom, expiresAt: input.expiresAt, cancellationNoticeDays: input.cancellationNoticeDays ?? null, brokerName: input.brokerName ?? null, brokerReviewedAt: input.brokerReviewedAt ?? null, brokerReviewRef: input.brokerReviewRef ?? null, verificationStatus: 'PENDING', verifiedById: null, verifiedAt: null };
  if (input.id) await prisma.insurancePolicyRecord.update({ where: { id }, data });
  else await prisma.insurancePolicyRecord.create({ data: { id, ...data, recordedById: actor.userId } });
  await audit(prisma, actor, AuditAction.INSURANCE_POLICY_CHANGED, 'insurance_policy', id, null, { holderType: input.holderType, coverType: input.coverType, insurer: input.insurer, policyNumber: input.policyNumber });
  return { id };
}

/** Insurer verification, by someone other than the person who recorded the policy. */
export async function verifyInsurancePolicy(id: string, input: { verified: boolean; method: string }, actor: StaffActor) {
  const row = await prisma.insurancePolicyRecord.findUnique({ where: { id } });
  if (row === null) throw notFound('Insurance policy');
  if (row.recordedById === actor.userId) throw separationRefusal('VERIFIER_IS_RECORDER', 'The person who recorded this policy cannot verify it.');
  await prisma.insurancePolicyRecord.update({ where: { id }, data: { verificationStatus: input.verified ? 'VERIFIED' : 'REJECTED', verificationMethod: input.method, verifiedById: actor.userId, verifiedAt: new Date() } });
  await audit(prisma, actor, AuditAction.INSURANCE_POLICY_CHANGED, 'insurance_policy', id, { verificationStatus: row.verificationStatus }, { verificationStatus: input.verified ? 'VERIFIED' : 'REJECTED', method: input.method });
}

export async function listInsurance(filter: { holderType?: 'SELLER' | 'PLATFORM'; sellerAccountId?: string }) {
  const now = new Date();
  const rows = await prisma.insurancePolicyRecord.findMany({ where: { ...(filter.holderType ? { holderType: filter.holderType } : {}), ...(filter.sellerAccountId ? { sellerAccountId: filter.sellerAccountId } : {}) }, orderBy: { expiresAt: 'asc' } });
  return serialise({
    groups: DOC08_INSURANCE_RISK_GROUPS,
    notice: 'Proposed underwriting starting limits, not legal minima or insurer quotations. Insurance never approves a category on its own.',
    policies: rows.map((p) => ({ ...p, gaps: insuranceGaps(p as never, DOC08_INSURANCE_RISK_GROUPS.find((g) => g.code === p.riskGroup) ?? null, now), daysToExpiry: Math.ceil((p.expiresAt.getTime() - now.getTime()) / DAY_MS) })),
  });
}
