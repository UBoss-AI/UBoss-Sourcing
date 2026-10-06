/**
 * The dispatch gate.
 *
 * When an order needs a third-party inspection, the goods may not leave until
 * the inspection has PASSED or an authorised conditional release has been
 * approved. This file is the one place that decides whether the gate is open,
 * and the one place that says which moves it guards. It is pure: the service
 * gathers the facts (`modules/inspection/gate.service.ts`), this turns them
 * into a verdict, and the two state machines refuse a guarded move unless they
 * are handed an open verdict:
 *
 *   - `assertSellerOrderTransition` (seller-state.ts) for READY_FOR_DISPATCH
 *     and SHIPPED;
 *   - `assertShipmentTransition` (logistics-shipment-state.ts) for every
 *     status that means the goods have been collected or are moving.
 *
 * Fail-closed on purpose. A guarded move that arrives WITHOUT a verdict is
 * refused as INSPECTION_GATE_NOT_EVALUATED, so a new code path that forgets to
 * ask cannot quietly let a consignment go. A screen hiding a button is not the
 * control; this is.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, conflict } from './errors.js';

/** Why the gate is open or shut. Sent to screens as `details[0].code`. */
export type InspectionGateReason =
  /** No inspection is needed for this order. */
  | 'NOT_REQUIRED'
  /** Nothing to inspect: a consignment with no seller order behind it. */
  | 'NOT_APPLICABLE'
  /** A signed PASS report, bound to what is being sent. */
  | 'PASSED'
  /** A conditional release approved by two people. */
  | 'CONDITIONALLY_RELEASED'
  /** These goods were already released and collected. */
  | 'ALREADY_RELEASED'
  | 'NOT_BOOKED'
  | 'IN_PROGRESS'
  | 'FAILED'
  /** The signed report could not decide either way. Holds like a failure. */
  | 'INCONCLUSIVE'
  /** An approved, unused sub-lot release covers exactly what is leaving. */
  | 'SUBLOT_RELEASED'
  | 'BLOCKING_NCR_OPEN'
  | 'RELEASE_PENDING_APPROVAL'
  | 'SCOPE_CHANGED'
  | 'BUYER_REVIEW_PERIOD';

export interface InspectionGateVerdict {
  open: boolean;
  reason: InspectionGateReason;
  requirementId: string | null;
  /** MANDATORY, RISK_TRIGGERED, BUYER_REQUESTED or NOT_REQUIRED. */
  level: string | null;
  /** When the buyer's review period ends, for BUYER_REVIEW_PERIOD. */
  reviewEndsAt?: string | null;
}

/** A verdict for a movement that has nothing to do with an inspection. */
export const GATE_NOT_APPLICABLE: InspectionGateVerdict = Object.freeze({
  open: true,
  reason: 'NOT_APPLICABLE',
  requirementId: null,
  level: null,
});

/** The facts the verdict is computed from. Gathered by the gate service. */
export interface InspectionGateFacts {
  requirementId: string;
  level: 'MANDATORY' | 'RISK_TRIGGERED' | 'BUYER_REQUESTED' | 'NOT_REQUIRED';
  /** The live release, if any: ACTIVE or PENDING_APPROVAL. */
  release: {
    kind: 'PASS' | 'CONDITIONAL';
    state: 'ACTIVE' | 'PENDING_APPROVAL';
    boundScopeHash: string;
  } | null;
  /**
   * The latest signed PRE-SHIPMENT report's result, or null when none is
   * signed. Raw-material and in-production reports never release goods; their
   * findings hold them through `blockingNcrCount` instead.
   */
  latestSignedResult: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  /** Whether a job is booked and not finished. */
  hasOpenJob: boolean;
  /** Non-conformances the policy says hold the goods, not yet closed. */
  blockingNcrCount: number;
  /** Fingerprint of what is about to be sent. */
  currentScopeHash: string;
  /** This particular consignment has already been collected. */
  alreadyCollected: boolean;
  /** When the buyer's review period after sign-off ends, if one applies. */
  buyerReviewEndsAt: Date | null;
  now: Date;
}

