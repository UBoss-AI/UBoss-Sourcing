/**
 * Releasing a clearly identified part of a lot.
 *
 * When the lot as a whole cannot be released - the pre-shipment report failed
 * or was inconclusive, or a finding still holds it - part of it sometimes can:
 * the cartons that were segregated, re-inspected and shown to be good. That
 * is a decision, not a calculation, and this file makes it a careful one:
 *
 *   1. An audit SUPERVISOR asks for it in the Audit Console, naming the
 *      sub-lot (its own code), the lot it came from, how it was separated and
 *      identified, and exactly what may leave per order line. The quantities
 *      may not exceed what remains undispatched on each line.
 *   2. Somebody ELSE approves it in the Admin Panel with the existing release
 *      permission. The requester can never approve their own request.
 *   3. Exactly ONE seller dispatch can use it, and only if what is being sent
 *      fits inside it line by line. Using it marks it spent in the same
 *      transaction as the dispatch, so a second dispatch - or two at once -
 *      finds it spent.
 *
 * A sub-lot release never turns the whole order into "released", never moves
 * the order to SHIPPED by itself, never touches warehouse stock, and never
 * says the rest of the lot was inspected. Passing a sample inspection does not
 * turn untested stock into individually verified stock, and nothing here
 * pretends it does.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { toMilli, type QuantityUnitName } from '../../domain/inspection-quantity.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { recordInspectionEvent, type InspectionActor } from './context.js';
import { notifyAuditUsers, staffUserIds } from '../audit-console/notification.service.js';

export interface SubLotLine {
  orderItemId: string;
  quantity: number;
}

function refuse(code: string, message: string): never {
  throw conflict(ErrorCode.INSPECTION_SUBLOT_NOT_ALLOWED, message, [{ code }]);
}

function linesOf(value: unknown): SubLotLine[] {
  return Array.isArray(value)
    ? (value as SubLotLine[]).filter((line) => typeof line.orderItemId === 'string' && Number.isInteger(line.quantity))
    : [];
}

/** A supervisor asks for a sub-lot release. */
export async function requestSubLotRelease(
  actor: InspectionActor & { userId: string },
  input: {
    jobId: string;
    subLotCode: string;
    lotReference: string;
    quantity: string;
    unit: QuantityUnitName;
    lines: SubLotLine[];
    reason: string;
  },
): Promise<{ id: string }> {
  if (input.reason.trim().length < 40) {
    refuse('REASON_REQUIRED', 'Say how the sub-lot was separated and identified, and why it may leave, in at least forty characters.');
  }
  if (input.lines.length === 0 || input.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'List what may leave, per order line, in whole units.', [{ field: 'lines', code: 'INVALID' }]);
  }
  if (toMilli(input.quantity, 'quantity') <= 0n) {
    throw badRequest(ErrorCode.INSPECTION_QUANTITY_INVALID, 'A sub-lot holds more than nothing.', [{ field: 'quantity', code: 'ZERO' }]);
  }

  return prisma.$transaction(async (tx) => {
    const job = await tx.inspectionJob.findUnique({
      where: { id: input.jobId },
      select: {
        id: true,
        jobNumber: true,
        stage: true,
        status: true,
        requirementId: true,
        requirement: { select: { orderId: true, sellerOrderGroupId: true, loadReleasedAt: true } },
        reports: { where: { status: 'SIGNED', supersededAt: null }, orderBy: { revision: 'desc' }, take: 1, select: { id: true } },
      },
    });
    if (job === null) throw notFound('Inspection');
    if (job.stage !== 'PRE_SHIPMENT' || job.status !== 'COMPLETED') {
      refuse('NOT_A_SIGNED_PRE_SHIPMENT_JOB', 'A sub-lot is released against a signed pre-shipment inspection.');
    }
    const report = job.reports[0];
    if (report === undefined) refuse('NO_SIGNED_REPORT', 'A sub-lot is released against a signed report.');

    const group = await tx.sellerOrderGroup.findUniqueOrThrow({
      where: { id: job.requirement.sellerOrderGroupId },
      select: { lines: { select: { orderItemId: true, quantity: true, fulfilledQuantity: true } } },
    });
    const remaining = new Map(group.lines.map((line) => [line.orderItemId, line.quantity - line.fulfilledQuantity]));
    for (const line of input.lines) {
      const left = remaining.get(line.orderItemId);
      if (left === undefined) refuse('LINE_NOT_ON_ORDER', 'One of those lines is not on this order.');
      if (line.quantity > left) refuse('MORE_THAN_REMAINS', 'A sub-lot cannot release more than remains to be dispatched on a line.');
    }
    const requested = new Map(input.lines.map((line) => [line.orderItemId, line.quantity]));
    const wholeLot = [...remaining.entries()].every(([itemId, left]) => left === 0 || (requested.get(itemId) ?? 0) >= left);
    if (wholeLot) {
      refuse('WHOLE_LOT', 'That is everything still to be dispatched. Releasing a whole held lot is a conditional release, not a sub-lot.');
    }

    const code = input.subLotCode.trim().toUpperCase().slice(0, 64);
    const taken = await tx.inspectionSubLotRelease.findUnique({
      where: { requirementId_subLotCode: { requirementId: job.requirementId, subLotCode: code } },
      select: { id: true },
    });
    if (taken !== null) refuse('CODE_TAKEN', 'That sub-lot code is already used on this order. Each sub-lot needs its own code.');

    const live = await tx.inspectionSubLotRelease.findFirst({
      where: { requirementId: job.requirementId, state: { in: ['PENDING_APPROVAL', 'APPROVED'] }, consumedAt: null },
      select: { subLotCode: true },
    });
    if (live !== null) refuse('ONE_AT_A_TIME', `Sub-lot ${live.subLotCode} is still open on this order. Use or cancel it first.`);

    const id = newId();
    await tx.inspectionSubLotRelease.create({
      data: {
        id,
        requirementId: job.requirementId,
        jobId: job.id,
        reportId: report.id,
        subLotCode: code,
        lotReference: input.lotReference.trim().slice(0, 64),
        quantity: input.quantity.trim(),
        unit: input.unit,
        linesJson: input.lines as never,
        reason: input.reason.trim(),
        requestedByUserId: actor.userId,
        requestedByLabel: actor.label.slice(0, 160),
        requestedAt: new Date(),
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'sublot_requested',
      actor,
      summary: `Sub-lot ${code} (${input.quantity.trim()} ${input.unit.toLowerCase()}) requested for release from ${job.jobNumber}. Waiting for a second approver.`,
      data: { subLotReleaseId: id, lines: input.lines },
      audit: AuditAction.INSPECTION_SUBLOT_REQUESTED,
    });
    return { id };
  });
}

