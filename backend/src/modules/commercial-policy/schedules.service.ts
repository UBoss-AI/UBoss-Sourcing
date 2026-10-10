/**
 * Versioned commercial schedules (Doc 08 s2-s6, Doc 07 s3, s6, s10).
 *
 * Each proposal from the two documents is imported as version 1 of its kind,
 * DRAFT. A schedule moves DRAFT -> PENDING_APPROVAL -> APPROVED -> ACTIVE ->
 * RETIRED, and only people move it:
 *   - the approver is not the preparer, and records the adoption evidence;
 *   - activation needs the signed-schedule reference, an effective date and,
 *     for money held or split, the payment provider's written confirmation;
 *   - activating a version retires the previous ACTIVE one of the same kind.
 * Nothing activates on import, on a timer or on deploy.
 */
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import {
  SCHEDULE_KINDS,
  activationProblems,
  certificationAllocation,
  commissionForLine,
  commissionWithLargeOrderBand,
  draftScheduleBody,
  logisticsCoordination,
  proposedInsuredValue,
  reserveForOrder,
  scheduledRateBps,
  type SalesChannel,
  type ScheduleKind,
  type ScheduleStatus,
} from '../../domain/commercial-policy.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { audit, separationRefusal, serialise, type Client, type StaffActor } from './shared.js';

const TITLES: Readonly<Record<ScheduleKind, [string, string]>> = {
  COMMISSION: ['Category commission schedule (B2B / B2C)', 'Doc 08 s2-s3'],
  LARGE_ORDER_DISCOUNT: ['Large B2B order incremental discount', 'Doc 08 s3'],
  LOGISTICS_CHARGE: ['Logistics coordination charge and cargo insured value', 'Doc 07 s3; Doc 08 s5'],
  CERTIFICATION_RECOVERY: ['Buyer-funded certification recovery', 'Doc 08 s4'],
  SECURITY: ['Seller security: rolling reserve or guarantee', 'Doc 07 s10; Doc 08 s6'],
  INSURANCE: ['Proposed insurance risk groups and limits', 'Doc 08 s6'],
  PAYMENT_PLAN: ['Bespoke B2B 30/60/10 payment plan', 'Doc 08 s5'],
  SUBSCRIPTION: ['Seller subscriptions and onboarding', 'Doc 08 s2'],
  CASE_WINDOWS: ['Receipt, case and appeal administrative windows', 'Doc 07 s6, s8'],
};

/** Import every Doc 07 / Doc 08 proposal as version 1, DRAFT. Idempotent: an existing version is never touched. */
export async function seedDraftSchedules(client: Client = prisma): Promise<number> {
  let created = 0;
  for (const kind of SCHEDULE_KINDS) {
    const existing = await client.commercialSchedule.findUnique({ where: { kind_version: { kind, version: 1 } }, select: { id: true } });
    if (existing !== null) continue;
    const [title, sourceDocument] = TITLES[kind];
    await client.commercialSchedule.create({
      data: {
        id: newId(),
        kind,
        version: 1,
        status: 'DRAFT',
        title,
        sourceDocument,
        scopeJson: {},
        bodyJson: serialise(draftScheduleBody(kind)) as never,
        note: 'Imported proposal. Not binding until adopted, disclosed and - where money is held or split - confirmed by the payment provider.',
      },
    });
    created += 1;
  }
  return created;
}

export async function listSchedules(filter: { kind?: ScheduleKind; status?: ScheduleStatus }) {
  const rows = await prisma.commercialSchedule.findMany({
    where: { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ kind: 'asc' }, { version: 'desc' }],
  });
  return serialise(rows);
}

export async function readSchedule(id: string) {
  const row = await prisma.commercialSchedule.findUnique({ where: { id } });
  if (row === null) throw notFound('Commercial schedule');
  const events = await prisma.commercialScheduleEvent.findMany({ where: { scheduleId: id }, orderBy: { createdAt: 'asc' } });
  return serialise({ ...row, events, activationProblems: activationProblems({ ...row, kind: row.kind as ScheduleKind, status: row.status as ScheduleStatus }, '') .filter((p) => p !== 'ACTIVATOR_IS_PREPARER') });
}

async function event(client: Client, scheduleId: string, kind: string, actor: StaffActor | null, note: string | null): Promise<void> {
  await client.commercialScheduleEvent.create({ data: { id: newId(), scheduleId, kind, actorUserId: actor?.userId ?? null, note } });
}

