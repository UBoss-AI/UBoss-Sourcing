/**
 * Shipment Assessment: the Audit Team's check between L1 and L2.
 *
 *   L1 complete -> requirement evaluated -> physical assessment OR waiver
 *   review -> QA / waiver approval -> final loading checks -> L2 may start.
 *
 * Every rule is a pure function here, so the Audit Console, the Seller Hub,
 * the carrier portal, the worker and the L2 gate cannot come to different
 * answers. Status changes go through `assertAssessmentTransition` only.
 *
 * What this file deliberately does NOT do:
 *  - invent a risk score or an automatic threshold. A Gold waiver is a
 *    person's documented judgement of the history they were shown;
 *  - waive anything by itself. Eligibility is a question for an auditor;
 *  - allow part of a shipment to go. There is no partial release.
 */
import { createHash } from 'node:crypto';

export const BADGE_TIERS = ['PLATINUM', 'GOLD', 'SILVER', 'BRONZE'] as const;
export type BadgeTier = (typeof BADGE_TIERS)[number];

/** Highest first. A move to a later index is a downgrade. */
export function isBadgeDowngrade(from: BadgeTier | null, to: BadgeTier | null): boolean {
  if (from === null) return false;
  if (to === null) return true;
  return BADGE_TIERS.indexOf(to) > BADGE_TIERS.indexOf(from);
}

export type BadgeRule = 'WAIVER_ELIGIBLE' | 'WAIVER_ELIGIBLE_WITH_REVIEW' | 'ASSESSMENT_REQUIRED';
export type Requirement = BadgeRule;

export interface BadgePolicy {
  version: number;
  platinumRule: BadgeRule;
  goldRule: BadgeRule;
  silverRule: BadgeRule;
  bronzeRule: BadgeRule;
  unbadgedRule: BadgeRule;
  defaultDispatchDays: number | null;
  maxDispatchDays: number | null;
  sellerCertificateMonths: number;
}

/** Why a policy draft is refused, or null. */
export function policyProblem(policy: Omit<BadgePolicy, 'version'>): string | null {
  if (policy.unbadgedRule !== 'ASSESSMENT_REQUIRED') return 'UNBADGED_MUST_REQUIRE_ASSESSMENT';
  if (policy.defaultDispatchDays !== null && (policy.defaultDispatchDays < 1 || policy.defaultDispatchDays > 365)) return 'DISPATCH_DAYS_RANGE';
  if (policy.maxDispatchDays !== null && (policy.maxDispatchDays < 1 || policy.maxDispatchDays > 365)) return 'DISPATCH_DAYS_RANGE';
  if (policy.defaultDispatchDays !== null && policy.maxDispatchDays !== null && policy.defaultDispatchDays > policy.maxDispatchDays) return 'DEFAULT_ABOVE_MAX';
  if (policy.sellerCertificateMonths < 1 || policy.sellerCertificateMonths > 36) return 'CERTIFICATE_MONTHS_RANGE';
  return null;
}

export function ruleFor(policy: BadgePolicy, badge: BadgeTier | null): BadgeRule {
  switch (badge) {
    case 'PLATINUM':
      return policy.platinumRule;
    case 'GOLD':
      return policy.goldRule;
    case 'SILVER':
      return policy.silverRule;
    case 'BRONZE':
      return policy.bronzeRule;
    default:
      // A missing or unrecognised badge needs assessment, whatever a policy says.
      return 'ASSESSMENT_REQUIRED';
  }
}

export interface RequirementFacts {
  badge: BadgeTier | null;
  policy: BadgePolicy;
  /** A regulatory, contractual or buyer-requested inspection applies. */
  mandatoryInspection: boolean;
  mandatoryReason: string | null;
  /** False when the inspection requirement could not be read. */
  applicabilityKnown: boolean;
  sellerSuspended: boolean;
}

export interface RequirementVerdict {
  requirement: Requirement;
  reason: string;
}

