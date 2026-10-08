/**
 * What the Audit Console's screens read.
 *
 * Two audiences share these screens and never see the same thing:
 *
 *   - an AGENCY member sees their own agency's jobs - an inspector only the
 *     jobs they are named on - through the inspection service's own agency
 *     views, so the isolation rule is the one already enforced there;
 *   - audit STAFF see every agency's jobs, reports and corrective actions,
 *     read-only, through the operator view.
 *
 * The audience comes from the session's membership, never from the request.
 */
import { OPEN_JOB_STATUSES } from '../../domain/inspection-state.js';
import { summariseDefectUnits, summariseQuantities, validateQuantities } from '../../domain/inspection-quantity.js';
import { ErrorCode, forbidden, notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  agencyCalendar,
  agencyDashboard,
  agencyJobDetail,
  agencyJobList,
  operatorInspectionView,
} from '../inspection/views.service.js';
import { EMPTY_SIGNALS, compareHealth, rateSellerHealth, type HealthBand, type SellerHealth } from '../../domain/seller-health.js';
import { sellerHealth, sellerHealthMap } from './health.service.js';
import type { AuditMember } from './membership.service.js';

const iso = (value: Date | null | undefined): string | null => (value === null || value === undefined ? null : value.toISOString());

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function canOversee(member: AuditMember): boolean {
  return member.kind === 'STAFF' && member.permissions.has('audit.job.oversee');
}

