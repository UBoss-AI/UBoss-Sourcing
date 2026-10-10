/**
 * Shipment Assessment: the cases, the rounds, the waivers and the releases.
 *
 * Audit decides; everybody else contributes or reads:
 *  - the Audit Team records checks, approves (QA, a second person), approves
 *    or rejects waivers, holds, and asks for reassessment;
 *  - the seller submits readiness and evidence and answers corrective action;
 *  - the carrier holding L2 records the final loading checks;
 *  - the admin panel reads.
 * Status changes go through `moveAssessment` -> `assertAssessmentTransition`.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  BLOCKING_STATUSES,
  COMMON_CHECKLIST,
  COMMON_CHECKLIST_VERSION,
  LOADING_CHECKLIST,
  categoryItems,
  deadlineProblem,
  evaluateChecks,
  isBadgeDowngrade,
  policyProblem,
  quantityProblem,
  ruleFor,
  type AssessmentStatus,
  type BadgePolicy,
  type BadgeTier,
  type CheckOutcome,
  type ChecklistItem,
  type QuantityFacts,
} from '../../domain/shipment-assessment.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { sniffDocumentType } from '../../infra/storage/index.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  activePolicy,
  announce,
  currentFingerprint,
  evaluateFor,
  loadAssessment,
  moveAssessment,
  nextNumber,
  versionConflict,
  writeEvent,
  type ActorRole,
  type Client,
} from './context.js';
import {
  documentView,
  issueFindingsReport,
  issueShipmentCertificate,
  issueWaiverDocument,
  type ShipmentDocContext,
  type Signer,
} from './documents.service.js';
import { releaseCheck } from './release-gate.service.js';

export interface AuditActor {
  userId: string;
  fullName: string;
  role: string;
}

export function signerOf(actor: AuditActor): Signer {
  return { userId: actor.userId, name: actor.fullName, role: actor.role };
}

/** A checklist as a JSON column value. */
function toJson(items: readonly ChecklistItem[]): Prisma.InputJsonArray {
  return items.map((item) => ({ ...item }));
}

const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

/** Console names for user ids: audit staff, then agency members, then the e-mail. */
export async function peopleNames(client: Client, ids: readonly (string | null | undefined)[]): Promise<{ id: string; fullName: string }[]> {
  const wanted = [...new Set(ids.filter((value): value is string => typeof value === 'string'))];
  if (wanted.length === 0) return [];
  const [staff, agency, users] = await Promise.all([
    client.auditStaffMember.findMany({ where: { userId: { in: wanted } }, select: { userId: true, fullName: true } }),
    client.inspectionAgencyMember.findMany({ where: { userId: { in: wanted } }, select: { userId: true, fullName: true } }),
    client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } }),
  ]);
  return wanted.map((id) => ({ id, fullName: staff.find((row) => row.userId === id)?.fullName ?? agency.find((row) => row.userId === id)?.fullName ?? users.find((row) => row.id === id)?.email ?? id }));
}

// --- Creating and syncing cases -------------------------------------------------

async function legFacts(client: Client, sellerOrderGroupId: string) {
  const legs = await client.shipmentLeg.findMany({
    where: { sellerOrderGroupId, level: { in: ['L1', 'L2'] } },
    select: { id: true, level: true, status: true, completedAt: true, expectedStartAt: true, orderLeg: { select: { destinationLabel: true } } },
  });
  return { l1: legs.find((leg) => leg.level === 'L1') ?? null, l2: legs.find((leg) => leg.level === 'L2') ?? null };
}

/** Create the case for a seller order if it has none. Never decides anything. */
export async function ensureCase(tx: PrismaTransaction, sellerOrderGroupId: string, existingAtRollout: boolean) {
  const existing = await tx.shipmentAssessment.findUnique({ where: { sellerOrderGroupId } });
  if (existing !== null) return existing;
  const group = await tx.sellerOrderGroup.findUniqueOrThrow({ where: { id: sellerOrderGroupId }, select: { orderId: true, sellerAccountId: true } });
  const facts = await evaluateFor(tx, sellerOrderGroupId);
  const { l1, l2 } = await legFacts(tx, sellerOrderGroupId);
  const id = newId();
  await tx.shipmentAssessment.create({
    data: {
      id,
      number: await nextNumber(tx, 'SA', 'shipment-assessment'),
      sellerOrderGroupId,
      orderId: group.orderId,
      sellerAccountId: group.sellerAccountId,
      status: 'AWAITING_L1',
      requirement: facts.requirement,
      requirementReason: facts.reason.slice(0, 512),
      mandatoryInspection: facts.mandatoryInspection,
      mandatoryReason: facts.mandatoryReason,
      applicabilityKnown: facts.applicabilityKnown,
      badgeAtEvaluation: facts.badge,
      policyVersion: facts.policyVersion,
      evaluatedAt: new Date(),
      l1LegId: l1?.id ?? null,
      l2LegId: l2?.id ?? null,
      plannedL2At: l2?.expectedStartAt ?? null,
      existingAtRollout,
    },
  });
  await writeEvent(tx, id, { kind: existingAtRollout ? 'CREATED_AT_ROLLOUT' : 'CREATED', actorRole: 'SYSTEM', actorUserId: null, toStatus: 'AWAITING_L1', note: facts.reason });
  return tx.shipmentAssessment.findUniqueOrThrow({ where: { id } });
}

/**
 * L1 has been handed over at the port of loading. Re-evaluate the policy and
 * open the right queue: waiver review when the badge allows it, assessment
 * otherwise. Nothing is waived here.
 */
async function markL1Complete(tx: PrismaTransaction, sellerOrderGroupId: string, existingAtRollout: boolean): Promise<void> {
  const row = await ensureCase(tx, sellerOrderGroupId, existingAtRollout);
  if (row.status !== 'AWAITING_L1') return;
  const { l1, l2 } = await legFacts(tx, sellerOrderGroupId);
  if (l1?.status !== 'COMPLETED') return;
  const facts = await evaluateFor(tx, sellerOrderGroupId);
  const to: AssessmentStatus = facts.requirement === 'ASSESSMENT_REQUIRED' ? 'READY_FOR_ASSESSMENT' : 'WAIVER_REVIEW';
  await moveAssessment(
    tx,
    row,
    to,
    { kind: 'L1_COMPLETED', actorRole: 'SYSTEM', actorUserId: null, note: facts.reason },
    {
      l1CompletedAt: l1.completedAt ?? new Date(),
      l1Location: l1.orderLeg?.destinationLabel ?? null,
      plannedL2At: l2?.expectedStartAt ?? null,
      requirement: facts.requirement,
      requirementReason: facts.reason.slice(0, 512),
      mandatoryInspection: facts.mandatoryInspection,
      mandatoryReason: facts.mandatoryReason,
      applicabilityKnown: facts.applicabilityKnown,
      badgeAtEvaluation: facts.badge,
      policyVersion: facts.policyVersion,
      evaluatedAt: new Date(),
      scopeFingerprint: await currentFingerprint(tx, sellerOrderGroupId),
    },
  );
  await announce(tx, row, {
    kind: 'shipment_assessment.ready',
    title: `${row.number}: ${to === 'WAIVER_REVIEW' ? 'waiver review needed' : 'ready for assessment'}`,
    body: facts.reason,
    seller: true,
  });
}

/** Called after an L1 handover. Best-effort: the sweep catches anything missed. */
export async function onL1Completed(sellerOrderGroupId: string): Promise<void> {
  if (!env.FEATURE_SHIPMENT_ASSESSMENT) return;
  try {
    await prisma.$transaction(async (tx) => {
      await markL1Complete(tx, sellerOrderGroupId, false);
    });
  } catch (error) {
    logger.warn({ err: error, sellerOrderGroupId }, 'shipment assessment not opened after L1; the sweep will retry');
  }
}

// --- Releases ------------------------------------------------------------------

