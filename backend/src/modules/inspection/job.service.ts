/**
 * Inspection jobs: booking, the agency's work, the report and its sign-off.
 *
 * The order of events a job walks, and the rule each step enforces:
 *
 *   1. BOOKED by the seller, the buyer or the operator. The scope is generated
 *      from the order - products, quantities, specifications, packaging,
 *      labelling, destination - and the category's plan is copied onto the job
 *      with the sampling it implies (FLOW-004, INSPECT-002).
 *   2. ACCEPTED by an independent agency, with its own conflict statement, or
 *      DECLINED with a reason (JOURNEY-036).
 *   3. An INSPECTOR is assigned: verified identity, current credentials,
 *      category competence, no personal conflict (JOURNEY-037).
 *   4. The seller presents the lot - readiness (JOURNEY-032, UAT-UI-008).
 *   5. The inspector declares no conflict and STARTS; records checks,
 *      sampling, defects and evidence against the plan (JOURNEY-038..041).
 *   6. The inspector SUBMITS; the agency's QA reviewer - never the same person
 *      - returns it or SIGNS it. Signing computes PASS or FAIL, hashes and
 *      signs the report, locks it, and records the release decision
 *      (JOURNEY-042, SCREEN-053, SCREEN-055).
 *
 * Every read and write for an agency is filtered by the agency id from the
 * session, and an inspector by the jobs they are named on (DOD-018).
 */
import { createHash, createHmac } from 'node:crypto';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { buildSamplingPlan, type SamplingPlan } from '../../domain/inspection-aql.js';
import { InspectionAgencyPermission } from '../../domain/inspection-permissions.js';
import {
  OPEN_JOB_STATUSES,
  assertInspectionJobTransition,
  computeInspectionResult,
  type ChecklistItem,
  type InspectionJobActor,
  type InspectionJobStatusName,
} from '../../domain/inspection-state.js';
import { readOrderItemSnapshot } from '../../domain/order-item-snapshot.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from '../seller/notification.service.js';
import {
  agencyActor,
  agencyEligibility,
  assertEligible,
  assertInspectorQualified,
  assertInspectionPermission,
  assertNoPersonalConflict,
  type InspectionMembership,
} from './agency.service.js';
import {
  AuditAction,
  nextJobNumber,
  ncrNumberFor,
  readPolicy,
  recordInspectionEvent,
  type InspectionActor,
} from './context.js';
import { storeEvidence, type EvidenceInput, type StoredEvidence } from './evidence.service.js';
import { currentScope, orderFactsFor, refreshRequirementStatus } from './gate.service.js';
import { choosePlan, type PlanSnapshot } from './policy.service.js';
import { afterReportSigned } from './release.service.js';
import { requestInspectionAsBuyer } from './requirement.service.js';

type Tx = PrismaTransaction;

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface InspectionPointInput {
  label: string;
  addressLine: string;
  city: string;
  country: string;
  portCode?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}

export interface BookingInput {
  sellerOrderGroupId: string;
  agencyId?: string | null;
  scheduledFor: Date;
  inspectionPointType: 'SELLER_PREMISES' | 'WAREHOUSE' | 'PORT' | 'OTHER';
  inspectionPoint: InspectionPointInput;
  payer: 'BUYER' | 'SELLER' | 'PLATFORM';
  language?: string | null;
  poReference?: string | null;
  referenceSample?: string | null;
  specialRequirements?: string | null;
  /** Set for a repeat inspection after corrective action. */
  reinspectionOfJobId?: string | null;
}

const BOOKABLE_GROUP_STATUSES = ['NEW', 'ACCEPTED', 'PROCESSING'];

/**
 * What the inspector is asked to check, generated from the order itself.
 * Written once; the order changing later is caught by the gate's fingerprint.
 */
async function buildScope(tx: Tx, sellerOrderGroupId: string, input: BookingInput) {
  const group = await tx.sellerOrderGroup.findUniqueOrThrow({
    where: { id: sellerOrderGroupId },
    select: {
      sellerOrderNumber: true,
      goodsTotalMinor: true,
      currency: true,
      lines: { select: { orderItemId: true, quantity: true } },
      order: { select: { orderNumber: true, shippingAddressJson: true } },
    },
  });

  const items = await tx.orderItem.findMany({
    where: { id: { in: group.lines.map((line) => line.orderItemId) } },
    select: {
      id: true,
      nameSnapshot: true,
      skuSnapshot: true,
      variantNameSnapshot: true,
      orderingUnit: true,
      unitQuantity: true,
      productInfoSnapshotJson: true,
    },
  });
  const byId = new Map(items.map((item) => [item.id, item]));

  const address = (group.order.shippingAddressJson ?? {}) as Record<string, unknown>;
  const destinationCountry = typeof address['country'] === 'string'
    ? address['country']
    : typeof address['countryCode'] === 'string'
      ? address['countryCode']
      : null;

  return {
    orderNumber: group.order.orderNumber,
    sellerOrderNumber: group.sellerOrderNumber,
    poReference: input.poReference?.trim() || group.order.orderNumber,
    referenceSample: input.referenceSample?.trim() || null,
    goodsValueMinor: group.goodsTotalMinor.toString(),
    currency: group.currency,
    lines: group.lines.map((line) => {
      const item = byId.get(line.orderItemId);
      const snapshot = readOrderItemSnapshot(item?.productInfoSnapshotJson ?? null);
      return {
        orderItemId: line.orderItemId,
        name: item?.nameSnapshot ?? 'Item',
        sku: item?.skuSnapshot ?? '',
        variant: item?.variantNameSnapshot ?? null,
        quantity: line.quantity,
        orderingUnit: item?.orderingUnit ?? 'PIECE',
        unitQuantity: item?.unitQuantity ?? line.quantity,
        specifications:
          snapshot?.specificationGroups.flatMap((group) =>
            group.rows.map((row) => ({ label: row.label, value: row.value, unit: row.unit })),
          ) ?? [],
        packaging: snapshot?.packaging ?? null,
        specialInstructions: snapshot?.specialInstructions ?? null,
      };
    }),
    destination: {
      country: destinationCountry,
      city: typeof address['city'] === 'string' ? address['city'] : null,
      requirements: [
        destinationCountry === null
          ? 'Destination labels as ordered.'
          : `Labels, marks and documents suitable for delivery to ${destinationCountry}.`,
      ],
    },
    specialRequirements: input.specialRequirements?.trim() || null,
  };
}

