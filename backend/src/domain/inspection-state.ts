/**
 * Inspection job states, the report result, and who may decide what.
 *
 * Same rule as the order, schedule and seller machines: no service writes
 * `InspectionJob.status` directly. Every change goes through
 * `assertInspectionJobTransition`, and the rules table below is also what the
 * screens render their buttons from, so a button that appears is a button that
 * works.
 *
 * The result of a report is never typed by a person either. It is computed by
 * `computeInspectionResult` from the defects recorded against the sampling the
 * plan fixed at booking - critical defects fail automatically, majors and
 * minors against their accept numbers (INSPECT-001, INSPECT-002).
 */
import { z } from 'zod';
import { ErrorCode, conflict } from './errors.js';
import type { SamplingPlan } from './inspection-aql.js';

export const InspectionJobStatusValues = [
  'REQUESTED',
  'ACCEPTED',
  'DECLINED',
  'INSPECTOR_ASSIGNED',
  'IN_PROGRESS',
  'REPORT_SUBMITTED',
  'COMPLETED',
  'CANCELLED',
] as const;

export type InspectionJobStatusName = (typeof InspectionJobStatusValues)[number];

/**
 * Who asks for a move. AGENCY_COORDINATOR is an agency admin or coordinator;
 * INSPECTOR is the named inspector on the job; QA is the agency's QA reviewer,
 * who must not be the inspector who wrote the report.
 */
export type InspectionJobActor = 'AGENCY_COORDINATOR' | 'INSPECTOR' | 'QA' | 'BOOKER' | 'OPERATOR' | 'SYSTEM';

interface JobRule {
  to: InspectionJobStatusName;
  actors: readonly InspectionJobActor[];
  requiresReason?: boolean;
}

const JOB_TRANSITIONS: Readonly<Record<InspectionJobStatusName, readonly JobRule[]>> = Object.freeze({
  REQUESTED: [
    { to: 'ACCEPTED', actors: ['AGENCY_COORDINATOR'] },
    { to: 'DECLINED', actors: ['AGENCY_COORDINATOR'], requiresReason: true },
    { to: 'CANCELLED', actors: ['BOOKER', 'OPERATOR'], requiresReason: true },
  ],
  ACCEPTED: [
    { to: 'INSPECTOR_ASSIGNED', actors: ['AGENCY_COORDINATOR'] },
    { to: 'CANCELLED', actors: ['OPERATOR'], requiresReason: true },
  ],
  INSPECTOR_ASSIGNED: [
    { to: 'IN_PROGRESS', actors: ['INSPECTOR'] },
    { to: 'CANCELLED', actors: ['OPERATOR'], requiresReason: true },
  ],
  IN_PROGRESS: [
    { to: 'REPORT_SUBMITTED', actors: ['INSPECTOR'] },
    { to: 'CANCELLED', actors: ['OPERATOR'], requiresReason: true },
  ],
  REPORT_SUBMITTED: [
    // QA sends it back to the inspector: incomplete, a calculation wrong.
    { to: 'IN_PROGRESS', actors: ['QA'], requiresReason: true },
    { to: 'COMPLETED', actors: ['QA'] },
  ],
  // Final. A correction is a re-inspection, never an edit.
  COMPLETED: [],
  DECLINED: [],
  CANCELLED: [],
});

/** Jobs still under way - the ones that stop a second booking. */
export const OPEN_JOB_STATUSES: readonly InspectionJobStatusName[] = Object.freeze([
  'REQUESTED',
  'ACCEPTED',
  'INSPECTOR_ASSIGNED',
  'IN_PROGRESS',
  'REPORT_SUBMITTED',
]);