/** What the policy says about one shipment. Never itself a waiver. */
export function evaluateRequirement(facts: RequirementFacts): RequirementVerdict {
  if (facts.sellerSuspended) return { requirement: 'ASSESSMENT_REQUIRED', reason: 'The seller is suspended.' };
  if (facts.mandatoryInspection) {
    return { requirement: 'ASSESSMENT_REQUIRED', reason: `A mandatory inspection applies: ${facts.mandatoryReason ?? 'required inspection'}. It cannot be waived.` };
  }
  if (!facts.applicabilityKnown) {
    return { requirement: 'ASSESSMENT_REQUIRED', reason: 'Whether a mandatory inspection applies could not be determined, so no waiver is offered.' };
  }
  const rule = ruleFor(facts.policy, facts.badge);
  const badge = facts.badge === null ? 'No Audit badge' : `${facts.badge} badge`;
  if (rule === 'WAIVER_ELIGIBLE') return { requirement: rule, reason: `${badge}: eligible for an auditor-approved waiver (policy v${String(facts.policy.version)}).` };
  if (rule === 'WAIVER_ELIGIBLE_WITH_REVIEW') {
    return { requirement: rule, reason: `${badge}: eligible for a waiver after a documented review of recent history (policy v${String(facts.policy.version)}).` };
  }
  return { requirement: rule, reason: `${badge}: physical assessment required (policy v${String(facts.policy.version)}).` };
}

// --- Status ------------------------------------------------------------------

export type AssessmentStatus =
  | 'AWAITING_L1'
  | 'READY_FOR_ASSESSMENT'
  | 'IN_PROGRESS'
  | 'AWAITING_QA'
  | 'WAIVER_REVIEW'
  | 'APPROVED_FOR_L2'
  | 'FAILED'
  | 'ON_HOLD'
  | 'REASSESSMENT_REQUIRED'
  | 'DISPATCHED'
  | 'CANCELLED';