/** A new DRAFT version, copied from the latest of its kind. */
export async function draftNewVersion(kind: ScheduleKind, actor: StaffActor) {
  return prisma.$transaction(async (tx) => {
    const latest = await tx.commercialSchedule.findFirst({ where: { kind }, orderBy: { version: 'desc' } });
    const [title, sourceDocument] = TITLES[kind];
    const id = newId();
    await tx.commercialSchedule.create({
      data: {
        id,
        kind,
        version: (latest?.version ?? 0) + 1,
        status: 'DRAFT',
        title: latest?.title ?? title,
        sourceDocument: latest?.sourceDocument ?? sourceDocument,
        scopeJson: (latest?.scopeJson ?? {}) as never,
        bodyJson: (latest?.bodyJson ?? serialise(draftScheduleBody(kind))) as never,
        preparedById: actor.userId,
      },
    });
    await event(tx, id, 'DRAFTED', actor, latest ? `Copied from version ${String(latest.version)}` : null);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'commercial_schedule', id, null, { kind, action: 'DRAFTED' });
    return { id };
  });
}

export interface ScheduleEdit {
  title?: string;
  scope?: { countries?: string[]; channels?: SalesChannel[]; sellerAccountIds?: string[] };
  body?: unknown;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  scheduleReference?: string | null;
  note?: string | null;
}

export async function editDraft(id: string, edit: ScheduleEdit, actor: StaffActor) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.commercialSchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Commercial schedule');
    if (row.status !== 'DRAFT') throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_EDITABLE, 'Only a draft schedule can be edited. Draft a new version instead.');
    const data = {
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.scope !== undefined ? { scopeJson: edit.scope as never } : {}),
      ...(edit.body !== undefined ? { bodyJson: edit.body as never } : {}),
      ...(edit.effectiveFrom !== undefined ? { effectiveFrom: edit.effectiveFrom } : {}),
      ...(edit.effectiveUntil !== undefined ? { effectiveUntil: edit.effectiveUntil } : {}),
      ...(edit.scheduleReference !== undefined ? { scheduleReference: edit.scheduleReference } : {}),
      ...(edit.note !== undefined ? { note: edit.note } : {}),
      preparedById: row.preparedById ?? actor.userId,
    };
    await tx.commercialSchedule.update({ where: { id }, data });
    await event(tx, id, 'EDITED', actor, null);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'commercial_schedule', id, { bodyJson: row.bodyJson, scopeJson: row.scopeJson }, { ...edit, action: 'EDITED' });
  });
}

export async function submitForApproval(id: string, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.commercialSchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Commercial schedule');
    if (row.status !== 'DRAFT') throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_EDITABLE, 'Only a draft can be submitted for approval.');
    await tx.commercialSchedule.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), preparedById: row.preparedById ?? actor.userId } });
    await event(tx, id, 'SUBMITTED', actor, null);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'commercial_schedule', id, { status: row.status }, { status: 'PENDING_APPROVAL' });
  });
}

/** Approve (or send back) a submitted schedule. The approver records the adoption evidence and is not the preparer. */
export async function decideSchedule(id: string, input: { approve: boolean; evidence: string; providerConfirmationRef?: string | null }, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.commercialSchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Commercial schedule');
    if (row.status !== 'PENDING_APPROVAL') throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_EDITABLE, 'Only a schedule awaiting approval can be decided.');
    if (row.preparedById === actor.userId) throw separationRefusal('APPROVER_IS_PREPARER', 'The person who prepared this schedule cannot approve it.');
    const data = input.approve
      ? {
          status: 'APPROVED',
          approvedById: actor.userId,
          approvedAt: new Date(),
          approvalEvidence: input.evidence,
          ...(input.providerConfirmationRef ? { providerConfirmationRef: input.providerConfirmationRef, providerConfirmedAt: new Date() } : {}),
        }
      : { status: 'DRAFT', submittedAt: null };
    await tx.commercialSchedule.update({ where: { id }, data });
    await event(tx, id, input.approve ? 'APPROVED' : 'RETURNED', actor, input.evidence);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'commercial_schedule', id, { status: row.status }, { status: data.status, evidence: input.evidence });
  });
}

