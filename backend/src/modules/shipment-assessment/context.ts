/**
 * Shared facts for Shipment Assessment: the policy in force, what the
 * shipment is (its fingerprint), whether a mandatory inspection applies, and
 * the event and notification writers every action uses.
 */
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import {
  assertAssessmentTransition,
  AssessmentTransitionError,
  evaluateRequirement,
  scopeFingerprint,
  type AssessmentStatus,
  type BadgePolicy,
  type BadgeTier,
  type RequirementVerdict,
} from '../../domain/shipment-assessment.js';
import { newId } from '../../infra/ids.js';
import type { prisma} from '../../infra/prisma.js';
import { type PrismaTransaction } from '../../infra/prisma.js';
import { ensureRequirement } from '../inspection/gate.service.js';
import { notifyAuditUsers, staffUserIds } from '../audit-console/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';

export type Client = PrismaTransaction | typeof prisma;

export async function activePolicy(client: Client): Promise<BadgePolicy & { id: string }> {
  const row = await client.shipmentAssessmentPolicy.findFirst({ orderBy: { version: 'desc' } });
  if (row === null) throw new Error('No shipment assessment policy exists. Run the migrations.');
  return row;
}

/** `SA-2026-000042`. Same counter pattern as inspection jobs. */
export async function nextNumber(tx: PrismaTransaction, prefix: 'SA' | 'AC', name: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `${name}:${String(year)}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix, padding: 6 },
  });
  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

/** What the shipment is right now. */
export async function currentFingerprint(client: Client, sellerOrderGroupId: string): Promise<string> {
  const group = await client.sellerOrderGroup.findUniqueOrThrow({
    where: { id: sellerOrderGroupId },
    select: {
      sellerAccountId: true,
      lines: { select: { offerId: true, quantity: true } },
      order: { select: { shippingAddressJson: true } },
      packingLists: {
        where: { status: 'ISSUED', supersededById: null, voidedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { number: true, contentHash: true, packageCount: true },
      },
    },
  });
  const address = (group.order.shippingAddressJson ?? {}) as Record<string, unknown>;
  const destination = ['countryCode', 'country', 'postcode', 'postalCode', 'city', 'line1', 'addressLine1']
    .map((key) => (typeof address[key] === 'string' ? (address[key]) : ''))
    .join('/');
  return scopeFingerprint({
    sellerAccountId: group.sellerAccountId,
    lines: group.lines,
    packingList: group.packingLists[0] ?? null,
    destination,
  });
}

export interface RequirementFacts extends RequirementVerdict {
  mandatoryInspection: boolean;
  mandatoryReason: string | null;
  applicabilityKnown: boolean;
  badge: BadgeTier | null;
  badgeVersion: number;
  policyVersion: number;
  sellerSuspended: boolean;
}

/**
 * Evaluate the requirement for one seller order. The inspection rules are
 * the existing ones (`ensureRequirement`); a MANDATORY or buyer-requested
 * inspection makes a waiver impossible, and a requirement that cannot be read
 * is treated as "unknown", which offers no waiver either.
 */
export async function evaluateFor(client: Client, sellerOrderGroupId: string): Promise<RequirementFacts> {
  const group = await client.sellerOrderGroup.findUniqueOrThrow({
    where: { id: sellerOrderGroupId },
    select: { sellerAccount: { select: { auditBadge: true, auditBadgeVersion: true, status: true } } },
  });
  let mandatoryInspection = false;
  let mandatoryReason: string | null = null;
  let applicabilityKnown = true;
  try {
    const requirement = await ensureRequirement(client, sellerOrderGroupId);
    if (requirement === null) {
      applicabilityKnown = false;
    } else {
      const full = await client.inspectionRequirement.findUnique({
        where: { id: requirement.id },
        select: { level: true, buyerRequested: true, reason: true, ruleName: true },
      });
      if (full !== null && (full.level === 'MANDATORY' || full.level === 'BUYER_REQUESTED' || full.buyerRequested)) {
        mandatoryInspection = true;
        mandatoryReason = full.buyerRequested || full.level === 'BUYER_REQUESTED' ? `buyer-requested inspection (${full.reason})` : `${full.ruleName ?? 'inspection rule'}: ${full.reason}`;
      }
    }
  } catch {
    applicabilityKnown = false;
  }
  const policy = await activePolicy(client);
  const badge = group.sellerAccount.auditBadge;
  const sellerSuspended = group.sellerAccount.status === 'SUSPENDED';
  const verdict = evaluateRequirement({ badge, policy, mandatoryInspection, mandatoryReason, applicabilityKnown, sellerSuspended });
  return {
    ...verdict,
    mandatoryInspection,
    mandatoryReason: mandatoryReason?.slice(0, 512) ?? null,
    applicabilityKnown,
    badge,
    badgeVersion: group.sellerAccount.auditBadgeVersion,
    policyVersion: policy.version,
    sellerSuspended,
  };
}

export type ActorRole = 'AUDIT' | 'SELLER' | 'LOGISTICS' | 'SYSTEM';

/**
 * Move an assessment, guarded on the version read. Returns the new version.
 * The only place `status` is written.
 */
export async function moveAssessment(
  tx: PrismaTransaction,
  current: { id: string; status: AssessmentStatus; version: number },
  to: AssessmentStatus,
  event: { kind: string; actorRole: ActorRole; actorUserId: string | null; note?: string | null; data?: unknown; idempotencyKey?: string | null },
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    assertAssessmentTransition(current.status, to);
  } catch (error) {
    if (!(error instanceof AssessmentTransitionError)) throw error;
    throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'This assessment cannot take that step from where it is.', [
      { field: 'status', code: 'TRANSITION', meta: { from: current.status, to } },
    ]);
  }
  const moved = await tx.shipmentAssessment.updateMany({
    where: { id: current.id, version: current.version },
    data: { ...extra, status: to, version: { increment: 1 } },
  });
  if (moved.count === 0) throw versionConflict();
  await writeEvent(tx, current.id, { ...event, fromStatus: current.status, toStatus: to });
}

export function versionConflict(): Error {
  return conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'This assessment was changed somewhere else. Reload it and try again.', [
    { field: 'version', code: 'VERSION' },
  ]);
}

export async function writeEvent(
  client: Client,
  assessmentId: string,
  event: {
    kind: string;
    actorRole: ActorRole;
    actorUserId: string | null;
    note?: string | null;
    data?: unknown;
    fromStatus?: AssessmentStatus | null;
    toStatus?: AssessmentStatus | null;
    idempotencyKey?: string | null;
  },
): Promise<void> {
  await client.shipmentAssessmentEvent.create({
    data: {
      id: newId(),
      assessmentId,
      kind: event.kind.slice(0, 48),
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      actorRole: event.actorRole,
      actorUserId: event.actorUserId,
      note: event.note ?? null,
      ...(event.data === undefined ? {} : { dataJson: event.data as object }),
      idempotencyKey: event.idempotencyKey?.slice(0, 80) ?? null,
    },
  });
}

export async function loadAssessment(client: Client, id: string) {
  const row = await client.shipmentAssessment.findUnique({ where: { id } });
  if (row === null) throw notFound('Shipment assessment');
  return row;
}

/** Tell the Audit Team, the seller, or both. Never fails the caller's action. */
export async function announce(
  tx: PrismaTransaction,
  assessment: { id: string; number: string; sellerAccountId: string },
  notice: { kind: string; title: string; body: string; audit?: boolean; seller?: boolean; auditUserIds?: string[] },
): Promise<void> {
  const link = `/shipment-assessment/${assessment.id}`;
  if (notice.audit !== false) {
    const users = notice.auditUserIds ?? (await staffUserIds(tx, ['SUPERVISOR', 'COMPLIANCE_REVIEWER']));
    await notifyAuditUsers(tx, users, {
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
      link,
      subjectType: 'SHIPMENT_ASSESSMENT',
      subjectId: assessment.id,
      dedupeKey: `${notice.kind}:${assessment.id}:${newId()}`,
    });
  }
  if (notice.seller === true) {
    await notifySeller({
      tx,
      sellerAccountId: assessment.sellerAccountId,
      kind: 'SHIPMENT_ASSESSMENT',
      title: notice.title,
      body: notice.body,
      linkPath: `/seller/shipment-assessments/${assessment.id}`,
      subjectType: 'SHIPMENT_ASSESSMENT',
      subjectId: assessment.id,
    });
  }
}