const TRANSITIONS: Record<AssessmentStatus, readonly AssessmentStatus[]> = {
  AWAITING_L1: ['READY_FOR_ASSESSMENT', 'WAIVER_REVIEW', 'CANCELLED', 'ON_HOLD'],
  READY_FOR_ASSESSMENT: ['IN_PROGRESS', 'WAIVER_REVIEW', 'ON_HOLD', 'CANCELLED'],
  WAIVER_REVIEW: ['APPROVED_FOR_L2', 'READY_FOR_ASSESSMENT', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['AWAITING_QA', 'FAILED', 'ON_HOLD', 'CANCELLED'],
  AWAITING_QA: ['APPROVED_FOR_L2', 'IN_PROGRESS', 'FAILED', 'ON_HOLD', 'CANCELLED'],
  APPROVED_FOR_L2: ['DISPATCHED', 'REASSESSMENT_REQUIRED', 'READY_FOR_ASSESSMENT', 'ON_HOLD', 'CANCELLED'],
  FAILED: ['REASSESSMENT_REQUIRED', 'CANCELLED'],
  ON_HOLD: ['REASSESSMENT_REQUIRED', 'READY_FOR_ASSESSMENT', 'CANCELLED'],
  REASSESSMENT_REQUIRED: ['IN_PROGRESS', 'WAIVER_REVIEW', 'ON_HOLD', 'CANCELLED'],
  DISPATCHED: [],
  CANCELLED: [],
};

export class AssessmentTransitionError extends Error {
  constructor(
    readonly from: AssessmentStatus,
    readonly to: AssessmentStatus,
  ) {
    super(`An assessment cannot move from ${from} to ${to}.`);
    this.name = 'AssessmentTransitionError';
  }
}

export function assessmentTransitionAllowed(from: AssessmentStatus, to: AssessmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The one gate every assessment status change goes through. */
export function assertAssessmentTransition(from: AssessmentStatus, to: AssessmentStatus): void {
  if (!assessmentTransitionAllowed(from, to)) throw new AssessmentTransitionError(from, to);
}

/** Statuses in which the shipment is blocked: nothing of it may go. */
export const BLOCKING_STATUSES: readonly AssessmentStatus[] = ['FAILED', 'ON_HOLD', 'REASSESSMENT_REQUIRED'];

// --- Checklist ---------------------------------------------------------------

export type CheckPhase = 'PRE_LOADING' | 'LOADING';
export type CheckOutcome = 'PASS' | 'FAIL' | 'HOLD' | 'NOT_APPLICABLE';

export interface ChecklistItem {
  code: string;
  /** A-K. */
  section: string;
  label: string;
  phase: CheckPhase;
  /** A photo or document must be attached for a PASS. */
  evidenceRequired: boolean;
}

export const CHECKLIST_SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;

export const COMMON_CHECKLIST_VERSION = 'common-v1';

/**
 * The common checklist. A-G sit under "Sales Order & Packing Verification".
 * Each item has its own result: a correct quantity never makes up for bad
 * packaging or a wrong label. No item demands temperature control, laboratory
 * testing or one AQL for every category - where those apply, they come from
 * the category's own approved plan (section C) and are marked N/A otherwise,
 * with a reason.
 */
export const COMMON_CHECKLIST: readonly ChecklistItem[] = Object.freeze([
  { code: 'A1', section: 'A', label: 'Correct seller, product, SKU, variant and OEM / Original Brand option', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'A2', section: 'A', label: 'Agreed specifications and approved reference sample, where applicable', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'A3', section: 'A', label: 'Order, packing list and physical goods are consistent', phase: 'PRE_LOADING', evidenceRequired: true },
  { code: 'B1', section: 'B', label: 'Counted quantity matches the declared and ordered quantity', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'B2', section: 'B', label: 'Selling unit and pieces per box / carton / pallet', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'B3', section: 'B', label: 'Package count, shortage / excess and weight where relevant', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'B4', section: 'B', label: 'Counting method and sample coverage recorded', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'C1', section: 'C', label: 'Workmanship and dimensions against the category criteria', phase: 'PRE_LOADING', evidenceRequired: true },
  { code: 'C2', section: 'C', label: 'Required functional tests, with measurements and tolerances', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'C3', section: 'C', label: 'Defects classified critical / major / minor under the approved rules', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'D1', section: 'D', label: 'No damage, scratches, corrosion, moisture or foreign particles', phase: 'PRE_LOADING', evidenceRequired: true },
  { code: 'D2', section: 'D', label: 'No unwanted visible dust or contamination against the product criteria (visual only - not a sterility check; sterile packs are not opened unless an approved method requires it)', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'E1', section: 'E', label: 'Inner protection, cushioning, accessories and seals suit the category', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'E2', section: 'E', label: 'Product and package identification on the inner packs', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'F1', section: 'F', label: 'Outer boxes not crushed, wet, torn or opened; affected packages identified', phase: 'PRE_LOADING', evidenceRequired: true },
  { code: 'F2', section: 'F', label: 'Closure, wrapping, pallet condition and stacking stability', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'G1', section: 'G', label: 'From, to and destination on every package', phase: 'PRE_LOADING', evidenceRequired: true },
  { code: 'G2', section: 'G', label: 'Order / SKU / batch / serial references, package numbering and quantities', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'G3', section: 'G', label: 'Applicable handling marks and destination-language requirements; barcodes verified where supported', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'H1', section: 'H', label: 'Staging area clean, dry, free of pests; storage arrangement suitable', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'H2', section: 'H', label: 'Rejected or quarantined goods kept separate', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'H3', section: 'H', label: 'Required temperature / humidity controls and records (N/A where none is required)', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'H4', section: 'H', label: 'Origin warehouse evidence reviewed, where available', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'I1', section: 'I', label: 'Expiry and required remaining shelf life (N/A where none applies)', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'I2', section: 'I', label: 'No temperature excursion; required handling evidence present (N/A where none applies)', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'J1', section: 'J', label: 'L1 arrival date, time, location, vehicle and handover reference', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'J2', section: 'J', label: 'Seal condition and any damage after L1 transport', phase: 'PRE_LOADING', evidenceRequired: true },
  { code: 'J3', section: 'J', label: 'Origin and arrival records agree', phase: 'PRE_LOADING', evidenceRequired: false },
  { code: 'K1', section: 'K', label: 'Vehicle / container clean, dry and suitable', phase: 'LOADING', evidenceRequired: true },
  { code: 'K2', section: 'K', label: 'Correct cargo loaded and secured; final count', phase: 'LOADING', evidenceRequired: false },
  { code: 'K3', section: 'K', label: 'Seal numbers recorded', phase: 'LOADING', evidenceRequired: true },
  { code: 'K4', section: 'K', label: 'Packing list, invoice and transport documents consistent', phase: 'LOADING', evidenceRequired: false },
]);

/** Section K alone: what a waiver still needs before departure. */
export const LOADING_CHECKLIST: readonly ChecklistItem[] = COMMON_CHECKLIST.filter((item) => item.phase === 'LOADING');

/** Category items from the approved inspection plan, added under section C. */
export function categoryItems(planChecklist: unknown): ChecklistItem[] {
  if (!Array.isArray(planChecklist)) return [];
  const items: ChecklistItem[] = [];
  for (const raw of planChecklist as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const code = typeof row['code'] === 'string' ? row['code'] : null;
    const label = typeof row['label'] === 'string' ? row['label'] : null;
    if (code === null || label === null) continue;
    items.push({ code: `CAT-${code}`.slice(0, 48), section: 'C', label: label.slice(0, 255), phase: 'PRE_LOADING', evidenceRequired: false });
  }
  return items;
}

export interface RecordedCheck {
  itemCode: string;
  outcome: CheckOutcome;
  note: string | null;
  evidenceCount: number;
}

export interface RoundEvaluation {
  outcome: 'PASSED' | 'FAILED' | 'HELD' | 'INCOMPLETE';
  missing: string[];
  missingEvidence: string[];
  unjustifiedNa: string[];
  failed: string[];
  held: string[];
}

/**
 * The verdict of one round's checks for one phase. Any FAIL fails the whole
 * shipment; any HOLD (or unverified item) holds the whole shipment. An item
 * with no result, a PASS without its required evidence, or an N/A without a
 * written reason makes the round incomplete - it can be neither approved nor
 * failed by omission.
 */
export function evaluateChecks(items: readonly ChecklistItem[], checks: readonly RecordedCheck[], phase: CheckPhase): RoundEvaluation {
  const byCode = new Map(checks.map((check) => [check.itemCode, check]));
  const result: RoundEvaluation = { outcome: 'PASSED', missing: [], missingEvidence: [], unjustifiedNa: [], failed: [], held: [] };
  for (const item of items.filter((entry) => entry.phase === phase)) {
    const check = byCode.get(item.code);
    if (check === undefined) {
      result.missing.push(item.code);
      continue;
    }
    if (check.outcome === 'FAIL') result.failed.push(item.code);
    else if (check.outcome === 'HOLD') result.held.push(item.code);
    else if (check.outcome === 'NOT_APPLICABLE' && (check.note ?? '').trim().length < 3) result.unjustifiedNa.push(item.code);
    else if (check.outcome === 'PASS' && item.evidenceRequired && check.evidenceCount === 0) result.missingEvidence.push(item.code);
  }
  if (result.failed.length > 0) result.outcome = 'FAILED';
  else if (result.held.length > 0) result.outcome = 'HELD';
  else if (result.missing.length + result.missingEvidence.length + result.unjustifiedNa.length > 0) result.outcome = 'INCOMPLETE';
  return result;
}

// --- Quantity ----------------------------------------------------------------

export interface QuantityFacts {
  orderedQuantity: number | null;
  declaredQuantity: number | null;
  presentedQuantity: number | null;
  countedQuantity: number | null;
  sampledQuantity: number | null;
  approvedQuantity: number | null;
}

/** Why the quantities cannot be approved as entered, or null. */
export function quantityProblem(q: QuantityFacts): string | null {
  const values = Object.values(q).filter((value): value is number => value !== null);
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return 'NEGATIVE_OR_FRACTION';
  if (q.countedQuantity === null || q.approvedQuantity === null || q.orderedQuantity === null) return 'COUNT_REQUIRED';
  if (q.sampledQuantity !== null && q.countedQuantity !== null && q.sampledQuantity > q.countedQuantity) return 'SAMPLE_ABOVE_COUNT';
  if (q.approvedQuantity > q.countedQuantity) return 'APPROVED_ABOVE_COUNT';
  // No partial release: the whole ordered quantity is approved, or nothing.
  if (q.approvedQuantity !== q.orderedQuantity) return 'APPROVED_NOT_WHOLE_SHIPMENT';
  return null;
}

/** How a sampled result is described. Never "all units tested" from a sample. */
export function samplingStatement(q: QuantityFacts, method: string | null): string {
  const counted = q.countedQuantity ?? 0;
  const sampled = q.sampledQuantity;
  if (sampled === null || sampled >= counted) return `All ${String(counted)} units presented were examined.`;
  return `Results are from a sample of ${String(sampled)} of ${String(counted)} units${method === null ? '' : ` (${method})`}. Units outside the sample were counted, not individually examined.`;
}

// --- Release ------------------------------------------------------------------

export interface ReleaseFacts {
  now: Date;
  l1Complete: boolean;
  status: AssessmentStatus;
  authorization: {
    status: 'ACTIVE' | 'CONSUMED' | 'INVALIDATED' | 'EXPIRED';
    kind: 'ASSESSMENT' | 'WAIVER';
    dispatchDeadline: Date;
    scopeFingerprint: string;
    badgeVersion: number;
    loadingChecksRequired: boolean;
  } | null;
  currentFingerprint: string;
  currentBadgeVersion: number;
  /** For a waiver: does the CURRENT badge still allow one under the current policy? */
  waiverStillEligible: boolean;
  sellerSuspended: boolean;
  loadingChecksPassed: boolean;
  openExceptions: number;
}

export type ReleaseRefusal =
  | 'L1_NOT_COMPLETE'
  | 'NOT_APPROVED'
  | 'NO_AUTHORIZATION'
  | 'AUTHORIZATION_EXPIRED'
  | 'SHIPMENT_CHANGED'
  | 'BADGE_CHANGED'
  | 'SELLER_SUSPENDED'
  | 'LOADING_CHECKS_PENDING';

/**
 * May L2 start now? Asked at the moment of departure, inside the departure's
 * transaction - never left to a scheduled job.
 */
export function releaseRefusal(facts: ReleaseFacts): ReleaseRefusal | null {
  if (!facts.l1Complete) return 'L1_NOT_COMPLETE';
  if (facts.sellerSuspended) return 'SELLER_SUSPENDED';
  if (facts.status !== 'APPROVED_FOR_L2') return 'NOT_APPROVED';
  const auth = facts.authorization;
  if (auth === null || auth.status !== 'ACTIVE') return 'NO_AUTHORIZATION';
  if (auth.dispatchDeadline.getTime() <= facts.now.getTime()) return 'AUTHORIZATION_EXPIRED';
  if (auth.scopeFingerprint !== facts.currentFingerprint) return 'SHIPMENT_CHANGED';
  if (auth.kind === 'WAIVER' && (auth.badgeVersion !== facts.currentBadgeVersion || !facts.waiverStillEligible)) return 'BADGE_CHANGED';
  if (auth.loadingChecksRequired && !facts.loadingChecksPassed) return 'LOADING_CHECKS_PENDING';
  return null;
}

/** A reviewer's dispatch deadline: in the future, inside the policy cap. */
export function deadlineProblem(deadline: Date, now: Date, policy: Pick<BadgePolicy, 'maxDispatchDays'>, evidenceLimit: Date | null): string | null {
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime()) return 'DEADLINE_IN_PAST';
  if (policy.maxDispatchDays !== null && deadline.getTime() > now.getTime() + policy.maxDispatchDays * 86_400_000) return 'DEADLINE_BEYOND_POLICY';
  if (evidenceLimit !== null && deadline.getTime() > evidenceLimit.getTime()) return 'DEADLINE_BEYOND_EVIDENCE';
  return null;
}

/** Seller certificate validity: N months, never past the first mandatory evidence expiry. */
export function certificateValidUntil(issuedAt: Date, months: number, evidenceExpiries: readonly Date[]): Date {
  const until = new Date(issuedAt);
  until.setUTCMonth(until.getUTCMonth() + months);
  for (const expiry of evidenceExpiries) if (expiry.getTime() < until.getTime()) until.setTime(expiry.getTime());
  return until;
}

/** What the shipment IS. Any change to it invalidates an unused release. */
export function scopeFingerprint(parts: {
  lines: readonly { offerId: string; quantity: number }[];
  packingList: { number: string | null; contentHash: string | null; packageCount: number } | null;
  destination: string;
  sellerAccountId: string;
}): string {
  const lines = [...parts.lines].sort((a, b) => a.offerId.localeCompare(b.offerId)).map((line) => `${line.offerId}:${String(line.quantity)}`);
  const packing = parts.packingList === null ? '-' : `${parts.packingList.number ?? ''}:${parts.packingList.contentHash ?? ''}:${String(parts.packingList.packageCount)}`;
  return createHash('sha256').update([parts.sellerAccountId, lines.join(','), packing, parts.destination].join('|')).digest('hex');
}

/** The sentence every waiver document carries, with the deployment's marketplace name. */
export function waiverStatement(marketplace: string): string {
  return `This shipment assessment was waived under the applicable ${marketplace} seller-badge policy. No physical shipment assessment is attested by this waiver.`;
}
export function scopeStatement(marketplace: string): string {
  return `Verified by ${marketplace} for the stated scope.`;
}
export const SIGNING_MECHANISM =
  'Authorised sign-off recorded in the Audit Console (named person, role and time). This is not a cryptographic digital signature; check the current status with the QR code.';
