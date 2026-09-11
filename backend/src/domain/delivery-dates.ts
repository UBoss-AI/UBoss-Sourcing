/**
 * Calendar days, for deliveries.
 *
 * Pure arithmetic - no I/O, no database - so the awkward cases can be tested
 * exhaustively, which is the same bargain `recurrence.ts` makes and for the
 * same reason.
 *
 * **A delivery date is a day, not an instant**, and this file exists because
 * the two are constantly confused. "The 18th" is the 18th whether it is read
 * in Pune or in Rotterdam. An instant is not: `new Date('2026-09-18')` is UTC
 * midnight, and printing it for a reader in São Paulo gives the 17th. So
 * everything here is a `YYYY-MM-DD` string, and a `Date` appears only at the
 * two boundaries - reading a wall clock and writing a `@db.Date` column -
 * where it is built and read back in UTC so the round trip cannot shift a day.
 *
 * **Notice is counted in calendar days, never in milliseconds.** `Date.now() +
 * 7 * 86_400_000` is the tempting version and it is wrong twice a year in
 * every zone that observes DST: the seventh day forward is 167 or 169 hours
 * away, not 168, and the answer lands on the 24th at 23:00 or the 25th at
 * 01:00 depending on which way the clocks went. Adding seven *days* to a
 * calendar date has no such failure mode, because a calendar date has no
 * time-of-day to drift.
 *
 * **"Today" belongs to somebody.** Every function that needs it takes a
 * timezone, and none of them falls back to the server's. At 03:00 in
 * Asia/Calcutta it is still yesterday in Europe/Brussels, and a rule that says
 * "seven days from today" has to mean the buyer's today or it is a different
 * rule for a third of the world.
 *
 * One free property the whole file relies on: `YYYY-MM-DD` sorts correctly as
 * a plain string, so `a < b` compares two calendar days and no helper is
 * needed for it.
 */
import { isValidTimeZone, zonedCalendarDate } from './recurrence.js';

/** A calendar day as `YYYY-MM-DD`. Never an instant. */
export type CalendarDay = string;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** How many days a month has, leap years included. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one, and the UTC
  // constructor normalises month 13 into January of the year after.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * True for a real `YYYY-MM-DD` naming a day that exists.
 *
 * A plain boolean rather than a `value is CalendarDay` predicate, because
 * `CalendarDay` *is* `string`: narrowing to it buys a caller nothing, and it
 * leaves the failing branch typed `never` — so the one place that wants to
 * put the offending value in an error message cannot.
 */
