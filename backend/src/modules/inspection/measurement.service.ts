/**
 * What the inspector counted, measured, tested and sent to a laboratory.
 *
 * Recorded only by the inspector named on the job, only while it is in
 * progress - the same rule as every other finding. Quantities are exact
 * decimals (see `domain/inspection-quantity.ts`); nothing here touches money.
 *
 * Nothing in this file changes warehouse stock. An inspection report is a
 * statement about goods, not a goods-received note: counting 5,000 units at a
 * factory does not put 5,000 units into any warehouse.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  COUNTING_METHODS,
  QUANTITY_UNITS,
  isCountable,
  summariseQuantities,
  toMilli,
  validateQuantities,
  type CountingMethod,
  type PackagingConversion,
  type QuantityUnitName,
} from '../../domain/inspection-quantity.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { InspectionMembership } from './agency.service.js';
import { agencyActor } from './agency.service.js';
import { recordInspectionEvent } from './context.js';
import { assertInProgress, assertIsNamedInspector, loadJobForAgency } from './job.service.js';

export { COUNTING_METHODS, QUANTITY_UNITS };

export interface QuantityRecordInput {
  unit: QuantityUnitName;
  /** Defaults to the ordered quantity frozen into the job's scope. */
  orderedQuantity?: string | null;
  declaredQuantity?: string | null;
  verifiedQuantity?: string | null;
  countingMethod?: CountingMethod | null;
  countingNote?: string | null;
  packaging?: PackagingConversion[] | null;
  sampledQuantity?: string | null;
  functionallyTestedQuantity?: string | null;
  testedConformingQuantity?: string | null;
  testedNonconformingQuantity?: string | null;
  damagedQuantity?: string | null;
  packagingObservations?: string | null;
  labelingObservations?: string | null;
  damageObservations?: string | null;
}

const clean = (value: string | null | undefined, max: number): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
};

/** Record (or correct, while the job is open) the job's quantity record. */
export async function recordQuantities(
  membership: InspectionMembership,
  jobId: string,
  input: QuantityRecordInput,
  correlationId?: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);

    if (input.countingMethod === 'DECLARED_ONLY' && clean(input.verifiedQuantity, 32) !== null) {
      throw badRequest(ErrorCode.INSPECTION_QUANTITY_INVALID, 'A quantity that was only declared was not physically verified.', [
        { field: 'verifiedQuantity', code: 'DECLARED_NOT_VERIFIED' },
      ]);
    }

    const ordered = clean(input.orderedQuantity, 32) ?? String(job.lotSize);
    const parsed = validateQuantities({
      unit: input.unit,
      scopeMethod: job.scopeMethod,
      orderedQuantity: ordered,
      declaredQuantity: input.declaredQuantity,
      verifiedQuantity: input.verifiedQuantity,
      countingMethod: input.countingMethod ?? null,
      packaging: input.packaging ?? null,
      sampledQuantity: input.sampledQuantity,
      functionallyTestedQuantity: input.functionallyTestedQuantity,
      testedConformingQuantity: input.testedConformingQuantity,
      testedNonconformingQuantity: input.testedNonconformingQuantity,
      damagedQuantity: input.damagedQuantity,
    });

    const decimal = (value: string | null | undefined): string | null => {
      const trimmed = clean(value, 32);
      return trimmed === null ? null : trimmed;
    };
    const data = {
      unit: input.unit,
      orderedQuantity: ordered,
      declaredQuantity: decimal(input.declaredQuantity),
      verifiedQuantity: decimal(input.verifiedQuantity),
      countingMethod: input.countingMethod ?? null,
      countingNote: clean(input.countingNote, 1024),
      packagingJson: input.packaging === null || input.packaging === undefined ? undefined : (input.packaging as never),
      sampledQuantity: decimal(input.sampledQuantity),
      functionallyTestedQuantity: decimal(input.functionallyTestedQuantity),
      testedConformingQuantity: decimal(input.testedConformingQuantity),
      testedNonconformingQuantity: decimal(input.testedNonconformingQuantity),
      damagedQuantity: decimal(input.damagedQuantity),
      packagingObservations: clean(input.packagingObservations, 4000),
      labelingObservations: clean(input.labelingObservations, 4000),
      damageObservations: clean(input.damageObservations, 4000),
      recordedByMemberId: membership.memberId,
    };

    await tx.inspectionQuantityRecord.upsert({
      where: { jobId: job.id },
      create: { id: newId(), jobId: job.id, ...data },
      update: { ...data, lockVersion: { increment: 1 } },
    });

    const summary = summariseQuantities(parsed);
    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'quantities_recorded',
      actor: agencyActor(membership, correlationId),
      summary: `Quantities recorded: ${summary.reconciliation.status.toLowerCase().replace('_', ' ')}. ${summary.statement}`,
      data: { reconciliation: summary.reconciliation, functional: summary.functional },
      visibleToBuyer: false,
      visibleToSeller: false,
    });

    return summary;
  });
}

// ---------------------------------------------------------------------------
// Laboratory samples and their chain of custody
// ---------------------------------------------------------------------------