/** Record the payment provider's written confirmation on an approved schedule. */
export async function recordProviderConfirmation(id: string, reference: string, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.commercialSchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Commercial schedule');
    if (row.status !== 'APPROVED' && row.status !== 'PENDING_APPROVAL') throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_EDITABLE, 'Provider confirmation is recorded before activation.');
    await tx.commercialSchedule.update({ where: { id }, data: { providerConfirmationRef: reference, providerConfirmedAt: new Date() } });
    await event(tx, id, 'PROVIDER_CONFIRMED', actor, reference);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'commercial_schedule', id, null, { providerConfirmationRef: reference });
  });
}

/** Activation: a person's act, never automatic. Retires the previous active version of the same kind. */
export async function activateSchedule(id: string, actor: StaffActor) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.commercialSchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Commercial schedule');
    const problems = activationProblems({ ...row, kind: row.kind as ScheduleKind, status: row.status as ScheduleStatus }, actor.userId);
    if (problems.includes('ACTIVATOR_IS_PREPARER') || problems.includes('APPROVER_IS_PREPARER')) {
      throw separationRefusal(problems.includes('APPROVER_IS_PREPARER') ? 'APPROVER_IS_PREPARER' : 'ACTIVATOR_IS_PREPARER', 'The person who prepared this schedule cannot activate it.');
    }
    if (problems.length > 0) {
      throw conflict(ErrorCode.COMMERCIAL_SCHEDULE_NOT_ACTIVATABLE, 'This schedule cannot be activated yet.', problems.map((code) => ({ code })));
    }
    const now = new Date();
    const previous = await tx.commercialSchedule.findMany({ where: { kind: row.kind, status: 'ACTIVE' }, select: { id: true } });
    for (const p of previous) {
      await tx.commercialSchedule.update({ where: { id: p.id }, data: { status: 'RETIRED', retiredAt: now } });
      await event(tx, p.id, 'RETIRED', actor, `Superseded by version ${String(row.version)}`);
    }
    await tx.commercialSchedule.update({ where: { id }, data: { status: 'ACTIVE', activatedById: actor.userId, activatedAt: now } });
    await event(tx, id, 'ACTIVATED', actor, null);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_ACTIVATED, 'commercial_schedule', id, { status: row.status }, { status: 'ACTIVE', retired: previous.map((p) => p.id) });
  });
}

export async function retireSchedule(id: string, actor: StaffActor, reason: string) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.commercialSchedule.findUnique({ where: { id } });
    if (row === null) throw notFound('Commercial schedule');
    if (row.status === 'RETIRED') return;
    await tx.commercialSchedule.update({ where: { id }, data: { status: 'RETIRED', retiredAt: new Date() } });
    await event(tx, id, 'RETIRED', actor, reason);
    await audit(tx, actor, AuditAction.COMMERCIAL_SCHEDULE_CHANGED, 'commercial_schedule', id, { status: row.status }, { status: 'RETIRED', reason });
  });
}

interface ScopeShape {
  countries?: string[];
  channels?: SalesChannel[];
  sellerAccountIds?: string[];
}

function inScope(scope: ScopeShape, at: { country: string | null; channel: SalesChannel; sellerAccountId: string | null }): boolean {
  if (scope.countries && scope.countries.length > 0 && (at.country === null || !scope.countries.includes(at.country))) return false;
  if (scope.channels && scope.channels.length > 0 && !scope.channels.includes(at.channel)) return false;
  if (scope.sellerAccountIds && scope.sellerAccountIds.length > 0 && (at.sellerAccountId === null || !scope.sellerAccountIds.includes(at.sellerAccountId))) return false;
  return true;
}

/** The ACTIVE schedule of a kind in force for a context, or null. Never a draft. */
export async function activeSchedule(client: Client, kind: ScheduleKind, at: { country: string | null; channel: SalesChannel; sellerAccountId: string | null; when?: Date }) {
  const when = at.when ?? new Date();
  const rows = await client.commercialSchedule.findMany({ where: { kind, status: 'ACTIVE' }, orderBy: { version: 'desc' } });
  return (
    rows.find((r) => (r.effectiveFrom === null || r.effectiveFrom.getTime() <= when.getTime()) && (r.effectiveUntil === null || r.effectiveUntil.getTime() > when.getTime()) && inScope((r.scopeJson ?? {}) as ScopeShape, at)) ?? null
  );
}

