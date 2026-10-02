/**
 * What each party is shown of an inspection.
 *
 * One query shape per audience, each deciding what to leave out in the query
 * or immediately after it - never in the browser:
 *
 *   - the BUYER sees the requirement, the timeline entries marked for them,
 *     and the signed report and non-conformances as the operator's policy
 *     allows (FLOW-007, SCREEN-023);
 *   - the SELLER sees their own order's inspection in full, read-only, plus
 *     what they can do next (SCREEN-041, SCREEN-094/095);
 *   - the AGENCY sees only its own jobs, an inspector only theirs (DOD-018);
 *   - the OPERATOR sees everything, including the release queue.
 *
 * A signed report is shown with its integrity checked on the way out: the
 * content hash is recomputed and the signature re-derived, so a row changed in
 * the database after signing shows as MISMATCH on every screen.
 */
import { createHash } from 'node:crypto';
import { notFound } from '../../domain/errors.js';
import { allowedInspectionJobTransitions, type InspectionJobStatusName } from '../../domain/inspection-state.js';
import { gateSentence } from '../../domain/inspection-gate.js';
import { prisma } from '../../infra/prisma.js';
import { agencyEligibility, interestedUserIds, maskDocumentNumber, type InspectionMembership } from './agency.service.js';
import { readPolicy } from './context.js';
import { EVIDENCE_SELECT } from './evidence.service.js';
import { cardStatusFor, ensureRequirement, orderFactsFor, peekGate } from './gate.service.js';
import { reportSignature } from './job.service.js';
import { OPEN_JOB_STATUSES } from '../../domain/inspection-state.js';

type Audience = 'BUYER' | 'SELLER' | 'AGENCY' | 'OPERATOR';

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function integrityOf(report: {
  status: string;
  contentJson: unknown;
  contentHash: string;
  signature: string | null;
  signedByMemberId: string | null;
  signedAt: Date | null;
}): 'VERIFIED' | 'MISMATCH' | 'UNSIGNED' {
  if (report.status !== 'SIGNED' || report.signature === null || report.signedAt === null || report.signedByMemberId === null) {
    return 'UNSIGNED';
  }
  const hash = createHash('sha256').update(JSON.stringify(report.contentJson)).digest('hex');
  if (hash !== report.contentHash) return 'MISMATCH';
  return reportSignature(report.contentHash, report.signedByMemberId, report.signedAt) === report.signature ? 'VERIFIED' : 'MISMATCH';
}

