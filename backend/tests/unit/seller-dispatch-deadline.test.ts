/**
 * When a seller has to have the box out of the door.
 *
 * The figure every SLA on the marketplace is measured against: the overdue
 * list, the "past dispatch time" filter and whatever the operator eventually
 * does about a seller who is always late all read this one column. So the
 * cases that matter are the ones where an obvious implementation would hand a
 * seller a deadline they could never have met - accepting at ten at night,
 * accepting on a Saturday - and mark them late for it.
 *
 * Every assertion is written in the location's own zone, because that is the
 * only clock the promise means anything on. Solingen is Europe/Berlin, which
 * is deliberately not the server's zone and not the buyer's.
 */
import { describe, expect, it } from 'vitest';
import { dispatchDeadline, type DispatchSchedule } from '../../src/domain/seller-state.js';

const BERLIN: DispatchSchedule = {
  timezone: 'Europe/Berlin',
  // Monday to Friday.
  workingDaysMask: 31,
  dispatchCutoff: '16:30',
  handlingTimeDays: 1,
};

/**
 * The deadline as the warehouse would read it off its own wall.
 *
 * Assembled from parts rather than formatted as a phrase: `Intl`'s short
 * month is "Sep" on one ICU build and "Sept" on another, and a test that
 * fails when Node is upgraded is a test nobody trusts. The weekday is spelled
 * out here because it is the whole point of half these cases.
 */
function local(instant: Date, timezone = 'Europe/Berlin'): string {
  const parts: Record<string, string> = {};

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const weekday = parts['weekday'] ?? '';
  const hour = parts['hour'] === '24' ? '00' : (parts['hour'] ?? '');

  return `${weekday.slice(0, 3)} ${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''} ${hour}:${parts['minute'] ?? ''}`;
}

describe('dispatchDeadline', () => {
  it('counts from today when the order arrives before the cut-off', () => {
    // Tuesday 15 September 2026, 09:00 in Berlin.
    const accepted = new Date('2026-09-15T07:00:00.000Z');

    // One working day on: Wednesday, at the cut-off.
    expect(local(dispatchDeadline(BERLIN, accepted))).toBe('Wed 2026-09-16 16:30');
  });

  it('starts tomorrow when the van has already gone', () => {
    // Tuesday 19:47 Berlin - after 16:30, so Tuesday is spent.
    const accepted = new Date('2026-09-15T17:47:00.000Z');

    expect(local(dispatchDeadline(BERLIN, accepted))).toBe('Thu 2026-09-17 16:30');
  });

  it('does not count a day the building is shut', () => {
    // Saturday 09:00 Berlin. Nothing leaves on Saturday or Sunday, so the
    // count starts on Monday and one working day lands on Tuesday.
    const accepted = new Date('2026-09-19T07:00:00.000Z');

    expect(local(dispatchDeadline(BERLIN, accepted))).toBe('Tue 2026-09-22 16:30');
  });

  it('honours a working week that is not Monday to Friday', () => {
    // Sunday to Thursday, as a business in the Gulf would keep it: bits for
    // Sunday (64), Monday (1), Tuesday (2), Wednesday (4) and Thursday (8).
    const gulf: DispatchSchedule = {
      timezone: 'Asia/Dubai',
      workingDaysMask: 64 + 1 + 2 + 4 + 8,
      dispatchCutoff: '15:00',
      handlingTimeDays: 1,
    };

    // Thursday 17 September 2026, 09:00 in Dubai. Friday and Saturday are the
    // weekend here, so one working day on is Sunday.
    const accepted = new Date('2026-09-17T05:00:00.000Z');

    expect(local(dispatchDeadline(gulf, accepted), 'Asia/Dubai')).toBe('Sun 2026-09-20 15:00');
  });

  it('gives a building with no cut-off the whole of its last day', () => {
    const noCutoff: DispatchSchedule = { ...BERLIN, dispatchCutoff: null };

    // Accepted late on Tuesday. With no cut-off stated, Tuesday still counts,
    // so the deadline is the end of Wednesday rather than a time nobody set.
    const accepted = new Date('2026-09-15T20:00:00.000Z');

    expect(local(dispatchDeadline(noCutoff, accepted))).toBe('Wed 2026-09-16 23:59');
  });

  it('is due the same day when the seller promises no handling time at all', () => {
    const sameDay: DispatchSchedule = { ...BERLIN, handlingTimeDays: 0 };

    // Tuesday 09:00 Berlin, cut-off not yet passed.
    const accepted = new Date('2026-09-15T07:00:00.000Z');

    expect(local(dispatchDeadline(sameDay, accepted))).toBe('Tue 2026-09-15 16:30');
  });

  it('treats a week with no working days as an ordinary week rather than looping', () => {
    // A mask of zero says "this place never works", which no operator means.
    // Read as the default week, it still produces a date.
    const broken: DispatchSchedule = { ...BERLIN, workingDaysMask: 0 };
    const accepted = new Date('2026-09-15T07:00:00.000Z');

    expect(local(dispatchDeadline(broken, accepted))).toBe('Wed 2026-09-16 16:30');
  });
});
