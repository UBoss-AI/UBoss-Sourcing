/**
 * Calendar-date arithmetic.
 *
 * The case this file exists for is the first one: a `YYYY-MM-DD` value must
 * survive being formatted and read back without moving a day, in every
 * timezone. Everything else here — month ends, leap years, the grid's shape —
 * is arithmetic that is easy to get subtly wrong and impossible to notice
 * until a standing order lands in the wrong month.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysInMonth,
  firstDayOfWeek,
  formatIsoDate,
  formatMonthYear,
  monthGrid,
  parseIsoDate,
  toIsoDate,
  weekdayNames,
  weekdayOf,
} from './calendar-date';

describe('a calendar date never shifts a day', () => {
  it('formats the day it was given, not the day before it', () => {
    // `new Date('2026-09-18').toLocaleDateString()` prints the 17th for every
    // reader west of Greenwich. This is the whole reason the module exists.
    expect(formatIsoDate('2026-09-18', 'en-GB', { dateStyle: 'short' })).toContain('18');
    expect(formatIsoDate('2026-01-01', 'en-GB', { dateStyle: 'short' })).toContain('01');
    expect(formatIsoDate('2026-12-31', 'en-GB', { year: 'numeric' })).toBe('2026');
  });

  it('round-trips through parse and back', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-09-18', '2026-12-31']) {
      const parsed = parseIsoDate(iso);
      expect(parsed).not.toBeNull();
      expect(toIsoDate(parsed as NonNullable<typeof parsed>)).toBe(iso);
    }
  });
});

describe('parsing', () => {
  it('reads the parts as a person writes them', () => {
    expect(parseIsoDate('2026-09-18')).toEqual({ year: 2026, month: 9, day: 18 });
  });

  it('refuses what is not a date', () => {
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('18-09-2026')).toBeNull();
    expect(parseIsoDate('2026-9-8')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    // A day that does not exist in that month. `new Date` would roll it over
    // to 1 March and call it valid, which is how a picker offers a day the
    // server then refuses.
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-02-29')).toBeNull();
  });

  it('accepts the leap day in a leap year', () => {
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });
});

describe('month lengths', () => {
  it('knows February', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    // The centurial rule, both ways round.
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
  });

  it('knows the thirties and the thirty-ones', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('moving by days', () => {
  it('crosses a month', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('crosses a year', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('crosses a leap day', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('adds the week of notice a delivery needs', () => {
    expect(addDays('2026-09-11', 7)).toBe('2026-09-18');
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
  });
});

describe('moving by months', () => {
  it('clamps a day the target month does not have', () => {
    // The 31st of March minus a month is the 28th of February, not the 3rd of
    // March — which is what `setMonth` would give.
    expect(addMonths({ year: 2026, month: 3, day: 31 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(addMonths({ year: 2024, month: 3, day: 31 }, -1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 3)).toEqual({
      year: 2026,
      month: 4,
      day: 30,
    });
  });

  it('crosses a year in both directions', () => {
    expect(addMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 15,
    });
    expect(addMonths({ year: 2026, month: 1, day: 15 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 15,
    });
    expect(addMonths({ year: 2026, month: 6, day: 1 }, -18)).toEqual({
      year: 2024,
      month: 12,
      day: 1,
    });
  });
});

describe('weekdays', () => {
  it('counts Sunday as 0', () => {
    // 11 September 2026 is a Friday.
    expect(weekdayOf('2026-09-11')).toBe(5);
    expect(weekdayOf('2026-09-13')).toBe(0);
    expect(weekdayOf('2026-09-14')).toBe(1);
  });

  it('names the days in the grid own order', () => {
    const monday = weekdayNames('en-GB', 1);
    expect(monday[0]?.long).toBe('Monday');
    expect(monday[6]?.long).toBe('Sunday');

    const sunday = weekdayNames('en-GB', 0);
    expect(sunday[0]?.long).toBe('Sunday');
    expect(sunday[6]?.long).toBe('Saturday');
  });

  it('falls back to Monday for a locale the platform cannot answer for', () => {
    // Monday is what the eight languages this storefront ships in
    // overwhelmingly use, so it is the safe default rather than Sunday.
    expect(firstDayOfWeek('nonsense-locale')).toBe(1);
    expect([0, 1, 6]).toContain(firstDayOfWeek('en-GB'));
  });
});

describe('the month grid', () => {
  it('is always six weeks, so the panel cannot change height', () => {
    for (const [year, month] of [
      [2026, 2],
      [2026, 9],
      [2026, 8],
      [2024, 2],
    ] as const) {
      expect(monthGrid(year, month, 1)).toHaveLength(42);
    }
  });

  it('starts on the week containing the first of the month', () => {
    // 1 September 2026 is a Tuesday, so a Monday-first grid opens on 31 Aug.
    const grid = monthGrid(2026, 9, 1);
    expect(grid[0]).toBe('2026-08-31');
    expect(grid[1]).toBe('2026-09-01');

    // The same month on a Sunday-first grid opens a day earlier.
    expect(monthGrid(2026, 9, 0)[0]).toBe('2026-08-30');
  });

  it('runs in unbroken day order and carries real neighbouring dates', () => {
    const grid = monthGrid(2026, 9, 1);

    for (let index = 1; index < grid.length; index += 1) {
      expect(grid[index]).toBe(addDays(grid[index - 1] as string, 1));
    }

    // The trailing days belong to October and are real dates, not blanks —
    // clicking the 1st of next month is a thing people do.
    expect(grid[grid.length - 1]).toBe('2026-10-11');
  });

  it('puts every day of the month somewhere in it', () => {
    const grid = monthGrid(2026, 2, 1);
    for (let day = 1; day <= 28; day += 1) {
      expect(grid).toContain(`2026-02-${String(day).padStart(2, '0')}`);
    }
  });
});

describe('the month heading', () => {
  it('names the month being shown, not the one before it', () => {
    expect(formatMonthYear(2026, 1, 'en-GB')).toBe('January 2026');
    expect(formatMonthYear(2026, 12, 'en-GB')).toBe('December 2026');
  });
});