export async function bookInspection(
  actor: InspectionActor,
  input: BookingInput,
): Promise<{ jobId: string; jobNumber: string }> {
  const policy = await readPolicy();

  const result = await prisma.$transaction(async (tx) => {
    const requirement = await tx.inspectionRequirement.findUnique({
      where: { sellerOrderGroupId: input.sellerOrderGroupId },
      select: {
        id: true,
        orderId: true,
        sellerAccountId: true,
        level: true,
        planId: true,
        preferredAgencyId: true,
        loadReleasedAt: true,
        sellerOrderGroup: { select: { status: true } },
      },
    });

    if (requirement === null || requirement.level === 'NOT_REQUIRED') {
      throw conflict(
        ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED,
        'No inspection is required for this order. The buyer can ask for one first.',
        [{ code: 'NOT_REQUIRED' }],
      );
    }

    if (!BOOKABLE_GROUP_STATUSES.includes(requirement.sellerOrderGroup.status) || requirement.loadReleasedAt !== null) {
      throw conflict(ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED, 'This order is past the point an inspection can be booked.', [
        { code: 'PAST_DISPATCH', meta: { status: requirement.sellerOrderGroup.status } },
      ]);
    }

    const open = await tx.inspectionJob.findFirst({
      where: { requirementId: requirement.id, status: { in: [...OPEN_JOB_STATUSES] } },
      select: { jobNumber: true },
    });
    if (open !== null) {
      throw conflict(ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED, `Inspection ${open.jobNumber} is already booked for this order.`, [
        { code: 'ALREADY_BOOKED', meta: { jobNumber: open.jobNumber } },
      ]);
    }

    // A re-inspection is only for goods that failed or hold findings, and
    // only once the seller has said what they corrected on each one.
    let kind: 'INITIAL' | 'REINSPECTION' = 'INITIAL';
    if ((input.reinspectionOfJobId ?? null) !== null) {
      const original = await tx.inspectionJob.findFirst({
        where: { id: input.reinspectionOfJobId ?? '', requirementId: requirement.id, status: 'COMPLETED' },
        select: { id: true },
      });
      if (original === null) throw notFound('Original inspection');

      const uncorrected = await tx.inspectionDefect.findMany({
        where: { requirementId: requirement.id, status: 'OPEN', job: { status: 'COMPLETED' } },
        select: { ncrNumber: true },
      });
      if (uncorrected.length > 0) {
        throw conflict(
          ErrorCode.INSPECTION_CAPA_REQUIRED,
          'Record the corrective action on every open non-conformance before booking a re-inspection.',
          uncorrected.map((defect) => ({ code: 'CAPA_MISSING', meta: { ncrNumber: defect.ncrNumber } })),
        );
      }
      kind = 'REINSPECTION';
    }

    const agencyId = input.agencyId ?? requirement.preferredAgencyId;
    if (agencyId === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose an inspection agency.', [{ field: 'agencyId', code: 'REQUIRED' }]);
    }

    const facts = await orderFactsFor(tx, input.sellerOrderGroupId);
    const country = input.inspectionPoint.country.trim().toUpperCase();

    assertEligible(
      await agencyEligibility(tx, {
        agencyId,
        sellerAccountId: requirement.sellerAccountId,
        orderId: requirement.orderId,
        categoryIds: facts.categoryIds,
        country,
        scheduledFor: input.scheduledFor,
      }),
    );

    const plan = await choosePlan(tx, { planId: requirement.planId, categoryIds: facts.categoryIds, now: new Date() });
    const scope = await buildScope(tx, input.sellerOrderGroupId, input);
    const lotSize = Math.max(1, scope.lines.reduce((sum, line) => sum + line.quantity, 0));
    const sampling = buildSamplingPlan({
      lotSize,
      level: plan.inspectionLevel,
      aqlCritical: plan.aqlCritical,
      aqlMajor: plan.aqlMajor,
      aqlMinor: plan.aqlMinor,
    });

    const id = newId();
    const jobNumber = await nextJobNumber(tx);
    const now = new Date();

    await tx.inspectionJob.create({
      data: {
        id,
        jobNumber,
        requirementId: requirement.id,
        agencyId,
        kind,
        reinspectionOfJobId: input.reinspectionOfJobId ?? null,
        status: 'REQUESTED',
        bookedByParty: actor.party,
        bookedById: actor.userId,
        bookedByLabel: actor.label.slice(0, 160),
        payer: input.payer,
        inspectionPointType: input.inspectionPointType,
        inspectionPointJson: { ...input.inspectionPoint, country },
        scheduledFor: input.scheduledFor,
        language: (input.language ?? plan.language).slice(0, 8),
        standard: `${plan.name} v${String(plan.version)} - ISO 2859-1 level ${plan.inspectionLevel}, AQL ${plan.aqlCritical}/${plan.aqlMajor}/${plan.aqlMinor}`.slice(0, 160),
        scopeJson: scope,
        planSnapshotJson: plan as never,
        lotSize,
        samplingJson: sampling as never,
        poReference: scope.poReference.slice(0, 64),
        referenceSample: scope.referenceSample,
        specialRequirements: scope.specialRequirements,
        acceptDueAt: new Date(now.getTime() + policy.agencyAcceptSlaHours * 3_600_000),
        reportDueAt: new Date(input.scheduledFor.getTime() + policy.reportSlaHours * 3_600_000),
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: requirement.id,
      orderId: requirement.orderId,
      jobId: id,
      kind: kind === 'REINSPECTION' ? 'reinspection_booked' : 'booked',
      actor,
      summary: `${kind === 'REINSPECTION' ? 'Re-inspection' : 'Inspection'} ${jobNumber} booked for ${input.scheduledFor.toISOString().slice(0, 10)} at ${input.inspectionPoint.label}.`,
      data: {
        jobNumber,
        agencyId,
        payer: input.payer,
        reinspectionOfJobId: input.reinspectionOfJobId ?? null,
        sampleSize: sampling.sampleSize,
        plan: `${plan.name} v${String(plan.version)}`,
      },
      audit: AuditAction.INSPECTION_BOOKED,
    });

    await refreshRequirementStatus(tx, requirement.id);

    if (actor.party !== 'SELLER') {
      await notifySeller({
        sellerAccountId: requirement.sellerAccountId,
        kind: 'INSPECTION_UPDATE',
        title: `Inspection ${jobNumber} was booked`,
        body: `An inspection is booked for ${input.scheduledFor.toISOString().slice(0, 10)}. Present the lot as ready before then.`,
        linkPath: `/seller/orders/${input.sellerOrderGroupId}`,
        subjectType: 'inspection_job',
        subjectId: id,
        tx,
      });
    }

    return { jobId: id, jobNumber };
  });

  return result;
}

/** The order part a buyer is acting on, checked to be theirs. */
async function buyerGroupFacts(customerProfileId: string, orderId: string, sellerOrderGroupId: string) {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: sellerOrderGroupId, orderId, order: { customerProfileId } },
    select: { id: true, sellerAccountId: true },
  });
  if (group === null) throw notFound('Order');
  return group;
}

/**
 * SCREEN-094: the agencies a buyer may choose for one part of their order,
 * on one day and in one country. An agency that is not independent of the
 * seller is left out entirely rather than shown with its reason, so the
 * buyer is never told who a seller is affiliated with.
 */
export async function buyerAgencyChoices(
  customerProfileId: string,
  input: { orderId: string; sellerOrderGroupId: string; country: string | null; scheduledFor: Date },
): Promise<Array<{ id: string; name: string; eligible: boolean; problems: string[] }>> {
  const group = await buyerGroupFacts(customerProfileId, input.orderId, input.sellerOrderGroupId);
  const facts = await orderFactsFor(prisma, group.id);
  const agencies = await prisma.inspectionAgency.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { name: 'asc' },
    take: 100,
    select: { id: true, name: true },
  });

  const country = input.country === null ? null : input.country.trim().toUpperCase();
  const rows = await Promise.all(
    agencies.map(async (agency) => {
      const problems = await agencyEligibility(prisma, {
        agencyId: agency.id,
        sellerAccountId: group.sellerAccountId,
        orderId: input.orderId,
        categoryIds: facts.categoryIds,
        country,
        scheduledFor: input.scheduledFor,
      });
      return { ...agency, problems: problems.map((problem) => problem.code) };
    }),
  );

  return rows
    .filter((row) => !row.problems.includes('AFFILIATED_WITH_SELLER') && !row.problems.includes('MEMBER_IS_SELLER'))
    .map((row) => ({ ...row, eligible: row.problems.length === 0 }));
}