/**
 * Open or shut, and why.
 *
 * The order of the checks is the order of the questions a person would ask:
 * is inspection needed at all; have these goods already gone; is there a
 * release; is it approved; does it still describe what is being sent; is
 * anything still holding it.
 */
export function evaluateInspectionGate(facts: InspectionGateFacts): InspectionGateVerdict {
  const base = { requirementId: facts.requirementId, level: facts.level };

  if (facts.level === 'NOT_REQUIRED') return { ...base, open: true, reason: 'NOT_REQUIRED' };

  // Goods already collected under a release are not stopped half way: a
  // carrier's later scans must still be recorded. A change after collection is
  // logged, and can no longer be re-inspected.
  if (facts.alreadyCollected) return { ...base, open: true, reason: 'ALREADY_RELEASED' };

  const release = facts.release;

  if (release === null) {
    if (facts.latestSignedResult === 'FAIL') return { ...base, open: false, reason: 'FAILED' };
    if (facts.latestSignedResult === 'INCONCLUSIVE') return { ...base, open: false, reason: 'INCONCLUSIVE' };
    if (facts.hasOpenJob) return { ...base, open: false, reason: 'IN_PROGRESS' };
    // A PASS with no live release means the release was superseded - the
    // goods changed after they were inspected.
    if (facts.latestSignedResult === 'PASS') return { ...base, open: false, reason: 'SCOPE_CHANGED' };
    return { ...base, open: false, reason: 'NOT_BOOKED' };
  }

  if (release.state === 'PENDING_APPROVAL') {
    return { ...base, open: false, reason: 'RELEASE_PENDING_APPROVAL' };
  }

  if (release.boundScopeHash !== facts.currentScopeHash) {
    return { ...base, open: false, reason: 'SCOPE_CHANGED' };
  }

  if (release.kind === 'CONDITIONAL') {
    return { ...base, open: true, reason: 'CONDITIONALLY_RELEASED' };
  }

  // A PASS release. An open major non-conformance still holds it, where the
  // operator's policy says so - only a conditional release overrides that.
  if (facts.blockingNcrCount > 0) return { ...base, open: false, reason: 'BLOCKING_NCR_OPEN' };

  if (facts.buyerReviewEndsAt !== null && facts.buyerReviewEndsAt.getTime() > facts.now.getTime()) {
    return {
      ...base,
      open: false,
      reason: 'BUYER_REVIEW_PERIOD',
      reviewEndsAt: facts.buyerReviewEndsAt.toISOString(),
    };
  }

  return { ...base, open: true, reason: 'PASSED' };
}

/** Where a guarded move was attempted, for the refusal's wording. */
export type GatedMove = 'SELLER_ORDER' | 'SHIPMENT';

const REASON_SENTENCE: Record<InspectionGateReason, string> = {
  NOT_REQUIRED: 'No inspection is required.',
  NOT_APPLICABLE: 'No inspection applies.',
  PASSED: 'The inspection passed.',
  CONDITIONALLY_RELEASED: 'The goods were conditionally released.',
  ALREADY_RELEASED: 'These goods were already released.',
  NOT_BOOKED: 'This order must be inspected before it leaves, and no inspection has been booked.',
  IN_PROGRESS: 'This order must be inspected before it leaves, and the inspection is not finished.',
  FAILED: 'The inspection failed. The goods cannot leave until a re-inspection passes or a conditional release is approved.',
  INCONCLUSIVE:
    'The inspection was inconclusive. The goods are on hold until a re-inspection decides, or an authorised release is approved.',
  SUBLOT_RELEASED: 'An approved sub-lot release covers exactly these goods.',
  BLOCKING_NCR_OPEN: 'A major non-conformance is still open. The goods cannot leave until it is corrected and verified.',
  RELEASE_PENDING_APPROVAL: 'A conditional release is waiting for a second approver.',
  SCOPE_CHANGED: 'The goods, packages, container or seal changed after the inspection. The inspection must be re-evaluated before dispatch.',
  BUYER_REVIEW_PERIOD: 'The buyer is still within the period to review the inspection report.',
};

/**
 * Refuse unless the verdict is open.
 *
 * Called by the state machines for every guarded move. A missing verdict is a
 * refusal of its own, so a caller that forgot to ask is caught the first time
 * it runs rather than the first time somebody audits a shipment.
 */