/** Approve or reject, in the Admin Panel. Never by the person who asked. */
export async function decideSubLotRelease(
  actor: InspectionActor & { userId: string },
  id: string,
  input: { decision: 'APPROVE' | 'REJECT'; note?: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.inspectionSubLotRelease.findUnique({
      where: { id },
      include: { requirement: { select: { orderId: true } } },
    });
    if (row === null) throw notFound('Sub-lot release');
    if (row.state !== 'PENDING_APPROVAL') refuse('NOT_PENDING', 'This sub-lot release has already been decided.');
    if (row.requestedByUserId === actor.userId) refuse('SAME_PERSON', 'The person who asked for a sub-lot release cannot also decide it.');
    if (input.decision === 'REJECT' && (input.note ?? '').trim().length === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the sub-lot release is rejected.', [{ field: 'note', code: 'REQUIRED' }]);
    }

    const decided = await tx.inspectionSubLotRelease.updateMany({
      where: { id, state: 'PENDING_APPROVAL', lockVersion: row.lockVersion },
      data: {
        state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        decidedByUserId: actor.userId,
        decidedByLabel: actor.label.slice(0, 160),
        decidedAt: new Date(),
        decisionNote: input.note?.trim().slice(0, 1024) || null,
        lockVersion: { increment: 1 },
      },
    });
    if (decided.count !== 1) refuse('NOT_PENDING', 'Somebody else decided this a moment ago.');

    await recordInspectionEvent(tx, {
      requirementId: row.requirementId,
      orderId: row.requirement.orderId,
      jobId: row.jobId,
      kind: input.decision === 'APPROVE' ? 'sublot_approved' : 'sublot_rejected',
      actor,
      summary: `Sub-lot ${row.subLotCode} release ${input.decision === 'APPROVE' ? 'approved' : 'rejected'}${input.note ? `: ${input.note.trim()}` : '.'}`,
      data: { subLotReleaseId: id },
      audit: AuditAction.INSPECTION_SUBLOT_DECIDED,
    });

    await notifyAuditUsers(tx, [row.requestedByUserId], {
      kind: 'SUBLOT_DECIDED',
      title: `Sub-lot ${row.subLotCode} ${input.decision === 'APPROVE' ? 'approved' : 'rejected'}`,
      body: input.note ?? null,
      link: `/jobs/${row.jobId}`,
      subjectType: 'inspection_sublot',
      subjectId: id,
      dedupeKey: `sublot-decided:${id}`,
    });
  });
}