export function isCalendarDay(value: string): boolean {
  const match = ISO_DAY.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** Format the year, month and day as `YYYY-MM-DD`. */
function toDay(year: number, month: number, day: number): CalendarDay {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0',
  )}`;
}

/**
 * Today, as a calendar day on a given wall clock.
 *
 * An unknown zone falls back to UTC rather than throwing. This is called from
 * pricing and validation paths where a bad `timezone` column - a value typed
 * in years ago, a zone a tzdata update retired - must not take a checkout
 * down; the caller that cares whether the zone was understood asks
 * `isValidTimeZone` itself.
 */
export function todayIn(timezone: string, now: Date = new Date()): CalendarDay {
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  const parts = zonedCalendarDate(now, zone);
  return toDay(parts.year, parts.month, parts.day);
}

/**
 * Move a calendar day by whole days. Crosses months, years and DST unharmed.
 *
 * `Date.UTC` with an out-of-range day normalises for us - day 32 of January is
 * the 1st of February - and UTC has no daylight saving to fall into.
 */
export function addCalendarDays(day: CalendarDay, days: number): CalendarDay {
  const match = ISO_DAY.exec(day);
  if (match === null) return day;

  const moved = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );

  return toDay(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** Saturday or Sunday. */
export function isWeekend(day: CalendarDay): boolean {
  const match = ISO_DAY.exec(day);
  if (match === null) return false;

  const weekday = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();

  return weekday === 0 || weekday === 6;
}

/**
 * Move a calendar day by whole working days.
 *
 * Saturdays and Sundays are skipped, and the start day is skipped forward too
 * if it lands on one: "two working days from Saturday" is Tuesday, not Monday,
 * because nothing left the building on the Saturday either.
 *
 * A weekend is not a universal fact, which is why every caller decides whether
 * to use this or `addCalendarDays` from a stored flag
 * (`WarehouseDeliveryZone.usesBusinessDays`) rather than this file deciding
 * for them. Public holidays are deliberately not modelled: they differ by
 * country, by region and by year, and a hard-coded list that is wrong is worse
 * than a transit window the operator widened by a day on purpose.
 */
export function addBusinessDays(day: CalendarDay, days: number): CalendarDay {
  let cursor = day;

  // A dispatch that would fall on a weekend happens on the Monday, even when
  // nothing is being added to it.
  while (isWeekend(cursor)) cursor = addCalendarDays(cursor, 1);

  let remaining = Math.max(0, Math.trunc(days));

  while (remaining > 0) {
    cursor = addCalendarDays(cursor, 1);
    if (!isWeekend(cursor)) remaining -= 1;
  }

  return cursor;
}

/** Whichever of two calendar days is later. */
export function laterOf(a: CalendarDay, b: CalendarDay): CalendarDay {
  return a >= b ? a : b;
}

/**
 * A calendar day as the instant a `@db.Date` column stores.
 *
 * UTC midnight, which is what Prisma writes into a MySQL `DATE` and what it
 * reads back. Anything built from a local `Date` would be a day out for two
 * thirds of the world on the way in, on the way out, or both.
 */
export function toDateColumn(day: CalendarDay): Date {
  // The full check, not just the shape. `Date.UTC` normalises the 30th of
  // February into the 2nd of March without complaint, so a caller that got
  // its arithmetic wrong would silently write a promise two days off rather
  // than being told. This is the boundary; being strict at it is the point.
  if (!isCalendarDay(day)) throw new RangeError(`Not a calendar day: ${day}`);

  const match = ISO_DAY.exec(day);
  if (match === null) throw new RangeError(`Not a calendar day: ${day}`);

  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** The other direction: a `@db.Date` column back to `YYYY-MM-DD`. */
export function fromDateColumn(value: Date): CalendarDay {
  return toDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

/**
 * The earliest day a first delivery may be asked for.
 *
 * `today + noticeDays`, counted on the customer's own clock and in calendar
 * days. With the default of seven and a customer whose today is the 10th of
 * September, the answer is the 17th - which is the worked example the
 * requirement is written against.
 *
 * Calendar days rather than working days, and that is deliberate: the notice
 * period is a commercial promise about elapsed time, not a count of shifts. An
 * operator who needs it to fall on a working day sets the number higher. What
 * the *warehouse* needs - handling time, weekends, the transit window - is a
 * separate calculation on the lane, and `effectiveEarliestDelivery` below is
 * where the two meet.
 */
export function earliestDeliveryDay(options: {
  timezone: string;
  noticeDays: number;
  now?: Date;
}): CalendarDay {
  const today = todayIn(options.timezone, options.now ?? new Date());
  return addCalendarDays(today, Math.max(0, Math.trunc(options.noticeDays)));
}

/**
 * The floor that actually applies, once a warehouse has been chosen.
 *
 * `max(today + notice, the warehouse's own earliest delivery)`. Both are real
 * constraints and neither overrides the other: the notice period is what the
 * business promises itself, and the lane's dispatch-plus-transit is what
 * physics and the carrier allow. A picker that enforced only the first would
 * let somebody choose a Tuesday the warehouse cannot reach until the Thursday.
 *
 * `warehouseEarliest` is null where no warehouse has been chosen or where the
 * chosen one publishes no lane to the destination, and the notice period then
 * stands alone.
 */
export function effectiveEarliestDelivery(
  noticeFloor: CalendarDay,
  warehouseEarliest: CalendarDay | null,
): CalendarDay {
  return warehouseEarliest === null ? noticeFloor : laterOf(noticeFloor, warehouseEarliest);
}

/**
 * The first zone in the list that a platform can actually resolve.
 *
 * The order is the caller's, and it is always most-specific-first: the
 * delivery address's own zone, then the plan's, then the store's. UTC is the
 * last resort rather than a default anybody chose - it is what is left when
 * every stored zone is empty or unrecognised, which happens on a deployment
 * whose addresses predate the column.
 */
export function resolveTimezone(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && isValidTimeZone(trimmed)) return trimmed;
  }

  return 'UTC';
}