async function requirementBundle(requirementId: string, audience: Audience) {
  const policy = await readPolicy();
  const requirement = await prisma.inspectionRequirement.findUnique({
    where: { id: requirementId },
    include: {
      sellerOrderGroup: {
        select: {
          id: true,
          sellerOrderNumber: true,
          status: true,
          sellerAccount: { select: { displayName: true } },
          order: { select: { orderNumber: true } },
        },
      },
      jobs: {
        orderBy: { createdAt: 'asc' },
        include: {
          agency: { select: { id: true, name: true } },
          reports: { orderBy: { revision: 'asc' } },
          defects: { orderBy: { ncrNumber: 'asc' } },
          checks: { orderBy: { itemCode: 'asc' } },
          invoices: audience === 'OPERATOR' || audience === 'AGENCY' ? { orderBy: { submittedAt: 'asc' } } : false,
        },
      },
      releases: { orderBy: { requestedAt: 'asc' } },
      bindings: { orderBy: { createdAt: 'asc' } },
      events: {
        where:
          audience === 'BUYER' ? { visibleToBuyer: true } : audience === 'SELLER' ? { visibleToSeller: true } : {},
        orderBy: { createdAt: 'asc' },
      },
      evidence: { select: EVIDENCE_SELECT, orderBy: { receivedAt: 'asc' } },
      referenceSample: {
        select: {
          id: true,
          reference: true,
          referenceCode: true,
          quantity: true,
          unitOfMeasure: true,
          approvalCriteria: true,
          decisionReason: true,
          decidedAt: true,
        },
      },
    },
  });
  if (requirement === null) throw notFound('Inspection');

  // JOURNEY-019: the RFQ purchase order behind this order and the reference
  // sample the buyer approved, so the inspector measures the goods against
  // what was agreed and the buyer can see the two are linked.
  const purchaseOrder = await prisma.rfqPurchaseOrder.findUnique({
    where: { orderId: requirement.orderId },
    select: { reference: true, contractJson: true },
  });
  const sampleFiles =
    requirement.referenceSample === null
      ? []
      : await prisma.rfqAttachment.findMany({
          where: { sampleId: requirement.referenceSample.id, purpose: 'SAMPLE' },
          select: { fileName: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
  const contractQuality =
    purchaseOrder === null
      ? null
      : (purchaseOrder.contractJson as { quality?: { inspectionTerms?: string | null; inspectionRequirement?: string } }).quality ?? null;

  const gate = await peekGate(requirement.id);
  const memberIds = requirement.jobs.flatMap((job) => [job.inspectorMemberId, job.backupInspectorMemberId]).filter((id): id is string => id !== null);
  const members = await prisma.inspectionAgencyMember.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, fullName: true, idDocumentType: true, idDocumentNumber: true, identityVerifiedAt: true },
  });
  const memberById = new Map(members.map((member) => [member.id, member]));

  // What the buyer may read, by policy.
  const releasedForBuyer = gate.open || requirement.loadReleasedAt !== null;
  const buyerSeesReport = (report: { status: string; publishedToBuyerAt: Date | null }): boolean =>
    report.status === 'SIGNED' &&
    (policy.buyerReportAccess === 'BEFORE_RELEASE'
      ? report.publishedToBuyerAt !== null
      : policy.buyerReportAccess === 'AFTER_RELEASE'
        ? releasedForBuyer
        : false);
  const buyerSeesDefect = (severity: string): boolean =>
    policy.buyerNcrVisibility === 'ALL' || (policy.buyerNcrVisibility === 'MAJOR_AND_CRITICAL' && severity !== 'MINOR');

  const jobs = requirement.jobs.map((job) => {
    const signed = job.reports.filter((report) => report.status === 'SIGNED');
    const reports = (audience === 'BUYER' ? signed.filter(buyerSeesReport) : audience === 'SELLER' ? signed : job.reports).map(
      (report) => ({
        id: report.id,
        revision: report.revision,
        status: report.status,
        result: report.result,
        summary: report.summary,
        computation: report.computationJson,
        content: audience === 'BUYER' ? null : report.contentJson,
        contentHash: report.contentHash,
        integrity: integrityOf(report),
        submittedAt: iso(report.submittedAt),
        returnedAt: iso(report.returnedAt),
        returnReason: report.returnReason,
        signedAt: iso(report.signedAt),
        signedByName: report.signedByName,
      }),
    );

    // Findings exist for the seller and buyer only once a report is signed:
    // before that they are the inspector's working.
    const findingsVisible = audience === 'OPERATOR' || audience === 'AGENCY' || job.status === 'COMPLETED';
    const buyerMaySee = audience !== 'BUYER' || reports.length > 0;
    const defects = !findingsVisible || !buyerMaySee
      ? []
      : job.defects
          .filter((defect) => audience !== 'BUYER' || buyerSeesDefect(defect.severity))
          .map((defect) => ({
            id: defect.id,
            ncrNumber: defect.ncrNumber,
            severity: defect.severity,
            originalSeverity: defect.originalSeverity,
            requirementRef: defect.requirementRef,
            description: defect.description,
            defectQuantity: defect.defectQuantity,
            status: defect.status,
            reclassifiedAt: iso(defect.reclassifiedAt),
            reclassificationReason: defect.reclassificationReason,
            sellerResponse: audience === 'BUYER' && policy.buyerNcrVisibility === 'NONE' ? null : defect.sellerResponse,
            correctiveAction: defect.correctiveAction,
            capaSubmittedAt: iso(defect.capaSubmittedAt),
            verifiedAt: iso(defect.verifiedAt),
            verifiedByReportId: defect.verifiedByReportId,
          }));

    const inspector = job.inspectorMemberId === null ? null : memberById.get(job.inspectorMemberId) ?? null;
    const visibleDefectIds = new Set(defects.map((defect) => defect.id));

    const evidence = requirement.evidence
      .filter((item) => item.jobId === job.id)
      .filter((item) => {
        if (audience === 'OPERATOR' || audience === 'AGENCY') return true;
        if (!findingsVisible && item.uploadedByParty !== 'SELLER') return false;
        if (audience === 'BUYER') {
          if (!buyerMaySee) return false;
          if (item.purpose === 'CAPA' || item.purpose === 'RELEASE') return false;
          return item.defectId === null || visibleDefectIds.has(item.defectId);
        }
        return true;
      })
      .map((item) => ({ ...item, capturedAt: iso(item.capturedAt), receivedAt: iso(item.receivedAt), latitude: item.latitude?.toString() ?? null, longitude: item.longitude?.toString() ?? null }));

    return {
      id: job.id,
      jobNumber: job.jobNumber,
      kind: job.kind,
      reinspectionOfJobId: job.reinspectionOfJobId,
      status: job.status,
      agency: job.agency,
      payer: job.payer,
      bookedByParty: job.bookedByParty,
      bookedByLabel: audience === 'BUYER' ? null : job.bookedByLabel,
      inspectionPointType: job.inspectionPointType,
      inspectionPoint: job.inspectionPointJson,
      scheduledFor: iso(job.scheduledFor),
      language: job.language,
      standard: job.standard,
      lotSize: job.lotSize,
      sampling: job.samplingJson,
      scope: audience === 'BUYER' ? null : job.scopeJson,
      readiness: audience === 'BUYER' ? null : job.readinessJson,
      readinessSubmittedAt: iso(job.readinessSubmittedAt),
      acceptDueAt: iso(job.acceptDueAt),
      reportDueAt: iso(job.reportDueAt),
      acceptedAt: iso(job.acceptedAt),
      assignedAt: iso(job.assignedAt),
      startedAt: iso(job.startedAt),
      submittedAt: iso(job.submittedAt),
      completedAt: iso(job.completedAt),
      cancelledAt: iso(job.cancelledAt),
      cancelReason: job.cancelReason,
      declineReason: job.declineReason,
      inspector:
        inspector === null
          ? null
          : {
              fullName: inspector.fullName,
              idDocumentType: audience === 'BUYER' ? null : inspector.idDocumentType,
              idDocumentNumber: audience === 'OPERATOR' ? maskDocumentNumber(inspector.idDocumentNumber) : null,
              identityVerified: inspector.identityVerifiedAt !== null,
            },
      samplingRecord: findingsVisible
        ? {
            lotReference: job.lotReference,
            sampledQuantity: job.sampledQuantity,
            acceptedQuantity: job.acceptedQuantity,
            rejectedQuantity: job.rejectedQuantity,
            cartonsOpened: job.cartonsOpened,
          }
        : null,
      checks: findingsVisible && audience !== 'BUYER'
        ? job.checks.map((check) => ({ ...check, recordedAt: iso(check.recordedAt) }))
        : [],
      reports,
      report: reports.at(-1) ?? null,
      defects,
      evidence,
      invoices:
        audience === 'OPERATOR' || audience === 'AGENCY'
          ? (job.invoices ?? []).map((invoice) => ({ ...invoice, amountMinor: invoice.amountMinor.toString() }))
          : [],
    };
  });

  const openReinspection = requirement.jobs.some(
    (job) => job.kind === 'REINSPECTION' && (OPEN_JOB_STATUSES as readonly string[]).includes(job.status),
  );

  return {
    requirement: {
      id: requirement.id,
      orderId: requirement.orderId,
      sellerOrderGroupId: requirement.sellerOrderGroupId,
      orderNumber: requirement.sellerOrderGroup.order.orderNumber,
      sellerOrderNumber: requirement.sellerOrderGroup.sellerOrderNumber,
      sellerName: requirement.sellerOrderGroup.sellerAccount.displayName,
      groupStatus: requirement.sellerOrderGroup.status,
      level: requirement.level,
      status: requirement.status,
      gate: { allowed: gate.open, sentence: gateSentence(gate.reason) },
      cardStatus: cardStatusFor(requirement.status, openReinspection),
      reason: requirement.reason,
      ruleName: audience === 'BUYER' ? null : requirement.ruleName,
      inputs: audience === 'OPERATOR' ? requirement.inputsJson : null,
      buyerRequested: requirement.buyerRequested,
      allowConditionalRelease: requirement.allowConditionalRelease,
      evaluatedAt: iso(requirement.evaluatedAt),
      loadReleasedAt: iso(requirement.loadReleasedAt),
      /** The RFQ purchase order the goods were bought on, with its inspection terms. Null otherwise. */
      purchaseOrder:
        purchaseOrder === null
          ? null
          : {
              reference: purchaseOrder.reference,
              inspectionRequirement: contractQuality?.inspectionRequirement ?? null,
              inspectionTerms: contractQuality?.inspectionTerms ?? null,
            },
      /** The approved reference sample the goods are measured against (JOURNEY-019). Null when there is none. */
      referenceSample:
        requirement.referenceSample === null
          ? null
          : {
              reference: requirement.referenceSample.reference,
              referenceCode: requirement.referenceSample.referenceCode,
              quantity: requirement.referenceSample.quantity.toString(),
              unitOfMeasure: requirement.referenceSample.unitOfMeasure,
              approvalCriteria: requirement.referenceSample.approvalCriteria,
              decisionReason: requirement.referenceSample.decisionReason,
              approvedAt: iso(requirement.referenceSample.decidedAt),
              files: sampleFiles.map((file) => file.fileName),
            },
    },
    gate: { ...gate, sentence: gateSentence(gate.reason) },
    jobs,
    releases:
      audience === 'BUYER'
        ? requirement.releases
            .filter((release) => release.state === 'ACTIVE' || release.state === 'SUPERSEDED')
            .map((release) => ({ id: release.id, kind: release.kind, state: release.state, approvedAt: iso(release.approvedAt) }))
        : requirement.releases.map((release) => ({
            ...release,
            requestedAt: iso(release.requestedAt),
            approvedAt: iso(release.approvedAt),
            rejectedAt: iso(release.rejectedAt),
            supersededAt: iso(release.supersededAt),
            createdAt: iso(release.createdAt),
          })),
    bindings: audience === 'BUYER' ? [] : requirement.bindings.map((binding) => ({ ...binding, stuffedAt: iso(binding.stuffedAt), createdAt: iso(binding.createdAt) })),
    releaseEvidence:
      audience === 'OPERATOR'
        ? requirement.evidence
            .filter((item) => item.purpose === 'RELEASE')
            .map((item) => ({ ...item, capturedAt: iso(item.capturedAt), receivedAt: iso(item.receivedAt), latitude: null, longitude: null }))
        : [],
    timeline: requirement.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      actorParty: event.actorParty,
      actorLabel: audience === 'BUYER' && event.actorParty !== 'BUYER' ? partyWord(event.actorParty) : event.actorLabel,
      summary: event.summary,
      jobId: event.jobId,
      createdAt: iso(event.createdAt),
    })),
    policy: {
      buyerReportAccess: policy.buyerReportAccess,
      buyerNcrVisibility: policy.buyerNcrVisibility,
      buyerMayRequest: policy.buyerMayRequest,
      requirePackingListForReadiness: policy.requirePackingListForReadiness,
      conditionalReleaseMinReasonLength: policy.conditionalReleaseMinReasonLength,
    },
  };
}

