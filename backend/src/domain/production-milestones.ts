/**
 * Production milestones: raw material, production, quality check, ready.
 *
 * The same rule as the order and schedule state machines: no service decides on
 * its own whether a milestone may be recorded. `modules/seller/production
 * .service.ts` asks this file, inside the transaction that writes the row, and
 * the seller's panel renders its buttons from `nextProductionStage` - so a
 * button that appears is a button that works.
 *
 * WHY IN ORDER, AND WHY NEVER SKIPPED
 *
 * "Ready" is what tells a buyer, and an inspection agency, that the goods can
 * be looked at. A seller who could mark an order ready without having recorded
 * a quality check would be telling both of them something nobody had checked.
 * So each stage needs the one before it, and READY needs QUALITY_CHECKED. This
 * is what "inspection readiness cannot be falsely advanced" means in code.
 *
 * READY does NOT open the dispatch gate. Only a signed PASS or an approved
 * conditional release does that (`domain/inspection-gate.ts`). Ready is a
 * statement by the seller; the gate is a decision by somebody else.
 */
import { ErrorCode, conflict } from './errors.js';

export const PRODUCTION_STAGES = [
  'RAW_MATERIAL',
  'IN_PRODUCTION',
  'QUALITY_CHECKED',
  'READY',
] as const;

export type ProductionStageName = (typeof PRODUCTION_STAGES)[number];

export const PRODUCTION_DELAY_REASONS = [
  'RAW_MATERIAL_SHORTAGE',
  'MACHINE_BREAKDOWN',
  'LABOUR_SHORTAGE',
  'QUALITY_REWORK',
  'SUPPLIER_DELAY',
  'TESTING_OR_CERTIFICATION',
  'BUYER_CHANGE_REQUEST',
  'LOGISTICS',
  'OTHER',
] as const;

export type ProductionDelayReasonName = (typeof PRODUCTION_DELAY_REASONS)[number];

/**
 * Seller order statuses in which production can be recorded.
 *
 * Not NEW: an order the seller has not accepted is not being made. Not
 * SHIPPED or later: once the goods have left, "in production" would be a
 * statement about the past written in the present tense.
 */
export const PRODUCTION_OPEN_STATUSES: readonly string[] = Object.freeze([
  'ACCEPTED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
]);

/** The next stage to complete, given the ones already completed. Null when all are. */
export function nextProductionStage(
  completed: ReadonlySet<ProductionStageName>,
): ProductionStageName | null {
  for (const stage of PRODUCTION_STAGES) {
    if (!completed.has(stage)) return stage;
  }
  return null;
}

/**
 * Refuse unless `stage` may be completed now.
 *
 * Three refusals, each with its own detail code so the screen can say which:
 * the order is not in production, the stage is already done, or an earlier
 * stage is still open.
 */
export function assertCanCompleteStage(input: {
  groupStatus: string;
  completed: ReadonlySet<ProductionStageName>;
  stage: ProductionStageName;
}): void {
  assertProductionOpen(input.groupStatus);

  if (input.completed.has(input.stage)) {
    throw conflict(ErrorCode.PRODUCTION_MILESTONE_NOT_ALLOWED, 'That milestone is already recorded.', [
      { field: 'stage', code: 'ALREADY_COMPLETED' },
    ]);
  }

  const next = nextProductionStage(input.completed);
  if (next !== input.stage) {
    throw conflict(
      ErrorCode.PRODUCTION_MILESTONE_NOT_ALLOWED,
      `Record ${String(next)} first. Milestones are recorded in order and none can be skipped.`,
      [{ field: 'stage', code: 'OUT_OF_ORDER', meta: { expected: next } }],
    );
  }
}

/** Refuse unless the seller order is one that is being produced. */
export function assertProductionOpen(groupStatus: string): void {
  if (!PRODUCTION_OPEN_STATUSES.includes(groupStatus)) {
    throw conflict(
      ErrorCode.PRODUCTION_MILESTONE_NOT_ALLOWED,
      groupStatus === 'NEW'
        ? 'Accept the order before recording production.'
        : 'This order is no longer in production.',
      [{ field: 'status', code: groupStatus === 'NEW' ? 'NOT_ACCEPTED' : 'CLOSED', meta: { status: groupStatus } }],
    );
  }
}

/** The stage a delay can be raised against: one not yet completed. */
export function assertCanDelayStage(input: {
  groupStatus: string;
  completed: ReadonlySet<ProductionStageName>;
  stage: ProductionStageName;
}): void {
  assertProductionOpen(input.groupStatus);
  if (input.completed.has(input.stage)) {
    throw conflict(
      ErrorCode.PRODUCTION_MILESTONE_NOT_ALLOWED,
      'That milestone is already recorded, so it cannot be delayed.',
      [{ field: 'stage', code: 'ALREADY_COMPLETED' }],
    );
  }
}
