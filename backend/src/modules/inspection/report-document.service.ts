/**
 * Issued inspection reports: corrections, and the downloadable PDF.
 *
 * PRESERVED, NEVER EDITED. A signed report is frozen - its content, hash and
 * HMAC seal never change. A correction (a typo, a wrong reference, an
 * omitted limitation) is a NEW revision that names the one it corrects and
 * why, signed by the agency's QA reviewer; the corrected report is kept,
 * unchanged, and marked superseded. A correction can never change the result:
 * changing what was found takes a re-inspection.
 *
 * WHAT THE "SIGNATURE" IS. The report records which authenticated account
 * signed it off and when, and the server seals the frozen content with an
 * HMAC so any later change is detectable. That is an integrity seal held by
 * this server - it is NOT a personal cryptographic digital signature, and the
 * PDF says so in those words. A typed name is never presented as one.
 *
 * THE PDF is rendered from the frozen content of a SIGNED report, with the
 * sign-off time as its creation date, so the same report always renders the
 * same file. The buyer's edition leaves out what the buyer view leaves out.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { InspectionAgencyPermission } from '../../domain/inspection-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction } from '../audit/audit.service.js';
import { PdfBuilder } from '../documents/pdf.js';
import { assertInspectionPermission, agencyActor, type InspectionMembership } from './agency.service.js';
import { readPolicy, recordInspectionEvent } from './context.js';
import { loadJobForAgency, reportSignature } from './job.service.js';

function hashOf(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export async function correctReport(
  membership: InspectionMembership,
  reportId: string,
  input: { reason: string; summary?: string | null; limitations?: string | null },
  correlationId?: string | null,
): Promise<{ reportId: string; revision: number }> {
  assertInspectionPermission(membership, InspectionAgencyPermission.REPORT_SIGN);
  const refuse = (code: string, message: string): never => {
    throw conflict(ErrorCode.INSPECTION_CORRECTION_NOT_ALLOWED, message, [{ code }]);
  };
  if (input.reason.trim().length < 20) refuse('REASON_REQUIRED', 'Explain the correction in at least twenty characters.');

  return prisma.$transaction(async (tx) => {
    const original = await tx.inspectionReport.findUnique({ where: { id: reportId } });
    if (original === null) throw notFound('Inspection report');
    const job = await loadJobForAgency(tx, membership, original.jobId);

    if (original.status !== 'SIGNED') refuse('NOT_SIGNED', 'Only an issued report can be corrected.');
    if (original.supersededAt !== null) refuse('ALREADY_SUPERSEDED', 'This report has already been corrected. Correct the latest revision.');
    const inspectors = [job.inspectorMemberId, job.backupInspectorMemberId];
    if (inspectors.includes(membership.memberId) || original.submittedByMemberId === membership.memberId) {
      refuse('SAME_PERSON', 'An inspector on this job cannot issue a correction of its report.');
    }

    const revision = (await tx.inspectionReport.count({ where: { jobId: job.id } })) + 1;
    const id = newId();
    const summary = input.summary === undefined ? original.summary : input.summary?.trim() || null;
    const limitations = input.limitations === undefined ? original.limitations : input.limitations?.trim() || null;
    const content = {
      ...(original.contentJson as Record<string, unknown>),
      summary,
      limitations,
      correction: { correctsRevision: original.revision, correctsReportId: original.id, reason: input.reason.trim() },
    };
    const contentHash = hashOf(content);
    const signedAt = new Date();

    // Claim the original first: two QA reviewers correcting at once must not
    // both succeed.
    const claimed = await tx.inspectionReport.updateMany({
      where: { id: original.id, supersededAt: null },
      data: { supersededAt: signedAt, supersededByReportId: id },
    });
    if (claimed.count !== 1) refuse('ALREADY_SUPERSEDED', 'This report was corrected a moment ago. Reload to see it.');

    await tx.inspectionReport.create({
      data: {
        id,
        jobId: job.id,
        revision,
        status: 'SIGNED',
        result: original.result,
        summary,
        limitations,
        computationJson: original.computationJson as never,
        contentJson: content as never,
        contentHash,
        signature: reportSignature(contentHash, membership.memberId, signedAt),
        submittedAt: signedAt,
        submittedByMemberId: membership.memberId,
        signedAt,
        signedByMemberId: membership.memberId,
        signedByName: membership.fullName,
        publishedToBuyerAt: original.publishedToBuyerAt === null ? null : signedAt,
        correctsReportId: original.id,
        correctionReason: input.reason.trim(),
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'report_corrected',
      actor: agencyActor(membership, correlationId),
      summary: `${job.jobNumber} report revision ${String(original.revision)} corrected by revision ${String(revision)}: ${input.reason.trim()}`,
      data: { reportId: id, correctsReportId: original.id, contentHash },
      audit: AuditAction.INSPECTION_REPORT_CORRECTED,
    });

    return { reportId: id, revision };
  });
}

// ---------------------------------------------------------------------------
// Who may download which report
// ---------------------------------------------------------------------------

export type ReportReader =
  | { kind: 'AGENCY'; membership: InspectionMembership }
  | { kind: 'STAFF' }
  | { kind: 'ADMIN' }
  | { kind: 'SELLER'; sellerAccountId: string }
  | { kind: 'BUYER'; customerProfileId: string };

/** The signed report, if this reader may have it; null (→ 404) otherwise. */
export async function loadReportFor(reader: ReportReader, reportId: string) {
  const report = await prisma.inspectionReport.findUnique({
    where: { id: reportId },
    include: {
      job: {
        select: {
          id: true,
          jobNumber: true,
          agencyId: true,
          inspectorMemberId: true,
          backupInspectorMemberId: true,
          requirement: { select: { orderId: true, sellerAccountId: true, releases: { select: { state: true, kind: true } } } },
          agency: { select: { legalName: true, kind: true } },
        },
      },
    },
  });
  if (report === null || report.status !== 'SIGNED') return null;

  switch (reader.kind) {
    case 'STAFF':
    case 'ADMIN':
      return report;
    case 'AGENCY': {
      const m = reader.membership;
      if (report.job.agencyId !== m.agencyId) return null;
      if (m.assignmentScoped && report.job.inspectorMemberId !== m.memberId && report.job.backupInspectorMemberId !== m.memberId) {
        return null;
      }
      return report;
    }
    case 'SELLER':
      return report.job.requirement.sellerAccountId === reader.sellerAccountId ? report : null;
    case 'BUYER': {
      const order = await prisma.order.findFirst({
        where: { id: report.job.requirement.orderId, customerProfileId: reader.customerProfileId },
        select: { id: true },
      });
      if (order === null) return null;
      const policy = await readPolicy();
      if (policy.buyerReportAccess === 'NONE') return null;
      if (policy.buyerReportAccess === 'BEFORE_RELEASE') return report.publishedToBuyerAt === null ? null : report;
      const released = report.job.requirement.releases.some((release) => release.state === 'ACTIVE');
      return released ? report : null;
    }
  }
}

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