export function allowedInspectionJobTransitions(
  from: InspectionJobStatusName,
  actor: InspectionJobActor,
): { to: InspectionJobStatusName; requiresReason: boolean }[] {
  return (JOB_TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

export function assertInspectionJobTransition(request: {
  from: InspectionJobStatusName;
  to: InspectionJobStatusName;
  actor: InspectionJobActor;
  reason?: string | null;
}): void {
  const { from, to, actor } = request;

  if (from === to) {
    throw conflict(ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED, `This inspection is already ${to}.`, [
      { code: 'SAME_STATUS', meta: { from, to } },
    ]);
  }

  const rule = (JOB_TRANSITIONS[from] ?? []).find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED,
      `An inspection cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED,
      `That role cannot move an inspection from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  const reason = request.reason ?? null;
  if (rule.requiresReason === true && (reason === null || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.INSPECTION_JOB_TRANSITION_NOT_ALLOWED,
      `Moving an inspection to ${to} needs a reason.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }
}

// ---------------------------------------------------------------------------
// The plan's checklist
// ---------------------------------------------------------------------------

/**
 * Checklist sections. PRODUCT covers identity, dimensions, workmanship,
 * functional tests and the reference sample; QUANTITY is the count; PACKAGING
 * and LABELLING are the export pack and its marks.
 */
export const CHECKLIST_SECTIONS = ['PRODUCT', 'QUANTITY', 'PACKAGING', 'LABELLING'] as const;

/**
 * Kinds of check, for category-specific checklists: function and performance,
 * dimensions and tolerances, material composition or grade (only with
 * laboratory evidence), weight/count/volume, labelling, packaging, batch /
 * serial / expiry details, and visual workmanship.
 */
export const CHECK_KINDS = [
  'FUNCTION',
  'DIMENSION',
  'MATERIAL',
  'WEIGHT_COUNT_VOLUME',
  'LABELLING',
  'PACKAGING',
  'BATCH_SERIAL_EXPIRY',
  'VISUAL',
  'OTHER',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

export const checklistItemSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[A-Z0-9_.-]+$/i),
  section: z.enum(CHECKLIST_SECTIONS),
  label: z.string().trim().min(1).max(255),
  requirement: z.string().trim().max(512).nullable().optional(),
  tolerance: z.string().trim().max(128).nullable().optional(),
  /** What kind of check this is, so a category's checklist reads by kind. */
  kind: z.enum(CHECK_KINDS).optional(),
  /**
   * A mandatory line must actually be performed: answering it NOT_APPLICABLE
   * makes the result INCONCLUSIVE rather than letting the lot pass on a check
   * nobody did. Absent is "not mandatory", which is how every plan written
   * before this flag existed keeps behaving exactly as it did.
   */
  mandatory: z.boolean().optional(),
  /** The line needs a laboratory report attached to its result. */
  requiresLabReport: z.boolean().optional(),
  /** The line needs the instrument and its calibration date recorded. */
  requiresEquipment: z.boolean().optional(),
});

export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const checklistSchema = z
  .array(checklistItemSchema)
  .min(1)
  .max(120)
  .refine((items) => new Set(items.map((item) => item.code.toUpperCase())).size === items.length, {
    message: 'Each checklist line needs its own code.',
  });

/**
 * The checklist a new plan starts from. Written as the brief lists the checks:
 * product identity, quantity, dimensions, workmanship, function, reference
 * sample, inner and outer packing, carton quantity, pallet, shipping marks,
 * barcode, destination labels and hazard symbols. An operator edits it per
 * category.
 */
export const DEFAULT_CHECKLIST: readonly ChecklistItem[] = Object.freeze([
  { code: 'PROD.IDENTITY', section: 'PRODUCT', label: 'Product identity matches the order and specification' },
  { code: 'PROD.DIMENSIONS', section: 'PRODUCT', label: 'Dimensions within tolerance', tolerance: 'As specified' },
  { code: 'PROD.WORKMANSHIP', section: 'PRODUCT', label: 'Workmanship and finish' },
  { code: 'PROD.FUNCTION', section: 'PRODUCT', label: 'Functional test' },
  { code: 'PROD.REFERENCE', section: 'PRODUCT', label: 'Matches the approved reference sample' },
  { code: 'QTY.COUNT', section: 'QUANTITY', label: 'Quantity ready matches the order' },
  { code: 'PACK.INNER', section: 'PACKAGING', label: 'Inner packaging' },
  { code: 'PACK.OUTER', section: 'PACKAGING', label: 'Outer carton condition' },
  { code: 'PACK.CARTON_QTY', section: 'PACKAGING', label: 'Units per carton as declared' },
  { code: 'PACK.PALLET', section: 'PACKAGING', label: 'Palletisation and wrapping' },
  { code: 'LABEL.SHIPPING_MARKS', section: 'LABELLING', label: 'Shipping marks' },
  { code: 'LABEL.BARCODE', section: 'LABELLING', label: 'Barcode present and scans' },
  { code: 'LABEL.DESTINATION', section: 'LABELLING', label: 'Destination labels and language' },
  { code: 'LABEL.HAZARD', section: 'LABELLING', label: 'Fragile or hazard symbols where applicable' },
] as ChecklistItem[]);

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface DefectCount {
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  defectQuantity: number;
}

export interface InspectionComputation {
  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  /** FULL: every unit examined, zero acceptance. SAMPLE: the plan's numbers. */
  scopeMethod: 'FULL' | 'SAMPLE';
  /** Why the result is INCONCLUSIVE, when it is. Empty otherwise. */
  holds: string[];
  counts: { critical: number; major: number; minor: number };
  limits: {
    critical: { accept: number; reject: number };
    major: { accept: number; reject: number };
    minor: { accept: number; reject: number };
  };
  /** Checklist lines that did not conform, which fail the report too. */
  nonconformingChecks: number;
  reasons: string[];
}

/**
 * PASS or FAIL, from the facts.
 *
 * - Any critical defect fails the lot, whatever the critical AQL says. A
 *   critical can only stop failing it by being reclassified by the agency's QA
 *   reviewer, with a reason and evidence - which changes the defect, not this
 *   rule.
 * - Majors and minors fail at or above their reject numbers.
 * - A checklist line marked non-conforming fails it: a label in the wrong
 *   language is not something a defect count should be allowed to absorb.
 */
export function computeInspectionResult(input: {
  sampling: Pick<SamplingPlan, 'critical' | 'major' | 'minor'>;
  defects: readonly DefectCount[];
  nonconformingChecks: number;
  /**
   * SAMPLE (the default) applies the plan's accept/reject numbers to the
   * sample. FULL examined every unit, so no sampling allowance applies: any
   * defect fails the lot unless an approved plan says otherwise - and no plan
   * field says otherwise yet, so it is zero.
   */
  scopeMethod?: 'FULL' | 'SAMPLE';
  /**
   * Reasons the evidence cannot support a decision either way: a mandatory
   * line not performed, a laboratory result outstanding. A FAIL still wins -
   * a lot already shown to be bad is bad - but nothing with a hold can PASS.
   */
  holds?: readonly string[];
}): InspectionComputation {
  const scopeMethod = input.scopeMethod ?? 'SAMPLE';
  const holds = [...(input.holds ?? [])];
  const sum = (severity: DefectCount['severity']): number =>
    input.defects
      .filter((defect) => defect.severity === severity)
      .reduce((total, defect) => total + Math.max(1, defect.defectQuantity), 0);

  const counts = { critical: sum('CRITICAL'), major: sum('MAJOR'), minor: sum('MINOR') };
  const reasons: string[] = [];

  const limits =
    scopeMethod === 'FULL'
      ? {
          critical: { accept: 0, reject: 1 },
          major: { accept: 0, reject: 1 },
          minor: { accept: 0, reject: 1 },
        }
      : {
          critical: { accept: 0, reject: 1 },
          major: { accept: input.sampling.major.accept, reject: input.sampling.major.reject },
          minor: { accept: input.sampling.minor.accept, reject: input.sampling.minor.reject },
        };

  if (counts.critical > 0) reasons.push('CRITICAL_DEFECT');
  if (counts.major >= limits.major.reject) reasons.push('MAJOR_OVER_LIMIT');
  if (counts.minor >= limits.minor.reject) reasons.push('MINOR_OVER_LIMIT');
  if (input.nonconformingChecks > 0) reasons.push('CHECKLIST_NONCONFORMING');

  return {
    result: reasons.length > 0 ? 'FAIL' : holds.length > 0 ? 'INCONCLUSIVE' : 'PASS',
    scopeMethod,
    holds,
    counts,
    limits,
    nonconformingChecks: input.nonconformingChecks,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Two people for a conditional release
// ---------------------------------------------------------------------------

/**
 * A conditional release is decided by two different people.
 *
 * The requester names the reason and attaches the evidence; a second person
 * with the same authority approves it. The same person pressing both buttons
 * is refused here, whatever permissions they hold (INSPECT-006).
 */
export function assertSecondApprover(requestedById: string | null, approverId: string): void {
  if (requestedById !== null && requestedById === approverId) {
    throw conflict(
      ErrorCode.INSPECTION_SELF_APPROVAL_FORBIDDEN,
      'A conditional release needs a second person. You requested this one, so somebody else must approve it.',
      [{ code: 'SAME_PERSON' }],
    );
  }
}