function partyWord(party: string): string {
  switch (party) {
    case 'SELLER':
      return 'The seller';
    case 'AGENCY':
      return 'The inspection agency';
    case 'OPERATOR':
      return 'The marketplace';
    default:
      return 'The system';
  }
}

export type InspectionView = Awaited<ReturnType<typeof requirementBundle>>;

// ---------------------------------------------------------------------------
// Per audience
// ---------------------------------------------------------------------------

/** The seller's view of one of their orders. Decides the requirement if nobody has. */
export async function sellerInspectionView(sellerAccountId: string, sellerOrderGroupId: string): Promise<InspectionView | null> {
  const group = await prisma.sellerOrderGroup.findFirst({
    where: { id: sellerOrderGroupId, sellerAccountId },
    select: { id: true },
  });
  if (group === null) throw notFound('Order');

  const requirement = await prisma.$transaction((tx) => ensureRequirement(tx, sellerOrderGroupId));
  if (requirement === null) return null;
  return requirementBundle(requirement.id, 'SELLER');
}

/** The buyer's view: one entry per seller in their order. */
export async function buyerInspectionViews(customerProfileId: string, orderId: string): Promise<InspectionView[]> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerProfileId },
    select: { id: true, sellerOrderGroups: { select: { id: true } } },
  });
  if (order === null) throw notFound('Order');

  const views: InspectionView[] = [];
  for (const group of order.sellerOrderGroups) {
    const requirement = await prisma.$transaction((tx) => ensureRequirement(tx, group.id));
    if (requirement !== null) views.push(await requirementBundle(requirement.id, 'BUYER'));
  }
  return views;
}