export interface CustodyEntry {
  at: string;
  from: string;
  to: string;
  note: string | null;
  byLabel: string;
}

function custodyOf(value: unknown): CustodyEntry[] {
  return Array.isArray(value) ? (value as CustodyEntry[]) : [];
}

export async function addLabSample(
  membership: InspectionMembership,
  jobId: string,
  input: {
    sampleCode: string;
    description: string;
    quantity?: string | null;
    unit?: QuantityUnitName | null;
    sealNumber?: string | null;
    takenAt: Date;
    laboratoryName?: string | null;
    laboratoryAccreditation?: string | null;
  },
  correlationId?: string | null,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);

    const quantity = clean(input.quantity, 32);
    if (quantity !== null) {
      const milli = toMilli(quantity, 'quantity');
      if (input.unit !== null && input.unit !== undefined && isCountable(input.unit) && milli % 1000n !== 0n) {
        throw badRequest(ErrorCode.INSPECTION_QUANTITY_INVALID, 'A counted sample is a whole number.', [{ field: 'quantity', code: 'NOT_WHOLE' }]);
      }
    }
    if (input.takenAt.getTime() > Date.now() + 5 * 60_000) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A sample cannot be taken in the future.', [{ field: 'takenAt', code: 'IN_FUTURE' }]);
    }

    const code = input.sampleCode.trim().toUpperCase().slice(0, 64);
    const taken = await tx.inspectionLabSample.findUnique({ where: { jobId_sampleCode: { jobId: job.id, sampleCode: code } } });
    if (taken !== null) {
      throw conflict(ErrorCode.CONFLICT, 'That sample code is already used on this inspection.', [{ field: 'sampleCode', code: 'DUPLICATE' }]);
    }

    const id = newId();
    await tx.inspectionLabSample.create({
      data: {
        id,
        jobId: job.id,
        sampleCode: code,
        description: input.description.trim().slice(0, 1024),
        quantity,
        unit: input.unit ?? null,
        sealNumber: clean(input.sealNumber, 64),
        takenAt: input.takenAt,
        takenByMemberId: membership.memberId,
        laboratoryName: clean(input.laboratoryName, 255),
        laboratoryAccreditation: clean(input.laboratoryAccreditation, 255),
        custodyJson: [
          {
            at: input.takenAt.toISOString(),
            from: 'Lot',
            to: membership.fullName,
            note: 'Sample taken and identified.',
            byLabel: membership.fullName,
          },
        ] satisfies CustodyEntry[],
      },
    });

    await recordInspectionEvent(tx, {
      requirementId: job.requirementId,
      orderId: job.requirement.orderId,
      jobId: job.id,
      kind: 'lab_sample_taken',
      actor: agencyActor(membership, correlationId),
      summary: `Laboratory sample ${code} taken${input.sealNumber ? ` under seal ${input.sealNumber.trim()}` : ''}.`,
      data: { sampleCode: code },
      visibleToBuyer: false,
      visibleToSeller: false,
    });
    return { id };
  });
}

/** Append one hand-over to a sample's chain of custody. Entries are never edited. */
export async function addCustodyEvent(
  membership: InspectionMembership,
  jobId: string,
  sampleId: string,
  input: { at: Date; from: string; to: string; note?: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);
    const sample = await tx.inspectionLabSample.findFirst({ where: { id: sampleId, jobId: job.id } });
    if (sample === null) throw notFound('Laboratory sample');

    const custody = custodyOf(sample.custodyJson);
    const last = custody[custody.length - 1];
    if (last !== undefined && new Date(last.at).getTime() > input.at.getTime()) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A hand-over cannot be earlier than the one before it.', [{ field: 'at', code: 'OUT_OF_ORDER' }]);
    }
    custody.push({
      at: input.at.toISOString(),
      from: input.from.trim().slice(0, 160),
      to: input.to.trim().slice(0, 160),
      note: clean(input.note, 500),
      byLabel: membership.fullName,
    });
    await tx.inspectionLabSample.update({ where: { id: sample.id }, data: { custodyJson: custody as never } });
  });
}

/** The laboratory's report, attached as evidence on this job, and what it says. */
export async function recordLabResult(
  membership: InspectionMembership,
  jobId: string,
  sampleId: string,
  input: { labReportEvidenceId: string; resultSummary: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await loadJobForAgency(tx, membership, jobId);
    assertIsNamedInspector(membership, job);
    assertInProgress(job);
    const sample = await tx.inspectionLabSample.findFirst({ where: { id: sampleId, jobId: job.id } });
    if (sample === null) throw notFound('Laboratory sample');
    const evidence = await tx.inspectionEvidence.findFirst({
      where: { id: input.labReportEvidenceId, jobId: job.id, mediaKind: 'DOCUMENT' },
      select: { id: true },
    });
    if (evidence === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach the laboratory report to this inspection first.', [
        { field: 'labReportEvidenceId', code: 'NOT_ON_JOB' },
      ]);
    }
    await tx.inspectionLabSample.update({
      where: { id: sample.id },
      data: { labReportEvidenceId: evidence.id, resultSummary: input.resultSummary.trim().slice(0, 4000) },
    });
  });
}