/** A job id this member may read, or a 404 - never a 403 that confirms it exists. */
async function assertMayReadJob(member: AuditMember, jobId: string): Promise<{ requirementId: string }> {
  const job = await prisma.inspectionJob.findUnique({
    where: { id: jobId },
    select: { requirementId: true, agencyId: true, inspectorMemberId: true, backupInspectorMemberId: true },
  });
  if (job === null) throw notFound('Inspection');
  if (canOversee(member)) return { requirementId: job.requirementId };
  const m = member.inspection;
  if (m === null || job.agencyId !== m.agencyId) throw notFound('Inspection');
  if (m.assignmentScoped && job.inspectorMemberId !== m.memberId && job.backupInspectorMemberId !== m.memberId) throw notFound('Inspection');
  return { requirementId: job.requirementId };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobFilters {
  status?: string | null;
  stage?: string | null;
  agencyId?: string | null;
  search?: string | null;
  overdue?: boolean;
}

export async function consoleJobList(member: AuditMember, filters: JobFilters) {
  if (member.inspection !== null) {
    const rows = await agencyJobList(member.inspection, { status: filters.status ?? null });
    const extra = await prisma.inspectionJob.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      select: { id: true, stage: true, scopeMethod: true },
    });
    const byId = new Map(extra.map((row) => [row.id, row]));
    return rows
      .map((row) => ({ ...row, stage: byId.get(row.id)?.stage ?? 'PRE_SHIPMENT', scopeMethod: byId.get(row.id)?.scopeMethod ?? 'SAMPLE', agencyName: member.agency?.name ?? '' }))
      .filter((row) => (filters.stage ? row.stage === filters.stage : true))
      .filter((row) => (filters.overdue ? row.slaState !== 'ON_TIME' : true))
      .filter((row) =>
        filters.search
          ? [row.jobNumber, row.sellerName, row.sellerOrderNumber].some((value) => value.toLowerCase().includes((filters.search ?? '').toLowerCase()))
          : true,
      );
  }
  if (!canOversee(member)) throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Your role in the Audit Console does not allow this.');

  const search = filters.search?.trim() ?? '';
  const now = new Date();
  const rows = await prisma.inspectionJob.findMany({
    where: {
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.stage ? { stage: filters.stage as never } : {}),
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.overdue
        ? {
            OR: [
              { status: 'REQUESTED', acceptDueAt: { lt: now } },
              { status: { in: [...OPEN_JOB_STATUSES] as never[] }, reportDueAt: { lt: now } },
            ],
          }
        : {}),
      ...(search === ''
        ? {}
        : {
            AND: [
              {
                OR: [
                  { jobNumber: { contains: search } },
                  { requirement: { sellerOrderGroup: { sellerOrderNumber: { contains: search } } } },
                  { requirement: { sellerOrderGroup: { sellerAccount: { displayName: { contains: search } } } } },
                  { lotReference: { contains: search } },
                ],
              },
            ],
          }),
    },
    orderBy: [{ scheduledFor: 'desc' }],
    take: 300,
    select: {
      id: true,
      jobNumber: true,
      kind: true,
      stage: true,
      scopeMethod: true,
      status: true,
      scheduledFor: true,
      acceptDueAt: true,
      reportDueAt: true,
      inspectionPointType: true,
      inspectionPointJson: true,
      inspectorMemberId: true,
      readinessSubmittedAt: true,
      lotSize: true,
      lotReference: true,
      agency: { select: { name: true, kind: true } },
      requirement: { select: { sellerOrderGroup: { select: { sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    jobNumber: row.jobNumber,
    kind: row.kind,
    stage: row.stage,
    scopeMethod: row.scopeMethod,
    status: row.status,
    scheduledFor: iso(row.scheduledFor),
    acceptDueAt: iso(row.acceptDueAt),
    reportDueAt: iso(row.reportDueAt),
    inspectionPointType: row.inspectionPointType,
    inspectionPoint: row.inspectionPointJson,
    inspectorMemberId: row.inspectorMemberId,
    readinessSubmitted: row.readinessSubmittedAt !== null,
    lotSize: row.lotSize,
    lotReference: row.lotReference,
    agencyName: row.agency.name,
    agencyKind: row.agency.kind,
    sellerName: row.requirement.sellerOrderGroup.sellerAccount.displayName,
    sellerOrderNumber: row.requirement.sellerOrderGroup.sellerOrderNumber,
    slaState:
      row.status === 'REQUESTED'
        ? row.acceptDueAt.getTime() < now.getTime()
          ? 'ACCEPT_OVERDUE'
          : 'ON_TIME'
        : (OPEN_JOB_STATUSES as readonly string[]).includes(row.status) && row.reportDueAt.getTime() < now.getTime()
          ? 'REPORT_OVERDUE'
          : 'ON_TIME',
  }));
}

/** What the console adds to the inspection's own job view. */
async function jobExtras(jobId: string) {
  const job = await prisma.inspectionJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true,
      stage: true,
      scopeMethod: true,
      timezone: true,
      lotSize: true,
      requirementId: true,
      agency: { select: { name: true, kind: true } },
      quantityRecord: true,
      labSamples: { orderBy: { sampleCode: 'asc' } },
      defects: { select: { severity: true, defectQuantity: true, unitRefsJson: true } },
      reports: {
        orderBy: { revision: 'asc' },
        select: {
          id: true,
          revision: true,
          status: true,
          result: true,
          limitations: true,
          correctsReportId: true,
          correctionReason: true,
          supersededAt: true,
          signedAt: true,
          signedByName: true,
        },
      },
    },
  });
  const q = job.quantityRecord;
  const s = (value: { toString(): string } | null): string | null => (value === null ? null : value.toString());
  const quantities =
    q === null
      ? null
      : {
          ...summariseQuantities(
            validateQuantities({
              unit: q.unit,
              scopeMethod: job.scopeMethod,
              orderedQuantity: q.orderedQuantity.toString(),
              declaredQuantity: s(q.declaredQuantity),
              verifiedQuantity: s(q.verifiedQuantity),
              sampledQuantity: s(q.sampledQuantity),
              functionallyTestedQuantity: s(q.functionallyTestedQuantity),
              testedConformingQuantity: s(q.testedConformingQuantity),
              testedNonconformingQuantity: s(q.testedNonconformingQuantity),
              damagedQuantity: s(q.damagedQuantity),
            }),
          ),
          countingMethod: q.countingMethod,
          countingNote: q.countingNote,
          packaging: q.packagingJson,
          observations: { packaging: q.packagingObservations, labelling: q.labelingObservations, damage: q.damageObservations },
          raw: {
            unit: q.unit,
            orderedQuantity: q.orderedQuantity.toString(),
            declaredQuantity: s(q.declaredQuantity),
            verifiedQuantity: s(q.verifiedQuantity),
            sampledQuantity: s(q.sampledQuantity),
            functionallyTestedQuantity: s(q.functionallyTestedQuantity),
            testedConformingQuantity: s(q.testedConformingQuantity),
            testedNonconformingQuantity: s(q.testedNonconformingQuantity),
            damagedQuantity: s(q.damagedQuantity),
          },
        };
  const subLots = await prisma.inspectionSubLotRelease.findMany({
    where: { jobId },
    orderBy: { requestedAt: 'desc' },
    select: { id: true, subLotCode: true, quantity: true, unit: true, state: true, requestedByLabel: true, requestedAt: true, decidedByLabel: true, decisionNote: true, consumedAt: true, linesJson: true },
  });
  return {
    stage: job.stage,
    scopeMethod: job.scopeMethod,
    timezone: job.timezone,
    agencyName: job.agency.name,
    agencyKind: job.agency.kind,
    quantities,
    defectUnits: summariseDefectUnits(job.defects.map((defect) => ({ severity: defect.severity, defectQuantity: defect.defectQuantity, unitRefs: strings(defect.unitRefsJson) }))),
    labSamples: job.labSamples.map((sample) => ({
      id: sample.id,
      sampleCode: sample.sampleCode,
      description: sample.description,
      quantity: sample.quantity?.toString() ?? null,
      unit: sample.unit,
      sealNumber: sample.sealNumber,
      takenAt: iso(sample.takenAt),
      laboratoryName: sample.laboratoryName,
      laboratoryAccreditation: sample.laboratoryAccreditation,
      custody: sample.custodyJson,
      labReportEvidenceId: sample.labReportEvidenceId,
      resultSummary: sample.resultSummary,
    })),
    reports: job.reports.map((report) => ({ ...report, supersededAt: iso(report.supersededAt), signedAt: iso(report.signedAt) })),
    subLots: subLots.map((row) => ({ ...row, quantity: row.quantity.toString(), requestedAt: iso(row.requestedAt), consumedAt: iso(row.consumedAt) })),
  };
}