export async function operatorInspectionView(requirementId: string): Promise<InspectionView> {
  return requirementBundle(requirementId, 'OPERATOR');
}

export async function operatorQueue(filters: { status?: string | null; search?: string | null; page: number; limit: number }) {
  const where = {
    ...(filters.status === undefined || filters.status === null || filters.status === ''
      ? { level: { not: 'NOT_REQUIRED' as const } }
      : { status: filters.status as never }),
    ...(filters.search === undefined || filters.search === null || filters.search.trim() === ''
      ? {}
      : {
          OR: [
            { sellerOrderGroup: { sellerOrderNumber: { contains: filters.search.trim() } } },
            { sellerOrderGroup: { order: { orderNumber: { contains: filters.search.trim() } } } },
          ],
        }),
  };

  const [total, rows, pendingReleases] = await Promise.all([
    prisma.inspectionRequirement.count({ where }),
    prisma.inspectionRequirement.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: {
        sellerOrderGroup: {
          select: { sellerOrderNumber: true, status: true, sellerAccount: { select: { displayName: true } }, order: { select: { orderNumber: true } } },
        },
        jobs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { jobNumber: true, status: true, kind: true, scheduledFor: true, reportDueAt: true, agency: { select: { name: true } } },
        },
        releases: { where: { state: 'PENDING_APPROVAL' }, select: { id: true, requestedByLabel: true, requestedById: true } },
      },
    }),
    prisma.inspectionRelease.count({ where: { state: 'PENDING_APPROVAL' } }),
  ]);

  return {
    total,
    pendingReleases,
    rows: rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.sellerOrderGroup.order.orderNumber,
      sellerOrderNumber: row.sellerOrderGroup.sellerOrderNumber,
      sellerName: row.sellerOrderGroup.sellerAccount.displayName,
      level: row.level,
      status: row.status,
      ruleName: row.ruleName,
      latestJob:
        row.jobs[0] === undefined
          ? null
          : { ...row.jobs[0], scheduledFor: iso(row.jobs[0].scheduledFor), reportDueAt: iso(row.jobs[0].reportDueAt) },
      pendingRelease: row.releases[0] ?? null,
      updatedAt: iso(row.updatedAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// The agency
// ---------------------------------------------------------------------------

function agencyJobWhere(membership: InspectionMembership) {
  return {
    agencyId: membership.agencyId,
    ...(membership.assignmentScoped
      ? { OR: [{ inspectorMemberId: membership.memberId }, { backupInspectorMemberId: membership.memberId }] }
      : {}),
  };
}

export async function agencyJobList(membership: InspectionMembership, filters: { status?: string | null }) {
  const rows = await prisma.inspectionJob.findMany({
    where: {
      ...agencyJobWhere(membership),
      ...(filters.status === undefined || filters.status === null || filters.status === '' ? {} : { status: filters.status as never }),
    },
    orderBy: [{ scheduledFor: 'asc' }],
    take: 200,
    select: {
      id: true,
      jobNumber: true,
      kind: true,
      status: true,
      scheduledFor: true,
      acceptDueAt: true,
      reportDueAt: true,
      inspectionPointType: true,
      inspectionPointJson: true,
      inspectorMemberId: true,
      readinessSubmittedAt: true,
      lotSize: true,
      requirement: { select: { sellerOrderGroup: { select: { sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } } } },
    },
  });

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    jobNumber: row.jobNumber,
    kind: row.kind,
    status: row.status,
    scheduledFor: iso(row.scheduledFor),
    acceptDueAt: iso(row.acceptDueAt),
    reportDueAt: iso(row.reportDueAt),
    inspectionPointType: row.inspectionPointType,
    inspectionPoint: row.inspectionPointJson,
    inspectorMemberId: row.inspectorMemberId,
    readinessSubmitted: row.readinessSubmittedAt !== null,
    lotSize: row.lotSize,
    sellerName: row.requirement.sellerOrderGroup.sellerAccount.displayName,
    sellerOrderNumber: row.requirement.sellerOrderGroup.sellerOrderNumber,
    slaState:
      row.status === 'REQUESTED'
        ? row.acceptDueAt.getTime() < now
          ? 'ACCEPT_OVERDUE'
          : 'ON_TIME'
        : (OPEN_JOB_STATUSES as readonly string[]).includes(row.status) && row.reportDueAt.getTime() < now
          ? 'REPORT_OVERDUE'
          : 'ON_TIME',
  }));
}