/**
 * SCREEN-094: the buyer books the inspection themselves - scope comes from
 * the order, they choose agency, date, place and payer. Every rule of an
 * operator booking still applies (eligibility, one open job, before
 * dispatch). Extra buyer rules: the marketplace must take buyer requests, a
 * buyer cannot book a re-inspection or put it on the platform's bill, and an
 * inspection no rule requires - one the buyer asked for - is paid by the buyer.
 */
export async function bookInspectionAsBuyer(
  actor: InspectionActor & { customerProfileId: string },
  input: Omit<BookingInput, 'reinspectionOfJobId' | 'payer'> & { orderId: string; payer: 'BUYER' | 'SELLER' },
): Promise<{ jobId: string; jobNumber: string }> {
  const policy = await readPolicy();
  if (!policy.buyerMayRequest) {
    throw conflict(ErrorCode.INSPECTION_BOOKING_NOT_ALLOWED, 'This marketplace does not take inspection requests from buyers.', [
      { code: 'BUYER_REQUESTS_OFF' },
    ]);
  }

  await buyerGroupFacts(actor.customerProfileId, input.orderId, input.sellerOrderGroupId);

  // No rule asks for an inspection yet: record the buyer's request first,
  // which is what makes this order part inspectable at all.
  const before = await prisma.inspectionRequirement.findUnique({
    where: { sellerOrderGroupId: input.sellerOrderGroupId },
    select: { level: true },
  });
  if (before === null || before.level === 'NOT_REQUIRED') {
    await requestInspectionAsBuyer(actor, { orderId: input.orderId, sellerOrderGroupId: input.sellerOrderGroupId, note: null });
  }

  const requirement = await prisma.inspectionRequirement.findUnique({
    where: { sellerOrderGroupId: input.sellerOrderGroupId },
    select: { level: true },
  });
  if (requirement?.level === 'BUYER_REQUESTED' && input.payer !== 'BUYER') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'An inspection you asked for is paid by you.', [
      { field: 'payer', code: 'BUYER_PAYS_OWN_REQUEST' },
    ]);
  }

  return bookInspection(actor, {
    sellerOrderGroupId: input.sellerOrderGroupId,
    agencyId: input.agencyId ?? null,
    scheduledFor: input.scheduledFor,
    inspectionPointType: input.inspectionPointType,
    inspectionPoint: input.inspectionPoint,
    payer: input.payer,
    language: input.language ?? null,
    poReference: input.poReference ?? null,
    referenceSample: input.referenceSample ?? null,
    specialRequirements: input.specialRequirements ?? null,
    reinspectionOfJobId: null,
  });
}

/** An operator or the booker calls a job off, with a reason. */
export async function cancelJob(actor: InspectionActor, jobId: string, reason: string, as: InspectionJobActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJob(tx, jobId);
    if (as === 'BOOKER' && job.bookedById !== actor.userId) throw notFound('Inspection');
    await moveJob(tx, job, 'CANCELLED', as, actor, reason, { cancelledAt: new Date(), cancelReason: reason.trim() });
  });
}

// ---------------------------------------------------------------------------
// Loading a job, for whom
// ---------------------------------------------------------------------------

async function loadJob(tx: Tx | typeof prisma, jobId: string) {
  const job = await tx.inspectionJob.findUnique({
    where: { id: jobId },
    include: { requirement: { select: { id: true, orderId: true, sellerAccountId: true, sellerOrderGroupId: true } } },
  });
  if (job === null) throw notFound('Inspection');
  return job;
}

type LoadedJob = Awaited<ReturnType<typeof loadJob>>;

/**
 * A job as the agency may see it: its own, and for an inspector only one they
 * are named on. Anything else is "not found" - not "forbidden", which would
 * confirm the job exists (DOD-018).
 */
export async function loadJobForAgency(
  tx: Tx | typeof prisma,
  membership: InspectionMembership,
  jobId: string,
): Promise<LoadedJob> {
  const job = await tx.inspectionJob.findFirst({
    where: {
      id: jobId,
      agencyId: membership.agencyId,
      ...(membership.assignmentScoped
        ? { OR: [{ inspectorMemberId: membership.memberId }, { backupInspectorMemberId: membership.memberId }] }
        : {}),
    },
    include: { requirement: { select: { id: true, orderId: true, sellerAccountId: true, sellerOrderGroupId: true } } },
  });
  if (job === null) throw notFound('Inspection');

  // A person who is part of the seller, or the buyer, cannot act on it even
  // inside an agency that can.
  await assertNoPersonalConflict(tx, membership.userId, {
    sellerAccountId: job.requirement.sellerAccountId,
    orderId: job.requirement.orderId,
  });

  return job;
}

async function moveJob(
  tx: Tx,
  job: LoadedJob,
  to: InspectionJobStatusName,
  as: InspectionJobActor,
  actor: InspectionActor,
  reason: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  assertInspectionJobTransition({ from: job.status, to, actor: as, reason });

  const moved = await tx.inspectionJob.updateMany({
    where: { id: job.id, version: job.version, status: job.status },
    data: { status: to, version: { increment: 1 }, ...data },
  });
  if (moved.count !== 1) {
    throw conflict(ErrorCode.CONFLICT, 'This inspection was changed by somebody else a moment ago. Reload and try again.', [
      { code: 'VERSION_CONFLICT' },
    ]);
  }

  await recordInspectionEvent(tx, {
    requirementId: job.requirementId,
    orderId: job.requirement.orderId,
    jobId: job.id,
    kind: `job_${to.toLowerCase()}`,
    actor,
    summary: `${job.jobNumber}: ${JOB_WORDS[to]}${reason === null || reason.trim() === '' ? '' : ` - ${reason.trim()}`}`,
    data: { from: job.status, to },
    audit: AuditAction.INSPECTION_JOB_STATUS_CHANGED,
  });

  await refreshRequirementStatus(tx, job.requirementId);
}

const JOB_WORDS: Record<InspectionJobStatusName, string> = {
  REQUESTED: 'booked',
  ACCEPTED: 'accepted by the agency',
  DECLINED: 'declined by the agency',
  INSPECTOR_ASSIGNED: 'inspector assigned',
  IN_PROGRESS: 'inspection started',
  REPORT_SUBMITTED: 'report submitted for QA review',
  COMPLETED: 'report signed',
  CANCELLED: 'cancelled',
};

// ---------------------------------------------------------------------------
// The agency answers
// ---------------------------------------------------------------------------

