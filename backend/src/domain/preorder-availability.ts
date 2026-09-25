/**
 * Available-to-promise, and the seller's answer when a preorder asks for more.
 *
 * AVAILABLE-TO-PROMISE
 *
 *     ATP = sellable stock at the locations that may serve this preorder
 *         - paid orders the seller has not yet accepted (not reserved yet)
 *         - the seller's safety stock for preorders
 *
 * floored at zero. "Sellable stock" is `SellerInventory.availableQuantity`,
 * which already excludes everything reserved - basket orders the seller has
 * accepted and other buyers' preorder holds - and everything quarantined.
 * Inbound and production quantities are NOT counted: this product records no
 * verified inbound dates to count them against, and a promise made from a
 * delivery nobody has confirmed is how a seller over-sells. Stock that is
 * still to arrive is the seller's FUTURE_SUPPLY installment, on a date they
 * commit to.
 *
 * ATP is INFORMATIONAL until the buyer accepts. Then the proposal's stock
 * allocation is reserved in one atomic write, and if it is no longer there the
 * proposal is invalidated rather than quietly shrunk.
 *
 * THE TWO ANSWERS
 *
 *   FULL_ON_REVISED_DATE   the whole quantity, on one later committed date.
 *   SPLIT_DELIVERY         two or more installments: what is available now
 *                          first, the rest on later dates.
 *
 * Both keep the buyer's quantity exactly. Nothing here rounds a quantity to a
 * container, trims it to what is in stock, or moves a date the seller did not
 * type.
 *
 * Pure: no I/O, no clock except the one passed in.
 */
import { isCalendarDay, type CalendarDay } from './delivery-dates.js';

export type InstallmentSource = 'AVAILABLE_STOCK' | 'FUTURE_SUPPLY';

export type AvailabilityProposalKind = 'FULL_ON_REVISED_DATE' | 'SPLIT_DELIVERY';

/** The most installments one schedule may have. */
export const MAX_INSTALLMENTS = 24;

// ---------------------------------------------------------------------------
// ATP
// ---------------------------------------------------------------------------

export interface AtpInput {
  /** Sellable pieces at each location that may serve this preorder. */
  locations: readonly { locationId: string; availableQuantity: number }[];
  /** Paid order lines for this offer the seller has not accepted yet. */
  unacceptedOrderQuantity: number;
  safetyStock: number;
}

export interface Atp {
  availableToPromise: number;
  onHand: number;
  unacceptedOrderQuantity: number;
  safetyStock: number;
}

export function availableToPromise(input: AtpInput): Atp {
  const onHand = input.locations.reduce(
    (sum, location) => sum + Math.max(0, Math.trunc(location.availableQuantity)),
    0,
  );
  const unaccepted = Math.max(0, Math.trunc(input.unacceptedOrderQuantity));
  const safety = Math.max(0, Math.trunc(input.safetyStock));
  return {
    availableToPromise: Math.max(0, onHand - unaccepted - safety),
    onHand,
    unacceptedOrderQuantity: unaccepted,
    safetyStock: safety,
  };
}

export interface Shortfall {
  sufficient: boolean;
  requested: number;
  /** What could go in the first fulfilment: all of it, or the ATP. */
  availableNow: number;
  /** requested - availableNow, never negative. */
  remaining: number;
}

export function assessShortfall(requested: number, atp: number): Shortfall {
  const available = Math.max(0, Math.trunc(atp));
  if (requested <= available) {
    return { sufficient: true, requested, availableNow: requested, remaining: 0 };
  }
  return {
    sufficient: false,
    requested,
    availableNow: available,
    remaining: requested - available,
  };
}

// ---------------------------------------------------------------------------
// The seller's proposal
// ---------------------------------------------------------------------------

export interface InstallmentInput {
  date: string;
  baseUnits: number;
  /** Optional: defaults to stock for the first installment, supply after it. */
  source?: InstallmentSource | null;
}