export async function consoleJobDetail(member: AuditMember, jobId: string) {
  const { requirementId } = await assertMayReadJob(member, jobId);
  const extras = await jobExtras(jobId);
  if (member.inspection !== null) {
    return { audience: 'AGENCY' as const, ...(await agencyJobDetail(member.inspection, jobId)), extras };
  }
  const view = await operatorInspectionView(requirementId);
  const job = view.jobs.find((entry) => entry.id === jobId);
  if (job === undefined) throw notFound('Inspection');
  return {
    audience: 'STAFF' as const,
    job,
    requirement: view.requirement,
    gate: view.gate,
    releases: view.releases,
    timeline: view.timeline.filter((event) => event.jobId === null || event.jobId === jobId),
    checklist: [],
    extras,
  };
}

export async function consoleCalendar(member: AuditMember, from: Date, days: number) {
  if (member.inspection === null) throw forbidden(ErrorCode.INSPECTION_AGENCY_MEMBER_REQUIRED, 'The calendar is an agency screen.');
  return agencyCalendar(member.inspection, from, days);
}

/** May this member read this evidence file? Agency rule for agencies; staff read everything. */
export async function consoleMaySeeEvidence(member: AuditMember, evidenceId: string): Promise<boolean> {
  const row = await prisma.inspectionEvidence.findUnique({ where: { id: evidenceId }, select: { jobId: true } });
  if (row === null) return false;
  if (canOversee(member)) return true;
  if (row.jobId === null) return false;
  try {
    await assertMayReadJob(member, row.jobId);
    return true;
  } catch {
    return false;
  }
}