export async function acceptJob(
  membership: InspectionMembership,
  jobId: string,
  input: { conflictStatement: string; confirmNoConflict: boolean },
  correlationId?: string | null,
): Promise<void> {
  assertInspectionPermission(membership, InspectionAgencyPermission.JOB_ACCEPT);

  if (!input.confirmNoConflict || input.conflictStatement.trim().length < 10) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Confirm the agency has no conflict of interest with this seller or buyer, in a sentence.',
      [{ field: 'conflictStatement', code: 'REQUIRED' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    const facts = await orderFactsFor(tx, job.requirement.sellerOrderGroupId);
    const point = job.inspectionPointJson as { country?: string };

    // Re-checked at acceptance: an affiliation declared since booking counts.
    const problems = (
      await agencyEligibility(tx, {
        agencyId: membership.agencyId,
        sellerAccountId: job.requirement.sellerAccountId,
        orderId: job.requirement.orderId,
        categoryIds: facts.categoryIds,
        country: point.country ?? null,
        scheduledFor: job.scheduledFor,
        excludeJobId: job.id,
      })
    ).filter((problem) => problem.code !== 'CAPACITY_FULL');
    assertEligible(problems);

    await moveJob(tx, job, 'ACCEPTED', 'AGENCY_COORDINATOR', agencyActor(membership, correlationId), null, {
      acceptedAt: new Date(),
      acceptedById: membership.userId,
      agencyConflictStatement: input.conflictStatement.trim(),
    });
  });
}

export async function declineJob(
  membership: InspectionMembership,
  jobId: string,
  reason: string,
  correlationId?: string | null,
): Promise<void> {
  assertInspectionPermission(membership, InspectionAgencyPermission.JOB_ACCEPT);
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    await moveJob(tx, job, 'DECLINED', 'AGENCY_COORDINATOR', agencyActor(membership, correlationId), reason, {
      declinedAt: new Date(),
      declineReason: reason.trim().slice(0, 1024),
    });
  });
}

export async function assignInspector(
  membership: InspectionMembership,
  jobId: string,
  input: { inspectorMemberId: string; backupInspectorMemberId?: string | null },
  correlationId?: string | null,
): Promise<void> {
  assertInspectionPermission(membership, InspectionAgencyPermission.JOB_ASSIGN);

  if (input.backupInspectorMemberId !== undefined && input.backupInspectorMemberId === input.inspectorMemberId) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The backup inspector must be a different person.', [
      { field: 'backupInspectorMemberId', code: 'SAME_PERSON' },
    ]);
  }

  const policy = await readPolicy();

  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    if (job.status !== 'ACCEPTED' && job.status !== 'INSPECTOR_ASSIGNED') {
      throw conflict(ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED, 'An inspector can be assigned only before the inspection starts.', [
        { code: 'TRANSITION_UNDEFINED', meta: { from: job.status, to: 'INSPECTOR_ASSIGNED' } },
      ]);
    }

    const facts = await orderFactsFor(tx, job.requirement.sellerOrderGroupId);
    const check = {
      agencyId: membership.agencyId,
      categoryIds: facts.categoryIds,
      scheduledFor: job.scheduledFor,
      sellerAccountId: job.requirement.sellerAccountId,
      orderId: job.requirement.orderId,
      requireCompetence: policy.requireInspectorCompetence,
    };

    const inspector = await assertInspectorQualified(tx, { ...check, memberId: input.inspectorMemberId });
    const backup =
      (input.backupInspectorMemberId ?? null) === null
        ? null
        : await assertInspectorQualified(tx, { ...check, memberId: input.backupInspectorMemberId ?? '' });

    const data = {
      inspectorMemberId: input.inspectorMemberId,
      backupInspectorMemberId: input.backupInspectorMemberId ?? null,
      assignedAt: new Date(),
    };
    const actor = agencyActor(membership, correlationId);

    if (job.status === 'ACCEPTED') {
      await moveJob(tx, job, 'INSPECTOR_ASSIGNED', 'AGENCY_COORDINATOR', actor, null, data);
    } else {
      // A reassignment. The earlier inspector's declaration no longer counts
      // for the new one, who must make their own.
      await tx.inspectionJob.update({ where: { id: job.id }, data: { ...data, version: { increment: 1 } } });
    }

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'inspector_assigned',
      actor,
      summary: `${inspector.fullName} will inspect${backup === null ? '' : `, with ${backup.fullName} as backup`}.`,
      data: { inspectorMemberId: input.inspectorMemberId, backupInspectorMemberId: input.backupInspectorMemberId ?? null },
      visibleToBuyer: false,
    });
  });
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

function assertIsNamedInspector(membership: InspectionMembership, job: LoadedJob): void {
  assertInspectionPermission(membership, InspectionAgencyPermission.JOB_PERFORM);
  if (job.inspectorMemberId !== membership.memberId && job.backupInspectorMemberId !== membership.memberId) {
    throw notFound('Inspection');
  }
}

function assertInProgress(job: LoadedJob): void {
  if (job.status !== 'IN_PROGRESS') {
    throw conflict(
      job.status === 'COMPLETED' ? ErrorCode.INSPECTION_REPORT_LOCKED : ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED,
      job.status === 'COMPLETED'
        ? 'This inspection is signed. Its findings can no longer change.'
        : 'Findings can be recorded only while the inspection is in progress.',
      [{ code: 'NOT_IN_PROGRESS', meta: { status: job.status } }],
    );
  }
}

/** The inspector's own declaration, before they start (FLOW-003). */
export async function declareConflict(
  membership: InspectionMembership,
  jobId: string,
  input: { hasConflict: boolean; details?: string | null },
  correlationId?: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);

    if (input.hasConflict && (input.details ?? '').trim().length === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Describe the conflict so the agency can reassign the job.', [
        { field: 'details', code: 'REQUIRED' },
      ]);
    }

    await tx.inspectionConflictDeclaration.upsert({
      where: { jobId_memberId: { jobId: job.id, memberId: membership.memberId } },
      create: {
        id: newId(),
        jobId: job.id,
        memberId: membership.memberId,
        hasConflict: input.hasConflict,
        details: input.details?.trim() || null,
      },
      update: { hasConflict: input.hasConflict, details: input.details?.trim() || null, declaredAt: new Date() },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'conflict_declared',
      actor: agencyActor(membership, correlationId),
      summary: input.hasConflict
        ? `${membership.fullName} declared a conflict of interest and cannot inspect this lot.`
        : `${membership.fullName} declared no conflict of interest.`,
      data: { hasConflict: input.hasConflict },
      visibleToBuyer: false,
    });
  });
}

export async function startJob(membership: InspectionMembership, jobId: string, correlationId?: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);

    const declaration = await tx.inspectionConflictDeclaration.findUnique({
      where: { jobId_memberId: { jobId: job.id, memberId: membership.memberId } },
      select: { hasConflict: true },
    });
    if (declaration === null) {
      throw conflict(ErrorCode.INSPECTION_CONFLICT_OF_INTEREST, 'Declare whether you have a conflict of interest before you start.', [
        { code: 'DECLARATION_REQUIRED' },
      ]);
    }
    if (declaration.hasConflict) {
      throw conflict(ErrorCode.INSPECTION_CONFLICT_OF_INTEREST, 'You declared a conflict of interest. Another inspector must do this job.', [
        { code: 'DECLARED_CONFLICT' },
      ]);
    }
    if (job.readinessSubmittedAt === null) {
      throw conflict(ErrorCode.INSPECTION_READINESS_INCOMPLETE, 'The seller has not presented the lot as ready yet.', [
        { code: 'READINESS_NOT_SUBMITTED' },
      ]);
    }

    await moveJob(tx, job, 'IN_PROGRESS', 'INSPECTOR', agencyActor(membership, correlationId), null, {
      startedAt: job.startedAt ?? new Date(),
    });
  });
}

