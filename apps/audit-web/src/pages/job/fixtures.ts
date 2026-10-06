/**
 * Job detail answers for tests, built field by field.
 *
 * `agencyJobFixture` is what an agency member reads from GET /audit/jobs/:id;
 * `staffJobFixture` is what audit staff read. Overrides are shallow per part
 * (`job`, `me`, `extras`), so a test changes only what it asserts on.
 */
import type {
  AgencyJobDetail,
  JobExtras,
  JobView,
  StaffJobDetail,
} from '@/lib/console-types';

export const FIXTURE_JOB_ID = '01JOBFIXTURE00000000000001';

export function jobViewFixture(overrides: Partial<JobView> = {}): JobView {
  return {
    id: FIXTURE_JOB_ID,
    jobNumber: 'INS-2026-000123',
    kind: 'INITIAL',
    reinspectionOfJobId: null,
    status: 'IN_PROGRESS',
    agency: { id: 'agency-a', name: 'Northgate Inspection' },
    payer: 'SELLER',
    bookedByParty: 'OPERATOR',
    bookedByLabel: 'Audit team',
    inspectionPointType: 'SELLER_PREMISES',
    inspectionPoint: { name: 'Plant 2', city: 'Pune', country: 'IN' },
    scheduledFor: '2026-10-08T03:30:00.000Z',
    language: 'en',
    standard: 'Medical consumables v1 - MIL-STD-105E / ANSI/ASQ Z1.4 single sampling, level II, AQL 0/2.5/4.0',
    lotSize: 5000,
    sampling: {
      lotSize: 5000,
      level: 'II',
      codeLetter: 'L',
      sampleSize: 200,
      critical: { aql: '0', sampleSize: 200, accept: 0, reject: 1 },
      major: { aql: '2.5', sampleSize: 200, accept: 10, reject: 11 },
      minor: { aql: '4.0', sampleSize: 200, accept: 14, reject: 15 },
    },
    scope: {
      orderNumber: 'ORD-1001',
      sellerOrderNumber: 'SO-1001-1',
      poReference: 'PO-77',
      referenceSample: null,
      specialRequirements: null,
      lines: [
        {
          orderItemId: '01ORDERITEM000000000000001',
          name: 'IV cannula 22G',
          sku: 'IVC-22',
          variant: null,
          quantity: 5000,
          orderingUnit: 'PIECE',
          unitQuantity: 5000,
        },
      ],
    },
    readiness: null,
    readinessSubmittedAt: '2026-10-06T10:00:00.000Z',
    acceptDueAt: '2026-10-07T10:00:00.000Z',
    reportDueAt: '2026-10-10T10:00:00.000Z',
    acceptedAt: '2026-10-06T11:00:00.000Z',
    assignedAt: '2026-10-06T12:00:00.000Z',
    startedAt: '2026-10-08T03:35:00.000Z',
    submittedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    declineReason: null,
    inspector: { fullName: 'Asha Rao', idDocumentType: 'PASSPORT', idDocumentNumber: null, identityVerified: true },
    samplingRecord: { lotReference: null, sampledQuantity: null, acceptedQuantity: null, rejectedQuantity: null, cartonsOpened: null },
    checks: [],
    reports: [],
    report: null,
    defects: [],
    evidence: [],
    ...overrides,
  };
}

export function extrasFixture(overrides: Partial<JobExtras> = {}): JobExtras {
  return {
    stage: 'PRE_SHIPMENT',
    scopeMethod: 'SAMPLE',
    timezone: 'Asia/Kolkata',
    agencyName: 'Northgate Inspection',
    agencyKind: 'THIRD_PARTY',
    quantities: null,
    defectUnits: {
      occurrences: { critical: 0, major: 0, minor: 0, total: 0 },
      defectiveUnitsIdentified: 0,
      defectiveUnitsByWorstSeverity: { critical: 0, major: 0, minor: 0 },
      occurrencesWithoutUnit: 0,
    },
    labSamples: [],
    reports: [],
    subLots: [],
    ...overrides,
  };
}

const requirement = {
  id: '01REQUIREMENT0000000000001',
  orderNumber: 'ORD-1001',
  sellerOrderNumber: 'SO-1001-1',
  sellerName: 'Sikka Pvt Ltd',
  level: 'MANDATORY',
  status: 'IN_PROGRESS',
  gate: { allowed: false, sentence: 'Dispatch is held until the inspection report is signed.' },
  reason: null,
  ruleName: 'Medical devices',
  purchaseOrder: null,
  referenceSample: null,
};

const gate = {
  required: true,
  released: false,
  reason: 'INSPECTION_IN_PROGRESS',
  sentence: 'Dispatch is held until the inspection report is signed.',
};

export function agencyJobFixture(
  overrides: {
    job?: Partial<JobView>;
    me?: Partial<AgencyJobDetail['me']>;
    extras?: Partial<JobExtras>;
  } & Partial<Omit<AgencyJobDetail, 'job' | 'me' | 'extras' | 'audience'>> = {},
): AgencyJobDetail {
  const { job, me, extras, ...rest } = overrides;
  return {
    audience: 'AGENCY',
    job: jobViewFixture(job),
    requirement,
    gate,
    checklist: [
      { code: 'PROD.IDENTITY', section: 'PRODUCT', label: 'Product identity matches the order', kind: 'VISUAL', mandatory: true },
      {
        code: 'PROD.DIMENSIONS',
        section: 'PRODUCT',
        label: 'Dimensions within tolerance',
        tolerance: '±0.1 mm',
        kind: 'DIMENSION',
        requiresEquipment: true,
      },
      { code: 'PACK.OUTER', section: 'PACKAGING', label: 'Outer carton condition', kind: 'PACKAGING' },
    ],
    conflictCheck: { agencyProblems: [], personalConflict: false, declarations: [] },
    me: {
      memberId: 'member-inspector',
      role: 'INSPECTOR',
      isNamedInspector: true,
      allowedTransitions: [{ to: 'REPORT_SUBMITTED', requiresReason: false }],
      ...me,
    },
    eligibleInspectors: [],
    consignments: [],
    extras: extrasFixture(extras),
    ...rest,
  };
}

export function staffJobFixture(
  overrides: { job?: Partial<JobView>; extras?: Partial<JobExtras> } & Partial<
    Omit<StaffJobDetail, 'job' | 'extras' | 'audience'>
  > = {},
): StaffJobDetail {
  const { job, extras, ...rest } = overrides;
  return {
    audience: 'STAFF',
    job: jobViewFixture(job),
    requirement,
    gate,
    releases: [],
    timeline: [
      {
        id: 'event-1',
        kind: 'job_booked',
        actorParty: 'OPERATOR',
        actorLabel: 'Audit team',
        summary: 'Inspection booked with Northgate Inspection.',
        jobId: FIXTURE_JOB_ID,
        createdAt: '2026-10-06T09:00:00.000Z',
      },
    ],
    checklist: [],
    extras: extrasFixture(extras),
    ...rest,
  };
}