async function invalidateRelease(
  tx: PrismaTransaction,
  assessment: { id: string; number: string; sellerAccountId: string; status: AssessmentStatus; version: number },
  reason: string,
  to: AssessmentStatus,
  actor: { role: ActorRole; userId: string | null },
): Promise<void> {
  const now = new Date();
  const active = await tx.shipmentReleaseAuthorization.findMany({ where: { assessmentId: assessment.id, status: 'ACTIVE' }, select: { id: true } });
  for (const release of active) {
    await tx.shipmentReleaseAuthorization.update({
      where: { id: release.id },
      data: { status: reason.startsWith('Dispatch deadline') ? 'EXPIRED' : 'INVALIDATED', activeSlot: null, invalidatedAt: now, invalidationReason: reason.slice(0, 1000), version: { increment: 1 } },
    });
    await tx.auditDocument.updateMany({ where: { releaseId: release.id, status: 'ACTIVE' }, data: { status: 'REVOKED', statusChangedAt: now, revokedReason: reason.slice(0, 1000) } });
    await tx.shipmentWaiverDecision.updateMany({ where: { assessmentId: assessment.id, decision: 'APPROVED', invalidatedAt: null }, data: { invalidatedAt: now, invalidationReason: reason.slice(0, 1000) } });
  }
  if (assessment.status !== to) {
    await moveAssessment(tx, assessment, to, { kind: 'RELEASE_INVALIDATED', actorRole: actor.role, actorUserId: actor.userId, note: reason }, { loadingChecksCompletedAt: null });
  }
  if (active.length > 0) {
    await recordAudit({ action: AuditAction.SHIPMENT_RELEASE_INVALIDATED, resourceType: 'ShipmentAssessment', resourceId: assessment.id, actorType: actor.role === 'AUDIT' ? 'AUDIT' : 'SYSTEM', actorUserId: actor.userId, after: { reason } }, tx);
    await announce(tx, assessment, { kind: 'shipment_assessment.release_invalidated', title: `${assessment.number}: release withdrawn`, body: reason, seller: true });
  }
}

async function createRelease(
  tx: PrismaTransaction,
  assessment: { id: string; sellerOrderGroupId: string; sellerAccountId: string },
  input: { kind: 'ASSESSMENT' | 'WAIVER'; round: number; waiverDecisionId: string | null; deadline: Date; justification: string; loadingChecksRequired: boolean; actor: AuditActor },
) {
  const seller = await tx.sellerAccount.findUniqueOrThrow({ where: { id: assessment.sellerAccountId }, select: { auditBadge: true, auditBadgeVersion: true } });
  const policy = await activePolicy(tx);
  const id = newId();
  try {
    await tx.shipmentReleaseAuthorization.create({
      data: {
        id,
        assessmentId: assessment.id,
        kind: input.kind,
        round: input.round,
        waiverDecisionId: input.waiverDecisionId,
        status: 'ACTIVE',
        activeSlot: assessment.id,
        scopeFingerprint: await currentFingerprint(tx, assessment.sellerOrderGroupId),
        badgeAtIssue: seller.auditBadge,
        badgeVersion: seller.auditBadgeVersion,
        policyVersion: policy.version,
        dispatchDeadline: input.deadline,
        deadlineJustification: input.justification.slice(0, 1000),
        loadingChecksRequired: input.loadingChecksRequired,
        issuedByUserId: input.actor.userId,
        issuedAt: new Date(),
      },
    });
  } catch {
    // uq_shipment_release_active: a second decision for the same shipment.
    throw versionConflict();
  }
  await recordAudit({ action: AuditAction.SHIPMENT_RELEASE_ISSUED, resourceType: 'ShipmentAssessment', resourceId: assessment.id, actorType: 'AUDIT', actorUserId: input.actor.userId, after: { releaseId: id, kind: input.kind, deadline: input.deadline.toISOString() } }, tx);
  return { id, dispatchDeadline: input.deadline, loadingChecksRequired: input.loadingChecksRequired };
}

function validateDeadline(deadlineIso: string | null, justification: string | null, policy: BadgePolicy): { deadline: Date; justification: string } {
  const now = new Date();
  let deadline: Date;
  let reason: string;
  if (deadlineIso === null || deadlineIso === '') {
    if (policy.defaultDispatchDays === null) {
      throw badRequest(ErrorCode.SHIPMENT_ASSESSMENT_POLICY_INVALID, 'Set a dispatch deadline and say why. There is no approved default window.', [{ field: 'dispatchDeadline', code: 'REQUIRED' }]);
    }
    deadline = new Date(now.getTime() + policy.defaultDispatchDays * 86_400_000);
    reason = `Approved policy window of ${String(policy.defaultDispatchDays)} days (policy v${String(policy.version)}).`;
  } else {
    deadline = new Date(deadlineIso);
    reason = (justification ?? '').trim();
    if (reason.length < 10) throw badRequest(ErrorCode.SHIPMENT_ASSESSMENT_POLICY_INVALID, 'Explain why this dispatch deadline is right.', [{ field: 'deadlineJustification', code: 'REQUIRED' }]);
  }
  const problem = deadlineProblem(deadline, now, policy, null);
  if (problem !== null) throw badRequest(ErrorCode.SHIPMENT_ASSESSMENT_POLICY_INVALID, 'That dispatch deadline is not allowed.', [{ field: 'dispatchDeadline', code: problem }]);
  return { deadline, justification: reason };
}

// --- Physical assessment ---------------------------------------------------------

async function checklistFor(client: Client, sellerOrderGroupId: string): Promise<{ items: ChecklistItem[]; version: string; planId: string | null; planVersion: number | null }> {
  // The category's own approved inspection plan supplies its specific checks.
  const line = await client.sellerOrderLine.findFirst({ where: { orderGroupId: sellerOrderGroupId }, select: { offer: { select: { product: { select: { categoryId: true } } } } } });
  const categoryId = line?.offer.product.categoryId ?? null;
  const plan =
    (categoryId === null ? null : await client.inspectionPlan.findFirst({ where: { categoryId, isActive: true }, orderBy: { version: 'desc' } })) ??
    null;
  const extra = plan === null ? [] : categoryItems(plan.checklistJson);
  const items = [...COMMON_CHECKLIST, ...extra];
  return { items, version: plan === null ? COMMON_CHECKLIST_VERSION : `${COMMON_CHECKLIST_VERSION}+plan-${plan.id.slice(-6)}-v${String(plan.version)}`, planId: plan?.id ?? null, planVersion: plan?.version ?? null };
}

export async function startRound(actor: AuditActor, id: string, expectedVersion: number) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== expectedVersion) throw versionConflict();
    if (row.l1CompletedAt === null) throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_NOT_RELEASED, 'L1 has not been handed over yet.', [{ field: 'status', code: 'L1_NOT_COMPLETE' }]);
    const round = row.currentRound + 1;
    const checklist = await checklistFor(tx, row.sellerOrderGroupId);
    const ordered = await tx.sellerOrderLine.aggregate({ where: { orderGroupId: row.sellerOrderGroupId }, _sum: { quantity: true } });
    await tx.shipmentAssessmentRound.create({
      data: {
        id: newId(),
        assessmentId: id,
        round,
        kind: 'ASSESSMENT',
        checklistVersion: checklist.version,
        categoryPlanId: checklist.planId,
        categoryPlanVersion: checklist.planVersion,
        checklistJson: toJson(checklist.items),
        assessorUserId: actor.userId,
        startedAt: new Date(),
        orderedQuantity: ordered._sum.quantity ?? null,
      },
    });
    await moveAssessment(tx, row, 'IN_PROGRESS', { kind: 'ROUND_STARTED', actorRole: 'AUDIT', actorUserId: actor.userId, data: { round } }, { currentRound: round, assessorUserId: actor.userId, scopeFingerprint: await currentFingerprint(tx, row.sellerOrderGroupId) });
  });
}

async function roundOf(client: Client, assessmentId: string, round: number) {
  const row = await client.shipmentAssessmentRound.findUnique({ where: { assessmentId_round: { assessmentId, round } } });
  if (row === null) throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'There is no round in progress.');
  return row;
}

export interface CheckInput {
  itemCode: string;
  outcome: CheckOutcome;
  note?: string | null;
  measuredValue?: string | null;
  sampled?: boolean;
}

/**
 * Record checks. The assessor records any item while the round is in
 * progress; final loading items (section K) may also be recorded after
 * approval, by the assessor or the carrier holding L2. Nobody but Audit may
 * change an auditor's finding.
 */
