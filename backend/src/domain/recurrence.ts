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

export type Frequency = 'EVERY_N_DAYS' | 'WEEKLY' | 'MONTHLY';

export interface RecurrenceRule {
  frequency: Frequency;
  /** EVERY_N_DAYS. The SOP's worked example is "every 7 days". */
  intervalDays?: number | null;
  /** WEEKLY. ISO-8601: 1 = Monday .. 7 = Sunday. */
  weekday?: number | null;
  /** MONTHLY. 1..31, clamped to the last valid day of a short month. */
  monthDay?: number | null;
  /** IANA zone the wall-clock time is interpreted in. */
  timezone: string;
  /** Local time of day, minutes since local midnight. */
  runAtMinute: number;
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
    case 'MONTHLY':
      return nextMonthly(rule, after, timeZone);
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

    case 'MONTHLY': {
      const day = rule.monthDay ?? 1;
      const suffix = day > 28 ? ' (or the last day, in shorter months)' : '';
      return `On day ${String(day)} of each month at ${time}${suffix} (${rule.timezone})`;
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
