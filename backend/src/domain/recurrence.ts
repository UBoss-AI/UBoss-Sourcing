/**
 * Recurrence.
 *
 * Pure date arithmetic - no I/O, no database - so the awkward cases can be
 * tested exhaustively.
 *
 * The hard part is timezones. A schedule means "every Monday at 06:00 for this
 * customer", which is a wall-clock intention in their zone, not a fixed offset
 * from UTC. Storing an interval in milliseconds would drift by an hour across
 * a DST boundary and deliver at 05:00 or 07:00 for half the year.
 *
 * So the local wall-clock time is computed first and converted to a UTC instant
 * second, using the zone's actual offset on that date. India has no DST, but a
 * client in a zone that does must still get their 06:00.
 */

export type Frequency =
  | 'EVERY_N_DAYS'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'EVERY_N_MONTHS'
  | 'ONE_TIME';

export interface RecurrenceRule {
  frequency: Frequency;
  /** EVERY_N_DAYS. The SOP's worked example is "every 7 days". */
  intervalDays?: number | null;
  /** WEEKLY and BIWEEKLY. ISO-8601: 1 = Monday .. 7 = Sunday. */
  weekday?: number | null;
  /** MONTHLY. 1..31, clamped to the last valid day of a short month. */
  monthDay?: number | null;
  /**
   * EVERY_N_MONTHS. 2..24 — "every second month", "every quarter", "yearly".
   *
   * Deliberately not expressible as EVERY_N_DAYS: a quarter is not 90 days,
   * and a year is not 365 of them. Counting in days puts a "quarterly" order
   * five days earlier each year and eventually into the wrong month
   * altogether, which for a standing order somebody budgets against is a
   * defect rather than a rounding detail.
   *
   * The day of the month is NOT carried here. It comes from the plan's start
   * date, because "every three months" is a choice about spacing and the date
   * was already chosen when the customer picked their first delivery. See
   * `nextEveryNMonths`.
   */
  intervalMonths?: number | null;
  /** IANA zone the wall-clock time is interpreted in. */
  timezone: string;
  /** Local time of day, minutes since local midnight. */
  runAtMinute: number;
}

/**
 * Frequencies that repeat.
 *
 * ONE_TIME is a frequency for the sake of one code path, not because it is
 * one. Anything that asks "when is the run after this one" has to exclude it,
 * and doing that through a named predicate beats scattering
 * `frequency !== 'ONE_TIME'` across four services.
 */
export function isRepeating(frequency: Frequency): boolean {
  return frequency !== 'ONE_TIME';
}

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