export async function recordChecks(actor: { userId: string; role: 'AUDIT' | 'LOGISTICS' }, id: string, checks: CheckInput[]) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    const round = await roundOf(tx, id, row.currentRound);
    const items = round.checklistJson as unknown as ChecklistItem[];
    const loadingOnly = row.status === 'APPROVED_FOR_L2';
    if (!loadingOnly && row.status !== 'IN_PROGRESS') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'Checks are recorded while the assessment is in progress.');
    if (actor.role === 'LOGISTICS' && !loadingOnly) throw forbidden(ErrorCode.FORBIDDEN, 'The carrier records only the final loading checks, after release.');
    const now = new Date();
    for (const check of checks) {
      const item = items.find((entry) => entry.code === check.itemCode);
      if (item === undefined) throw badRequest(ErrorCode.VALIDATION_FAILED, `Unknown checklist item ${check.itemCode}.`, [{ field: 'itemCode', code: 'UNKNOWN' }]);
      if (loadingOnly && item.phase !== 'LOADING') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'After approval only the final loading checks can be recorded.');
      const existing = await tx.shipmentAssessmentCheck.findUnique({ where: { assessmentId_round_itemCode: { assessmentId: id, round: round.round, itemCode: item.code } } });
      if (existing !== null && existing.recordedByRole === 'AUDIT' && actor.role !== 'AUDIT') throw forbidden(ErrorCode.FORBIDDEN, "An auditor's finding can only be changed by the Audit Team.");
      const data = {
        section: item.section,
        phase: item.phase,
        outcome: check.outcome,
        note: check.note?.slice(0, 2000) ?? null,
        measuredValue: check.measuredValue?.slice(0, 255) ?? null,
        sampled: check.sampled === true,
        recordedByUserId: actor.userId,
        recordedByRole: actor.role,
        recordedAt: now,
      };
      await tx.shipmentAssessmentCheck.upsert({
        where: { assessmentId_round_itemCode: { assessmentId: id, round: round.round, itemCode: item.code } },
        update: data,
        create: { id: newId(), assessmentId: id, round: round.round, itemCode: item.code, ...data },
      });
    }
    await writeEvent(tx, id, { kind: 'CHECKS_RECORDED', actorRole: actor.role, actorUserId: actor.userId, data: checks.map((check) => ({ itemCode: check.itemCode, outcome: check.outcome })) });
    if (loadingOnly) await refreshLoadingChecks(tx, row, round.round, items, actor);
  });
}

/** Loading checks all passed -> mark them complete; any FAIL/HOLD -> the whole shipment goes on hold. */
async function refreshLoadingChecks(tx: PrismaTransaction, row: Awaited<ReturnType<typeof loadAssessment>>, round: number, items: ChecklistItem[], actor: { userId: string; role: 'AUDIT' | 'LOGISTICS' }) {
  const verdict = evaluateChecks(items, await checksWithEvidence(tx, row.id, round), 'LOADING');
  if (verdict.outcome === 'PASSED') {
    await tx.shipmentAssessment.update({ where: { id: row.id }, data: { loadingChecksCompletedAt: new Date(), version: { increment: 1 } } });
    await writeEvent(tx, row.id, { kind: 'LOADING_CHECKS_PASSED', actorRole: actor.role, actorUserId: actor.userId });
  } else if (verdict.outcome === 'FAILED' || verdict.outcome === 'HELD') {
    const fresh = await loadAssessment(tx, row.id);
    await invalidateRelease(tx, fresh, `Final loading check ${verdict.outcome === 'FAILED' ? 'failed' : 'on hold'}: ${[...verdict.failed, ...verdict.held].join(', ')}.`, 'ON_HOLD', actor);
  } else if (row.loadingChecksCompletedAt !== null) {
    await tx.shipmentAssessment.update({ where: { id: row.id }, data: { loadingChecksCompletedAt: null, version: { increment: 1 } } });
  }
}

async function checksWithEvidence(client: Client, assessmentId: string, round: number) {
  const [checks, evidence] = await Promise.all([
    client.shipmentAssessmentCheck.findMany({ where: { assessmentId, round } }),
    client.shipmentAssessmentEvidence.groupBy({ by: ['itemCode'], where: { assessmentId, round }, _count: { _all: true } }),
  ]);
  const counts = new Map(evidence.map((entry) => [entry.itemCode ?? '', entry._count._all]));
  return checks.map((check) => ({ itemCode: check.itemCode, outcome: check.outcome, note: check.note, evidenceCount: counts.get(check.itemCode) ?? 0 }));
}

export async function recordQuantities(actor: AuditActor, id: string, input: Partial<QuantityFacts> & Record<string, unknown>) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.status !== 'IN_PROGRESS') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'Quantities are recorded while the assessment is in progress.');
    const fields = ['declaredQuantity', 'presentedQuantity', 'countedQuantity', 'sampledQuantity', 'approvedQuantity', 'unitsPerPackage', 'packagesDeclared', 'packagesCounted'] as const;
    const data: Record<string, unknown> = {};
    for (const field of fields) if (input[field] !== undefined) data[field] = input[field];
    for (const field of ['sellingUnit', 'countingMethod', 'samplingMethod', 'sampleCoverageNote', 'inspectionLocation'] as const) {
      if (typeof input[field] === 'string' || input[field] === null) data[field] = input[field];
    }
    for (const field of ['grossWeightDeclaredGrams', 'grossWeightMeasuredGrams'] as const) {
      if (typeof input[field] === 'string' && /^\d{1,15}$/.test(input[field])) data[field] = BigInt(input[field]);
      else if (input[field] === null) data[field] = null;
    }
    await tx.shipmentAssessmentRound.update({ where: { assessmentId_round: { assessmentId: id, round: row.currentRound } }, data });
    await writeEvent(tx, id, { kind: 'QUANTITIES_RECORDED', actorRole: 'AUDIT', actorUserId: actor.userId });
  });
}

export async function uploadEvidence(
  actor: { userId: string; role: 'AUDIT' | 'SELLER' | 'LOGISTICS' },
  id: string,
  input: { itemCode: string | null; note: string | null; fileName: string; bytes: Buffer },
) {
  if (input.bytes.length === 0 || input.bytes.length > MAX_EVIDENCE_BYTES) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Upload a file up to 15 MB.', [{ field: 'file', code: 'SIZE' }]);
  const type = sniffDocumentType(input.bytes);
  const row = await loadAssessment(prisma, id);
  if (row.status === 'DISPATCHED' || row.status === 'CANCELLED') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'This assessment is closed.');
  const stored = await storage.put(input.bytes, type.mimeType, type.extension, 'private');
  const evidenceId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.shipmentAssessmentEvidence.create({
      data: {
        id: evidenceId,
        assessmentId: id,
        round: Math.max(row.currentRound, 0),
        itemCode: input.itemCode?.slice(0, 48) ?? null,
        storageKey: stored.storageKey,
        fileName: input.fileName.slice(0, 255),
        contentType: type.mimeType,
        byteSize: input.bytes.length,
        contentHash: createHash('sha256').update(input.bytes).digest('hex'),
        uploadedByUserId: actor.userId,
        uploadedByRole: actor.role,
        note: input.note?.slice(0, 1000) ?? null,
      },
    });
    await writeEvent(tx, id, { kind: 'EVIDENCE_ADDED', actorRole: actor.role, actorUserId: actor.userId, data: { evidenceId, itemCode: input.itemCode } });
    if (actor.role !== 'AUDIT') {
      await announce(tx, row, { kind: 'shipment_assessment.evidence', title: `${row.number}: new evidence`, body: `${actor.role === 'SELLER' ? 'The seller' : 'The carrier'} added ${input.fileName}.` });
    }
    if (row.status === 'APPROVED_FOR_L2' && input.itemCode !== null) {
      const round = await roundOf(tx, id, row.currentRound);
      await refreshLoadingChecks(tx, row, round.round, round.checklistJson as unknown as ChecklistItem[], { userId: actor.userId, role: actor.role === 'SELLER' ? 'AUDIT' : actor.role });
    }
  });
  return { id: evidenceId };
}

export async function readEvidence(where: { id: string; assessmentIds?: string[]; uploadedByRole?: string }) {
  const row = await prisma.shipmentAssessmentEvidence.findFirst({
    where: { id: where.id, ...(where.assessmentIds === undefined ? {} : { assessmentId: { in: where.assessmentIds } }), ...(where.uploadedByRole === undefined ? {} : { uploadedByRole: where.uploadedByRole }) },
  });
  if (row === null) throw notFound('Evidence');
  return { fileName: row.fileName, contentType: row.contentType, bytes: await storage.get(row.storageKey) };
}

async function docContext(tx: PrismaTransaction, id: string, round: number): Promise<ShipmentDocContext> {
  const row = await loadAssessment(tx, id);
  const r = round > 0 ? await tx.shipmentAssessmentRound.findUnique({ where: { assessmentId_round: { assessmentId: id, round } } }) : null;
  const checks = round > 0 ? await tx.shipmentAssessmentCheck.findMany({ where: { assessmentId: id, round }, orderBy: { itemCode: 'asc' } }) : [];
  const names = await peopleNames(tx, [r?.assessorUserId, r?.qaReviewerUserId].filter((value): value is string => typeof value === 'string'));
  const nameOf = (userId: string | null | undefined) => names.find((user) => user.id === userId)?.fullName ?? null;
  return { assessment: row, round: r, checks, assessorName: nameOf(r?.assessorUserId), qaName: nameOf(r?.qaReviewerUserId) };
}