export interface ProposalInput {
  kind: AvailabilityProposalKind;
  /** The request's quantity. A proposal may not change it. */
  totalBaseUnits: number;
  /** Live ATP, read when the proposal is checked. */
  availableToPromise: number;
  requestedDay: CalendarDay;
  /** The earliest day anybody may commit to - the platform notice. */
  floorDay: CalendarDay;
  /** FULL_ON_REVISED_DATE: the one date. */
  revisedDate?: string | null;
  /** FULL_ON_REVISED_DATE: hold what is on hand now for this buyer. */
  reserveAvailableStock?: boolean;
  /** SPLIT_DELIVERY: the schedule. */
  installments?: readonly InstallmentInput[] | null;
  expiresAt: Date;
  now: Date;
  /** The longest the seller may leave the offer open. */
  maxExpiryHours: number;
}

export interface PlannedInstallment {
  sequence: number;
  date: CalendarDay;
  baseUnits: number;
  source: InstallmentSource;
}

export interface ProposalProblem {
  field: string;
  code: string;
  message: string;
  meta?: Record<string, number | string>;
}

export type ProposalResult =
  | {
      ok: true;
      installments: PlannedInstallment[];
      /** Pieces reserved from stock at the buyer's acceptance. */
      stockAllocationBaseUnits: number;
      /** The last installment's date: "delivered by". */
      committedDate: CalendarDay;
    }
  | { ok: false; problems: ProposalProblem[] };

function formatCount(value: number): string {
  return value.toLocaleString('en');
}

/**
 * Is this revised-date or split-delivery proposal one a buyer may be sent?
 *
 * The ONE place the rules live, so the seller's preview and the save cannot
 * disagree. Every problem is returned, not just the first, so the form can
 * mark every field that needs attention at once.
 */