/**
 * The zone's UTC offset at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in that zone and comparing the result back
 * against UTC - the only way to get a historically correct offset without
 * shipping a timezone database of our own.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const asIfUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    // Some locales render midnight as 24; normalise it.
    Number(parts['hour']) % 24,
    Number(parts['minute']),
    Number(parts['second']),
  );

  return asIfUtc - instant.getTime();
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a local wall-clock time in a zone to a UTC instant.
 *
 * Two passes: the first offset is a guess based on treating the components as
 * UTC, the second corrects it using the offset actually in force at the
 * candidate instant. That second pass is what gets DST boundaries right.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  timeZone: string,
): Date {
  if (!isValidTimeZone(timeZone)) {
    throw new RecurrenceError(`Unknown timezone: ${timeZone}`);
  }

  const naive = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutesOfDay / 60),
    minutesOfDay % 60,
    0,
    0,
  );

  const firstGuess = naive - zoneOffsetMs(new Date(naive), timeZone);
  const corrected = naive - zoneOffsetMs(new Date(firstGuess), timeZone);

  return new Date(corrected);
}

/** The calendar date an instant falls on, in the given zone. */
export function zonedCalendarDate(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO weekday (1 = Monday .. 7 = Sunday) for a calendar date. */
function isoWeekday(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

export function validateRule(rule: RecurrenceRule): void {
  if (!isValidTimeZone(rule.timezone)) {
    throw new RecurrenceError(`Unknown timezone: ${rule.timezone}`);
  }

  if (!Number.isInteger(rule.runAtMinute) || rule.runAtMinute < 0 || rule.runAtMinute >= 1440) {
    throw new RecurrenceError('runAtMinute must be between 0 and 1439.');
  }

  switch (rule.frequency) {
    case 'EVERY_N_DAYS':
      if (
        rule.intervalDays === null ||
        rule.intervalDays === undefined ||
        !Number.isInteger(rule.intervalDays) ||
        rule.intervalDays < 1 ||
        rule.intervalDays > 365
      ) {
        throw new RecurrenceError('intervalDays must be a whole number between 1 and 365.');
      }
      break;

    case 'WEEKLY':
    case 'BIWEEKLY':
      if (
        rule.weekday === null ||
        rule.weekday === undefined ||
        !Number.isInteger(rule.weekday) ||
        rule.weekday < 1 ||
        rule.weekday > 7
      ) {
        throw new RecurrenceError('weekday must be 1 (Monday) through 7 (Sunday).');
      }
      break;

    case 'ONE_TIME':
      // Nothing to validate. A one-shot plan carries its instant in
      // `RecurringSchedule.runOnceAt`, not in a rule - there is no pattern to
      // check, only a date, and the service checks that it is in the future.
      break;

    case 'MONTHLY':
      if (
        rule.monthDay === null ||
        rule.monthDay === undefined ||
        !Number.isInteger(rule.monthDay) ||
        rule.monthDay < 1 ||
        rule.monthDay > 31
      ) {
        throw new RecurrenceError('monthDay must be between 1 and 31.');
      }
      break;

    case 'EVERY_N_MONTHS':
      // Two and up. One would be MONTHLY spelled a second way, and two ways
      // to store the same cadence is how a screen that reads one of them
      // starts reporting a plan's own settings back wrongly.
      if (
        rule.intervalMonths === null ||
        rule.intervalMonths === undefined ||
        !Number.isInteger(rule.intervalMonths) ||
        rule.intervalMonths < 2 ||
        rule.intervalMonths > 24
      ) {
        throw new RecurrenceError('intervalMonths must be a whole number between 2 and 24.');
      }
      break;

    default: {
      const exhaustive: never = rule.frequency;
      throw new RecurrenceError(`Unknown frequency: ${String(exhaustive)}`);
    }
  }
}

export interface NextRunInput {
  rule: RecurrenceRule;
  /** First date the schedule may run, as a calendar date in its own zone. */
  startDate: Date;
  /** When the schedule last ran. Null for a schedule that never has. */
  lastRunAt?: Date | null;
  /** Compute the next run strictly after this instant. Defaults to now. */
  after?: Date;
}

/**
 * The next run instant, in UTC.
 *
 * Always strictly after `after`, so a schedule cannot re-fire for a slot it
 * has already served. Returns null when the recurrence has no further
 * occurrence (which only end-date and max-occurrence checks produce; those
 * live in the service, since they need stored counts).
 */
export function nextRunAt(input: NextRunInput): Date | null {
  const { rule } = input;
  validateRule(rule);

  const after = input.after ?? new Date();
  const timeZone = rule.timezone;

  // A one-shot plan has exactly one run, and it is not derived from a pattern.
  // Returning null here rather than throwing is what lets the engine's
  // "advance to the next slot" path stay uniform: it asks for the next run,
  // gets null, and completes the plan.
  if (rule.frequency === 'ONE_TIME') return null;

  // Never run before the start date, even if the schedule was created earlier.
  const startCalendar = zonedCalendarDate(input.startDate, timeZone);
  const startInstant = zonedTimeToUtc(
    startCalendar.year,
    startCalendar.month,
    startCalendar.day,
    rule.runAtMinute,
    timeZone,
  );

  if (startInstant.getTime() > after.getTime()) return startInstant;

  switch (rule.frequency) {
    case 'EVERY_N_DAYS':
      return nextEveryNDays(rule, startInstant, input.lastRunAt ?? null, after);
    case 'WEEKLY':
      return nextWeekly(rule, after, timeZone);
    case 'BIWEEKLY':
      return nextBiweekly(rule, startInstant, after, timeZone);
    case 'MONTHLY':
      return nextMonthly(rule, after, timeZone);
    case 'EVERY_N_MONTHS':
      return nextEveryNMonths(rule, startInstant, input.lastRunAt ?? null, after, timeZone);
    // ONE_TIME is absent on purpose: it returned above, before the start-date
    // comparison, so the compiler has already narrowed it out of this switch.
    // Listing it here would be unreachable code that only looks reassuring.
    default: {
      const exhaustive: never = rule.frequency;
      throw new RecurrenceError(`Unknown frequency: ${String(exhaustive)}`);
    }
  }
}

/**
 * Every N days.
 *
 * Counted from the START date, not from the last run. Anchoring to the last run
 * would let a delayed execution drift the whole schedule forward - a weekly
 * order that runs six hours late would slowly become a Tuesday order.
 */
function nextEveryNDays(
  rule: RecurrenceRule,
  startInstant: Date,
  lastRunAt: Date | null,
  after: Date,
): Date {
  const interval = rule.intervalDays ?? 1;
  const timeZone = rule.timezone;
  const startCalendar = zonedCalendarDate(startInstant, timeZone);

  // Jump straight to the right neighbourhood instead of stepping day by day,
  // which matters for a schedule that has been paused for a year.
  const elapsedDays = Math.floor(
    (after.getTime() - startInstant.getTime()) / 86_400_000,
  );
  let periods = Math.max(0, Math.floor(elapsedDays / interval));

  // Walk forward until strictly after `after`, and past the last run.
  for (let guard = 0; guard < 1000; guard += 1) {
    const candidate = addDaysInZone(
      startCalendar,
      periods * interval,
      rule.runAtMinute,
      timeZone,
    );

    const isFuture = candidate.getTime() > after.getTime();
    const isAfterLastRun = lastRunAt === null || candidate.getTime() > lastRunAt.getTime();

    if (isFuture && isAfterLastRun) return candidate;
    periods += 1;
  }

  throw new RecurrenceError('Could not determine the next run within a reasonable number of steps.');
}

function addDaysInZone(
  base: { year: number; month: number; day: number },
  days: number,
  minutesOfDay: number,
  timeZone: string,
): Date {
  // Calendar arithmetic in UTC first, so adding days never lands on a
  // non-existent local time; the zone conversion happens afterwards.
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + days));

  return zonedTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    minutesOfDay,
    timeZone,
  );
}