/** SCREEN-045: assignments, SLA, inspectors, reports and invoices, for one agency. */
export async function agencyDashboard(membership: InspectionMembership) {
  const jobs = await agencyJobList(membership, {});
  const [inspectors, invoices, agency, reports] = await Promise.all([
    membership.assignmentScoped
      ? Promise.resolve([])
      : prisma.inspectionAgencyMember.findMany({
          where: { agencyId: membership.agencyId },
          orderBy: { fullName: 'asc' },
          select: {
            id: true,
            fullName: true,
            role: true,
            status: true,
            jobTitle: true,
            identityVerifiedAt: true,
            credentialExpiresAt: true,
            credentials: true,
            competenceCategoryIdsJson: true,
            idDocumentType: true,
            idDocumentNumber: true,
          },
        }),
    membership.permissions.has('inspection.invoice.write')
      ? prisma.inspectionAgencyInvoice.findMany({
          where: { agencyId: membership.agencyId },
          orderBy: { submittedAt: 'desc' },
          take: 50,
          include: { job: { select: { jobNumber: true } } },
        })
      : Promise.resolve([]),
    prisma.inspectionAgency.findUniqueOrThrow({
      where: { id: membership.agencyId },
      select: { name: true, dailyCapacity: true, status: true, independenceStatement: true },
    }),
    prisma.inspectionReport.findMany({
      where: { job: agencyJobWhere(membership) },
      orderBy: { submittedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        revision: true,
        status: true,
        result: true,
        submittedAt: true,
        signedAt: true,
        returnedAt: true,
        job: { select: { id: true, jobNumber: true } },
      },
    }),
  ]);

  const count = (statuses: InspectionJobStatusName[]): number => jobs.filter((job) => statuses.includes(job.status)).length;

  return {
    agency,
    me: { memberId: membership.memberId, fullName: membership.fullName, role: membership.role, permissions: [...membership.permissions] },
    counts: {
      offered: count(['REQUESTED']),
      toAssign: count(['ACCEPTED']),
      assigned: count(['INSPECTOR_ASSIGNED']),
      inProgress: count(['IN_PROGRESS']),
      awaitingQa: count(['REPORT_SUBMITTED']),
      completed: count(['COMPLETED']),
      overdue: jobs.filter((job) => job.slaState !== 'ON_TIME').length,
    },
    jobs,
    inspectors: inspectors.map((member) => ({
      ...member,
      idDocumentNumber: maskDocumentNumber(member.idDocumentNumber),
      identityVerifiedAt: iso(member.identityVerifiedAt),
      credentialExpiresAt: iso(member.credentialExpiresAt),
    })),
    reports: reports.map((report) => ({
      id: report.id,
      jobId: report.job.id,
      jobNumber: report.job.jobNumber,
      revision: report.revision,
      status: report.status,
      result: report.result,
      submittedAt: iso(report.submittedAt),
      signedAt: iso(report.signedAt),
      returnedAt: iso(report.returnedAt),
    })),
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      jobNumber: invoice.job.jobNumber,
      invoiceNumber: invoice.invoiceNumber,
      amountMinor: invoice.amountMinor.toString(),
      currency: invoice.currency,
      payer: invoice.payer,
      status: invoice.status,
      submittedAt: iso(invoice.submittedAt),
      paidAt: iso(invoice.paidAt),
    })),
  };
}