export function validateAvailabilityProposal(input: ProposalInput): ProposalResult {
  const problems: ProposalProblem[] = [];
  const atp = Math.max(0, Math.trunc(input.availableToPromise));

  checkExpiry(input, problems);

  if (input.kind === 'FULL_ON_REVISED_DATE') {
    const date = input.revisedDate ?? '';
    if (!isCalendarDay(date)) {
      problems.push({
        field: 'revisedDate',
        code: 'DATE_REQUIRED',
        message: 'Give the date you commit to deliver the complete quantity.',
      });
    } else {
      if (date < input.floorDay) {
        problems.push({
          field: 'revisedDate',
          code: 'TOO_EARLY',
          message: `The earliest date you can commit to is ${input.floorDay}.`,
          meta: { earliest: input.floorDay },
        });
      }
      if (date <= input.requestedDay) {
        problems.push({
          field: 'revisedDate',
          code: 'NOT_LATER',
          message: `A revised date must be after the date the buyer asked for (${input.requestedDay}). To deliver by then, accept the request instead.`,
          meta: { requested: input.requestedDay },
        });
      }
    }

    if (problems.length > 0) return { ok: false, problems };

    const reserve = input.reserveAvailableStock !== false;
    const fromStock = reserve ? Math.min(atp, input.totalBaseUnits) : 0;
    return {
      ok: true,
      installments: [
        {
          sequence: 1,
          date,
          baseUnits: input.totalBaseUnits,
          // All of it from stock only when all of it is on the shelf now.
          source: fromStock >= input.totalBaseUnits ? 'AVAILABLE_STOCK' : 'FUTURE_SUPPLY',
        },
      ],
      stockAllocationBaseUnits: fromStock,
      committedDate: date,
    };
  }

  // --- SPLIT_DELIVERY --------------------------------------------------------

  const parts = input.installments ?? [];

  if (parts.length < 2) {
    problems.push({
      field: 'installments',
      code: 'TOO_FEW',
      message: 'A split delivery needs at least two shipments.',
    });
  }
  if (parts.length > MAX_INSTALLMENTS) {
    problems.push({
      field: 'installments',
      code: 'TOO_MANY',
      message: `A split delivery may have at most ${String(MAX_INSTALLMENTS)} shipments.`,
    });
  }
  if (atp <= 0) {
    problems.push({
      field: 'installments',
      code: 'NOTHING_AVAILABLE_NOW',
      message:
        'Nothing is available to ship now, so there is no first shipment to split off. Offer the complete quantity on a revised date instead.',
    });
  }

  const planned: PlannedInstallment[] = [];
  let sum = 0;
  let previous = '';
  let fromStock = 0;

  parts.forEach((part, index) => {
    const field = `installments.${String(index)}`;
    const source: InstallmentSource =
      part.source ?? (index === 0 ? 'AVAILABLE_STOCK' : 'FUTURE_SUPPLY');

    if (!Number.isSafeInteger(part.baseUnits) || part.baseUnits <= 0) {
      problems.push({
        field: `${field}.baseUnits`,
        code: 'QUANTITY_INVALID',
        message: 'Every shipment needs a quantity of one piece or more, as a whole number.',
      });
    } else {
      sum += part.baseUnits;
      if (source === 'AVAILABLE_STOCK') fromStock += part.baseUnits;
    }

    if (!isCalendarDay(part.date)) {
      problems.push({
        field: `${field}.date`,
        code: 'DATE_REQUIRED',
        message: 'Every shipment needs a committed delivery date.',
      });
    } else {
      if (part.date < input.floorDay) {
        problems.push({
          field: `${field}.date`,
          code: 'TOO_EARLY',
          message: `The earliest date you can commit to is ${input.floorDay}.`,
          meta: { earliest: input.floorDay },
        });
      }
      if (previous !== '' && part.date <= previous) {
        problems.push({
          field: `${field}.date`,
          code: 'NOT_LATER',
          message: 'Each shipment must be on a later date than the one before it.',
        });
      }
      previous = part.date;
    }

    if (index === 0 && source !== 'AVAILABLE_STOCK') {
      // There is no verified inbound record to promise a first shipment from,
      // so the first one is the stock that exists.
      problems.push({
        field: `${field}.source`,
        code: 'FIRST_NOT_FROM_STOCK',
        message: 'The first shipment is the stock you have now.',
      });
    }

    planned.push({ sequence: index + 1, date: part.date, baseUnits: part.baseUnits, source });
  });

  if (
    parts.length >= 2 &&
    sum !== input.totalBaseUnits &&
    problems.every((p) => p.code !== 'QUANTITY_INVALID')
  ) {
    problems.push({
      field: 'installments',
      code: 'SUM_MISMATCH',
      message: `The shipments add up to ${formatCount(sum)} pieces and the buyer asked for ${formatCount(input.totalBaseUnits)}. They must add up exactly.`,
      meta: { sum, total: input.totalBaseUnits },
    });
  }

  if (atp > 0 && fromStock > atp) {
    problems.push({
      field: 'installments.0.baseUnits',
      code: 'EXCEEDS_AVAILABLE',
      message: `Only ${formatCount(atp)} pieces are available now, so shipments from stock cannot total ${formatCount(fromStock)}.`,
      meta: { availableToPromise: atp, fromStock },
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    installments: planned,
    stockAllocationBaseUnits: fromStock,
    committedDate: previous,
  };
}

function checkExpiry(input: ProposalInput, problems: ProposalProblem[]): void {
  const at = input.expiresAt.getTime();
  if (!Number.isFinite(at) || at <= input.now.getTime() + 3_600_000) {
    problems.push({
      field: 'expiresAt',
      code: 'EXPIRY_TOO_SOON',
      message: 'Give the buyer at least an hour to answer.',
    });
    return;
  }
  if (at > input.now.getTime() + input.maxExpiryHours * 3_600_000) {
    problems.push({
      field: 'expiresAt',
      code: 'EXPIRY_TOO_LATE',
      message: `An offer can stay open for at most ${String(input.maxExpiryHours)} hours.`,
      meta: { maxHours: input.maxExpiryHours },
    });
  }
}