/** The assessor submits the round. Fail and hold block the whole shipment. */
export async function submitRound(actor: AuditActor, id: string, input: { findingsSummary: string; expectedVersion: number }) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== input.expectedVersion) throw versionConflict();
    if (row.status !== 'IN_PROGRESS') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'Only a round in progress can be submitted.');
    const round = await roundOf(tx, id, row.currentRound);
    const items = round.checklistJson as unknown as ChecklistItem[];
    const verdict = evaluateChecks(items, await checksWithEvidence(tx, id, round.round), 'PRE_LOADING');
    const now = new Date();
    if (verdict.outcome === 'INCOMPLETE') {
      throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_INCOMPLETE, 'Some checks are missing a result, evidence or an N/A reason.', [
        ...verdict.missing.map((code) => ({ field: code, code: 'MISSING' })),
        ...verdict.missingEvidence.map((code) => ({ field: code, code: 'EVIDENCE_REQUIRED' })),
        ...verdict.unjustifiedNa.map((code) => ({ field: code, code: 'NA_REASON_REQUIRED' })),
      ]);
    }
    const summary = input.findingsSummary.trim().slice(0, 10000);
    if (verdict.outcome === 'PASSED') {
      const problem = quantityProblem({
        orderedQuantity: round.orderedQuantity,
        declaredQuantity: round.declaredQuantity,
        presentedQuantity: round.presentedQuantity,
        countedQuantity: round.countedQuantity,
        sampledQuantity: round.sampledQuantity,
        approvedQuantity: round.approvedQuantity,
      });
      if (problem !== null) throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_INCOMPLETE, 'The quantities cannot be approved as entered.', [{ field: 'quantity', code: problem }]);
      await tx.shipmentAssessmentRound.update({ where: { id: round.id }, data: { submittedAt: now, findingsSummary: summary } });
      await moveAssessment(tx, row, 'AWAITING_QA', { kind: 'ROUND_SUBMITTED', actorRole: 'AUDIT', actorUserId: actor.userId });
      await announce(tx, row, { kind: 'shipment_assessment.awaiting_qa', title: `${row.number}: awaiting QA`, body: 'An assessment round passed and needs a second person to approve it.' });
      return;
    }
    const outcome = verdict.outcome === 'FAILED' ? 'FAILED' : 'HELD';
    await tx.shipmentAssessmentRound.update({ where: { id: round.id }, data: { submittedAt: now, findingsSummary: summary, outcome } });
    await moveAssessment(tx, row, outcome === 'FAILED' ? 'FAILED' : 'ON_HOLD', { kind: 'ROUND_SUBMITTED', actorRole: 'AUDIT', actorUserId: actor.userId, data: { failed: verdict.failed, held: verdict.held } }, { holdReason: `Round ${String(round.round)}: ${[...verdict.failed, ...verdict.held].join(', ')}`.slice(0, 1000) });
    await issueFindingsReport(tx, await docContext(tx, id, round.round), outcome, signerOf(actor));
    await announce(tx, row, {
      kind: 'shipment_assessment.failed',
      title: `${row.number}: ${outcome === 'FAILED' ? 'assessment failed' : 'shipment on hold'}`,
      body: 'The whole shipment is blocked. Corrective action and a reassessment are required before L2.',
      seller: true,
    });
  });
}

/** QA: a second person approves (issuing the release and certificate) or returns the round. */
export async function qaDecide(
  actor: AuditActor,
  id: string,
  input: { decision: 'APPROVED' | 'RETURNED'; note: string | null; dispatchDeadline: string | null; deadlineJustification: string | null; expectedVersion: number },
) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== input.expectedVersion) throw versionConflict();
    if (row.status !== 'AWAITING_QA') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'This round is not awaiting QA.');
    const round = await roundOf(tx, id, row.currentRound);
    if (round.assessorUserId === actor.userId) throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_INDEPENDENCE_REQUIRED, 'The person who assessed the shipment cannot also approve it.');
    const now = new Date();
    if (input.decision === 'RETURNED') {
      if ((input.note ?? '').trim().length < 3) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say what must be corrected.', [{ field: 'note', code: 'REQUIRED' }]);
      await tx.shipmentAssessmentRound.update({ where: { id: round.id }, data: { qaReviewerUserId: actor.userId, qaDecision: 'RETURNED', qaNote: input.note, qaDecidedAt: now, submittedAt: null } });
      await moveAssessment(tx, row, 'IN_PROGRESS', { kind: 'QA_RETURNED', actorRole: 'AUDIT', actorUserId: actor.userId, note: input.note });
      return;
    }
    // Re-check at the moment of approval: nothing may have slipped since submission.
    const facts = await evaluateFor(tx, row.sellerOrderGroupId);
    if (facts.sellerSuspended) throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_NOT_RELEASED, 'The seller is suspended.', [{ field: 'seller', code: 'SELLER_SUSPENDED' }]);
    const policy = await activePolicy(tx);
    const { deadline, justification } = validateDeadline(input.dispatchDeadline, input.deadlineJustification, policy);
    const items = round.checklistJson as unknown as ChecklistItem[];
    const loading = evaluateChecks(items, await checksWithEvidence(tx, id, round.round), 'LOADING');
    await tx.shipmentAssessmentRound.update({ where: { id: round.id }, data: { qaReviewerUserId: actor.userId, qaDecision: 'APPROVED', qaNote: input.note, qaDecidedAt: now, outcome: 'PASSED' } });
    const release = await createRelease(tx, row, { kind: 'ASSESSMENT', round: round.round, waiverDecisionId: null, deadline, justification, loadingChecksRequired: true, actor });
    await moveAssessment(tx, row, 'APPROVED_FOR_L2', { kind: 'QA_APPROVED', actorRole: 'AUDIT', actorUserId: actor.userId, note: input.note }, {
      qaReviewerUserId: actor.userId,
      holdReason: null,
      loadingChecksCompletedAt: loading.outcome === 'PASSED' ? now : null,
    });
    await issueShipmentCertificate(tx, await docContext(tx, id, round.round), { ...release, loadingChecksRequired: loading.outcome !== 'PASSED' }, signerOf(actor));
    await announce(tx, row, { kind: 'shipment_assessment.approved', title: `${row.number}: approved for L2`, body: `Dispatch by ${deadline.toISOString().slice(0, 10)}. Final loading checks are still required where not yet recorded.`, seller: true });
  });
}

// --- Waivers ----------------------------------------------------------------------

/** What a waiver reviewer is shown: the actual history, nothing computed from it. */
export async function waiverHistory(client: Client, sellerAccountId: string, excludeAssessmentId: string) {
  try {
    const [reports, rounds, complaints, seller] = await Promise.all([
      client.inspectionReport.findMany({
        where: { job: { requirement: { sellerAccountId } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { result: true, status: true, signedAt: true, createdAt: true, job: { select: { jobNumber: true } } },
      }),
      client.shipmentAssessmentRound.findMany({
        where: { assessment: { sellerAccountId, id: { not: excludeAssessmentId } }, outcome: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { round: true, outcome: true, submittedAt: true, assessment: { select: { number: true } } },
      }),
      client.dispute.findMany({
        where: { sellerAccountId, status: { notIn: ['RESOLVED', 'REJECTED', 'WITHDRAWN', 'WON', 'LOST'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, status: true, createdAt: true },
      }),
      client.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId }, select: { status: true, qualityScore: true, auditBadge: true, auditBadgeSetAt: true } }),
    ]);
    return {
      available: true,
      inspections: reports.map((report) => ({ job: report.job.jobNumber, result: report.result, status: report.status, at: (report.signedAt ?? report.createdAt).toISOString() })),
      assessments: rounds.map((round) => ({ number: round.assessment.number, round: round.round, outcome: round.outcome, at: round.submittedAt?.toISOString() ?? null })),
      unresolvedComplaints: complaints.map((complaint) => ({ id: complaint.id, status: complaint.status, at: complaint.createdAt.toISOString() })),
      seller: { status: seller.status, qualityScore: seller.qualityScore?.toString() ?? null, badge: seller.auditBadge, badgeSetAt: seller.auditBadgeSetAt?.toISOString() ?? null },
    };
  } catch (error) {
    logger.warn({ err: error, sellerAccountId }, 'waiver history unavailable');
    return { available: false, inspections: [], assessments: [], unresolvedComplaints: [], seller: null };
  }
}

/** An auditor opens waiver review for an eligible shipment (e.g. after an upgrade). Not a waiver. */
export async function openWaiverReview(actor: AuditActor, id: string, expectedVersion: number) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== expectedVersion) throw versionConflict();
    const facts = await evaluateFor(tx, row.sellerOrderGroupId);
    if (facts.requirement === 'ASSESSMENT_REQUIRED') throw conflict(ErrorCode.SHIPMENT_WAIVER_NOT_ALLOWED, facts.reason, [{ field: 'requirement', code: 'NOT_ELIGIBLE' }]);
    await moveAssessment(tx, row, 'WAIVER_REVIEW', { kind: 'WAIVER_REVIEW_OPENED', actorRole: 'AUDIT', actorUserId: actor.userId, note: facts.reason }, {
      requirement: facts.requirement,
      requirementReason: facts.reason.slice(0, 512),
      badgeAtEvaluation: facts.badge,
      policyVersion: facts.policyVersion,
      evaluatedAt: new Date(),
    });
  });
}