/** ENH-011: capacity, place, time and seller readiness, one row per day. */
export async function agencyCalendar(membership: InspectionMembership, from: Date, days: number) {
  const until = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const [agency, jobs] = await Promise.all([
    prisma.inspectionAgency.findUniqueOrThrow({ where: { id: membership.agencyId }, select: { dailyCapacity: true } }),
    prisma.inspectionJob.findMany({
      where: {
        ...agencyJobWhere(membership),
        scheduledFor: { gte: from, lt: until },
        status: { notIn: ['DECLINED', 'CANCELLED'] },
      },
      orderBy: { scheduledFor: 'asc' },
      select: {
        id: true,
        jobNumber: true,
        status: true,
        scheduledFor: true,
        inspectionPointType: true,
        inspectionPointJson: true,
        readinessSubmittedAt: true,
        readinessJson: true,
      },
    }),
  ]);

  const byDay = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const key = job.scheduledFor.toISOString().slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), job]);
  }

  return {
    capacity: agency.dailyCapacity,
    days: Array.from({ length: days }, (_unused, index) => {
      const date = new Date(from.getTime() + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const entries = byDay.get(date) ?? [];
      return {
        date,
        booked: entries.length,
        capacity: agency.dailyCapacity,
        full: entries.length >= agency.dailyCapacity,
        jobs: entries.map((job) => ({
          id: job.id,
          jobNumber: job.jobNumber,
          status: job.status,
          time: job.scheduledFor.toISOString().slice(11, 16),
          inspectionPointType: job.inspectionPointType,
          inspectionPoint: job.inspectionPointJson,
          readiness: job.readinessSubmittedAt === null ? 'NOT_READY' : 'READY',
          readyDate: (job.readinessJson as { readyDate?: string } | null)?.readyDate ?? null,
        })),
      };
    }),
  };
}