/** Signed reports, newest first: the agency's own, or every agency's for staff. */
export async function consoleReports(member: AuditMember, filters: { result?: string | null; search?: string | null }) {
  const scope =
    member.inspection === null
      ? canOversee(member)
        ? {}
        : null
      : {
          agencyId: member.inspection.agencyId,
          ...(member.inspection.assignmentScoped
            ? { OR: [{ inspectorMemberId: member.inspection.memberId }, { backupInspectorMemberId: member.inspection.memberId }] }
            : {}),
        };
  if (scope === null) throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Your role in the Audit Console does not allow this.');
  const search = filters.search?.trim() ?? '';
  const rows = await prisma.inspectionReport.findMany({
    where: {
      status: 'SIGNED',
      ...(filters.result ? { result: filters.result as never } : {}),
      job: {
        ...scope,
        ...(search === ''
          ? {}
          : {
              AND: [
                {
                  OR: [
                    { jobNumber: { contains: search } },
                    { requirement: { sellerOrderGroup: { sellerOrderNumber: { contains: search } } } },
                    { requirement: { sellerOrderGroup: { sellerAccount: { displayName: { contains: search } } } } },
                  ],
                },
              ],
            }),
      },
    },
    orderBy: { signedAt: 'desc' },
    take: 300,
    select: {
      id: true,
      revision: true,
      result: true,
      signedAt: true,
      signedByName: true,
      supersededAt: true,
      correctsReportId: true,
      job: {
        select: {
          id: true,
          jobNumber: true,
          stage: true,
          scopeMethod: true,
          kind: true,
          agency: { select: { name: true, kind: true } },
          requirement: { select: { sellerOrderGroup: { select: { sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } } } },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    result: row.result,
    signedAt: iso(row.signedAt),
    signedByName: row.signedByName,
    superseded: row.supersededAt !== null,
    isCorrection: row.correctsReportId !== null,
    jobId: row.job.id,
    jobNumber: row.job.jobNumber,
    stage: row.job.stage,
    scopeMethod: row.job.scopeMethod,
    kind: row.job.kind,
    agencyName: row.job.agency.name,
    agencyKind: row.job.agency.kind,
    sellerName: row.job.requirement.sellerOrderGroup.sellerAccount.displayName,
    sellerOrderNumber: row.job.requirement.sellerOrderGroup.sellerOrderNumber,
  }));
}

/** Non-conformances and the re-inspections that close them. */
export async function consoleCorrectiveActions(member: AuditMember, filters: { status?: string | null }) {
  const jobScope =
    member.inspection === null
      ? canOversee(member)
        ? {}
        : null
      : {
          agencyId: member.inspection.agencyId,
          ...(member.inspection.assignmentScoped
            ? { OR: [{ inspectorMemberId: member.inspection.memberId }, { backupInspectorMemberId: member.inspection.memberId }] }
            : {}),
        };
  if (jobScope === null) throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Your role in the Audit Console does not allow this.');
  const defects = await prisma.inspectionDefect.findMany({
    where: { ...(filters.status ? { status: filters.status as never } : {}), job: { ...jobScope, status: 'COMPLETED' } },
    orderBy: { recordedAt: 'desc' },
    take: 300,
    select: {
      id: true,
      ncrNumber: true,
      severity: true,
      description: true,
      status: true,
      requirementRef: true,
      correctiveAction: true,
      sellerResponse: true,
      capaSubmittedAt: true,
      verifiedAt: true,
      requirementId: true,
      job: { select: { id: true, jobNumber: true, agency: { select: { name: true } }, requirement: { select: { sellerOrderGroup: { select: { sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } } } } } },
    },
  });
  const reinspections = await prisma.inspectionJob.findMany({
    where: { kind: 'REINSPECTION', requirementId: { in: [...new Set(defects.map((defect) => defect.requirementId))] } },
    select: { id: true, jobNumber: true, status: true, requirementId: true, reinspectionOfJobId: true },
  });
  return defects.map((defect) => ({
    id: defect.id,
    ncrNumber: defect.ncrNumber,
    severity: defect.severity,
    description: defect.description,
    status: defect.status,
    requirementRef: defect.requirementRef,
    // The seller's answer is shown as the seller's; nobody but the agency
    // edits the finding itself.
    correctiveAction: defect.correctiveAction,
    sellerResponse: defect.sellerResponse,
    capaSubmittedAt: iso(defect.capaSubmittedAt),
    verifiedAt: iso(defect.verifiedAt),
    jobId: defect.job.id,
    jobNumber: defect.job.jobNumber,
    agencyName: defect.job.agency.name,
    sellerName: defect.job.requirement.sellerOrderGroup.sellerAccount.displayName,
    sellerOrderNumber: defect.job.requirement.sellerOrderGroup.sellerOrderNumber,
    reinspections: reinspections.filter((job) => job.requirementId === defect.requirementId).map(({ requirementId: _r, ...job }) => job),
  }));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function consoleDashboard(member: AuditMember) {
  if (member.inspection !== null) {
    return { audience: 'AGENCY' as const, agency: await agencyDashboard(member.inspection) };
  }
  const now = new Date();
  const [cases, documents, rulesWaiting, rulesApproved, rulesDraft, jobsOpen, jobsOverdue, held, subLots, expiring] = await Promise.all([
    prisma.complianceCase.groupBy({ by: ['status'], _count: true }),
    prisma.sellerCertification.groupBy({ by: ['reviewStatus'], where: { archivedAt: null }, _count: true }),
    prisma.complianceRequirement.count({ where: { status: 'IN_REVIEW' } }),
    prisma.complianceRequirement.count({ where: { status: 'APPROVED' } }),
    prisma.complianceRequirement.count({ where: { status: 'DRAFT' } }),
    prisma.inspectionJob.count({ where: { status: { in: [...OPEN_JOB_STATUSES] as never[] } } }),
    prisma.inspectionJob.count({
      where: { OR: [{ status: 'REQUESTED', acceptDueAt: { lt: now } }, { status: { in: [...OPEN_JOB_STATUSES] as never[] }, reportDueAt: { lt: now } }] },
    }),
    prisma.inspectionRequirement.count({ where: { status: { in: ['FAILED', 'ON_HOLD', 'BLOCKED_BY_NCR'] } } }),
    prisma.inspectionSubLotRelease.count({ where: { state: 'PENDING_APPROVAL' } }),
    prisma.sellerCertification.count({
      where: { reviewStatus: 'APPROVED', archivedAt: null, expiresOn: { lte: new Date(now.getTime() + 30 * 86_400_000), gte: now } },
    }),
  ]);
  const byStatus = <T extends { _count: number }>(rows: T[], key: keyof T) =>
    Object.fromEntries(rows.map((row) => [String(row[key]), row._count])) as Record<string, number>;
  return {
    audience: 'STAFF' as const,
    staff: {
      cases: byStatus(cases, 'status'),
      documents: byStatus(documents, 'reviewStatus'),
      rules: { waitingForApproval: rulesWaiting, approved: rulesApproved, drafts: rulesDraft },
      inspections: { open: jobsOpen, overdue: jobsOverdue, held, subLotsWaiting: subLots },
      documentsExpiringIn30Days: expiring,
    },
  };
}

// ---------------------------------------------------------------------------
// Sellers (staff)
// ---------------------------------------------------------------------------

export async function consoleSellers(filters: { search?: string | null; status?: string | null; health?: HealthBand | null; sort?: 'name' | 'risk' }) {
  const search = filters.search?.trim() ?? '';
  const sellers = await prisma.sellerAccount.findMany({
    where: {
      archivedAt: null,
      ...(search === '' ? {} : { displayName: { contains: search } }),
      ...(filters.status ? { complianceCases: { some: { status: filters.status as never } } } : {}),
    },
    orderBy: { displayName: 'asc' },
    take: 300,
    select: {
      id: true,
      displayName: true,
      kind: true,
      status: true,
      registrationCountry: true,
      complianceCases: { select: { status: true, level: true } },
      certifications: { where: { archivedAt: null }, select: { reviewStatus: true } },
    },
  });
  const health = await sellerHealthMap(sellers.map((seller) => seller.id));
  // The map holds every id asked for; the fallback is a clean record.
  const healthOf = (id: string): SellerHealth => health.get(id) ?? rateSellerHealth({ ...EMPTY_SIGNALS });
  const rows = sellers.map((seller) => ({
    id: seller.id,
    name: seller.displayName,
    kind: seller.kind,
    applicationStatus: seller.status,
    country: seller.registrationCountry,
    qualifications: seller.complianceCases.filter((row) => row.level === 'SELLER_CATEGORY' && row.status === 'QUALIFIED').length,
    casesOpen: seller.complianceCases.filter((row) => ['REQUESTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'REREVIEW_REQUIRED'].includes(row.status)).length,
    documentsWaiting: seller.certifications.filter((row) => row.reviewStatus === 'SUBMITTED' || row.reviewStatus === 'UNDER_REVIEW').length,
    // The list carries the rating and its counts; the issues are on the seller's page.
    rating: healthOf(seller.id),
  }));
  const filtered = filters.health ? rows.filter((row) => row.rating.band === filters.health) : rows;
  if (filters.sort === 'risk') filtered.sort((a, b) => compareHealth(a.rating, b.rating) || a.name.localeCompare(b.name));
  return filtered.map(({ rating, ...row }) => ({
    ...row,
    health: { score: rating.score, band: rating.band, bySeverity: rating.bySeverity, passRatePercent: rating.inspection.passRatePercent },
  }));
}

/**
 * One seller, the four things kept apart: business identity (the existing
 * KYB, read here, decided in the Admin Panel), category qualifications,
 * product cases, and the documents behind them.
 */
export async function consoleSellerDetail(sellerAccountId: string) {
  const seller = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: {
      id: true,
      displayName: true,
      kind: true,
      status: true,
      registrationCountry: true,
      statusReason: true,
      factories: { where: { archivedAt: null }, select: { id: true, name: true, city: true, countryCode: true } },
    },
  });
  if (seller === null) throw notFound('Seller');
  const [trustChecks, screening, cases, documents, health] = await Promise.all([
    prisma.sellerTrustCheck.findMany({
      where: { sellerAccountId, isCurrent: true },
      select: { kind: true, state: true, method: true, issuer: true, checkedAt: true, validUntil: true },
    }),
    prisma.sellerScreeningCheck.findMany({ where: { sellerAccountId }, orderBy: { createdAt: "desc" }, take: 5, select: { state: true, createdAt: true } }),
    prisma.complianceCase.findMany({ where: { sellerAccountId }, orderBy: { updatedAt: 'desc' }, include: { category: { select: { name: true } } } }),
    prisma.sellerCertification.findMany({ where: { sellerAccountId, archivedAt: null }, orderBy: { updatedAt: 'desc' } }),
    sellerHealth(sellerAccountId),
  ]);
  return {
    seller: {
      id: seller.id,
      name: seller.displayName,
      kind: seller.kind,
      applicationStatus: seller.status,
      country: seller.registrationCountry,
      statusReason: seller.statusReason,
    },
    businessIdentity: {
      note: 'Business identity is verified in the Admin Panel (seller application and KYB). Shown here read-only.',
      checks: trustChecks.map((check) => ({ ...check, checkedAt: iso(check.checkedAt), validUntil: iso(check.validUntil) })),
      screening: screening.map((row) => ({ state: row.state, at: iso(row.createdAt) })),
    },
    factories: seller.factories,
    health,
    cases: cases.map((row) => ({
      id: row.id,
      caseNumber: row.caseNumber,
      level: row.level,
      categoryId: row.categoryId,
      categoryName: row.category.name,
      productId: row.productId === '' ? null : row.productId,
      supplyRole: row.supplyRole,
      destinationMarket: row.destinationMarket,
      status: row.status,
      expiresAt: iso(row.expiresAt),
      updatedAt: iso(row.updatedAt),
    })),
    documents: documents.map((row) => ({
      id: row.id,
      standard: row.standard,
      documentType: row.documentType,
      reviewStatus: row.reviewStatus,
      expiresOn: row.expiresOn?.toISOString().slice(0, 10) ?? null,
      issuer: row.issuer,
      requirementCodes: strings(row.requirementCodesJson),
      categoryScopeIds: strings(row.categoryScopeIdsJson),
      revision: row.revision,
      supersededAt: iso(row.supersededAt),
    })),
  };
}
