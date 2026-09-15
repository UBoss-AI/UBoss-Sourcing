/**
 * The SLA calculator.
 *
 * Four claims the module makes in prose, asserted here: a promise met late
 * stays breached for ever, a shipment with no promise has no SLA rather than a
 * green one, a closed consignment is over rather than late, and the shipment's
 * state is the WORSE of its two legs rather than the latest.
 */
import { describe, expect, it } from 'vitest';
import { assessSla, dueAtFrom, onTimePercentage } from '../../src/domain/logistics-sla.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');

function at(offsetMinutes: number): Date {
  return new Date(NOW.getTime() + offsetMinutes * 60_000);
}

const BASE = {
  pickupDueAt: null,
  deliveryDueAt: null,
  pickedUpAt: null,
  deliveredAt: null,
  isClosed: false,
  riskWindowMinutes: 120,
  now: NOW,
};

describe('a promise that was never made', () => {
  it('has no SLA rather than a green one', () => {
    /*
     * The distinction this enum exists for. Colouring a shipment with no
     * promised date green would tell an operator that a promise is being kept
     * when none was made.
     */
    const result = assessSla(BASE);

    expect(result.state).toBe('NOT_APPLICABLE');
    expect(result.pickup.state).toBe('NOT_APPLICABLE');
    expect(result.delivery.state).toBe('NOT_APPLICABLE');
    expect(result.minutesRemaining).toBeNull();
  });
});

describe('a promise still ahead', () => {
  it('is on track outside the risk window', () => {
    const result = assessSla({ ...BASE, deliveryDueAt: at(300) });

    expect(result.state).toBe('ON_TRACK');
    expect(result.minutesRemaining).toBe(300);
    expect(result.minutesLate).toBe(0);
  });

  it('is at risk inside it', () => {
    const result = assessSla({ ...BASE, deliveryDueAt: at(90) });

    expect(result.state).toBe('AT_RISK');
    expect(result.minutesRemaining).toBe(90);
  });

  it('treats the boundary as at risk', () => {
    // A shipment exactly on the window edge is inside it. The other way round
    // means a deadline that becomes urgent one minute after it should have.
    expect(assessSla({ ...BASE, deliveryDueAt: at(120) }).state).toBe('AT_RISK');
    expect(assessSla({ ...BASE, deliveryDueAt: at(121) }).state).toBe('ON_TRACK');
  });

  it('reports the NEAREST deadline when both legs are open', () => {
    const result = assessSla({ ...BASE, pickupDueAt: at(60), deliveryDueAt: at(600) });
    expect(result.minutesRemaining).toBe(60);
  });
});

describe('a promise that was missed', () => {
  it('is breached once the deadline passes', () => {
    const result = assessSla({ ...BASE, deliveryDueAt: at(-45) });

    expect(result.state).toBe('BREACHED');
    expect(result.minutesLate).toBe(45);
  });

  it('stays breached after the parcel finally arrives', () => {
    /*
     * The whole point of recording `metAt`. A consignment that arrived two
     * days late must not turn green the moment it arrives, or a carrier's
     * score would be perfect on every job it eventually completed.
     */
    const result = assessSla({
      ...BASE,
      deliveryDueAt: at(-2880),
      deliveredAt: at(-10),
      isClosed: true,
    });

    expect(result.state).toBe('BREACHED');
    expect(result.minutesLate).toBe(2870);
  });

  it('is on track when it arrived in time', () => {
    const result = assessSla({
      ...BASE,
      deliveryDueAt: at(60),
      deliveredAt: at(-30),
      isClosed: true,
    });

    expect(result.state).toBe('ON_TRACK');
    expect(result.minutesLate).toBe(0);
  });
});

describe('a consignment that is over', () => {
  it('stops being late once it is closed and never will arrive', () => {
    /*
     * A cancelled or lost parcel is not "late", it is over. Counting it as a
     * breach would make a carrier's score worse every day a written-off
     * consignment sat in the table.
     */
    const result = assessSla({ ...BASE, deliveryDueAt: at(-500), isClosed: true });

    expect(result.state).toBe('NOT_APPLICABLE');
    expect(result.minutesLate).toBe(0);
  });
});

describe('two legs', () => {
  it('takes the WORSE of the two, not the latest', () => {
    /*
     * Collected four hours late, still due to arrive on time. The shipment is
     * BREACHED, because the promise that was broken stays broken - and an
     * operator who wants to know which half broke reads the legs.
     */
    const result = assessSla({
      ...BASE,
      pickupDueAt: at(-300),
      pickedUpAt: at(-60),
      deliveryDueAt: at(600),
    });

    expect(result.state).toBe('BREACHED');
    expect(result.pickup.state).toBe('BREACHED');
    expect(result.delivery.state).toBe('ON_TRACK');
    expect(result.minutesLate).toBe(240);
  });

  it('reports each leg separately for the operator who asks', () => {
    const result = assessSla({
      ...BASE,
      pickupDueAt: at(-60),
      pickedUpAt: at(-60),
      deliveryDueAt: at(30),
    });

    expect(result.pickup.state).toBe('ON_TRACK');
    expect(result.delivery.state).toBe('AT_RISK');
    expect(result.state).toBe('AT_RISK');
  });
});

describe('dueAtFrom', () => {
  it('adds hours to an anchor', () => {
    expect(dueAtFrom(NOW, 6)?.toISOString()).toBe('2026-09-15T18:00:00.000Z');
  });

  it('produces nothing from nothing', () => {
    // A policy that promises nothing produces no deadline, which `assessSla`
    // reads as NOT_APPLICABLE rather than as "due now".
    expect(dueAtFrom(NOW, null)).toBeNull();
    expect(dueAtFrom(null, 6)).toBeNull();
  });
});

describe('onTimePercentage', () => {
  it('is null for a carrier that has delivered nothing', () => {
    /*
     * A brand-new carrier showing a perfect score is the single most
     * misleading number an operations dashboard can display, because it is
     * exactly the carrier somebody is deciding whether to trust.
     */
    expect(onTimePercentage(0, 0)).toBeNull();
  });

  it('rounds to one decimal place', () => {
    expect(onTimePercentage(3, 2)).toBe(66.7);
    expect(onTimePercentage(100, 97)).toBe(97);
  });
});