interface Content {
  jobNumber?: string;
  kind?: string;
  stage?: string;
  scopeMethod?: string;
  timezone?: string | null;
  agency?: string;
  agencyKind?: string;
  inspector?: string | null;
  plan?: { name?: string; version?: number; categorySpecific?: boolean };
  inspectionPoint?: { label?: string; city?: string; country?: string };
  scheduledFor?: string;
  startedAt?: string | null;
  standard?: string;
  reinspectionOfJobId?: string | null;
  scope?: { poReference?: string; lines?: { name?: string; sku?: string; variant?: string | null; quantity?: number }[] };
  sampling?: { sampleSize?: number; codeLetter?: string; level?: string; major?: { accept: number; reject: number }; minor?: { accept: number; reject: number } };
  samplingRecord?: { lotReference?: string | null; lotSize?: number; sampledQuantity?: number | null; cartonsOpened?: number | null };
  checks?: { itemCode: string; section: string; label: string; outcome: string; measuredValue?: string | null; note?: string | null; equipmentRef?: string | null; equipmentCalibratedUntil?: string | null }[];
  defects?: { ncrNumber: string; severity: string; originalSeverity: string; requirementRef: string; description: string; defectQuantity: number; unitRefs?: string[] | null }[];
  defectUnits?: { occurrences: { critical: number; major: number; minor: number; total: number }; defectiveUnitsIdentified: number; occurrencesWithoutUnit: number };
  quantities?: {
    unit: string;
    reconciliation: { ordered: string; declared: string | null; verified: string | null; difference: string | null; status: string };
    functional: { tested: string | null; conforming: string | null; nonconforming: string | null; untested: string | null };
    statement: string;
    countingMethod?: string | null;
    observations?: { packaging?: string | null; labelling?: string | null; damage?: string | null };
  } | null;
  labSamples?: { sampleCode: string; description: string; laboratoryName: string | null; laboratoryAccreditation: string | null; resultSummary: string | null; sealNumber: string | null }[];
  evidence?: { id: string; purpose: string; sha256: string; capturedAt: string }[];
  computation?: { result: string; holds?: string[]; reasons?: string[]; scopeMethod?: string };
  summary?: string | null;
  limitations?: string | null;
  correction?: { correctsRevision: number; reason: string };
}

