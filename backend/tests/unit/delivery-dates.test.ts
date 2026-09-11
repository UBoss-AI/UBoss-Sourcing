/**
 * Calendar days, and the two ways of getting them wrong.
 *
 * Both failures this file guards against are invisible in a unit test written
 * in the same timezone as the code and at the wrong time of day, which is why
 * every case below pins an instant and a zone explicitly rather than trusting
 * the machine's.
 *
 *   - **Counting in milliseconds.** `now + 7 * 86_400_000` is 168 hours, and
 *     the seventh day forward is 167 or 169 of them across a DST boundary. The
 *     March and October cases below are the ones where the arithmetic version
 *     lands on the wrong date, and they pass here because nothing counts in
 *     hours.
 *   - **Using the server's today.** At 03:00 in Asia/Calcutta it is still
 *     yesterday in Europe/Brussels and still the day before that in Honolulu.
 *     A rule that says "seven days from today" has to mean the buyer's today.
 */
import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  addCalendarDays,
  earliestDeliveryDay,
  effectiveEarliestDelivery,
  fromDateColumn,
  isCalendarDay,
  isWeekend,
  laterOf,
  resolveTimezone,
  toDateColumn,
  todayIn,
} from '../../src/domain/delivery-dates.js';

describe('what counts as a calendar day', () => {
  it('accepts a real day and refuses one that does not exist', () => {
    expect(isCalendarDay('2026-09-11')).toBe(true);
    expect(isCalendarDay('2028-02-29')).toBe(true); // a leap year
    expect(isCalendarDay('2026-02-29')).toBe(false); // not one
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('2026-09-31')).toBe(false);
    expect(isCalendarDay('11/09/2026')).toBe(false);
  });
});

describe('whose today it is', () => {
  /**
   * One instant, three zones, three different days.
   *
   * 2026-09-10T21:30:00Z is late evening in London, already the 11th in
   * Calcutta, and still mid-afternoon on the 10th in Los Angeles. A rule
   * counted from the server's day would give a buyer in one of these three a
   * date a day out from the one their delivery actually runs against.
   */
  const instant = new Date('2026-09-10T21:30:00.000Z');

  it('reads the day on the customer clock, not the server one', () => {
    expect(todayIn('Asia/Calcutta', instant)).toBe('2026-09-11');
    expect(todayIn('Europe/London', instant)).toBe('2026-09-10');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-09-10');
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-09-11');
  });

  it('falls back to UTC for a zone the platform cannot resolve', () => {
    // Never throws: this is called from pricing and validation paths, and a
    // stale zone in a column must not take a checkout down.
    expect(todayIn('Mars/Olympus_Mons', instant)).toBe('2026-09-10');
  });
});