/** SCREEN-046: one assignment, with its scope, schedule, checklist and conflict check. */
export async function agencyJobDetail(membership: InspectionMembership, jobId: string) {
  const job = await prisma.inspectionJob.findFirst({
    where: { id: jobId, ...agencyJobWhere(membership) },
    select: { id: true, requirementId: true, status: true, agencyId: true, scheduledFor: true, inspectionPointJson: true, inspectorMemberId: true, backupInspectorMemberId: true, planSnapshotJson: true, requirement: { select: { sellerAccountId: true, orderId: true, sellerOrderGroupId: true } } },
  });
  if (job === null) throw notFound('Inspection');

  const bundle = await requirementBundle(job.requirementId, 'AGENCY');
  const detail = bundle.jobs.find((entry) => entry.id === job.id);
  if (detail === undefined) throw notFound('Inspection');

  // The conflict check, shown rather than just enforced: the coordinator sees
  // why the agency may or may not take the job.
  const facts = await orderFactsFor(prisma, job.requirement.sellerOrderGroupId);
  const problems = await agencyEligibility(prisma, {
    agencyId: membership.agencyId,
    sellerAccountId: job.requirement.sellerAccountId,
    orderId: job.requirement.orderId,
    categoryIds: facts.categoryIds,
    country: (job.inspectionPointJson as { country?: string }).country ?? null,
    scheduledFor: job.scheduledFor,
    excludeJobId: job.id,
  });
  const interested = await interestedUserIds(prisma, job.requirement);
  const personalConflict = interested.sellerUserIds.has(membership.userId) || interested.buyerUserId === membership.userId;

  const declarations = await prisma.inspectionConflictDeclaration.findMany({
    where: { jobId: job.id },
    select: { memberId: true, hasConflict: true, details: true, declaredAt: true, member: { select: { fullName: true } } },
  });

  const actorRole =
    membership.role === 'INSPECTOR' ? 'INSPECTOR' : membership.role === 'QA_REVIEWER' ? 'QA' : 'AGENCY_COORDINATOR';

  const eligibleInspectors = membership.permissions.has('inspection.job.assign')
    ? await prisma.inspectionAgencyMember.findMany({
        where: { agencyId: membership.agencyId, role: 'INSPECTOR', status: 'ACTIVE' },
        select: { id: true, fullName: true, identityVerifiedAt: true, credentialExpiresAt: true, competenceCategoryIdsJson: true },
      })
    : [];

  return {
    job: detail,
    requirement: { ...bundle.requirement, inputs: null },
    gate: bundle.gate,
    checklist: (job.planSnapshotJson as { checklist?: unknown[] }).checklist ?? [],
    conflictCheck: {
      agencyProblems: problems.filter((problem) => problem.code !== 'CAPACITY_FULL').map((problem) => problem.code),
      personalConflict,
      declarations: declarations.map((declaration) => ({
        memberId: declaration.memberId,
        fullName: declaration.member.fullName,
        hasConflict: declaration.hasConflict,
        details: declaration.details,
        declaredAt: iso(declaration.declaredAt),
      })),
    },
    me: {
      memberId: membership.memberId,
      role: membership.role,
      isNamedInspector: job.inspectorMemberId === membership.memberId || job.backupInspectorMemberId === membership.memberId,
      allowedTransitions: allowedInspectionJobTransitions(detail.status, actorRole),
    },
    eligibleInspectors: eligibleInspectors.map((member) => ({
      id: member.id,
      fullName: member.fullName,
      identityVerified: member.identityVerifiedAt !== null,
      credentialExpiresAt: iso(member.credentialExpiresAt),
      competent: ((member.competenceCategoryIdsJson as string[] | null) ?? []).some((id) => facts.categoryIds.includes(id)),
    })),
    bindings: bundle.bindings,
    // ENH-012: the consignments the goods can be bound to, with what the seller recorded.
    consignments: (
      await prisma.logisticsShipment.findMany({
        where: { sellerOrderGroupId: job.requirement.sellerOrderGroupId, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, shipmentReference: true, packages: { select: { containerNumber: true, sealNumber: true } } },
      })
    ).map((shipment) => ({
      id: shipment.id,
      shipmentReference: shipment.shipmentReference,
      containerNumbers: [...new Set(shipment.packages.map((pack) => pack.containerNumber).filter((value): value is string => value !== null))],
      sealNumbers: [...new Set(shipment.packages.map((pack) => pack.sealNumber).filter((value): value is string => value !== null))],
    })),
  };
}