export async function decideWaiver(
  actor: AuditActor,
  id: string,
  input: {
    decision: 'APPROVED' | 'REJECTED';
    reason: string;
    historyReviewNote: string | null;
    evidenceRefs: string[];
    dispatchDeadline: string | null;
    deadlineJustification: string | null;
    expectedVersion: number;
  },
) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== input.expectedVersion) throw versionConflict();
    if (row.status !== 'WAIVER_REVIEW') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'This shipment is not in waiver review.');
    if (input.reason.trim().length < 10) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the reason for this decision.', [{ field: 'reason', code: 'REQUIRED' }]);
    // Decided on the facts NOW, not on what the queue said earlier.
    const facts = await evaluateFor(tx, row.sellerOrderGroupId);
    const history = await waiverHistory(tx, row.sellerAccountId, row.id);
    const now = new Date();
    const decisionId = newId();
    const base = {
      id: decisionId,
      assessmentId: id,
      badgeAtDecision: facts.badge,
      badgeVersion: facts.badgeVersion,
      policyVersion: facts.policyVersion,
      historyReviewNote: input.historyReviewNote,
      historySnapshotJson: history as unknown as object,
      reason: input.reason.trim(),
      evidenceRefsJson: input.evidenceRefs,
      decidedByUserId: actor.userId,
      decidedAt: now,
    };
    if (input.decision === 'REJECTED') {
      await tx.shipmentWaiverDecision.create({ data: { ...base, decision: 'REJECTED' } });
      await moveAssessment(tx, row, 'READY_FOR_ASSESSMENT', { kind: 'WAIVER_REJECTED', actorRole: 'AUDIT', actorUserId: actor.userId, note: input.reason });
      await recordAudit({ action: AuditAction.SHIPMENT_WAIVER_DECIDED, resourceType: 'ShipmentAssessment', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { decision: 'REJECTED', badge: facts.badge } }, tx);
      await announce(tx, row, { kind: 'shipment_assessment.waiver_rejected', title: `${row.number}: assessment required`, body: 'The waiver was not approved. The shipment will be physically assessed.', seller: true });
      return;
    }
    if (facts.requirement === 'ASSESSMENT_REQUIRED') {
      const code = facts.mandatoryInspection ? 'MANDATORY_INSPECTION' : !facts.applicabilityKnown ? 'APPLICABILITY_UNKNOWN' : facts.sellerSuspended ? 'SELLER_SUSPENDED' : 'BADGE_NOT_ELIGIBLE';
      throw conflict(ErrorCode.SHIPMENT_WAIVER_NOT_ALLOWED, facts.reason, [{ field: 'requirement', code }]);
    }
    if (facts.requirement === 'WAIVER_ELIGIBLE_WITH_REVIEW') {
      if (!history.available) throw conflict(ErrorCode.SHIPMENT_WAIVER_NOT_ALLOWED, 'The seller history needed for this review could not be read. Leave it pending or require assessment.', [{ field: 'history', code: 'HISTORY_UNAVAILABLE' }]);
      if ((input.historyReviewNote ?? '').trim().length < 20) {
        throw badRequest(ErrorCode.SHIPMENT_WAIVER_NOT_ALLOWED, 'Record what you reviewed in the recent inspections and complaints, and your judgement.', [{ field: 'historyReviewNote', code: 'REVIEW_REQUIRED' }]);
      }
    }
    const policy = await activePolicy(tx);
    const { deadline, justification } = validateDeadline(input.dispatchDeadline, input.deadlineJustification, policy);
    await tx.shipmentWaiverDecision.create({ data: { ...base, decision: 'APPROVED' } });
    const round = row.currentRound + 1;
    // A waiver round holds only the final loading checks, which still apply.
    await tx.shipmentAssessmentRound.create({
      data: { id: newId(), assessmentId: id, round, kind: 'WAIVER', checklistVersion: `${COMMON_CHECKLIST_VERSION}-loading`, checklistJson: toJson(LOADING_CHECKLIST), startedAt: now },
    });
    const release = await createRelease(tx, row, { kind: 'WAIVER', round, waiverDecisionId: decisionId, deadline, justification, loadingChecksRequired: true, actor });
    await moveAssessment(tx, row, 'APPROVED_FOR_L2', { kind: 'WAIVER_APPROVED', actorRole: 'AUDIT', actorUserId: actor.userId, note: input.reason }, { currentRound: round, loadingChecksCompletedAt: null });
    await issueWaiverDocument(tx, await docContext(tx, id, 0), { badge: facts.badge, policyVersion: facts.policyVersion, reason: input.reason.trim() }, release, signerOf(actor));
    await recordAudit({ action: AuditAction.SHIPMENT_WAIVER_DECIDED, resourceType: 'ShipmentAssessment', resourceId: id, actorType: 'AUDIT', actorUserId: actor.userId, after: { decision: 'APPROVED', badge: facts.badge, policyVersion: facts.policyVersion } }, tx);
    await announce(tx, row, { kind: 'shipment_assessment.waiver_approved', title: `${row.number}: assessment waived`, body: `Dispatch by ${deadline.toISOString().slice(0, 10)}. The final loading checks still apply.`, seller: true });
  });
}

// --- Holds, corrections, reassessment ---------------------------------------------

export async function holdShipment(actor: AuditActor, id: string, reason: string, expectedVersion: number) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== expectedVersion) throw versionConflict();
    await invalidateRelease(tx, row, `On hold: ${reason}`, 'ON_HOLD', { role: 'AUDIT', userId: actor.userId });
    await tx.shipmentAssessment.update({ where: { id }, data: { holdReason: reason.slice(0, 1000) } });
    await announce(tx, row, { kind: 'shipment_assessment.hold', title: `${row.number}: on hold`, body: reason, seller: true });
  });
}

/** After a failure, hold or change: a new round is needed. Earlier rounds stay as they were. */
export async function requireReassessment(actor: AuditActor, id: string, reason: string, expectedVersion: number) {
  return prisma.$transaction(async (tx) => {
    const row = await loadAssessment(tx, id);
    if (row.version !== expectedVersion) throw versionConflict();
    await invalidateRelease(tx, row, `Reassessment required: ${reason}`, 'REASSESSMENT_REQUIRED', { role: 'AUDIT', userId: actor.userId });
    if (row.currentRound > 0) {
      await tx.shipmentAssessmentRound.updateMany({ where: { assessmentId: id, round: row.currentRound, correctiveAction: null }, data: { correctiveAction: reason, correctiveActionAt: new Date() } });
    }
    await announce(tx, row, { kind: 'shipment_assessment.reassessment', title: `${row.number}: reassessment required`, body: reason, seller: true });
  });
}

export async function resolveException(actor: AuditActor, exceptionId: string, note: string) {
  const row = await prisma.shipmentAssessmentException.findUnique({ where: { id: exceptionId } });
  if (row === null) throw notFound('Exception');
  if (row.resolvedAt !== null) throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'Already resolved.');
  await prisma.$transaction(async (tx) => {
    // The departure stays on record; resolving says what was done about it.
    await tx.shipmentAssessmentException.update({ where: { id: exceptionId }, data: { resolvedAt: new Date(), resolvedByUserId: actor.userId, resolutionNote: note } });
    await writeEvent(tx, row.assessmentId, { kind: 'EXCEPTION_RESOLVED', actorRole: 'AUDIT', actorUserId: actor.userId, note });
  });
}

// --- Seller -------------------------------------------------------------------------

