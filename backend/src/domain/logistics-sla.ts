/**
 * Is this shipment going to be late, and how late is it already?
 *
 * One implementation, called by four things that must agree: the dashboard
 * counter, the shipment list's SLA column, the exception sweep that raises an
 * `SLA_RISK`, and the partner scorecard. Two implementations of "at risk"
 * would mean a dashboard saying three and a list showing four, and the first
 * question anybody asks then is which number is wrong - which is the same
 * reasoning that makes `quoteSchedule` the only pricing implementation.
 *
 * WHAT AN SLA IS HERE
 *
 * A promise with two halves, because a carrier can miss either independently:
 * collect by a time, and deliver by a time. A pickup missed by four hours on a
 * consignment that still arrives on Tuesday is a breach of one half and not
 * the other, and an operator negotiating a contract renewal needs to see which.
 *
 * `riskWindowMinutes` is the deployment's own figure, carried on
 * `LogisticsSlaPolicy` - how long before a deadline a shipment starts counting
 * as at risk. It is a setting rather than a constant because it is a
 * commercial judgement: two hours is right for a city courier and useless for
 * a cross-border air consignment.
 *
 * Nothing here reads the clock. `now` is always passed in, so the same inputs
 * produce the same answer in a test, in a worker and in a request.
 */

/**
 * The four states, in order of severity.
 *
 * `NOT_APPLICABLE` is separate from `ON_TRACK` on purpose. A shipment with no
 * promised date has no SLA to be on track against, and colouring it green
 * would tell an operator that a promise is being kept when none was made.
 */
export type SlaState = 'NOT_APPLICABLE' | 'ON_TRACK' | 'AT_RISK' | 'BREACHED';

export interface SlaInput {
  /** When collection was promised. Null where the contract promises nothing. */
  pickupDueAt: Date | null;
  /** When delivery was promised. */
  deliveryDueAt: Date | null;
  /** When collection actually happened, if it has. */
  pickedUpAt: Date | null;
  /** When delivery actually happened, if it has. */
  deliveredAt: Date | null;
  /**
   * Whether the shipment has stopped moving for good.
   *
   * A cancelled or lost shipment is not "late"; it is over. Counting it as a
   * breach would mean a carrier's score got worse every day a written-off
   * parcel sat in the table.
   */
  isClosed: boolean;
  riskWindowMinutes: number;
  now: Date;
}

export interface SlaAssessment {
  state: SlaState;
  pickup: SlaLegAssessment;
  delivery: SlaLegAssessment;
  /**
   * How late the worst leg is, in whole minutes. Zero unless something is
   * BREACHED. Positive only - "how early it was" is not an SLA question.
   */
  minutesLate: number;
  /**
   * Minutes until the nearest deadline, where one is still ahead. Null once
   * everything is met, breached or absent. The list column reads this to say
   * "due in 3h".
   */
  minutesRemaining: number | null;
}

export interface SlaLegAssessment {
  state: SlaState;
  dueAt: Date | null;
  metAt: Date | null;
  minutesLate: number;
  minutesRemaining: number | null;
}

const MINUTE_MS = 60_000;

function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MINUTE_MS);
}

/**
 * One half of the promise.
 *
 * Met after the deadline is still a breach, and it stays a breach for ever.
 * That is the whole point of recording `metAt`: a shipment that arrived two
 * days late must not turn green the moment it arrives.
 */
function assessLeg(
  dueAt: Date | null,
  metAt: Date | null,
  isClosed: boolean,
  riskWindowMinutes: number,
  now: Date,
): SlaLegAssessment {
  if (dueAt === null) {
    return { state: 'NOT_APPLICABLE', dueAt: null, metAt, minutesLate: 0, minutesRemaining: null };
  }

  if (metAt !== null) {
    const late = Math.max(0, minutesBetween(dueAt, metAt));
    return {
      state: late > 0 ? 'BREACHED' : 'ON_TRACK',
      dueAt,
      metAt,
      minutesLate: late,
      minutesRemaining: null,
    };
  }

  // Never met, and never going to be. Not a breach of a delivery promise -
  // there is nothing left to deliver - so the leg simply stops applying.
  if (isClosed) {
    return { state: 'NOT_APPLICABLE', dueAt, metAt: null, minutesLate: 0, minutesRemaining: null };
  }

  const remaining = minutesBetween(now, dueAt);

  if (remaining < 0) {
    return { state: 'BREACHED', dueAt, metAt: null, minutesLate: -remaining, minutesRemaining: 0 };
  }

  return {
    state: remaining <= riskWindowMinutes ? 'AT_RISK' : 'ON_TRACK',
    dueAt,
    metAt: null,
    minutesLate: 0,
    minutesRemaining: remaining,
  };
}

const SEVERITY: Readonly<Record<SlaState, number>> = Object.freeze({
  NOT_APPLICABLE: 0,
  ON_TRACK: 1,
  AT_RISK: 2,
  BREACHED: 3,
});

/**
 * The shipment's SLA state is the worse of its two legs.
 *
 * Worse, not latest: a shipment collected four hours late and still due to
 * arrive on time is BREACHED, because the promise that was broken stays
 * broken. An operator who wants to know which half broke reads `pickup` and
 * `delivery`, which is why both are returned rather than collapsed.
 */
export function assessSla(input: SlaInput): SlaAssessment {
  const riskWindow = Math.max(0, input.riskWindowMinutes);

  const pickup = assessLeg(
    input.pickupDueAt,
    input.pickedUpAt,
    input.isClosed,
    riskWindow,
    input.now,
  );
  const delivery = assessLeg(
    input.deliveryDueAt,
    input.deliveredAt,
    input.isClosed,
    riskWindow,
    input.now,
  );

  const state = SEVERITY[pickup.state] >= SEVERITY[delivery.state] ? pickup.state : delivery.state;

  const remainingCandidates = [pickup.minutesRemaining, delivery.minutesRemaining].filter(
    (value): value is number => value !== null,
  );

  return {
    state,
    pickup,
    delivery,
    minutesLate: Math.max(pickup.minutesLate, delivery.minutesLate),
    minutesRemaining: remainingCandidates.length === 0 ? null : Math.min(...remainingCandidates),
  };
}

/**
 * When a promise falls due, from a policy expressed in hours.
 *
 * Hours rather than working days, deliberately. A working-day calculation
 * needs a calendar of public holidays per country, and this software is
 * installed by businesses in twenty-seven of them; getting it approximately
 * right in code would be worse than being exactly right about a simpler
 * promise. A deployment that contracts in working days sets the hours to match
 * and carries the calendar in its own contract.
 *
 * Null in, null out: a policy that promises nothing produces no deadline,
 * which `assessLeg` reads as NOT_APPLICABLE rather than as "due now".
 */
export function dueAtFrom(anchor: Date | null, hours: number | null): Date | null {
  if (anchor === null || hours === null) return null;
  return new Date(anchor.getTime() + hours * 3_600_000);
}

/**
 * On-time delivery rate, as a percentage with one decimal place.
 *
 * Returns null rather than 100 for a partner that has delivered nothing. A
 * brand-new carrier showing a perfect score is the single most misleading
 * number an operations dashboard can display, because it is exactly the
 * carrier somebody is deciding whether to trust with a consignment.
 */
export function onTimePercentage(delivered: number, onTime: number): number | null {
  if (delivered <= 0) return null;
  return Math.round((onTime / delivered) * 1000) / 10;
}