function checklistOf(job: LoadedJob): ChecklistItem[] {
  return ((job.planSnapshotJson as unknown as PlanSnapshot).checklist ?? []);
}

export async function recordCheck(
  membership: InspectionMembership,
  jobId: string,
  input: { itemCode: string; outcome: 'CONFORM' | 'NONCONFORM' | 'NOT_APPLICABLE'; measuredValue?: string | null; note?: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);

    // Only the plan's own lines. An inspector cannot add a check the plan
    // does not have, or answer one it does not ask (INSPECT-002).
    const item = checklistOf(job).find((line) => line.code.toUpperCase() === input.itemCode.toUpperCase());
    if (item === undefined) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That check is not on this inspection’s plan.', [
        { field: 'itemCode', code: 'NOT_IN_PLAN' },
      ]);
    }
    if (input.outcome === 'NONCONFORM' && (input.note ?? '').trim().length === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say what did not conform.', [{ field: 'note', code: 'REQUIRED' }]);
    }

    await tx.inspectionCheckResult.upsert({
      where: { jobId_itemCode: { jobId: job.id, itemCode: item.code } },
      create: {
        id: newId(),
        jobId: job.id,
        itemCode: item.code,
        section: item.section,
        label: item.label.slice(0, 255),
        requirement: item.requirement ?? item.tolerance ?? null,
        outcome: input.outcome,
        measuredValue: input.measuredValue?.trim().slice(0, 128) || null,
        note: input.note?.trim().slice(0, 1024) || null,
        recordedByMemberId: membership.memberId,
      },
      update: {
        outcome: input.outcome,
        measuredValue: input.measuredValue?.trim().slice(0, 128) || null,
        note: input.note?.trim().slice(0, 1024) || null,
        recordedByMemberId: membership.memberId,
        recordedAt: new Date(),
      },
    });
  });
}

export async function recordSampling(
  membership: InspectionMembership,
  jobId: string,
  input: { lotReference: string; sampledQuantity: number; acceptedQuantity: number; rejectedQuantity: number; cartonsOpened?: number | null },
): Promise<void> {
  if (input.acceptedQuantity + input.rejectedQuantity !== input.sampledQuantity) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Accepted and rejected units must add up to the units sampled.', [
      { field: 'rejectedQuantity', code: 'DOES_NOT_ADD_UP' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);

    if (input.sampledQuantity > job.lotSize) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'More units sampled than the lot holds.', [
        { field: 'sampledQuantity', code: 'ABOVE_LOT', meta: { lotSize: job.lotSize } },
      ]);
    }

    await tx.inspectionJob.update({
      where: { id: job.id },
      data: {
        lotReference: input.lotReference.trim().slice(0, 64),
        sampledQuantity: input.sampledQuantity,
        acceptedQuantity: input.acceptedQuantity,
        rejectedQuantity: input.rejectedQuantity,
        cartonsOpened: input.cartonsOpened ?? null,
        version: { increment: 1 },
      },
    });
  });
}

export async function recordDefect(
  membership: InspectionMembership,
  jobId: string,
  input: { severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; requirementRef: string; description: string; defectQuantity: number },
  correlationId?: string | null,
): Promise<{ defectId: string; ncrNumber: string }> {
  return prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);

    const index = (await tx.inspectionDefect.count({ where: { jobId: job.id } })) + 1;
    const id = newId();
    const ncrNumber = ncrNumberFor(job.jobNumber, index);

    await tx.inspectionDefect.create({
      data: {
        id,
        jobId: job.id,
        requirementId: job.requirementId,
        ncrNumber,
        severity: input.severity,
        originalSeverity: input.severity,
        requirementRef: input.requirementRef.trim().slice(0, 128),
        description: input.description.trim(),
        defectQuantity: Math.max(1, input.defectQuantity),
        recordedByMemberId: membership.memberId,
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'defect_recorded',
      actor: agencyActor(membership, correlationId),
      summary: `${ncrNumber}: ${input.severity.toLowerCase()} defect recorded against ${input.requirementRef.trim()}.`,
      data: { ncrNumber, severity: input.severity },
      visibleToBuyer: false,
      visibleToSeller: false,
    });

    return { defectId: id, ncrNumber };
  });
}

/**
 * The agency attaches evidence to its own job. The inspector while the
 * inspection is in progress; QA while reviewing (for a reclassification); the
 * named inspector after sign-off only for a loading/binding record.
 */
export async function uploadAgencyEvidence(
  membership: InspectionMembership,
  jobId: string,
  input: Omit<EvidenceInput, 'requirementId' | 'jobId'>,
  correlationId?: string | null,
): Promise<StoredEvidence> {
  const job = await loadJobForAgency(prisma, membership, jobId);

  if (input.purpose === 'RECLASSIFICATION') {
    assertInspectionPermission(membership, InspectionAgencyPermission.REPORT_SIGN);
    if (job.status !== 'REPORT_SUBMITTED') assertInProgress(job);
  } else if (input.purpose === 'BINDING') {
    assertIsNamedInspector(membership, job);
    if (job.status !== 'COMPLETED') {
      throw conflict(ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED, 'Loading evidence is recorded after the report is signed.', [
        { code: 'NOT_COMPLETED' },
      ]);
    }
  } else if (input.purpose === 'CAPA' || input.purpose === 'RELEASE') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The agency does not attach that kind of evidence.', [
      { field: 'purpose', code: 'NOT_ALLOWED' },
    ]);
  } else {
    assertIsNamedInspector(membership, job);
    assertInProgress(job);
  }

  if ((input.defectId ?? null) !== null) {
    const defect = await prisma.inspectionDefect.findFirst({ where: { id: input.defectId ?? '', jobId: job.id }, select: { id: true } });
    if (defect === null) throw notFound('Defect');
  }

  if (input.checkItemCode !== null && input.checkItemCode !== undefined && !checklistOf(job).some((item) => item.code === input.checkItemCode)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That check is not on this inspection’s plan.', [
      { field: 'checkItemCode', code: 'NOT_IN_PLAN' },
    ]);
  }

  const stored = await storeEvidence(agencyActor(membership, correlationId), {
    ...input,
    requirementId: job.requirementId,
    jobId: job.id,
  });

  if (!stored.duplicate) {
    await prisma.$transaction(async (tx) => {
      await recordInspectionEvent(tx, {
        requirementId: job.requirementId,
        orderId: job.requirement.orderId,
        jobId: job.id,
        kind: 'evidence_added',
        actor: agencyActor(membership, correlationId),
        summary: `${stored.mediaKind.toLowerCase()} evidence added (${input.purpose.toLowerCase()}), SHA-256 ${stored.contentHash.slice(0, 12)}.`,
        data: { evidenceId: stored.id, purpose: input.purpose, contentHash: stored.contentHash },
        visibleToBuyer: false,
        visibleToSeller: false,
      });
    });
  }

  return stored;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