function nextWeekly(rule: RecurrenceRule, after: Date, timeZone: string): Date {
  const target = rule.weekday ?? 1;
  const today = zonedCalendarDate(after, timeZone);

  for (let offset = 0; offset <= 14; offset += 1) {
    const candidateDate = new Date(
      Date.UTC(today.year, today.month - 1, today.day + offset),
    );

    const weekday = isoWeekday(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
    );

    if (weekday !== target) continue;

    const candidate = zonedTimeToUtc(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      rule.runAtMinute,
      timeZone,
    );

    // The target weekday may be today but the time already past.
    if (candidate.getTime() > after.getTime()) return candidate;
  }

  throw new RecurrenceError('Could not find the next weekly occurrence.');
}

/**
 * Every second week, on a fixed weekday.
 *
 * The distinction from `EVERY_N_DAYS` with intervalDays = 14 is the anchor.
 * That counts fourteen days from a run; this counts fourteen days from the
 * START, so the parity of the week is a property of the schedule rather than
 * of its history. A customer who skips one delivery still gets the next one on
 * their Tuesday, and a plan paused for two months resumes on the same Tuesdays
 * it would have used had it never paused.
 *
 * Parity is measured in whole local days between the start's calendar date and
 * the candidate's, not in elapsed milliseconds: across a DST boundary the two
 * differ by an hour, and dividing by 86_400_000 would eventually put a
 * fortnightly schedule on the wrong week.
 */
