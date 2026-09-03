/**
 * Recurrence arithmetic.
 *
 * The cases that matter are the awkward ones: month-end clamping, DST
 * boundaries, a schedule resumed after a long pause. Each is a way a recurring
 * order silently arrives on the wrong day or not at all.
 */
import { describe, expect, it } from 'vitest';
import {
  RecurrenceError,
  describeRule,
  isValidTimeZone,
  nextRunAt,
  retryDelayMinutes,
  validateRule,
  zonedCalendarDate,
  zonedTimeToUtc,
  type RecurrenceRule,
} from '../../src/domain/recurrence.js';

const KOLKATA = 'Asia/Kolkata';
const LONDON = 'Europe/London';

function rule(overrides: Partial<RecurrenceRule> = {}): RecurrenceRule {
  return {
    frequency: 'EVERY_N_DAYS',
    intervalDays: 7,
    timezone: KOLKATA,
    // 06:00 local
    runAtMinute: 360,
    ...overrides,
  };
}

describe('timezone conversion', () => {
  it('converts a local wall-clock time to the right UTC instant', () => {
    // 06:00 IST is 00:30 UTC - India is UTC+5:30.
    const instant = zonedTimeToUtc(2026, 3, 15, 360, KOLKATA);
    expect(instant.toISOString()).toBe('2026-03-15T00:30:00.000Z');
  });

  /**
   * The reason wall-clock time is stored rather than a fixed offset. London is
   * UTC+0 in winter and UTC+1 in summer; 06:00 local must stay 06:00 local.
   */
  it('tracks a DST change so the local time stays put', () => {
    // GMT: 06:00 local is 06:00 UTC.
    expect(zonedTimeToUtc(2026, 1, 15, 360, LONDON).toISOString()).toBe(
      '2026-01-15T06:00:00.000Z',
    );

    // BST: 06:00 local is 05:00 UTC.
    expect(zonedTimeToUtc(2026, 7, 15, 360, LONDON).toISOString()).toBe(
      '2026-07-15T05:00:00.000Z',
    );
  });

  it('reads back the calendar date in the target zone', () => {
    // 23:00 UTC on the 14th is already the 15th in Kolkata.
    const date = zonedCalendarDate(new Date('2026-03-14T23:00:00.000Z'), KOLKATA);
    expect(date).toEqual({ year: 2026, month: 3, day: 15 });
  });

  it('rejects an unknown timezone', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(() => zonedTimeToUtc(2026, 1, 1, 0, 'Mars/Olympus_Mons')).toThrow(RecurrenceError);
  });
});

describe('validation', () => {
  it('requires the field its frequency uses', () => {
    expect(() => validateRule(rule({ frequency: 'EVERY_N_DAYS', intervalDays: null }))).toThrow(
      RecurrenceError,
    );
    expect(() => validateRule(rule({ frequency: 'WEEKLY', weekday: null }))).toThrow(
      RecurrenceError,
    );
    expect(() => validateRule(rule({ frequency: 'MONTHLY', monthDay: null }))).toThrow(
      RecurrenceError,
    );
  });

  it('bounds the ranges', () => {
    expect(() => validateRule(rule({ intervalDays: 0 }))).toThrow(RecurrenceError);
    expect(() => validateRule(rule({ intervalDays: 400 }))).toThrow(RecurrenceError);
    expect(() => validateRule(rule({ frequency: 'WEEKLY', weekday: 8 }))).toThrow(RecurrenceError);
    expect(() => validateRule(rule({ frequency: 'MONTHLY', monthDay: 32 }))).toThrow(
      RecurrenceError,
    );
    expect(() => validateRule(rule({ runAtMinute: 1440 }))).toThrow(RecurrenceError);
  });

  it('accepts a valid rule', () => {
    expect(() => validateRule(rule())).not.toThrow();
  });
});