interface ReportFacts {
  job: LoadedJob;
  checks: Awaited<ReturnType<typeof prisma.inspectionCheckResult.findMany>>;
  defects: Awaited<ReturnType<typeof prisma.inspectionDefect.findMany>>;
  evidence: { id: string; purpose: string; contentHash: string; defectId: string | null; capturedAt: Date }[];
}

async function reportFacts(tx: Tx, job: LoadedJob): Promise<ReportFacts> {
  const [checks, defects, evidence] = await Promise.all([
    tx.inspectionCheckResult.findMany({ where: { jobId: job.id }, orderBy: { itemCode: 'asc' } }),
    tx.inspectionDefect.findMany({ where: { jobId: job.id }, orderBy: { ncrNumber: 'asc' } }),
    tx.inspectionEvidence.findMany({
      where: { jobId: job.id },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, purpose: true, contentHash: true, defectId: true, capturedAt: true },
    }),
  ]);
  return { job, checks, defects, evidence };
}

/** What is still missing before a report can be submitted or signed. */
function completenessProblems(facts: ReportFacts): { code: string; meta?: Record<string, string | number | boolean | null> }[] {
  const problems: { code: string; meta?: Record<string, string | number | boolean | null> }[] = [];
  const sampling = facts.job.samplingJson as unknown as SamplingPlan;
  const answered = new Set(facts.checks.map((check) => check.itemCode.toUpperCase()));

  for (const item of checklistOf(facts.job)) {
    if (!answered.has(item.code.toUpperCase())) problems.push({ code: 'CHECK_UNANSWERED', meta: { itemCode: item.code } });
  }

  if (facts.job.sampledQuantity === null || facts.job.lotReference === null) {
    problems.push({ code: 'SAMPLING_NOT_RECORDED' });
  } else if (facts.job.sampledQuantity < Math.min(sampling.sampleSize, facts.job.lotSize)) {
    problems.push({
      code: 'SAMPLE_TOO_SMALL',
      meta: { required: Math.min(sampling.sampleSize, facts.job.lotSize), sampled: facts.job.sampledQuantity },
    });
  }

  if (facts.evidence.length === 0) problems.push({ code: 'EVIDENCE_MISSING' });

  for (const defect of facts.defects) {
    if (!facts.evidence.some((item) => item.defectId === defect.id)) {
      problems.push({ code: 'DEFECT_EVIDENCE_MISSING', meta: { ncrNumber: defect.ncrNumber } });
    }
  }

  return problems;
}

function computationFor(facts: ReportFacts) {
  const sampling = facts.job.samplingJson as unknown as SamplingPlan;
  return computeInspectionResult({
    sampling,
    defects: facts.defects.map((defect) => ({ severity: defect.severity, defectQuantity: defect.defectQuantity })),
    nonconformingChecks: facts.checks.filter((check) => check.outcome === 'NONCONFORM').length,
  });
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry)),
  );
}

async function reportContent(tx: Tx, facts: ReportFacts, summary: string | null) {
  const [agency, inspector] = await Promise.all([
    tx.inspectionAgency.findUniqueOrThrow({ where: { id: facts.job.agencyId }, select: { name: true, legalName: true } }),
    facts.job.inspectorMemberId === null
      ? null
      : tx.inspectionAgencyMember.findUnique({
          where: { id: facts.job.inspectorMemberId },
          select: { fullName: true, idDocumentType: true },
        }),
  ]);

  return jsonSafe({
    v: 1,
    jobNumber: facts.job.jobNumber,
    kind: facts.job.kind,
    reinspectionOfJobId: facts.job.reinspectionOfJobId,
    agency: agency.legalName,
    inspector: inspector?.fullName ?? null,
    inspectionPoint: facts.job.inspectionPointJson,
    scheduledFor: facts.job.scheduledFor,
    startedAt: facts.job.startedAt,
    standard: facts.job.standard,
    scope: facts.job.scopeJson,
    sampling: facts.job.samplingJson,
    samplingRecord: {
      lotReference: facts.job.lotReference,
      lotSize: facts.job.lotSize,
      sampledQuantity: facts.job.sampledQuantity,
      acceptedQuantity: facts.job.acceptedQuantity,
      rejectedQuantity: facts.job.rejectedQuantity,
      cartonsOpened: facts.job.cartonsOpened,
    },
    checks: facts.checks.map((check) => ({
      itemCode: check.itemCode,
      section: check.section,
      label: check.label,
      outcome: check.outcome,
      measuredValue: check.measuredValue,
      note: check.note,
    })),
    defects: facts.defects.map((defect) => ({
      ncrNumber: defect.ncrNumber,
      severity: defect.severity,
      originalSeverity: defect.originalSeverity,
      requirementRef: defect.requirementRef,
      description: defect.description,
      defectQuantity: defect.defectQuantity,
      reclassificationReason: defect.reclassificationReason,
    })),
    evidence: facts.evidence.map((item) => ({ id: item.id, purpose: item.purpose, sha256: item.contentHash, capturedAt: item.capturedAt })),
    computation: computationFor(facts),
    summary,
  });
}

function hashOf(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** The report's signature: HMAC over the content hash, the signer and the moment. */
export function reportSignature(contentHash: string, signerMemberId: string, signedAt: Date): string {
  return createHmac('sha256', `inspection-report:${env.SESSION_COOKIE_SECRET}`)
    .update(`${contentHash}|${signerMemberId}|${signedAt.toISOString()}`)
    .digest('hex');
}

export async function submitReport(
  membership: InspectionMembership,
  jobId: string,
  input: { summary?: string | null },
  correlationId?: string | null,
): Promise<{ reportId: string; revision: number; result: 'PASS' | 'FAIL' }> {
  return prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);

    const facts = await reportFacts(tx, job);
    const problems = completenessProblems(facts);
    if (problems.length > 0) {
      throw conflict(ErrorCode.INSPECTION_REPORT_INCOMPLETE, 'The report is not complete yet.', problems);
    }

    const summary = input.summary?.trim() || null;
    const content = await reportContent(tx, facts, summary);
    const computation = computationFor(facts);
    const revision = (await tx.inspectionReport.count({ where: { jobId: job.id } })) + 1;
    const id = newId();

    await tx.inspectionReport.create({
      data: {
        id,
        jobId: job.id,
        revision,
        status: 'SUBMITTED',
        result: computation.result,
        summary,
        computationJson: computation as never,
        contentJson: content as never,
        contentHash: hashOf(content),
        submittedAt: new Date(),
        submittedByMemberId: membership.memberId,
      },
    });

    await moveJob(tx, job, 'REPORT_SUBMITTED', 'INSPECTOR', agencyActor(membership, correlationId), null, {
      submittedAt: new Date(),
    });

    return { reportId: id, revision, result: computation.result };
  });
}

async function submittedReport(tx: Tx, job: LoadedJob) {
  const report = await tx.inspectionReport.findFirst({
    where: { jobId: job.id, status: 'SUBMITTED' },
    orderBy: { revision: 'desc' },
  });
  if (report === null) {
    throw conflict(ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED, 'There is no submitted report to review.', [
      { code: 'NO_SUBMITTED_REPORT' },
    ]);
  }
  return report;
}

