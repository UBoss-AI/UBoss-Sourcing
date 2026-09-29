/**
 * The release decision: whether the goods may leave, who said so, and what it
 * was bound to (SCREEN-055, FLOW-006, INSPECT-006).
 *
 * Three ways a release comes to exist:
 *
 *   - A signed PASS report. Recorded automatically at sign-off, by the QA
 *     reviewer who signed, bound to the goods as they stood.
 *   - A loading record. The named inspector, after a PASS, ties the goods to a
 *     container and seal with witness and stuffing evidence; that rebinds the
 *     release to the loaded goods (JOURNEY-045, ENH-012). It is also how the
 *     agency re-evaluates after a post-inspection change.
 *   - A conditional release. An operator with INSPECTION_RELEASE requests it
 *     with a reason of the policy's minimum length and at least one piece of
 *     evidence; a SECOND person with the same permission approves it. The
 *     same person pressing both is refused (assertSecondApprover).
 *
 * A FAIL report records no release and supersedes any earlier one. So does a
 * newer signed report of any result: the latest signed report is always what
 * the goods are measured against.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { assertSecondApprover } from '../../domain/inspection-state.js';
import { InspectionAgencyPermission } from '../../domain/inspection-permissions.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from '../seller/notification.service.js';
import { agencyActor, assertInspectionPermission, type InspectionMembership } from './agency.service.js';
import { AuditAction, readPolicy, recordInspectionEvent, type InspectionActor } from './context.js';
import {
  currentScope,
  evaluateSellerOrderGate,
  notifyDispatchAuthorised,
  peekGate,
  refreshRequirementStatus,
} from './gate.service.js';

type Tx = PrismaTransaction;

async function supersedeLive(tx: Tx, requirementId: string, reason: string): Promise<number> {
  const result = await tx.inspectionRelease.updateMany({
    where: { requirementId, state: { in: ['ACTIVE', 'PENDING_APPROVAL'] } },
    data: { state: 'SUPERSEDED', supersededAt: new Date(), supersededReason: reason.slice(0, 255) },
  });
  return result.count;
}

async function groupOf(tx: Tx, requirementId: string): Promise<{ sellerOrderGroupId: string; orderId: string; sellerAccountId: string }> {
  return tx.inspectionRequirement.findUniqueOrThrow({
    where: { id: requirementId },
    select: { sellerOrderGroupId: true, orderId: true, sellerAccountId: true },
  });
}

/** Consequences of a signed report, in the signing transaction. */
export async function afterReportSigned(
  tx: Tx,
  input: {
    requirementId: string;
    orderId: string;
    sellerAccountId: string;
    sellerOrderGroupId: string;
    jobId: string;
    jobNumber: string;
    jobKind: 'INITIAL' | 'REINSPECTION';
    reportId: string;
    result: 'PASS' | 'FAIL';
    actor: InspectionActor;
  },
): Promise<void> {
  await supersedeLive(tx, input.requirementId, `Replaced by the signed report of ${input.jobNumber}.`);

  // Findings on this job that the seller must now answer are no longer the
  // inspector's working: they are NCRs. A re-inspection that PASSES verifies
  // the corrections recorded against the earlier findings.
  if (input.result === 'PASS' && input.jobKind === 'REINSPECTION') {
    const verified = await tx.inspectionDefect.updateMany({
      where: { requirementId: input.requirementId, status: 'CAPA_SUBMITTED', jobId: { not: input.jobId } },
      data: { status: 'VERIFIED_CLOSED', verifiedAt: new Date(), verifiedByReportId: input.reportId },
    });
    if (verified.count > 0) {
      await recordInspectionEvent(tx, {
        requirementId: input.requirementId,
        orderId: input.orderId,
        jobId: input.jobId,
        kind: 'ncr_verified',
        actor: input.actor,
        summary: `${String(verified.count)} non-conformance${verified.count === 1 ? '' : 's'} verified closed by re-inspection ${input.jobNumber}.`,
        data: { reportId: input.reportId, count: verified.count },
      });
    }
  }

  if (input.result === 'PASS') {
    const scope = await currentScope(tx, input.sellerOrderGroupId);
    const releaseId = newId();
    await tx.inspectionRelease.create({
      data: {
        id: releaseId,
        requirementId: input.requirementId,
        kind: 'PASS',
        state: 'ACTIVE',
        reportId: input.reportId,
        requestedByParty: input.actor.party,
        requestedById: input.actor.userId,
        requestedByLabel: input.actor.label.slice(0, 160),
        requestedAt: new Date(),
        approvedById: input.actor.userId,
        approvedByLabel: input.actor.label.slice(0, 160),
        approvedAt: new Date(),
        boundScopeHash: scope.hash,
        boundScopeJson: scope.summary as never,
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: input.requirementId,
      orderId: input.orderId,
      jobId: input.jobId,
      kind: 'release_recorded',
      actor: input.actor,
      summary: `Release recorded: ${input.jobNumber} passed. The goods may leave once nothing else holds them.`,
      data: { releaseId, reportId: input.reportId, boundScope: scope.summary },
      audit: AuditAction.INSPECTION_RELEASE_RECORDED,
    });

    await refreshRequirementStatus(tx, input.requirementId);
    await notifyDispatchAuthorised(tx, input.requirementId, releaseId);
  } else {
    await refreshRequirementStatus(tx, input.requirementId);
  }

  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'INSPECTION_UPDATE',
    title: `Inspection ${input.jobNumber}: ${input.result === 'PASS' ? 'passed' : 'failed'}`,
    body:
      input.result === 'PASS'
        ? 'The signed report passed. Check the order for any finding still open before you dispatch.'
        : 'The signed report failed. The goods cannot leave. Record corrective action on each finding and book a re-inspection.',
    linkPath: `/seller/orders/${input.sellerOrderGroupId}`,
    severity: input.result === 'PASS' ? 'SUCCESS' : 'CRITICAL',
    subjectType: 'inspection_job',
    subjectId: input.jobId,
    dedupeKey: `inspection-signed:${input.reportId}`,
    tx,
  });
}