export async function sellerUpdate(sellerAccountId: string, userId: string, id: string, input: { readinessNote?: string; correctiveResponse?: string }) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.shipmentAssessment.findFirst({ where: { id, sellerAccountId } });
    if (row === null) throw notFound('Shipment assessment');
    if (row.status === 'DISPATCHED' || row.status === 'CANCELLED') throw conflict(ErrorCode.SHIPMENT_ASSESSMENT_TRANSITION_NOT_ALLOWED, 'This assessment is closed.');
    const now = new Date();
    await tx.shipmentAssessment.update({
      where: { id },
      data: {
        ...(input.readinessNote === undefined ? {} : { readinessNote: input.readinessNote.slice(0, 10000), readinessSubmittedAt: now }),
        ...(input.correctiveResponse === undefined ? {} : { sellerResponse: input.correctiveResponse.slice(0, 10000), sellerRespondedAt: now }),
        version: { increment: 1 },
      },
    });
    await writeEvent(tx, id, { kind: input.correctiveResponse === undefined ? 'SELLER_READINESS' : 'SELLER_CORRECTIVE_RESPONSE', actorRole: 'SELLER', actorUserId: userId, note: input.correctiveResponse ?? input.readinessNote ?? null });
    await announce(tx, row, { kind: 'shipment_assessment.seller_update', title: `${row.number}: seller update`, body: input.correctiveResponse === undefined ? 'The seller submitted readiness information.' : 'The seller responded to the corrective action.' });
  });
}

// --- Badge and policy -----------------------------------------------------------------

/** Set a seller's Audit badge. A downgrade withdraws unused waivers; an upgrade creates none. */
export async function setBadge(actor: AuditActor, sellerAccountId: string, tier: BadgeTier | null, reason: string, expectedBadgeVersion: number) {
  if (reason.trim().length < 10) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the reason for the badge change.', [{ field: 'reason', code: 'REQUIRED' }]);
  return prisma.$transaction(async (tx) => {
    const seller = await tx.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { auditBadge: true, auditBadgeVersion: true } });
    if (seller === null) throw notFound('Seller');
    if (seller.auditBadgeVersion !== expectedBadgeVersion) throw versionConflict();
    const moved = await tx.sellerAccount.updateMany({
      where: { id: sellerAccountId, auditBadgeVersion: expectedBadgeVersion },
      data: { auditBadge: tier, auditBadgeSetAt: new Date(), auditBadgeVersion: { increment: 1 } },
    });
    if (moved.count === 0) throw versionConflict();
    await tx.sellerBadgeChange.create({ data: { id: newId(), sellerAccountId, fromTier: seller.auditBadge, toTier: tier, reason: reason.trim().slice(0, 2000), changedByUserId: actor.userId } });
    await recordAudit({ action: AuditAction.SELLER_BADGE_CHANGED, resourceType: 'SellerAccount', resourceId: sellerAccountId, actorType: 'AUDIT', actorUserId: actor.userId, before: { badge: seller.auditBadge }, after: { badge: tier, reason } }, tx);
    if (!isBadgeDowngrade(seller.auditBadge, tier)) return;
    const policy = await activePolicy(tx);
    const stillEligible = ruleFor(policy, tier) !== 'ASSESSMENT_REQUIRED';
    const open = await tx.shipmentAssessment.findMany({ where: { sellerAccountId, status: { in: ['WAIVER_REVIEW', 'APPROVED_FOR_L2'] } } });
    for (const row of open) {
      const waiverRelease = await tx.shipmentReleaseAuthorization.findFirst({ where: { assessmentId: row.id, status: 'ACTIVE', kind: 'WAIVER' } });
      if (waiverRelease !== null || (row.status === 'WAIVER_REVIEW' && !stillEligible)) {
        await invalidateRelease(tx, row, `Seller badge downgraded from ${seller.auditBadge ?? 'none'} to ${tier ?? 'none'}.`, 'READY_FOR_ASSESSMENT', { role: 'AUDIT', userId: actor.userId });
      }
    }
  });
}

export async function publishPolicy(actor: AuditActor, input: Omit<BadgePolicy, 'version'> & { note: string }) {
  const problem = policyProblem(input);
  if (problem !== null) throw badRequest(ErrorCode.SHIPMENT_ASSESSMENT_POLICY_INVALID, 'This policy is not allowed.', [{ field: 'policy', code: problem }]);
  return prisma.$transaction(async (tx) => {
    const current = await activePolicy(tx);
    const version = current.version + 1;
    try {
      await tx.shipmentAssessmentPolicy.create({ data: { id: newId(), version, ...input, createdByUserId: actor.userId } });
    } catch {
      throw versionConflict();
    }
    await recordAudit({ action: AuditAction.SHIPMENT_ASSESSMENT_POLICY_PUBLISHED, resourceType: 'ShipmentAssessmentPolicy', resourceId: String(version), actorType: 'AUDIT', actorUserId: actor.userId, before: current, after: { version, ...input } }, tx);
    return { version };
  });
}

// --- Sweep (worker) ---------------------------------------------------------------------

/**
 * The periodic pass. Opens cases for shipments awaiting L2 (marking those that
 * predate the feature), catches L1 handovers that were missed, cancels cases
 * of cancelled orders, withdraws releases that expired or whose shipment or
 * seller changed, and expires and reminds about documents. The gate checks
 * all of this itself; this pass is what makes the queues tell the truth.
 */
export async function sweepShipmentAssessments(now = new Date()): Promise<{ opened: number; invalidated: number; expired: number }> {
  let opened = 0;
  let invalidated = 0;
  if (env.FEATURE_SHIPMENT_ASSESSMENT) {
    const waiting = await prisma.shipmentLeg.findMany({
      where: { level: 'L2', status: { notIn: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] }, sellerOrderGroup: { shipmentAssessment: null } },
      select: { sellerOrderGroupId: true },
      take: 200,
    });
    for (const leg of waiting) {
      try {
        await prisma.$transaction(async (tx) => {
          const l1 = await tx.shipmentLeg.findFirst({ where: { sellerOrderGroupId: leg.sellerOrderGroupId, level: 'L1' }, select: { status: true } });
          // Already at the port with no case: it was waiting when the feature was switched on.
          await ensureCase(tx, leg.sellerOrderGroupId, l1?.status === 'COMPLETED');
          await markL1Complete(tx, leg.sellerOrderGroupId, false);
        });
        opened += 1;
      } catch (error) {
        logger.warn({ err: error, group: leg.sellerOrderGroupId }, 'shipment assessment case not opened');
      }
    }
    const pendingL1 = await prisma.shipmentAssessment.findMany({ where: { status: 'AWAITING_L1' }, select: { sellerOrderGroupId: true }, take: 200 });
    for (const row of pendingL1) {
      await prisma.$transaction(async (tx) => markL1Complete(tx, row.sellerOrderGroupId, false)).catch(() => undefined);
    }
    const cancelled = await prisma.shipmentAssessment.findMany({ where: { status: { notIn: ['DISPATCHED', 'CANCELLED'] }, sellerOrderGroup: { status: 'CANCELLED' } }, take: 200 });
    for (const row of cancelled) {
      await prisma.$transaction(async (tx) => {
        await invalidateRelease(tx, row, 'Seller order cancelled.', 'CANCELLED', { role: 'SYSTEM', userId: null });
        await tx.shipmentAssessment.update({ where: { id: row.id }, data: { cancelledAt: now } });
      }).catch(() => undefined);
    }
    const active = await prisma.shipmentReleaseAuthorization.findMany({ where: { status: 'ACTIVE' }, select: { assessmentId: true }, take: 500 });
    for (const release of active) {
      try {
        await prisma.$transaction(async (tx) => {
          const { assessment, refusal } = await releaseCheck(tx, release.assessmentId);
          if (refusal === null || refusal === 'LOADING_CHECKS_PENDING' || refusal === 'L1_NOT_COMPLETE') return;
          const reasons: Record<string, [string, AssessmentStatus]> = {
            AUTHORIZATION_EXPIRED: ['Dispatch deadline passed before L2 departed.', 'REASSESSMENT_REQUIRED'],
            SHIPMENT_CHANGED: ['The shipment changed after release (lines, quantities, packing list or destination).', 'REASSESSMENT_REQUIRED'],
            BADGE_CHANGED: ["The seller's badge changed after the waiver.", 'READY_FOR_ASSESSMENT'],
            SELLER_SUSPENDED: ['The seller was suspended.', 'ON_HOLD'],
          };
          const [reason, to] = reasons[refusal] ?? ['Release no longer valid.', 'REASSESSMENT_REQUIRED'];
          await invalidateRelease(tx, assessment, reason, to, { role: 'SYSTEM', userId: null });
        });
        invalidated += 1;
      } catch (error) {
        logger.warn({ err: error, assessmentId: release.assessmentId }, 'release re-check failed');
      }
    }
  }
  // Documents: expire, and remind 30 days before a seller certificate's review date.
  const expired = await prisma.auditDocument.updateMany({ where: { status: 'ACTIVE', validUntil: { lte: now } }, data: { status: 'EXPIRED', statusChangedAt: now } });
  const soon = await prisma.auditDocument.findMany({
    where: { status: 'ACTIVE', kind: 'SELLER_VERIFICATION_CERTIFICATE', reminderSentAt: null, validUntil: { lte: new Date(now.getTime() + 30 * 86_400_000) } },
    take: 100,
  });
  for (const doc of soon) {
    await prisma.$transaction(async (tx) => {
      await tx.auditDocument.update({ where: { id: doc.id }, data: { reminderSentAt: now } });
      await announce(tx, { id: doc.id, number: doc.number, sellerAccountId: doc.sellerAccountId }, {
        kind: 'audit_document.review_due',
        title: `${doc.number}: seller verification review due`,
        body: `The certificate is due for review on ${doc.validUntil?.toISOString().slice(0, 10) ?? ''}.`,
        seller: true,
      });
    }).catch(() => undefined);
  }
  // A suspended seller's certificate no longer stands.
  await prisma.auditDocument.updateMany({
    where: { status: 'ACTIVE', kind: 'SELLER_VERIFICATION_CERTIFICATE', sellerAccount: { status: 'SUSPENDED' } },
    data: { status: 'REVOKED', statusChangedAt: now, revokedReason: 'Seller suspended. Re-review required.' },
  });
  return { opened, invalidated, expired: expired.count };
}