function assertQaIsSomebodyElse(membership: InspectionMembership, report: { submittedByMemberId: string }): void {
  assertInspectionPermission(membership, InspectionAgencyPermission.REPORT_SIGN);
  if (report.submittedByMemberId === membership.memberId) {
    throw conflict(ErrorCode.INSPECTION_SELF_APPROVAL_FORBIDDEN, 'The person who wrote a report cannot also sign it.', [
      { code: 'SAME_PERSON' },
    ]);
  }
}

export async function returnReport(
  membership: InspectionMembership,
  jobId: string,
  reason: string,
  correlationId?: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    const report = await submittedReport(tx, job);
    assertQaIsSomebodyElse(membership, report);

    await tx.inspectionReport.update({
      where: { id: report.id },
      data: { status: 'RETURNED', returnedAt: new Date(), returnedByMemberId: membership.memberId, returnReason: reason.trim().slice(0, 1024) },
    });

    await moveJob(tx, job, 'IN_PROGRESS', 'QA', agencyActor(membership, correlationId), reason);
  });
}

/**
 * QA changes a defect's severity - the only way a CRITICAL stops failing a
 * lot (INSPECT-001). Needs the QA role, a different person from whoever
 * recorded it, a written reason and evidence uploaded for the purpose.
 */
export async function reclassifyDefect(
  membership: InspectionMembership,
  defectId: string,
  input: { severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; reason: string; evidenceId: string },
  correlationId?: string | null,
): Promise<void> {
  assertInspectionPermission(membership, InspectionAgencyPermission.REPORT_SIGN);

  await prisma.$transaction(async (tx) => {
    const defect = await tx.inspectionDefect.findUnique({ where: { id: defectId } });
    if (defect === null) throw notFound('Defect');
    const job = await loadJobForAgency(tx, membership, defect.jobId);

    const refuse = (code: string, message: string): never => {
      throw conflict(ErrorCode.INSPECTION_RECLASSIFICATION_NOT_ALLOWED, message, [{ code }]);
    };

    if (job.status !== 'REPORT_SUBMITTED') refuse('NOT_UNDER_REVIEW', 'A defect can be reclassified only while its report is under QA review.');
    if (defect.recordedByMemberId === membership.memberId) refuse('SAME_PERSON', 'The person who recorded a defect cannot reclassify it.');
    if (input.severity === defect.severity) refuse('SAME_SEVERITY', 'That is already its severity.');
    if (input.reason.trim().length < 20) refuse('REASON_REQUIRED', 'Explain the reclassification in at least twenty characters.');

    const evidence = await tx.inspectionEvidence.findFirst({
      where: { id: input.evidenceId, jobId: job.id, purpose: 'RECLASSIFICATION' },
      select: { id: true },
    });
    if (evidence === null) refuse('EVIDENCE_REQUIRED', 'Attach the evidence the reclassification rests on.');

    await tx.inspectionDefect.update({
      where: { id: defect.id },
      data: {
        severity: input.severity,
        reclassifiedAt: new Date(),
        reclassifiedByMemberId: membership.memberId,
        reclassificationReason: input.reason.trim(),
      },
    });
    await tx.inspectionEvidence.update({ where: { id: input.evidenceId }, data: { defectId: defect.id } });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'defect_reclassified',
      actor: agencyActor(membership, correlationId),
      summary: `${defect.ncrNumber} reclassified from ${defect.severity.toLowerCase()} to ${input.severity.toLowerCase()} by QA: ${input.reason.trim()}`,
      data: { ncrNumber: defect.ncrNumber, from: defect.severity, to: input.severity, evidenceId: input.evidenceId },
      audit: AuditAction.INSPECTION_DEFECT_RECLASSIFIED,
      visibleToBuyer: false,
    });
  });
}

/**
 * QA signs. The result is recomputed from the defects as they now stand, the
 * content is frozen, hashed and signed, the job completes, and the release
 * decision follows in the same transaction (release.service.ts).
 */
export async function signReport(
  membership: InspectionMembership,
  jobId: string,
  correlationId?: string | null,
): Promise<{ reportId: string; result: 'PASS' | 'FAIL' }> {
  const policy = await readPolicy();

  return prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    const report = await submittedReport(tx, job);
    assertQaIsSomebodyElse(membership, report);

    const inspectorIds = [job.inspectorMemberId, job.backupInspectorMemberId].filter((id): id is string => id !== null);
    if (inspectorIds.includes(membership.memberId)) {
      throw conflict(ErrorCode.INSPECTION_SELF_APPROVAL_FORBIDDEN, 'An inspector on this job cannot sign its report.', [
        { code: 'SAME_PERSON' },
      ]);
    }

    const facts = await reportFacts(tx, job);
    const problems = completenessProblems(facts);
    if (problems.length > 0) {
      throw conflict(ErrorCode.INSPECTION_REPORT_INCOMPLETE, 'The report is not complete yet.', problems);
    }

    const content = await reportContent(tx, facts, report.summary);
    const computation = computationFor(facts);
    const contentHash = hashOf(content);
    const signedAt = new Date();

    const signed = await tx.inspectionReport.updateMany({
      where: { id: report.id, status: 'SUBMITTED' },
      data: {
        status: 'SIGNED',
        result: computation.result,
        computationJson: computation as never,
        contentJson: content as never,
        contentHash,
        signature: reportSignature(contentHash, membership.memberId, signedAt),
        signedAt,
        signedByMemberId: membership.memberId,
        signedByName: membership.fullName,
        publishedToBuyerAt: policy.buyerReportAccess === 'BEFORE_RELEASE' ? signedAt : null,
      },
    });
    if (signed.count !== 1) {
      throw conflict(ErrorCode.INSPECTION_REPORT_LOCKED, 'This report was already signed.', [{ code: 'ALREADY_SIGNED' }]);
    }

    const actor = agencyActor(membership, correlationId);
    await moveJob(tx, job, 'COMPLETED', 'QA', actor, null, { completedAt: signedAt });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'report_signed',
      actor,
      summary: `${job.jobNumber} report signed: ${computation.result}. ${String(computation.counts.critical)} critical, ${String(computation.counts.major)} major, ${String(computation.counts.minor)} minor.`,
      data: { reportId: report.id, result: computation.result, contentHash, counts: computation.counts, reasons: computation.reasons },
      audit: AuditAction.INSPECTION_REPORT_SIGNED,
    });

    await afterReportSigned(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      sellerAccountId: job.requirement.sellerAccountId,
      sellerOrderGroupId: job.requirement.sellerOrderGroupId,
      jobId: job.id,
      jobNumber: job.jobNumber,
      jobKind: job.kind,
      reportId: report.id,
      result: computation.result,
      actor,
    });

    return { reportId: report.id, result: computation.result };
  });
}

// ---------------------------------------------------------------------------
// The seller presents the lot
// ---------------------------------------------------------------------------

export interface ReadinessInput {
  lotReference: string;
  readyDate: string | null;
  locationLabel: string;
  contactName: string;
  contactPhone: string;
  packedStatus: 'NOT_PACKED' | 'PARTIALLY_PACKED' | 'PACKED' | 'SEALED';
  declaration: boolean;
  note?: string | null;
}