/** Department slug of a category: itself when top level, else the root of its materialised path (/rootId/.../). */
export async function departmentSlugOf(client: Client, categoryId: string | null): Promise<string | null> {
  if (categoryId === null) return null;
  const cat = await client.category.findUnique({ where: { id: categoryId }, select: { slug: true, parentId: true, path: true } });
  if (cat === null) return null;
  if (cat.parentId === null) return cat.slug;
  const rootId = cat.path.split('/').find((p) => p.length > 0) ?? cat.parentId;
  const root = await client.category.findUnique({ where: { id: rootId }, select: { slug: true } });
  return root?.slug ?? null;
}

/** The adopted commission rate for a line, or null when no ACTIVE schedule covers it. */
export async function scheduledCommissionBps(client: Client, input: { categoryId: string | null; country: string | null; channel: SalesChannel; sellerAccountId: string | null }): Promise<{ bps: number; scheduleId: string; version: number } | null> {
  const schedule = await activeSchedule(client, 'COMMISSION', input);
  if (schedule === null) return null;
  const slug = await departmentSlugOf(client, input.categoryId);
  if (slug === null) return null;
  const bps = scheduledRateBps(schedule.bodyJson as never, slug, input.channel);
  return bps === null ? null : { bps, scheduleId: schedule.id, version: schedule.version };
}

/**
 * The financial and operational effect of a schedule, shown before anyone
 * approves it. Pure arithmetic on example figures the reviewer chooses.
 */
export async function previewSchedule(id: string, sample: { goodsMinor: bigint; externalFreightMinor: bigint; channel: SalesChannel; departmentSlug: string | null }) {
  const row = await prisma.commercialSchedule.findUnique({ where: { id } });
  if (row === null) throw notFound('Commercial schedule');
  const body = row.bodyJson as Record<string, unknown>;
  const kind = row.kind as ScheduleKind;
  switch (kind) {
    case 'COMMISSION': {
      const rows = (body['rows'] ?? []) as { department: string; categorySlug: string | null; b2bBps: number; b2cBps: number }[];
      return serialise({
        kind,
        perDepartment: rows.map((r) => {
          const bps = sample.channel === 'B2B' ? r.b2bBps : r.b2cBps;
          return { department: r.department, categorySlug: r.categorySlug, ...commissionForLine({ goodsMinor: sample.goodsMinor, sellerFundedDiscountMinor: 0n, platformFundedDiscountMinor: 0n, bps }) };
        }),
      });
    }
    case 'LARGE_ORDER_DISCOUNT': {
      const reduced = typeof body['reducedBps'] === 'number' ? body['reducedBps'] : null;
      const threshold = typeof body['thresholdMinor'] === 'string' ? BigInt(body['thresholdMinor']) : 250_000_000n;
      return serialise({
        kind,
        reducedRateProvided: reduced !== null,
        example: commissionWithLargeOrderBand(sample.goodsMinor, 1250, reduced === null ? null : { reducedBps: reduced, thresholdMinor: threshold, approvalReference: row.approvalEvidence ?? '', contributionEvidence: row.approvalEvidence ?? '' }, sample.channel),
      });
    }
    case 'LOGISTICS_CHARGE': {
      const bps = typeof body['bps'] === 'number' ? body['bps'] : 500;
      const cap = typeof body['capMinor'] === 'string' ? BigInt(body['capMinor']) : null;
      return serialise({ kind, coordination: logisticsCoordination(sample.externalFreightMinor, { kind: 'COST_PLUS', bps, capMinor: cap }), proposedInsuredValueMinor: proposedInsuredValue(sample.goodsMinor, sample.externalFreightMinor) });
    }
    case 'CERTIFICATION_RECOVERY':
      return serialise({ kind, allocationWithUnlimitedBalance: certificationAllocation(sample.goodsMinor, Number(body['capBps'] ?? 100), sample.goodsMinor), note: 'Capped per order by the programme’s documented unrecovered cost; zero once recovered.' });
    case 'SECURITY': {
      const proposals = (body['proposals'] ?? {}) as Record<string, { reserveBps: number; holdDays: number }>;
      return serialise({ kind, perTier: Object.fromEntries(Object.entries(proposals).map(([tier, p]) => [tier, { reserveMinor: reserveForOrder(sample.goodsMinor, p.reserveBps, null, 0n), holdDays: p.holdDays }])) });
    }
    case 'PAYMENT_PLAN': {
      const { splitByMilestones } = await import('../../domain/commercial-policy.js');
      return serialise({ kind, parts: splitByMilestones(sample.goodsMinor, (body['milestones'] ?? []) as { code: string; bps: number }[]) });
    }
    default:
      return serialise({ kind, body });
  }
}