/** Cancel one's own request before it is decided or used. */
export async function cancelSubLotRelease(actor: { userId: string }, id: string): Promise<void> {
  const result = await prisma.inspectionSubLotRelease.updateMany({
    where: { id, requestedByUserId: actor.userId, state: { in: ['PENDING_APPROVAL', 'APPROVED'] }, consumedAt: null },
    data: { state: 'CANCELLED', lockVersion: { increment: 1 } },
  });
  if (result.count !== 1) refuse('NOT_CANCELLABLE', 'Only your own open, unused sub-lot release can be cancelled.');
}

/**
 * Called by the seller dispatch path when the whole-lot gate is shut. Opens
 * it for THIS dispatch only if an approved, unused sub-lot covers exactly
 * what is being sent, and spends it in the same transaction. Returns false -
 * and changes nothing - otherwise.
 */
export async function consumeSubLotForDispatch(
  tx: PrismaTransaction,
  input: { sellerOrderGroupId: string; contents: { orderItemId: string; quantity: number }[]; dispatchRef: string },
): Promise<boolean> {
  const requirement = await tx.inspectionRequirement.findUnique({
    where: { sellerOrderGroupId: input.sellerOrderGroupId },
    select: { id: true, orderId: true },
  });
  if (requirement === null) return false;

  const release = await tx.inspectionSubLotRelease.findFirst({
    where: { requirementId: requirement.id, state: 'APPROVED', consumedAt: null },
  });
  if (release === null) return false;

  const allowed = new Map(linesOf(release.linesJson).map((line) => [line.orderItemId, line.quantity]));
  const fits = input.contents.every((entry) => {
    const cap = allowed.get(entry.orderItemId);
    return cap !== undefined && entry.quantity > 0 && entry.quantity <= cap;
  });
  if (!fits) return false;

  const spent = await tx.inspectionSubLotRelease.updateMany({
    where: { id: release.id, state: 'APPROVED', consumedAt: null, lockVersion: release.lockVersion },
    data: { consumedAt: new Date(), consumedByRef: input.dispatchRef.slice(0, 64), lockVersion: { increment: 1 } },
  });
  if (spent.count !== 1) return false;

  await recordInspectionEvent(tx, {
    requirementId: requirement.id,
    orderId: requirement.orderId,
    jobId: release.jobId,
    kind: 'sublot_dispatched',
    actor: { party: 'SYSTEM', userId: null, label: 'The system' },
    summary: `Sub-lot ${release.subLotCode} dispatched under its approved release. The rest of the lot stays held.`,
    data: { subLotReleaseId: release.id, contents: input.contents, dispatchRef: input.dispatchRef },
    audit: AuditAction.INSPECTION_SUBLOT_CONSUMED,
  });
  return true;
}

/** Tell the supervisors and the admin desk there is a sub-lot waiting. */
export async function notifySubLotWaiting(id: string): Promise<void> {
  const row = await prisma.inspectionSubLotRelease.findUnique({ where: { id }, select: { subLotCode: true, jobId: true, requestedByUserId: true } });
  if (row === null) return;
  const supervisors = (await staffUserIds(prisma, ['SUPERVISOR'])).filter((userId) => userId !== row.requestedByUserId);
  await notifyAuditUsers(prisma, supervisors, {
    kind: 'SUBLOT_REQUESTED',
    title: `Sub-lot ${row.subLotCode} is waiting for approval in the Admin Panel`,
    link: `/jobs/${row.jobId}`,
    subjectType: 'inspection_sublot',
    subjectId: id,
    dedupeKey: `sublot-requested:${id}`,
  });
}