function nextBiweekly(
  rule: RecurrenceRule,
  startInstant: Date,
  after: Date,
  timeZone: string,
): Date {
  const target = rule.weekday ?? 1;
  const start = zonedCalendarDate(startInstant, timeZone);
  const startDayNumber = Date.UTC(start.year, start.month - 1, start.day) / 86_400_000;

  const today = zonedCalendarDate(after, timeZone);

  // 28 days covers the worst case: the target weekday is tomorrow but on an
  // odd week, so the answer is thirteen days later than the first match.
  for (let offset = 0; offset <= 28; offset += 1) {
    const candidateDate = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));

    const weekday = isoWeekday(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
    );

    if (weekday !== target) continue;

    // Whole days since the start date, so only every second qualifying week is
    // accepted. A negative difference cannot occur: nextRunAt has already
    // returned the start instant for anything before it.
    const candidateDayNumber = candidateDate.getTime() / 86_400_000;
    const daysSinceStart = Math.round(candidateDayNumber - startDayNumber);
    if (Math.abs(daysSinceStart % 14) >= 7) continue;

    const candidate = zonedTimeToUtc(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      rule.runAtMinute,
      timeZone,
    );

    // The right weekday on the right week may still be earlier today.
    if (candidate.getTime() > after.getTime()) return candidate;
  }

  throw new RecurrenceError('Could not find the next fortnightly occurrence.');
}

/**
 * Monthly, clamped.
 *
 * A "31st of the month" schedule must still run in February. Clamping to the
 * last day is the least surprising behaviour: skipping short months would mean
 * a monthly order silently not arriving four times a year.
 */
function nextMonthly(rule: RecurrenceRule, after: Date, timeZone: string): Date {
  const requestedDay = rule.monthDay ?? 1;
  const today = zonedCalendarDate(after, timeZone);

  for (let monthOffset = 0; monthOffset <= 24; monthOffset += 1) {
    const cursor = new Date(Date.UTC(today.year, today.month - 1 + monthOffset, 1));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;

    const day = Math.min(requestedDay, daysInMonth(year, month));
    const candidate = zonedTimeToUtc(year, month, day, rule.runAtMinute, timeZone);

    if (candidate.getTime() > after.getTime()) return candidate;
  }

  throw new RecurrenceError('Could not find the next monthly occurrence.');
}

/**
 * Every N months, on the start date's day of the month.
 *
 * Counted in CALENDAR months from the start, which is the whole reason this
 * frequency exists. "Every three months from the 15th" is the 15th of January,
 * April, July and October for ever; the same intention expressed as
 * `EVERY_N_DAYS` with 90 walks backwards through the calendar by five days a
 * year and after four years is billing in a different month.
 *
 * Anchored to the start month rather than to the last run, exactly as
 * `nextEveryNDays` is: a delivery held for a fortnight must not move every
 * later one, or a quarterly plan drifts a little each time somebody pauses it.
 *
 * The day is clamped in short months on the same reasoning as MONTHLY — the
 * 31st becomes the 30th in a thirty-day month, and the 29th of February
 * becomes the 28th. Skipping the month instead would mean a plan the customer
 * set up simply not arriving, which is the worse of the two surprises. The
 * clamp is applied per month from the *unclamped* start day, so one short
 * month does not shorten every month after it.
 */
