/**
 * Calendar dates, without the timezone trap.
 *
 * A delivery date is a **day**, not an instant: "the 18th" is the 18th whether
 * the buyer reads it in Pune or in Rotterdam, and the schedule's own timezone
 * decides what 06:00 on that day means. So everything here works on
 * `YYYY-MM-DD` strings and never on a local `Date`.
 *
 * That is not fussiness. `new Date('2026-09-18')` is parsed as UTC midnight,
 * and `toLocaleDateString()` on it prints the 17th for every reader west of
 * Greenwich — which is how a picker comes to show one day, send another, and
 * be right about neither. Where a `Date` is unavoidable (weekday arithmetic,
 * month lengths, `Intl` formatting) it is built with `Date.UTC` and read back
 * in UTC, so the round trip cannot shift a day.
 *
 * One free property worth knowing about: `YYYY-MM-DD` sorts correctly as a
 * plain string, so `a < b` compares two calendar dates and no helper is
 * needed for it. Every range check in this file and in `DatePicker` relies on
 * that.
 */

/** A calendar date, pulled apart. `month` is 1-12, as a person writes it. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD`, or null if it is not one — or is not a real day. */
export function parseIsoDate(iso: string): CalendarDate | null {
  const match = ISO_DATE.exec(iso);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

export function toIsoDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${month}-${day}`;
}

/** How many days a month has, leap years included. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one, and the UTC
  // constructor normalises month 13 into January of the year after.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Move a calendar date by whole days. Crosses months and years correctly. */
export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  if (date === null) return iso;

  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return toIsoDate({
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  });
}

/**
 * Move a month view by whole months, clamping the day.
 *
 * The 31st of March minus one month is the 28th (or 29th) of February, not the
 * 3rd of March — which is what `setMonth` would give.
 */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;

  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/** The day of the week, 0 for Sunday through 6 for Saturday. */
export function weekdayOf(iso: string): number {
  const date = parseIsoDate(iso);
  if (date === null) return 0;
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Today, as a calendar date on a given wall clock. */
export function todayIso(timezone: string): string {
  try {
    // `en-CA` formats as YYYY-MM-DD, and asking in the schedule's own zone is
    // what makes "today" the customer's today rather than the machine's.
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

/**
 * Which day a week starts on here, 0 for Sunday through 6 for Saturday.
 *
 * Asked of the platform rather than assumed: a Monday grid is right across
 * Europe and India and wrong in the United States, and this store is sold into
 * all of them. Monday is the fallback because it is what the eight languages
 * this storefront ships in overwhelmingly use.
 *
 * The API has two shapes in the wild — `getWeekInfo()` in the current spec and
 * a `weekInfo` getter in older engines — and both report `firstDay` as ISO
 * 1-7 with Monday first, which is not the 0-6 the rest of this file uses.
 */
export function firstDayOfWeek(intlLocale: string): number {
  try {
    const locale = new Intl.Locale(intlLocale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };

    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    const firstDay = info?.firstDay;

    if (typeof firstDay !== 'number' || firstDay < 1 || firstDay > 7) return 1;

    // ISO counts Sunday as 7; this file counts it as 0.
    return firstDay === 7 ? 0 : firstDay;
  } catch {
    return 1;
  }
}

/**
 * The six-week grid a month is drawn in.
 *
 * Always 42 days, and deliberately: a month that needed five rows one moment
 * and six the next would make the panel change height as somebody paged
 * through it, moving the button they were about to press. The days from the
 * neighbouring months are real dates and are returned as such — the picker
 * draws them muted, and they remain selectable, because clicking the 1st of
 * next month is a thing people do.
 */
export function monthGrid(year: number, month: number, weekStartsOn: number): string[] {
  const first = toIsoDate({ year, month, day: 1 });
  const offset = (weekdayOf(first) - weekStartsOn + 7) % 7;
  const start = addDays(first, -offset);

  return Array.from({ length: 42 }, (_unused, index) => addDays(start, index));
}

/** The weekday initials for the header row, in the grid's own order. */
export function weekdayNames(intlLocale: string, weekStartsOn: number): { short: string; long: string }[] {
  // Any week will do; 4 January 1970 was a Sunday, so index 0 is Sunday.
  const short = new Intl.DateTimeFormat(intlLocale, { weekday: 'narrow', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(intlLocale, { weekday: 'long', timeZone: 'UTC' });

  return Array.from({ length: 7 }, (_unused, index) => {
    const day = new Date(Date.UTC(1970, 0, 4 + ((weekStartsOn + index) % 7)));
    return { short: short.format(day), long: long.format(day) };
  });
}

/**
 * Format a calendar date for a reader, in UTC.
 *
 * The `timeZone: 'UTC'` is the whole point — see the header. Without it a
 * date-only value drifts by a day for two thirds of the world.
 */
export function formatIsoDate(
  iso: string,
  intlLocale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = parseIsoDate(iso);
  if (date === null) return iso;

  return new Intl.DateTimeFormat(intlLocale, { ...options, timeZone: 'UTC' }).format(
    new Date(Date.UTC(date.year, date.month - 1, date.day)),
  );
}

/** The month and year a view is showing, for its heading. */
export function formatMonthYear(year: number, month: number, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