// ---------------------------------------------------------------------------
// Evidence, per audience
// ---------------------------------------------------------------------------

/** May this seller see this file? Only on their own order, and only what the seller view shows. */
export async function sellerMaySeeEvidence(sellerAccountId: string, evidenceId: string): Promise<boolean> {
  const row = await prisma.inspectionEvidence.findUnique({
    where: { id: evidenceId },
    select: { purpose: true, uploadedByParty: true, requirement: { select: { sellerAccountId: true } }, job: { select: { status: true } } },
  });
  if (row === null || row.requirement.sellerAccountId !== sellerAccountId) return false;
  if (row.purpose === 'RELEASE') return false;
  return row.uploadedByParty === 'SELLER' || row.job?.status === 'COMPLETED';
}

export async function buyerMaySeeEvidence(customerProfileId: string, evidenceId: string): Promise<boolean> {
  const row = await prisma.inspectionEvidence.findUnique({
    where: { id: evidenceId },
    select: { requirementId: true, jobId: true, requirement: { select: { orderId: true } } },
  });
  if (row === null) return false;
  const order = await prisma.order.findFirst({ where: { id: row.requirement.orderId, customerProfileId }, select: { id: true } });
  if (order === null) return false;
  const view = await requirementBundle(row.requirementId, 'BUYER');
  return view.jobs.some((job) => job.evidence.some((item) => item.id === evidenceId));
}

export async function agencyMaySeeEvidence(membership: InspectionMembership, evidenceId: string): Promise<boolean> {
  const row = await prisma.inspectionEvidence.findUnique({ where: { id: evidenceId }, select: { jobId: true } });
  if (row === null || row.jobId === null) return false;
  const job = await prisma.inspectionJob.findFirst({ where: { id: row.jobId, ...agencyJobWhere(membership) }, select: { id: true } });
  return job !== null;
}