describe('moving by whole days', () => {
  it('crosses a month, a year and a leap day', () => {
    expect(addCalendarDays('2026-09-28', 5)).toBe('2026-10-03');
    expect(addCalendarDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  /**
   * The DST cases, stated as the rule and as the arithmetic that gets them
   * wrong.
   *
   * Europe/Brussels springs forward on 29 March 2026 and falls back on 25
   * October. Seven days from the 26th of March is the 2nd of April whichever
   * way the clocks went - and that is the whole point: a calendar day has no
   * time of day to lose an hour from.
   */
  it('is unmoved by a spring-forward', () => {
    expect(addCalendarDays('2026-03-26', 7)).toBe('2026-04-02');

    // Seven days of milliseconds from noon on the 26th, read back in
    // Brussels, is 11:00 on the 2nd rather than noon - which is exactly the
    // hour the naive version loses. The DAY is still the 2nd, and that is
    // what this module trades in.
    const naive = new Date(Date.parse('2026-03-26T12:00:00+01:00') + 7 * 86_400_000);
    expect(todayIn('Europe/Brussels', naive)).toBe('2026-04-02');
  });

  it('is unmoved by a fall-back', () => {
    expect(addCalendarDays('2026-10-22', 7)).toBe('2026-10-29');
  });

  /**
   * The case the milliseconds version actually gets wrong.
   *
   * Just after midnight on 22 October in Brussels, which is still CEST. Seven
   * days of milliseconds later the clocks have gone back, so 168 hours lands
   * at 23:30 on the **28th** rather than 00:30 on the 29th - and a floor
   * computed that way tells the customer the earliest is the 28th and then
   * refuses the 28th. Adding seven calendar days has no such failure mode,
   * because a calendar day has no time of day to lose an hour from.
   */
  it('does not lose a day the way seven times 86,400,000 does', () => {
    const justAfterMidnight = new Date('2026-10-22T00:30:00+02:00');

    expect(todayIn('Europe/Brussels', justAfterMidnight)).toBe('2026-10-22');
    expect(
      earliestDeliveryDay({ timezone: 'Europe/Brussels', noticeDays: 7, now: justAfterMidnight }),
    ).toBe('2026-10-29');

    const naive = new Date(justAfterMidnight.getTime() + 7 * 86_400_000);
    expect(todayIn('Europe/Brussels', naive)).toBe('2026-10-28');
  });
});

describe('working days', () => {
  // 2026-09-11 is a Friday; the 12th and 13th are the weekend.
  it('knows which days are the weekend', () => {
    expect(isWeekend('2026-09-11')).toBe(false);
    expect(isWeekend('2026-09-12')).toBe(true);
    expect(isWeekend('2026-09-13')).toBe(true);
    expect(isWeekend('2026-09-14')).toBe(false);
  });

  it('steps over a weekend', () => {
    expect(addBusinessDays('2026-09-11', 1)).toBe('2026-09-14');
    expect(addBusinessDays('2026-09-11', 3)).toBe('2026-09-16');
    expect(addBusinessDays('2026-09-11', 5)).toBe('2026-09-18');
  });

  /**
   * Starting on a weekend moves forward first.
   *
   * "Two working days from Saturday" is Tuesday, not Monday: nothing left the
   * building on the Saturday either, so the count starts on the Monday.
   */
  it('starts counting from the next working day when it begins on one', () => {
    expect(addBusinessDays('2026-09-12', 0)).toBe('2026-09-14');
    expect(addBusinessDays('2026-09-12', 2)).toBe('2026-09-16');
  });

  it('leaves a zero-day step on the same day when that day works', () => {
    expect(addBusinessDays('2026-09-11', 0)).toBe('2026-09-11');
  });
});

describe('the floor a first delivery is held to', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  /** The worked example from the requirement, in the buyer's own zone. */
  it('is today plus seven, counted on the customer clock', () => {
    expect(earliestDeliveryDay({ timezone: 'Europe/Brussels', noticeDays: 7, now })).toBe(
      '2026-09-17',
    );
  });

  it('is a different date for a buyer whose today is different', () => {
    // 12:00 UTC on the 10th is already 17:30 on the 10th in Calcutta and
    // 05:00 on the 10th in Los Angeles - the same day in both, so the same
    // floor. Push the instant late enough and they part company.
    const lateEvening = new Date('2026-09-10T20:00:00.000Z');

    expect(earliestDeliveryDay({ timezone: 'Asia/Calcutta', noticeDays: 7, now: lateEvening })).toBe(
      '2026-09-18',
    );
    expect(
      earliestDeliveryDay({ timezone: 'America/Los_Angeles', noticeDays: 7, now: lateEvening }),
    ).toBe('2026-09-17');
  });

  it('allows a notice period of zero, which means today', () => {
    expect(earliestDeliveryDay({ timezone: 'UTC', noticeDays: 0, now })).toBe('2026-09-10');
  });

  it('never goes backwards on a negative setting', () => {
    expect(earliestDeliveryDay({ timezone: 'UTC', noticeDays: -5, now })).toBe('2026-09-10');
  });
});

describe('the warehouse as the other floor', () => {
  it('takes the later of the two', () => {
    expect(effectiveEarliestDelivery('2026-09-17', '2026-09-21')).toBe('2026-09-21');
    expect(effectiveEarliestDelivery('2026-09-17', '2026-09-14')).toBe('2026-09-17');
  });

  /** No warehouse chosen adds no constraint - it does not mean "tomorrow". */
  it('leaves the notice floor alone when no warehouse was chosen', () => {
    expect(effectiveEarliestDelivery('2026-09-17', null)).toBe('2026-09-17');
  });

  it('compares calendar days as plain strings', () => {
    expect(laterOf('2026-09-09', '2026-09-10')).toBe('2026-09-10');
    expect(laterOf('2026-12-31', '2027-01-01')).toBe('2027-01-01');
  });
});

describe('crossing the database boundary', () => {
  /**
   * A `@db.Date` column round trip cannot shift a day.
   *
   * Built and read back in UTC on both sides. Anything built from a local
   * `Date` would be a day out for two thirds of the world on the way in, on
   * the way out, or both.
   */
  it('survives a round trip through a DATE column', () => {
    for (const day of ['2026-01-01', '2026-06-15', '2026-12-31', '2028-02-29']) {
      expect(fromDateColumn(toDateColumn(day))).toBe(day);
    }
  });

  it('writes UTC midnight, not local midnight', () => {
    expect(toDateColumn('2026-09-17').toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });

  it('refuses to store something that is not a day', () => {
    expect(() => toDateColumn('2026-02-30')).toThrow(RangeError);
  });
});

describe('picking a timezone', () => {
  it('takes the first one the platform can resolve', () => {
    expect(resolveTimezone('Europe/Brussels', 'Asia/Calcutta')).toBe('Europe/Brussels');
    expect(resolveTimezone(null, 'Asia/Calcutta')).toBe('Asia/Calcutta');
    expect(resolveTimezone(undefined, '', 'Europe/Athens')).toBe('Europe/Athens');
  });

  it('skips a zone nobody can resolve rather than adopting it', () => {
    // A stored zone that no longer exists must not silently become the
    // answer: every date computed against it would fall back to UTC while the
    // column claimed otherwise.
    expect(resolveTimezone('Nowhere/Fictional', 'Europe/Madrid')).toBe('Europe/Madrid');
  });

  it('ends at UTC rather than at the machine clock', () => {
    expect(resolveTimezone(null, undefined, '')).toBe('UTC');
  });
});