// ---------------------------------------------------------------------------
// Conditional release
// ---------------------------------------------------------------------------

export interface OperatorReleaseActor extends InspectionActor {
  party: 'OPERATOR';
  userId: string;
}

export async function requestConditionalRelease(
  actor: OperatorReleaseActor,
  requirementId: string,
  input: { reason: string; riskNote?: string | null; evidenceIds: string[] },
): Promise<{ releaseId: string }> {
  const policy = await readPolicy();

  return prisma.$transaction(async (tx) => {
    const requirement = await tx.inspectionRequirement.findUnique({
      where: { id: requirementId },
      select: { id: true, orderId: true, level: true, allowConditionalRelease: true, loadReleasedAt: true, sellerOrderGroupId: true },
    });
    if (requirement === null) throw notFound('Inspection');

    const refuse = (code: string, message: string): never => {
      throw conflict(ErrorCode.INSPECTION_RELEASE_NOT_ALLOWED, message, [{ code }]);
    };

    if (requirement.level === 'NOT_REQUIRED') refuse('NOT_REQUIRED', 'This order does not need a release.');
    if (!requirement.allowConditionalRelease) {
      refuse('RULE_FORBIDS', 'The rule that required this inspection does not allow a conditional release.');
    }
    if (requirement.loadReleasedAt !== null) refuse('ALREADY_DISPATCHED', 'These goods have already been released.');

    const pending = await tx.inspectionRelease.count({ where: { requirementId, state: 'PENDING_APPROVAL' } });
    if (pending > 0) refuse('ALREADY_PENDING', 'A conditional release is already waiting for approval.');

    const verdict = await peekGateTx(tx, requirementId);
    if (verdict.open) refuse('GATE_OPEN', 'The goods are already free to leave.');

    if (input.reason.trim().length < policy.conditionalReleaseMinReasonLength) {
      throw badRequest(
        ErrorCode.INSPECTION_RELEASE_NOT_ALLOWED,
        `Give the reason in at least ${String(policy.conditionalReleaseMinReasonLength)} characters.`,
        [{ field: 'reason', code: 'REASON_TOO_SHORT', meta: { minimum: policy.conditionalReleaseMinReasonLength } }],
      );
    }

    const evidence = await tx.inspectionEvidence.findMany({
      where: { id: { in: input.evidenceIds }, requirementId, purpose: 'RELEASE', releaseId: null },
      select: { id: true },
    });
    if (evidence.length === 0) {
      throw badRequest(ErrorCode.INSPECTION_RELEASE_NOT_ALLOWED, 'Attach the evidence this release rests on.', [
        { field: 'evidenceIds', code: 'EVIDENCE_REQUIRED' },
      ]);
    }

    const scope = await currentScope(tx, requirement.sellerOrderGroupId);
    const releaseId = newId();

    await tx.inspectionRelease.create({
      data: {
        id: releaseId,
        requirementId,
        kind: 'CONDITIONAL',
        state: 'PENDING_APPROVAL',
        reason: input.reason.trim(),
        riskNote: input.riskNote?.trim().slice(0, 1024) || null,
        requestedByParty: 'OPERATOR',
        requestedById: actor.userId,
        requestedByLabel: actor.label.slice(0, 160),
        requestedAt: new Date(),
        boundScopeHash: scope.hash,
        boundScopeJson: scope.summary as never,
      },
    });

    await tx.inspectionEvidence.updateMany({
      where: { id: { in: evidence.map((row) => row.id) } },
      data: { releaseId },
    });

    await recordInspectionEvent(tx, {
      requirementId,
      orderId: requirement.orderId,
      kind: 'conditional_release_requested',
      actor,
      summary: `Conditional release requested by ${actor.label}: ${input.reason.trim()}`,
      data: { releaseId, evidence: evidence.map((row) => row.id), gateReason: verdict.reason },
      audit: AuditAction.INSPECTION_RELEASE_REQUESTED,
      visibleToBuyer: false,
    });

    await refreshRequirementStatus(tx, requirementId);
    return { releaseId };
  });
}