function nextEveryNMonths(
  rule: RecurrenceRule,
  startInstant: Date,
  lastRunAt: Date | null,
  after: Date,
  timeZone: string,
): Date {
  const interval = rule.intervalMonths ?? 2;
  const start = zonedCalendarDate(startInstant, timeZone);
  const current = zonedCalendarDate(after, timeZone);

  // Whole months between the start and now, then rounded down to a multiple of
  // the interval. Jumping rather than stepping matters for a yearly plan that
  // has been paused: stepping a month at a time from 2026 would take a hundred
  // iterations to reach 2035.
  const monthsElapsed =
    (current.year - start.year) * 12 + (current.month - start.month);
  let periods = Math.max(0, Math.floor(monthsElapsed / interval));

  for (let guard = 0; guard < 1000; guard += 1) {
    // Month arithmetic through Date.UTC on the first of the month, so an
    // overflowing month index rolls the year over correctly, and only then is
    // the day clamped to what that month actually has.
    const cursor = new Date(Date.UTC(start.year, start.month - 1 + periods * interval, 1));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = Math.min(start.day, daysInMonth(year, month));

    const candidate = zonedTimeToUtc(year, month, day, rule.runAtMinute, timeZone);

    const isFuture = candidate.getTime() > after.getTime();
    const isAfterLastRun = lastRunAt === null || candidate.getTime() > lastRunAt.getTime();

    if (isFuture && isAfterLastRun) return candidate;
    periods += 1;
  }

  throw new RecurrenceError('Could not find the next occurrence of this monthly interval.');
}

/**
 * A human-readable summary.
 *
 * SOP 11.1 requires a visible schedule summary before activation - a customer
 * consenting to recurring charges must be able to read back what they agreed
 * to, in words.
 */
export function describeRule(rule: RecurrenceRule): string {
  const time = `${String(Math.floor(rule.runAtMinute / 60)).padStart(2, '0')}:${String(
    rule.runAtMinute % 60,
  ).padStart(2, '0')}`;

  const weekdayNames = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];

  switch (rule.frequency) {
    case 'EVERY_N_DAYS': {
      const days = rule.intervalDays ?? 1;
      return days === 1
        ? `Every day at ${time} (${rule.timezone})`
        : `Every ${String(days)} days at ${time} (${rule.timezone})`;
    }

    case 'WEEKLY':
      return `Every ${weekdayNames[(rule.weekday ?? 1) - 1] ?? 'Monday'} at ${time} (${rule.timezone})`;

    case 'BIWEEKLY':
      return `Every second ${weekdayNames[(rule.weekday ?? 1) - 1] ?? 'Monday'} at ${time} (${rule.timezone})`;

    case 'ONE_TIME':
      // No pattern to describe. The caller has the instant and formats it -
      // this function only ever sees the rule.
      return `Once, at ${time} (${rule.timezone})`;

    case 'MONTHLY': {
      const day = rule.monthDay ?? 1;
      const suffix = day > 28 ? ' (or the last day, in shorter months)' : '';
      return `On day ${String(day)} of each month at ${time}${suffix} (${rule.timezone})`;
    }

    case 'EVERY_N_MONTHS': {
      const months = rule.intervalMonths ?? 2;
      // Named where a name exists. "Every 12 months" is accurate and reads
      // like a machine wrote it; the customer chose "once a year".
      const cadence =
        months === 12
          ? 'Once a year'
          : months === 3
            ? 'Every three months'
            : months === 6
              ? 'Every six months'
              : `Every ${String(months)} months`;

      // The date is not restated: it comes from the start date, which the
      // caller already shows beside this line.
      return `${cadence}, on the same date, at ${time} (${rule.timezone})`;
    }

    default: {
      const exhaustive: never = rule.frequency;
      return String(exhaustive);
    }
  }
}

/**
 * Retry backoff after a failed occurrence.
 *
 * The SOP declines to fix these numbers pending provider agreement, so the
 * shape is configurable and this is only the default: increasing gaps, capped,
 * then a pause for a human.
 */
export function retryDelayMinutes(attemptCount: number): number {
  const schedule = [60, 240, 720]; // 1h, 4h, 12h
  return schedule[Math.min(attemptCount, schedule.length) - 1] ?? 720;
}