// --- Reading ------------------------------------------------------------------------------

export const QUEUES: Record<string, AssessmentStatus[]> = {
  awaitingL1: ['AWAITING_L1'],
  ready: ['READY_FOR_ASSESSMENT'],
  inProgress: ['IN_PROGRESS'],
  awaitingQa: ['AWAITING_QA'],
  waiver: ['WAIVER_REVIEW'],
  approved: ['APPROVED_FOR_L2'],
  failed: ['FAILED', 'ON_HOLD'],
  reassessment: ['REASSESSMENT_REQUIRED'],
  history: ['DISPATCHED', 'CANCELLED'],
};

export async function listAssessments(filters: { queue: string | null; search: string | null; rollout: boolean; sellerAccountId?: string; orderIds?: string[]; page: number; pageSize: number }) {
  const statuses = filters.queue === null ? undefined : QUEUES[filters.queue];
  const search = (filters.search ?? '').trim();
  const where = {
    ...(statuses === undefined ? {} : { status: { in: statuses } }),
    ...(filters.rollout ? { existingAtRollout: true, status: { notIn: ['DISPATCHED', 'CANCELLED'] as AssessmentStatus[] } } : {}),
    ...(filters.sellerAccountId === undefined ? {} : { sellerAccountId: filters.sellerAccountId }),
    ...(filters.orderIds === undefined ? {} : { orderId: { in: filters.orderIds } }),
    ...(search === ''
      ? {}
      : {
          OR: [
            { number: { contains: search } },
            { sellerAccount: { displayName: { contains: search } } },
            { sellerOrderGroup: { sellerOrderNumber: { contains: search } } },
            { sellerOrderGroup: { order: { orderNumber: { contains: search } } } },
          ],
        }),
  };
  const [rows, total, grouped, rollout] = await Promise.all([
    prisma.shipmentAssessment.findMany({
      where,
      orderBy: [{ l1CompletedAt: 'asc' }, { createdAt: 'asc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: {
        sellerAccount: { select: { displayName: true, auditBadge: true } },
        sellerOrderGroup: { select: { sellerOrderNumber: true, order: { select: { orderNumber: true } }, lines: { select: { quantity: true } } } },
        releases: { where: { status: 'ACTIVE' }, select: { dispatchDeadline: true, kind: true } },
        documents: { where: { status: { in: ['ACTIVE', 'USED'] } }, select: { kind: true, status: true } },
      },
    }),
    prisma.shipmentAssessment.count({ where }),
    prisma.shipmentAssessment.groupBy({ by: ['status'], where: filters.sellerAccountId === undefined ? {} : { sellerAccountId: filters.sellerAccountId }, _count: { _all: true } }),
    prisma.shipmentAssessment.count({ where: { existingAtRollout: true, status: { notIn: ['DISPATCHED', 'CANCELLED'] } } }),
  ]);
  const counts: Record<string, number> = { rollout };
  for (const [queue, statuses2] of Object.entries(QUEUES)) counts[queue] = grouped.filter((entry) => statuses2.includes(entry.status)).reduce((sum, entry) => sum + entry._count._all, 0);
  const userIds = [...new Set(rows.flatMap((row) => [row.assessorUserId, row.qaReviewerUserId]).filter((value): value is string => value !== null))];
  const users = await peopleNames(prisma, userIds);
  const nameOf = (userId: string | null) => users.find((user) => user.id === userId)?.fullName ?? null;
  return {
    total,
    counts,
    rows: rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      orderNumber: row.sellerOrderGroup.order.orderNumber,
      sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
      seller: row.sellerAccount.displayName,
      badge: row.sellerAccount.auditBadge,
      units: row.sellerOrderGroup.lines.reduce((sum, line) => sum + line.quantity, 0),
      lines: row.sellerOrderGroup.lines.length,
      l1CompletedAt: row.l1CompletedAt?.toISOString() ?? null,
      l1Location: row.l1Location,
      plannedL2At: row.plannedL2At?.toISOString() ?? null,
      requirement: row.requirement,
      requirementReason: row.requirementReason,
      mandatoryInspection: row.mandatoryInspection,
      assessor: nameOf(row.assessorUserId),
      qaReviewer: nameOf(row.qaReviewerUserId),
      releaseDeadline: row.releases[0]?.dispatchDeadline.toISOString() ?? null,
      releaseKind: row.releases[0]?.kind ?? null,
      certificate: row.documents.find((doc) => doc.kind !== 'SHIPMENT_FINDINGS_REPORT')?.kind ?? (row.documents.length > 0 ? 'SHIPMENT_FINDINGS_REPORT' : null),
      existingAtRollout: row.existingAtRollout,
      blocked: BLOCKING_STATUSES.includes(row.status),
    })),
  };
}

export type Audience = 'AUDIT' | 'ADMIN' | 'SELLER' | 'LOGISTICS' | 'BUYER';

/**
 * One case for one audience. Audit and admin see everything; the seller sees
 * findings and its own uploads but no reviewer history snapshot; the carrier
 * sees release state, handling needs and the loading checks; the buyer sees a
 * summary and the released documents only.
 */