async function peekGateTx(tx: Tx, requirementId: string) {
  // The verdict read inside the transaction, so a release and a dispatch
  // cannot both act on a stale view.
  const requirement = await tx.inspectionRequirement.findUniqueOrThrow({
    where: { id: requirementId },
    select: { sellerOrderGroupId: true },
  });
  return evaluateSellerOrderGate(tx, requirement.sellerOrderGroupId);
}

export async function approveConditionalRelease(actor: OperatorReleaseActor, releaseId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const release = await tx.inspectionRelease.findUnique({
      where: { id: releaseId },
      include: { requirement: { select: { id: true, orderId: true, sellerOrderGroupId: true, sellerAccountId: true } } },
    });
    if (release === null || release.kind !== 'CONDITIONAL') throw notFound('Release');
    if (release.state !== 'PENDING_APPROVAL') {
      throw conflict(ErrorCode.INSPECTION_RELEASE_NOT_ALLOWED, 'This release is not waiting for approval.', [
        { code: 'NOT_PENDING', meta: { state: release.state } },
      ]);
    }

    assertSecondApprover(release.requestedById, actor.userId);

    // Approved against the goods as they stand NOW: if anything changed since
    // the request, the approver is approving the changed goods and sees it.
    const scope = await currentScope(tx, release.requirement.sellerOrderGroupId);

    await tx.inspectionRelease.updateMany({
      where: { requirementId: release.requirementId, state: 'ACTIVE' },
      data: { state: 'SUPERSEDED', supersededAt: new Date(), supersededReason: 'Replaced by a conditional release.' },
    });

    const approved = await tx.inspectionRelease.updateMany({
      where: { id: release.id, state: 'PENDING_APPROVAL' },
      data: {
        state: 'ACTIVE',
        approvedById: actor.userId,
        approvedByLabel: actor.label.slice(0, 160),
        approvedAt: new Date(),
        boundScopeHash: scope.hash,
        boundScopeJson: scope.summary as never,
      },
    });
    if (approved.count !== 1) {
      throw conflict(ErrorCode.CONFLICT, 'This release was decided by somebody else a moment ago.', [{ code: 'VERSION_CONFLICT' }]);
    }

    await recordInspectionEvent(tx, {
      requirementId: release.requirementId,
      orderId: release.requirement.orderId,
      kind: 'conditional_release_approved',
      actor,
      summary: `Conditional release approved by ${actor.label}, requested by ${release.requestedByLabel}.`,
      data: { releaseId: release.id, requestedById: release.requestedById, reason: release.reason },
      audit: AuditAction.INSPECTION_RELEASE_APPROVED,
    });

    await refreshRequirementStatus(tx, release.requirementId);
    await notifyDispatchAuthorised(tx, release.requirementId, release.id);

    await notifySeller({
      sellerAccountId: release.requirement.sellerAccountId,
      kind: 'INSPECTION_UPDATE',
      title: 'The goods were conditionally released',
      body: `The marketplace released these goods for dispatch: ${release.reason ?? ''}`.slice(0, 1000),
      linkPath: `/seller/orders/${release.requirement.sellerOrderGroupId}`,
      severity: 'WARNING',
      subjectType: 'inspection_release',
      subjectId: release.id,
      dedupeKey: `inspection-conditional:${release.id}`,
      tx,
    });
  });
}