describe('every N days', () => {
  const startDate = new Date('2026-03-01T00:00:00.000Z');

  it('runs on the start date when that is still ahead', () => {
    const next = nextRunAt({
      rule: rule(),
      startDate,
      after: new Date('2026-02-20T00:00:00.000Z'),
    });

    expect(next?.toISOString()).toBe('2026-03-01T00:30:00.000Z');
  });

  /** The SOP's worked example: every 7 days. */
  it('steps in 7-day intervals from the start date', () => {
    const next = nextRunAt({
      rule: rule({ intervalDays: 7 }),
      startDate,
      after: new Date('2026-03-01T06:00:00.000Z'),
    });

    expect(next?.toISOString()).toBe('2026-03-08T00:30:00.000Z');
  });

  /**
   * Anchored to the start date, not the last run. Anchoring to the last run
   * would let a delayed execution drag the whole schedule forward - a Sunday
   * order that ran six hours late would slowly become a Monday order.
   */
  it('does not drift when a run happens late', () => {
    const next = nextRunAt({
      rule: rule({ intervalDays: 7 }),
      startDate,
      // Ran 8 hours late.
      lastRunAt: new Date('2026-03-08T08:30:00.000Z'),
      after: new Date('2026-03-08T08:30:00.000Z'),
    });

    // Still the 15th at 06:00 local, not the 15th plus 8 hours.
    expect(next?.toISOString()).toBe('2026-03-15T00:30:00.000Z');
  });

  it('never returns a slot that has already run', () => {
    const next = nextRunAt({
      rule: rule({ intervalDays: 7 }),
      startDate,
      lastRunAt: new Date('2026-03-15T00:30:00.000Z'),
      after: new Date('2026-03-15T00:29:00.000Z'),
    });

    expect(next?.getTime()).toBeGreaterThan(new Date('2026-03-15T00:30:00.000Z').getTime());
  });

  /** A schedule paused for a year must not step day by day to catch up. */
  it('jumps straight to the right slot after a long pause', () => {
    const next = nextRunAt({
      rule: rule({ intervalDays: 7 }),
      startDate,
      after: new Date('2027-03-01T00:00:00.000Z'),
    });

    expect(next).not.toBeNull();
    expect(next?.getTime()).toBeGreaterThan(new Date('2027-03-01T00:00:00.000Z').getTime());

    // Still on the 7-day grid measured from the start date.
    const daysSinceStart = Math.round(
      (Number(next?.getTime()) - new Date('2026-03-01T00:30:00.000Z').getTime()) / 86_400_000,
    );
    expect(daysSinceStart % 7).toBe(0);
  });

  it('supports a daily schedule', () => {
    const next = nextRunAt({
      rule: rule({ intervalDays: 1 }),
      startDate,
      after: new Date('2026-03-05T06:00:00.000Z'),
    });

    expect(next?.toISOString()).toBe('2026-03-06T00:30:00.000Z');
  });
});

describe('weekly', () => {
  const startDate = new Date('2026-03-01T00:00:00.000Z');

  it('finds the next occurrence of the chosen weekday', () => {
    // 2026-03-04 is a Wednesday.
    const next = nextRunAt({
      rule: rule({ frequency: 'WEEKLY', weekday: 3, intervalDays: null }),
      startDate,
      after: new Date('2026-03-02T00:00:00.000Z'),
    });

    expect(next?.toISOString()).toBe('2026-03-04T00:30:00.000Z');
    expect(next?.getUTCDay()).toBe(3);
  });

  /** The target weekday may be today with the time already gone. */
  it('rolls to next week when today is the day but the time has passed', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'WEEKLY', weekday: 3, intervalDays: null }),
      startDate,
      // Wednesday 08:00 IST, past the 06:00 slot.
      after: new Date('2026-03-04T02:30:00.000Z'),
    });

    expect(next?.toISOString()).toBe('2026-03-11T00:30:00.000Z');
  });

  it('handles Sunday as ISO day 7', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'WEEKLY', weekday: 7, intervalDays: null }),
      startDate,
      after: new Date('2026-03-02T00:00:00.000Z'),
    });

    // 2026-03-08 is a Sunday.
    expect(next?.getUTCDay()).toBe(0);
  });
});