const STAGE_WORDS: Record<string, string> = {
  RAW_MATERIAL: 'Raw-material / incoming inspection',
  DURING_PRODUCTION: 'During-production inspection',
  PRE_SHIPMENT: 'Pre-shipment inspection',
  RECEIVING: 'Receiving inspection',
};
const AGENCY_KIND_WORDS: Record<string, string> = {
  THIRD_PARTY: 'Independent third-party inspection agency',
  INTERNAL: 'Marketplace internal inspection (not independent)',
  SELLER_SELF: 'Seller self-inspection (not independent)',
};
const DISPOSITION_WORDS: Record<string, string> = {
  PASS: 'PASS - accepted under the plan',
  FAIL: 'FAIL - rejected',
  INCONCLUSIVE: 'INCONCLUSIVE - goods on hold',
};

const dateTime = (value: string | Date | null | undefined, timezone: string | null | undefined): string => {
  if (value === null || value === undefined) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  const zone = timezone ?? 'UTC';
  try {
    return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(date)} (${zone})`;
  } catch {
    return `${date.toISOString().replace('T', ' ').slice(0, 16)} (UTC)`;
  }
};

export async function renderReportPdf(
  reportId: string,
  edition: 'FULL' | 'BUYER',
): Promise<{ bytes: Buffer; fileName: string }> {
  const report = await prisma.inspectionReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { job: { select: { jobNumber: true, timezone: true, requirement: { select: { orderId: true, sellerOrderGroup: { select: { sellerOrderNumber: true, sellerAccount: { select: { displayName: true } } } } } } } } },
  });
  const content = report.contentJson as Content;
  const policy = await readPolicy();
  const later = await prisma.inspectionReport.findFirst({
    where: { correctsReportId: report.id },
    select: { revision: true },
  });
  const reinspections = await prisma.inspectionJob.findMany({
    where: { reinspectionOfJobId: report.jobId },
    select: { jobNumber: true, status: true },
  });
  const tz = content.timezone ?? report.job.timezone;
  const signedAt = report.signedAt ?? report.submittedAt;
  const reference = `${content.jobNumber ?? report.job.jobNumber} / rev ${String(report.revision)}`;

  const pdf = new PdfBuilder({
    title: `Inspection report ${reference}`,
    issuedAt: signedAt,
    author: content.agency ?? 'Inspection agency',
    subject: STAGE_WORDS[content.stage ?? 'PRE_SHIPMENT'] ?? 'Inspection report',
    reference,
    watermark: report.supersededAt !== null ? 'SUPERSEDED BY A CORRECTION' : null,
  });

  pdf.title(
    STAGE_WORDS[content.stage ?? 'PRE_SHIPMENT'] ?? 'Inspection report',
    `Report ${content.jobNumber ?? report.job.jobNumber}, revision ${String(report.revision)}${edition === 'BUYER' ? ' - buyer copy' : ''}`,
    DISPOSITION_WORDS[report.result] ?? report.result,
  );

  pdf.facts(
    [
      ['Agency', content.agency ?? '-'],
      ['Independence', AGENCY_KIND_WORDS[content.agencyKind ?? 'THIRD_PARTY'] ?? '-'],
      ['Inspector', content.inspector ?? '-'],
      ['QA sign-off by', report.signedByName ?? '-'],
      ['Signed off', dateTime(signedAt, tz)],
      ['Seller', report.job.requirement.sellerOrderGroup.sellerAccount.displayName],
      ['Seller order', report.job.requirement.sellerOrderGroup.sellerOrderNumber],
      ['Purchase order', content.scope?.poReference ?? '-'],
      ['Lot', content.samplingRecord?.lotReference ?? '-'],
      ['Inspection point', [content.inspectionPoint?.label, content.inspectionPoint?.city, content.inspectionPoint?.country].filter(Boolean).join(', ') || '-'],
      ['Scheduled', dateTime(content.scheduledFor, tz)],
      ['Started', dateTime(content.startedAt, tz)],
      ['Method', content.scopeMethod === 'FULL' ? 'Full inspection - every unit' : 'Sample inspection'],
      ['Plan / checklist version', `${content.plan?.name ?? '-'} v${String(content.plan?.version ?? '-')}${content.plan?.categorySpecific === false ? ' (generic plan, not specific to this category)' : ''}`],
      ['Standard', content.standard ?? '-'],
    ],
    3,
  );

  if (content.correction !== undefined) {
    pdf.paragraph(`Correction of revision ${String(content.correction.correctsRevision)}. Reason: ${content.correction.reason}`, { bold: true });
  }
  if (report.supersededAt !== null) {
    pdf.paragraph(`This revision was superseded by revision ${String(later?.revision ?? '?')} on ${dateTime(report.supersededAt, tz)}. It is kept unchanged for the record.`, { bold: true });
  }
  if (content.kind === 'REINSPECTION') pdf.paragraph('This is a re-inspection after corrective action.', { muted: true });
  if (reinspections.length > 0) {
    pdf.paragraph(`Re-inspections of this job: ${reinspections.map((job) => `${job.jobNumber} (${job.status.toLowerCase()})`).join(', ')}.`, { muted: true });
  }

  pdf.rule();
  pdf.paragraph('Products in scope', { bold: true });
  pdf.table(
    [
      { header: 'Product', weight: 4 },
      { header: 'SKU', weight: 2 },
      { header: 'Ordered', weight: 1, align: 'right' },
    ],
    (content.scope?.lines ?? []).map((line) => [
      [line.name, line.variant].filter(Boolean).join(' - '),
      line.sku ?? '',
      String(line.quantity ?? ''),
    ]),
  );

  // Quantity reconciliation, functional results and the lot disposition are
  // three separate sections, on purpose.
  pdf.paragraph('Quantity reconciliation', { bold: true });
  const q = content.quantities ?? null;
  if (q === null) {
    pdf.paragraph('No quantity record was made on this inspection. The lot was not physically counted for this report.', { muted: true });
  } else {
    pdf.facts(
      [
        ['Unit', q.unit],
        ['Ordered', q.reconciliation.ordered],
        ['Declared by the seller', q.reconciliation.declared ?? 'not declared'],
        ['Physically verified', q.reconciliation.verified ?? 'not verified'],
        ['Shortage (-) / excess (+)', q.reconciliation.difference ?? '-'],
        ['Counting method', q.countingMethod ?? '-'],
      ],
      3,
    );
  }

  pdf.paragraph('Sampling and functional results', { bold: true });
  pdf.facts(
    [
      ['Lot size (ordered units)', String(content.samplingRecord?.lotSize ?? '-')],
      ['Units examined', String(content.samplingRecord?.sampledQuantity ?? '-')],
      ['Required sample size', content.scopeMethod === 'FULL' ? 'every unit' : String(content.sampling?.sampleSize ?? '-')],
      ['Major accept / reject', content.scopeMethod === 'FULL' ? '0 / 1' : `${String(content.sampling?.major?.accept ?? '-')} / ${String(content.sampling?.major?.reject ?? '-')}`],
      ['Minor accept / reject', content.scopeMethod === 'FULL' ? '0 / 1' : `${String(content.sampling?.minor?.accept ?? '-')} / ${String(content.sampling?.minor?.reject ?? '-')}`],
      ['Cartons opened', String(content.samplingRecord?.cartonsOpened ?? '-')],
    ],
    3,
  );
  if (q !== null) pdf.paragraph(q.statement);
  pdf.paragraph(
    content.scopeMethod === 'FULL'
      ? 'Every unit in the lot was examined.'
      : 'A sample result describes the units that were examined. Units that were not examined were not individually verified, and this report does not state that they work.',
    { muted: true },
  );

  pdf.paragraph('Defects', { bold: true });
  const units = content.defectUnits;
  if (units !== undefined) {
    pdf.facts(
      [
        ['Defect occurrences', `${String(units.occurrences.total)} (critical ${String(units.occurrences.critical)}, major ${String(units.occurrences.major)}, minor ${String(units.occurrences.minor)})`],
        ['Defective units identified', String(units.defectiveUnitsIdentified)],
        ['Occurrences not tied to a named unit', String(units.occurrencesWithoutUnit)],
      ],
      3,
    );
  }
  const showDefectText = edition === 'FULL' || policy.buyerNcrVisibility !== 'NONE';
  const defects = (content.defects ?? []).filter(
    (defect) => edition === 'FULL' || policy.buyerNcrVisibility === 'ALL' || defect.severity !== 'MINOR',
  );
  if (showDefectText && defects.length > 0) {
    pdf.table(
      [
        { header: 'NCR', weight: 2 },
        { header: 'Severity', weight: 1 },
        { header: 'Against', weight: 2 },
        { header: 'Description', weight: 5 },
        { header: 'Occurrences', weight: 1, align: 'right' },
        { header: 'Units', weight: 2 },
      ],
      defects.map((defect) => [
        defect.ncrNumber,
        defect.severity === defect.originalSeverity ? defect.severity : `${defect.severity} (was ${defect.originalSeverity})`,
        defect.requirementRef,
        defect.description,
        String(defect.defectQuantity),
        (defect.unitRefs ?? []).join(', '),
      ]),
    );
  } else if (defects.length === 0) {
    pdf.paragraph('No defects recorded.', { muted: true });
  }

  if (edition === 'FULL') {
    pdf.paragraph('Checklist', { bold: true });
    pdf.table(
      [
        { header: 'Code', weight: 2 },
        { header: 'Check', weight: 4 },
        { header: 'Result', weight: 2 },
        { header: 'Measured', weight: 2 },
        { header: 'Instrument', weight: 2 },
        { header: 'Note', weight: 4 },
      ],
      (content.checks ?? []).map((check) => [
        check.itemCode,
        check.label,
        check.outcome.replace('_', ' '),
        check.measuredValue ?? '',
        check.equipmentRef === null || check.equipmentRef === undefined ? '' : `${check.equipmentRef}${check.equipmentCalibratedUntil ? `, cal. to ${String(check.equipmentCalibratedUntil).slice(0, 10)}` : ''}`,
        check.note ?? '',
      ]),
    );

    if ((content.labSamples ?? []).length > 0) {
      pdf.paragraph('Laboratory samples', { bold: true });
      pdf.table(
        [
          { header: 'Sample', weight: 2 },
          { header: 'Description', weight: 4 },
          { header: 'Seal', weight: 2 },
          { header: 'Laboratory', weight: 3 },
          { header: 'Result', weight: 4 },
        ],
        (content.labSamples ?? []).map((sample) => [
          sample.sampleCode,
          sample.description,
          sample.sealNumber ?? '',
          [sample.laboratoryName, sample.laboratoryAccreditation].filter(Boolean).join(' - '),
          sample.resultSummary ?? 'pending',
        ]),
      );
    }

    pdf.paragraph('Evidence', { bold: true });
    pdf.table(
      [
        { header: 'Evidence id', weight: 3 },
        { header: 'Purpose', weight: 2 },
        { header: 'Captured', weight: 3 },
        { header: 'SHA-256', weight: 6 },
      ],
      (content.evidence ?? []).map((item) => [item.id, item.purpose, dateTime(item.capturedAt, tz), item.sha256]),
      { fontSize: 6.5 },
    );
  }

  pdf.rule();
  pdf.paragraph('Lot disposition', { bold: true });
  pdf.paragraph(DISPOSITION_WORDS[report.result] ?? report.result, { bold: true });
  const why = [...(content.computation?.reasons ?? []), ...(content.computation?.holds ?? [])];
  if (why.length > 0) pdf.paragraph(`Decided by: ${why.join(', ')}.`, { muted: true });
  if (content.summary) pdf.paragraph(`Findings: ${content.summary}`);
  pdf.paragraph(`Limitations: ${content.limitations ?? 'None stated by the inspector.'}`);

  pdf.closing({
    qrPng: null,
    qrCaption: null,
    signatures: [
      { heading: 'Inspected by', lines: [content.inspector ?? '-', content.agency ?? ''] },
      { heading: 'QA sign-off', lines: [report.signedByName ?? '-', dateTime(signedAt, tz)] },
      {
        heading: 'Integrity',
        lines: [
          `Content SHA-256 ${report.contentHash.slice(0, 16)}...`,
          'Sealed by the server (HMAC). Not a personal digital signature.',
        ],
      },
    ],
  });
  pdf.paragraph(
    'This report records an inspection carried out by the people named above. The software that produced it does not inspect goods, does not grant accreditation and does not replace any regulatory approval.',
    { muted: true, size: 7 },
  );

  const { bytes } = await pdf.finish();
  return { bytes, fileName: `inspection-${(content.jobNumber ?? report.job.jobNumber).replace(/[^A-Za-z0-9-]/g, '')}-rev${String(report.revision)}.pdf` };
}