export async function rejectConditionalRelease(actor: OperatorReleaseActor, releaseId: string, reason: string): Promise<void> {
  if (reason.trim().length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the release is refused.', [{ field: 'reason', code: 'REQUIRED' }]);
  }

  await prisma.$transaction(async (tx) => {
    const release = await tx.inspectionRelease.findUnique({
      where: { id: releaseId },
      include: { requirement: { select: { orderId: true } } },
    });
    if (release === null || release.kind !== 'CONDITIONAL') throw notFound('Release');

    const rejected = await tx.inspectionRelease.updateMany({
      where: { id: release.id, state: 'PENDING_APPROVAL' },
      data: { state: 'REJECTED', rejectedById: actor.userId, rejectedAt: new Date(), rejectionReason: reason.trim().slice(0, 1024) },
    });
    if (rejected.count !== 1) {
      throw conflict(ErrorCode.INSPECTION_RELEASE_NOT_ALLOWED, 'This release is not waiting for approval.', [{ code: 'NOT_PENDING' }]);
    }

    await recordInspectionEvent(tx, {
      requirementId: release.requirementId,
      orderId: release.requirement.orderId,
      kind: 'conditional_release_rejected',
      actor,
      summary: `Conditional release refused by ${actor.label}: ${reason.trim()}`,
      data: { releaseId: release.id },
      audit: AuditAction.INSPECTION_RELEASE_REJECTED,
      visibleToBuyer: false,
    });

    await refreshRequirementStatus(tx, release.requirementId);
  });
}

// ---------------------------------------------------------------------------
// Binding inspected goods to a container and seal
// ---------------------------------------------------------------------------

export interface BindingInput {
  logisticsShipmentId: string;
  containerNumber?: string | null;
  sealNumber?: string | null;
  stuffedQuantity: number;
  stuffedAt: Date;
  witnessName?: string | null;
}