describe('monthly', () => {
  const startDate = new Date('2026-01-01T00:00:00.000Z');

  it('runs on the chosen day', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'MONTHLY', monthDay: 15, intervalDays: null }),
      startDate,
      after: new Date('2026-03-05T00:00:00.000Z'),
    });

    expect(next?.toISOString()).toBe('2026-03-15T00:30:00.000Z');
  });

  /**
   * A "31st" schedule must still run in February. Skipping short months would
   * mean a monthly order silently not arriving four times a year.
   */
  it('clamps to the last day of a shorter month', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'MONTHLY', monthDay: 31, intervalDays: null }),
      startDate,
      after: new Date('2026-02-01T00:00:00.000Z'),
    });

    // February 2026 has 28 days.
    expect(zonedCalendarDate(next ?? new Date(), KOLKATA)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it('clamps to 29 in a leap February', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'MONTHLY', monthDay: 31, intervalDays: null }),
      startDate: new Date('2028-01-01T00:00:00.000Z'),
      after: new Date('2028-02-01T00:00:00.000Z'),
    });

    expect(zonedCalendarDate(next ?? new Date(), KOLKATA)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it('rolls into the next month when the day has passed', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'MONTHLY', monthDay: 5, intervalDays: null }),
      startDate,
      after: new Date('2026-03-10T00:00:00.000Z'),
    });

    expect(zonedCalendarDate(next ?? new Date(), KOLKATA)).toEqual({
      year: 2026,
      month: 4,
      day: 5,
    });
  });

  it('crosses a year boundary', () => {
    const next = nextRunAt({
      rule: rule({ frequency: 'MONTHLY', monthDay: 5, intervalDays: null }),
      startDate,
      after: new Date('2026-12-10T00:00:00.000Z'),
    });

    expect(zonedCalendarDate(next ?? new Date(), KOLKATA)).toEqual({
      year: 2027,
      month: 1,
      day: 5,
    });
  });
});

describe('always moves forward', () => {
  /**
   * The invariant the whole engine rests on: a next run is strictly in the
   * future. A rule that returned a past instant would fire immediately, over
   * and over.
   */
  it('returns an instant strictly after the reference point, for every rule', () => {
    const reference = new Date('2026-06-15T12:00:00.000Z');

    const rules: RecurrenceRule[] = [
      rule({ intervalDays: 1 }),
      rule({ intervalDays: 7 }),
      rule({ intervalDays: 30 }),
      rule({ frequency: 'WEEKLY', weekday: 1, intervalDays: null }),
      rule({ frequency: 'WEEKLY', weekday: 7, intervalDays: null }),
      rule({ frequency: 'MONTHLY', monthDay: 1, intervalDays: null }),
      rule({ frequency: 'MONTHLY', monthDay: 31, intervalDays: null }),
      rule({ intervalDays: 7, timezone: LONDON }),
      rule({ intervalDays: 7, timezone: 'America/New_York' }),
      rule({ intervalDays: 7, runAtMinute: 0 }),
      rule({ intervalDays: 7, runAtMinute: 1439 }),
    ];

    for (const candidate of rules) {
      const next = nextRunAt({
        rule: candidate,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        after: reference,
      });

      expect(next, describeRule(candidate)).not.toBeNull();
      expect(Number(next?.getTime()), describeRule(candidate)).toBeGreaterThan(reference.getTime());
    }
  });
});

describe('describeRule', () => {
  /** SOP 11.1 requires a readable summary before a customer consents. */
  it('renders a summary a customer can check', () => {
    expect(describeRule(rule({ intervalDays: 7 }))).toBe(
      'Every 7 days at 06:00 (Asia/Kolkata)',
    );
    expect(describeRule(rule({ intervalDays: 1 }))).toBe('Every day at 06:00 (Asia/Kolkata)');
    expect(describeRule(rule({ frequency: 'WEEKLY', weekday: 3, intervalDays: null }))).toBe(
      'Every Wednesday at 06:00 (Asia/Kolkata)',
    );
    expect(describeRule(rule({ frequency: 'MONTHLY', monthDay: 15, intervalDays: null }))).toBe(
      'On day 15 of each month at 06:00 (Asia/Kolkata)',
    );
  });

  it('warns about clamping for a late month day', () => {
    expect(describeRule(rule({ frequency: 'MONTHLY', monthDay: 31, intervalDays: null }))).toContain(
      'or the last day',
    );
  });
});

describe('retry backoff', () => {
  it('increases and then caps', () => {
    expect(retryDelayMinutes(1)).toBe(60);
    expect(retryDelayMinutes(2)).toBe(240);
    expect(retryDelayMinutes(3)).toBe(720);
    expect(retryDelayMinutes(9)).toBe(720);
  });
});