/**
 * What stops a seller saying "ready": every missing item, by name
 * (UAT-UI-008). A packing list is required when the operator's policy says so
 * and none is issued for this order's consignments.
 */
export async function readinessProblems(
  client: Tx | typeof prisma,
  sellerOrderGroupId: string,
  input: ReadinessInput,
  requirePackingList: boolean,
): Promise<{ code: string; field?: string }[]> {
  const problems: { code: string; field?: string }[] = [];
  if (input.lotReference.trim() === '') problems.push({ code: 'LOT_REFERENCE_REQUIRED', field: 'lotReference' });
  if (input.readyDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(input.readyDate)) problems.push({ code: 'READY_DATE_REQUIRED', field: 'readyDate' });
  if (input.locationLabel.trim() === '') problems.push({ code: 'LOCATION_REQUIRED', field: 'locationLabel' });
  if (input.contactName.trim() === '' || input.contactPhone.trim() === '') problems.push({ code: 'CONTACT_REQUIRED', field: 'contactName' });
  if (input.packedStatus !== 'PACKED' && input.packedStatus !== 'SEALED') problems.push({ code: 'NOT_PACKED', field: 'packedStatus' });
  if (!input.declaration) problems.push({ code: 'DECLARATION_REQUIRED', field: 'declaration' });

  if (requirePackingList) {
    const issued = await client.sellerPackingList.count({
      where: { sellerOrderGroupId, status: 'ISSUED' },
    });
    if (issued === 0) problems.push({ code: 'PACKING_LIST_MISSING' });
  }

  return problems;
}

export async function submitReadiness(
  actor: InspectionActor & { sellerAccountId: string },
  jobId: string,
  input: ReadinessInput,
): Promise<void> {
  const policy = await readPolicy();

  await prisma.$transaction(async (tx) => {
    const job = await loadJob(tx, jobId);
    if (job.requirement.sellerAccountId !== actor.sellerAccountId) throw notFound('Inspection');

    if (!['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED'].includes(job.status)) {
      throw conflict(ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED, 'The lot can be presented only before the inspection starts.', [
        { code: 'NOT_BEFORE_START', meta: { status: job.status } },
      ]);
    }

    const problems = await readinessProblems(tx, job.requirement.sellerOrderGroupId, input, policy.requirePackingListForReadiness);
    if (problems.length > 0) {
      throw conflict(
        ErrorCode.INSPECTION_READINESS_INCOMPLETE,
        problems.some((problem) => problem.code === 'PACKING_LIST_MISSING')
          ? 'Issue the packing list for this order before presenting the lot for inspection.'
          : 'Some details are missing before the lot can be presented.',
        problems.map((problem) => ({ code: problem.code, ...(problem.field === undefined ? {} : { field: problem.field }) })),
      );
    }

    const scope = await currentScope(tx, job.requirement.sellerOrderGroupId);
    const now = new Date();

    await tx.inspectionJob.update({
      where: { id: job.id },
      data: {
        readinessJson: { ...input, scopeHash: scope.hash, consignments: scope.summary.consignments },
        readinessSubmittedAt: now,
        readinessSubmittedById: actor.userId,
        version: { increment: 1 },
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'readiness_submitted',
      actor,
      summary: `The seller presented lot ${input.lotReference.trim()} as ${input.packedStatus.toLowerCase().replace('_', ' ')}, ready on ${input.readyDate ?? ''}.`,
      data: { lotReference: input.lotReference, packedStatus: input.packedStatus, readyDate: input.readyDate },
    });
  });
}

// ---------------------------------------------------------------------------
// Corrective action
// ---------------------------------------------------------------------------

/**
 * The seller answers a non-conformance: what they found, what they corrected,
 * with evidence of the correction (FLOW-005). The NCR stays in the original
 * report; the re-inspection is what closes it.
 */
export async function submitCapa(
  actor: InspectionActor & { sellerAccountId: string },
  defectId: string,
  input: { sellerResponse: string; correctiveAction: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const defect = await tx.inspectionDefect.findUnique({
      where: { id: defectId },
      include: { job: { include: { requirement: { select: { id: true, orderId: true, sellerAccountId: true } } } } },
    });
    if (defect === null || defect.job.requirement.sellerAccountId !== actor.sellerAccountId) throw notFound('Non-conformance');
    if (defect.job.status !== 'COMPLETED') throw notFound('Non-conformance');

    if (defect.status === 'VERIFIED_CLOSED') {
      throw conflict(ErrorCode.CONFLICT, 'This non-conformance is already closed.', [{ code: 'ALREADY_CLOSED' }]);
    }
    if (input.correctiveAction.trim().length < 10) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Describe the corrective action.', [{ field: 'correctiveAction', code: 'REQUIRED' }]);
    }

    const evidence = await tx.inspectionEvidence.count({ where: { defectId: defect.id, purpose: 'CAPA' } });
    if (evidence === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach evidence of the correction.', [{ field: 'evidence', code: 'REQUIRED' }]);
    }

    await tx.inspectionDefect.update({
      where: { id: defect.id },
      data: {
        status: 'CAPA_SUBMITTED',
        sellerResponse: input.sellerResponse.trim(),
        correctiveAction: input.correctiveAction.trim(),
        capaSubmittedAt: new Date(),
        capaSubmittedById: actor.userId,
        capaSubmittedByLabel: actor.label.slice(0, 160),
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: defect.job.requirement.id,
      orderId: defect.job.requirement.orderId,
      jobId: defect.jobId,
      kind: 'capa_submitted',
      actor,
      summary: `Corrective action recorded for ${defect.ncrNumber}.`,
      data: { ncrNumber: defect.ncrNumber },
      audit: AuditAction.INSPECTION_CAPA_SUBMITTED,
    });

    await refreshRequirementStatus(tx, defect.job.requirement.id);
  });
}

/** The seller attaches evidence: correction evidence on a defect, or readiness evidence on a job. */
export async function uploadSellerEvidence(
  actor: InspectionActor & { sellerAccountId: string },
  input: { jobId: string; defectId?: string | null; purpose: 'CAPA' | 'GENERAL' } & Omit<EvidenceInput, 'requirementId' | 'jobId' | 'purpose' | 'defectId'>,
): Promise<StoredEvidence> {
  const job = await loadJob(prisma, input.jobId);
  if (job.requirement.sellerAccountId !== actor.sellerAccountId) throw notFound('Inspection');

  // A seller never adds to the agency's own findings (INSPECT-003).
  if (input.purpose === 'CAPA') {
    const defect = await prisma.inspectionDefect.findFirst({ where: { id: input.defectId ?? '', jobId: job.id }, select: { id: true } });
    if (defect === null) throw notFound('Non-conformance');
  } else if (!['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED'].includes(job.status)) {
    throw conflict(ErrorCode.INSPECTION_REPORT_LOCKED, 'Readiness evidence is added before the inspection starts.', [
      { code: 'NOT_BEFORE_START' },
    ]);
  }

  return storeEvidence(actor, {
    ...input,
    requirementId: job.requirementId,
    jobId: job.id,
    defectId: input.purpose === 'CAPA' ? (input.defectId ?? null) : null,
  });
}