export function assertInspectionGateOpen(
  verdict: InspectionGateVerdict | undefined,
  move: GatedMove,
  meta: { from: string; to: string },
): void {
  if (verdict === undefined) {
    throw conflict(
      ErrorCode.INSPECTION_GATE_NOT_EVALUATED,
      'This move needs the inspection gate to be checked first.',
      [{ code: 'GATE_NOT_EVALUATED', meta: { ...meta, move } }],
    );
  }

  if (verdict.open) return;

  throw conflict(ErrorCode.INSPECTION_GATE_CLOSED, REASON_SENTENCE[verdict.reason], [
    {
      code: verdict.reason,
      meta: {
        ...meta,
        move,
        requirementId: verdict.requirementId,
        level: verdict.level,
        reviewEndsAt: verdict.reviewEndsAt ?? null,
      },
    },
  ]);
}

export function gateSentence(reason: InspectionGateReason): string {
  return REASON_SENTENCE[reason];
}

// ---------------------------------------------------------------------------
// What was inspected
// ---------------------------------------------------------------------------

/** One consignment's packages, as the fingerprint reads them. */
export interface ScopePackage {
  sequence: number;
  packagingType: string | null;
  containerNumber: string | null;
  sealNumber: string | null;
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  contents: { orderItemId: string; quantity: number; batchNumber: string | null }[];
}

export interface ScopeInput {
  /** The seller order's lines: what was ordered, in pieces. */
  lines: { orderItemId: string; quantity: number }[];
  /** Every consignment that is not cancelled, with its packages. */
  consignments: { shipmentId: string; packages: ScopePackage[] }[];
}

export interface ScopeFingerprint {
  hash: string;
  /** The same facts, readable: what the release screen and the binding show. */
  summary: {
    lines: { orderItemId: string; quantity: number }[];
    consignments: {
      shipmentId: string;
      packageCount: number;
      containers: string[];
      seals: string[];
    }[];
  };
}

/**
 * A stable fingerprint of what is being sent.
 *
 * Package ids are deliberately left out - saving a package list replaces
 * every row, and a new id for an unchanged carton must not re-open the gate.
 * What is in: quantities, how many packages, their type, weight and size,
 * what is in each, and every container and seal number. Change any of those
 * after a release and the hash moves, which is how INSPECT-004 is enforced
 * without trusting every edit path to remember to say so.
 */
export function scopeFingerprint(input: ScopeInput): ScopeFingerprint {
  const lines = [...input.lines]
    .map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity }))
    .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));

  const consignments = [...input.consignments]
    .sort((a, b) => a.shipmentId.localeCompare(b.shipmentId))
    .map((consignment) => ({
      shipmentId: consignment.shipmentId,
      packages: [...consignment.packages]
        .sort((a, b) => a.sequence - b.sequence)
        .map((pack) => ({
          sequence: pack.sequence,
          packagingType: normalise(pack.packagingType),
          containerNumber: normalise(pack.containerNumber),
          sealNumber: normalise(pack.sealNumber),
          weightGrams: pack.weightGrams,
          dimensions: [pack.lengthMm, pack.widthMm, pack.heightMm],
          contents: [...pack.contents]
            .map((content) => ({
              orderItemId: content.orderItemId,
              quantity: content.quantity,
              batchNumber: normalise(content.batchNumber),
            }))
            .sort(
              (a, b) =>
                a.orderItemId.localeCompare(b.orderItemId) ||
                (a.batchNumber ?? '').localeCompare(b.batchNumber ?? '') ||
                a.quantity - b.quantity,
            ),
        })),
    }));

  const hash = createHash('sha256')
    .update(JSON.stringify({ v: 1, lines, consignments }))
    .digest('hex');

  return {
    hash,
    summary: {
      lines,
      consignments: consignments.map((consignment) => ({
        shipmentId: consignment.shipmentId,
        packageCount: consignment.packages.length,
        containers: unique(consignment.packages.map((pack) => pack.containerNumber)),
        seals: unique(consignment.packages.map((pack) => pack.sealNumber)),
      })),
    },
  };
}

function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === '' ? null : trimmed;
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}