function normal(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toUpperCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * The named inspector records the loading of goods that passed. The container
 * and seal must be exactly what the consignment's packages say, the quantity
 * what the order says, and stuffing evidence must already be attached. The
 * release is then bound to the goods as loaded; a later change to either
 * number closes the gate again.
 */
export async function recordBinding(
  membership: InspectionMembership,
  jobId: string,
  input: BindingInput,
  correlationId?: string | null,
): Promise<{ bindingId: string; releaseId: string }> {
  assertInspectionPermission(membership, InspectionAgencyPermission.JOB_PERFORM);
  const { loadJobForAgency } = await import('./job.service.js');

  return prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    if (job.inspectorMemberId !== membership.memberId && job.backupInspectorMemberId !== membership.memberId) {
      throw notFound('Inspection');
    }

    const latest = await tx.inspectionReport.findFirst({
      where: { status: 'SIGNED', job: { requirementId: job.requirementId } },
      orderBy: { signedAt: 'desc' },
      select: { id: true, jobId: true, result: true },
    });
    if (latest === null || latest.jobId !== job.id || latest.result !== 'PASS') {
      throw conflict(ErrorCode.INSPECTION_BINDING_MISMATCH, 'Loading can be recorded only against the latest report, and only if it passed.', [
        { code: 'NO_PASSED_REPORT' },
      ]);
    }

    const requirement = await groupOf(tx, job.requirementId);
    const loaded = await tx.inspectionRequirement.findUniqueOrThrow({ where: { id: job.requirementId }, select: { loadReleasedAt: true } });
    if (loaded.loadReleasedAt !== null) {
      throw conflict(ErrorCode.INSPECTION_BINDING_MISMATCH, 'These goods have already left.', [{ code: 'ALREADY_DISPATCHED' }]);
    }

    const shipment = await tx.logisticsShipment.findFirst({
      where: { id: input.logisticsShipmentId, sellerOrderGroupId: requirement.sellerOrderGroupId, status: { not: 'CANCELLED' } },
      select: { id: true, packages: { select: { containerNumber: true, sealNumber: true } } },
    });
    if (shipment === null) throw notFound('Consignment');

    const containers = new Set(shipment.packages.map((pack) => normal(pack.containerNumber)));
    const seals = new Set(shipment.packages.map((pack) => normal(pack.sealNumber)));
    const mismatch: string[] = [];
    if (shipment.packages.length === 0) mismatch.push('NO_PACKAGES');
    if (normal(input.containerNumber) !== null && (containers.size !== 1 || !containers.has(normal(input.containerNumber)))) {
      mismatch.push('CONTAINER_MISMATCH');
    }
    if (normal(input.sealNumber) !== null && (seals.size !== 1 || !seals.has(normal(input.sealNumber)))) {
      mismatch.push('SEAL_MISMATCH');
    }
    if (normal(input.containerNumber) === null && normal(input.sealNumber) === null) mismatch.push('CONTAINER_OR_SEAL_REQUIRED');

    const ordered = await tx.sellerOrderLine.aggregate({
      where: { orderGroupId: requirement.sellerOrderGroupId },
      _sum: { quantity: true },
    });
    if (input.stuffedQuantity !== (ordered._sum.quantity ?? 0)) mismatch.push('QUANTITY_MISMATCH');

    if (mismatch.length > 0) {
      throw conflict(
        ErrorCode.INSPECTION_BINDING_MISMATCH,
        'What was loaded does not match the consignment. Check the container, seal and quantity.',
        mismatch.map((code) => ({ code })),
      );
    }

    const evidence = await tx.inspectionEvidence.findMany({
      where: { jobId: job.id, purpose: 'BINDING', bindingId: null },
      select: { id: true },
    });
    if (evidence.length === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach stuffing or loading evidence first.', [
        { field: 'evidence', code: 'EVIDENCE_REQUIRED' },
      ]);
    }

    const scope = await currentScope(tx, requirement.sellerOrderGroupId);
    const bindingId = newId();
    const releaseId = newId();
    const actor = agencyActor(membership, correlationId);

    await tx.inspectionShipmentBinding.create({
      data: {
        id: bindingId,
        requirementId: job.requirementId,
        jobId: job.id,
        logisticsShipmentId: shipment.id,
        containerNumber: normal(input.containerNumber),
        sealNumber: normal(input.sealNumber),
        stuffedQuantity: input.stuffedQuantity,
        stuffedAt: input.stuffedAt,
        witnessName: input.witnessName?.trim().slice(0, 160) || null,
        recordedByMemberId: membership.memberId,
        scopeHash: scope.hash,
      },
    });
    await tx.inspectionEvidence.updateMany({ where: { id: { in: evidence.map((row) => row.id) } }, data: { bindingId } });

    await supersedeLive(tx, job.requirementId, 'Rebound to the goods as loaded.');
    await tx.inspectionRelease.create({
      data: {
        id: releaseId,
        requirementId: job.requirementId,
        kind: 'PASS',
        state: 'ACTIVE',
        reportId: latest.id,
        bindingId,
        requestedByParty: 'AGENCY',
        requestedById: membership.userId,
        requestedByLabel: actor.label.slice(0, 160),
        requestedAt: new Date(),
        approvedById: membership.userId,
        approvedByLabel: actor.label.slice(0, 160),
        approvedAt: new Date(),
        boundScopeHash: scope.hash,
        boundScopeJson: scope.summary as never,
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: requirement.orderId,
      jobId: job.id,
      kind: 'goods_bound',
      actor,
      summary: `Loading witnessed: ${String(input.stuffedQuantity)} units in container ${normal(input.containerNumber) ?? '-'}, seal ${normal(input.sealNumber) ?? '-'}.`,
      data: { bindingId, releaseId, containerNumber: normal(input.containerNumber), sealNumber: normal(input.sealNumber), witness: input.witnessName ?? null },
      audit: AuditAction.INSPECTION_RELEASE_RECORDED,
    });

    await refreshRequirementStatus(tx, job.requirementId);
    await notifyDispatchAuthorised(tx, job.requirementId, releaseId);

    return { bindingId, releaseId };
  });
}

export { peekGate };