export async function readAssessment(id: string, audience: Audience, scope: { sellerAccountId?: string; orderIds?: string[]; partnerId?: string } = {}) {
  const row = await prisma.shipmentAssessment.findFirst({
    where: {
      id,
      ...(scope.sellerAccountId === undefined ? {} : { sellerAccountId: scope.sellerAccountId }),
      ...(scope.orderIds === undefined ? {} : { orderId: { in: scope.orderIds } }),
    },
    include: {
      sellerAccount: { select: { displayName: true, legalName: true, auditBadge: true, auditBadgeVersion: true, status: true } },
      sellerOrderGroup: {
        select: {
          sellerOrderNumber: true,
          order: { select: { orderNumber: true } },
          lines: { select: { quantity: true, offer: { select: { sellerSku: true, product: { select: { name: true } } } } } },
        },
      },
      rounds: { orderBy: { round: 'asc' } },
      checks: { orderBy: [{ round: 'asc' }, { itemCode: 'asc' }] },
      evidence: { orderBy: { createdAt: 'asc' } },
      events: { orderBy: { occurredAt: 'asc' } },
      waivers: { orderBy: { decidedAt: 'asc' } },
      releases: { orderBy: { createdAt: 'asc' } },
      exceptions: { orderBy: { occurredAt: 'asc' } },
      documents: { orderBy: { issuedAt: 'asc' } },
    },
  });
  if (row === null) throw notFound('Shipment assessment');
  if (audience === 'LOGISTICS') {
    const leg = row.l2LegId === null ? null : await prisma.shipmentLeg.findFirst({ where: { id: row.l2LegId, logisticsPartnerId: scope.partnerId ?? '' }, select: { id: true } });
    if (leg === null) throw notFound('Shipment assessment');
  }
  const { refusal } = await releaseCheck(prisma, row.id);
  const full = audience === 'AUDIT' || audience === 'ADMIN';
  const current = row.rounds.find((round) => round.round === row.currentRound) ?? null;
  const base = {
    id: row.id,
    number: row.number,
    status: row.status,
    version: row.version,
    orderNumber: row.sellerOrderGroup.order.orderNumber,
    sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
    seller: row.sellerAccount.displayName,
    badge: row.sellerAccount.auditBadge,
    l1CompletedAt: row.l1CompletedAt?.toISOString() ?? null,
    l1Location: row.l1Location,
    plannedL2At: row.plannedL2At?.toISOString() ?? null,
    releaseRefusal: refusal,
    releaseDeadline: row.releases.find((release) => release.status === 'ACTIVE')?.dispatchDeadline.toISOString() ?? null,
    loadingChecksCompletedAt: row.loadingChecksCompletedAt?.toISOString() ?? null,
    documents: row.documents
      .filter((doc) => audience !== 'BUYER' || doc.kind === 'SHIPMENT_ASSESSMENT_CERTIFICATE' || doc.kind === 'SHIPMENT_WAIVER_AUTHORIZATION')
      .filter((doc) => audience !== 'LOGISTICS' || doc.kind !== 'SHIPMENT_FINDINGS_REPORT')
      .map(documentView),
  };
  if (audience === 'BUYER') return base;
  const loadingItems = (current?.checklistJson as unknown as ChecklistItem[] | undefined)?.filter((item) => item.phase === 'LOADING') ?? [];
  const checkView = (check: (typeof row.checks)[number]) => ({
    round: check.round,
    itemCode: check.itemCode,
    section: check.section,
    phase: check.phase,
    outcome: check.outcome,
    note: check.note,
    measuredValue: check.measuredValue,
    sampled: check.sampled,
    recordedByRole: check.recordedByRole,
    recordedAt: check.recordedAt.toISOString(),
  });
  const evidenceView = (evidence: (typeof row.evidence)[number]) => ({
    id: evidence.id,
    round: evidence.round,
    itemCode: evidence.itemCode,
    fileName: evidence.fileName,
    contentType: evidence.contentType,
    byteSize: evidence.byteSize,
    uploadedByRole: evidence.uploadedByRole,
    note: evidence.note,
    createdAt: evidence.createdAt.toISOString(),
  });
  if (audience === 'LOGISTICS') {
    return {
      ...base,
      currentRound: row.currentRound,
      loadingItems,
      checks: row.checks.filter((check) => check.round === row.currentRound && check.phase === 'LOADING').map(checkView),
      holdReason: BLOCKING_STATUSES.includes(row.status) ? 'The Audit Team has blocked this shipment.' : null,
    };
  }
  const roundView = (round: (typeof row.rounds)[number]) => ({
    round: round.round,
    kind: round.kind,
    checklistVersion: round.checklistVersion,
    checklist: round.checklistJson,
    startedAt: round.startedAt?.toISOString() ?? null,
    submittedAt: round.submittedAt?.toISOString() ?? null,
    inspectionLocation: round.inspectionLocation,
    quantities: {
      orderedQuantity: round.orderedQuantity,
      declaredQuantity: round.declaredQuantity,
      presentedQuantity: round.presentedQuantity,
      countedQuantity: round.countedQuantity,
      sampledQuantity: round.sampledQuantity,
      approvedQuantity: round.approvedQuantity,
      sellingUnit: round.sellingUnit,
      unitsPerPackage: round.unitsPerPackage,
      packagesDeclared: round.packagesDeclared,
      packagesCounted: round.packagesCounted,
      grossWeightDeclaredGrams: round.grossWeightDeclaredGrams?.toString() ?? null,
      grossWeightMeasuredGrams: round.grossWeightMeasuredGrams?.toString() ?? null,
      countingMethod: round.countingMethod,
      samplingMethod: round.samplingMethod,
      sampleCoverageNote: round.sampleCoverageNote,
    },
    outcome: round.outcome,
    findingsSummary: round.findingsSummary,
    qaDecision: round.qaDecision,
    qaNote: full ? round.qaNote : null,
    qaDecidedAt: round.qaDecidedAt?.toISOString() ?? null,
    correctiveAction: round.correctiveAction,
    assessorUserId: full ? round.assessorUserId : null,
  });
  const seller = {
    ...base,
    currentRound: row.currentRound,
    requirement: row.requirement,
    requirementReason: row.requirementReason,
    mandatoryInspection: row.mandatoryInspection,
    mandatoryReason: row.mandatoryReason,
    readinessNote: row.readinessNote,
    sellerResponse: row.sellerResponse,
    holdReason: row.holdReason,
    lines: row.sellerOrderGroup.lines.map((line) => ({ sku: line.offer.sellerSku, name: line.offer.product.name, quantity: line.quantity })),
    rounds: row.rounds.map(roundView),
    checks: row.checks.map(checkView),
    evidence: row.evidence.map(evidenceView),
  };
  if (audience === 'SELLER') return seller;
  const users = await peopleNames(prisma, [row.assessorUserId, row.qaReviewerUserId, ...row.events.map((event) => event.actorUserId), ...row.waivers.map((waiver) => waiver.decidedByUserId)].filter((value): value is string => value !== null));
  const nameOf = (userId: string | null) => users.find((user) => user.id === userId)?.fullName ?? null;
  return {
    ...seller,
    applicabilityKnown: row.applicabilityKnown,
    badgeAtEvaluation: row.badgeAtEvaluation,
    badgeVersion: row.sellerAccount.auditBadgeVersion,
    policyVersion: row.policyVersion,
    existingAtRollout: row.existingAtRollout,
    assessor: nameOf(row.assessorUserId),
    assessorUserId: row.assessorUserId,
    qaReviewer: nameOf(row.qaReviewerUserId),
    sellerStatus: row.sellerAccount.status,
    events: row.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorRole: event.actorRole,
      actor: nameOf(event.actorUserId),
      note: event.note,
      occurredAt: event.occurredAt.toISOString(),
    })),
    waivers: row.waivers.map((waiver) => ({
      id: waiver.id,
      decision: waiver.decision,
      badgeAtDecision: waiver.badgeAtDecision,
      policyVersion: waiver.policyVersion,
      historyReviewNote: waiver.historyReviewNote,
      history: waiver.historySnapshotJson,
      reason: waiver.reason,
      evidenceRefs: waiver.evidenceRefsJson,
      decidedBy: nameOf(waiver.decidedByUserId),
      decidedAt: waiver.decidedAt.toISOString(),
      invalidatedAt: waiver.invalidatedAt?.toISOString() ?? null,
      invalidationReason: waiver.invalidationReason,
    })),
    releases: row.releases.map((release) => ({
      id: release.id,
      kind: release.kind,
      status: release.status,
      round: release.round,
      dispatchDeadline: release.dispatchDeadline.toISOString(),
      deadlineJustification: release.deadlineJustification,
      badgeAtIssue: release.badgeAtIssue,
      policyVersion: release.policyVersion,
      issuedAt: release.issuedAt.toISOString(),
      consumedAt: release.consumedAt?.toISOString() ?? null,
      invalidatedAt: release.invalidatedAt?.toISOString() ?? null,
      invalidationReason: release.invalidationReason,
    })),
    exceptions: row.exceptions.map((exception) => ({
      id: exception.id,
      kind: exception.kind,
      detail: exception.detail,
      occurredAt: exception.occurredAt.toISOString(),
      resolvedAt: exception.resolvedAt?.toISOString() ?? null,
      resolutionNote: exception.resolutionNote,
    })),
  };
}

export async function readPolicy() {
  const rows = await prisma.shipmentAssessmentPolicy.findMany({ orderBy: { version: 'desc' }, take: 20 });
  return { current: rows[0] ?? null, history: rows };
}

export async function badgeHistory(sellerAccountId: string) {
  const [seller, changes] = await Promise.all([
    prisma.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { auditBadge: true, auditBadgeSetAt: true, auditBadgeVersion: true } }),
    prisma.sellerBadgeChange.findMany({ where: { sellerAccountId }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  if (seller === null) throw notFound('Seller');
  const users = await peopleNames(prisma, changes.map((change) => change.changedByUserId));
  return {
    badge: seller.auditBadge,
    setAt: seller.auditBadgeSetAt?.toISOString() ?? null,
    version: seller.auditBadgeVersion,
    history: changes.map((change) => ({
      fromTier: change.fromTier,
      toTier: change.toTier,
      reason: change.reason,
      changedBy: users.find((user) => user.id === change.changedByUserId)?.fullName ?? null,
      at: change.createdAt.toISOString(),
    })),
  };
}

export async function sellerDocuments(sellerAccountId: string) {
  const rows = await prisma.auditDocument.findMany({ where: { sellerAccountId, kind: 'SELLER_VERIFICATION_CERTIFICATE' }, orderBy: { issuedAt: 'desc' } });
  return rows.map(documentView);
}
