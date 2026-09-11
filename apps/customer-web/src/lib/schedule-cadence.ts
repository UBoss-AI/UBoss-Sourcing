/**
 * How often, as a person says it — and as the API stores it.
 *
 * These two are not the same thing, and this file is the one place that
 * converts between them. "Every three months" is one choice to a buyer and
 * two fields to the server (a frequency and an interval), and the day it lands
 * on is a third, taken from the start date. So the intervals the storefront
 * offers are their own type and `recurrenceFor` turns one into the fields the
 * API expects.
 *
 * It lives in `lib/` rather than inside the builder because two screens now
 * ask the same question: the builder, where a schedule is created, and the
 * schedule workspace, where one is changed. Two copies of this mapping is how
 * a plan created as "every 3 months" gets saved back as "every 90 days" — the
 * same standing order, quietly moved onto a different calendar.
 *
 * Two rules the conversion has to keep, both of them the server's:
 *
 *   - **Only the field that frequency depends on is sent.** The database has a
 *     CHECK constraint (`chk_schedule_frequency_field_present`) naming each
 *     frequency and its column, so an insert that omits the required one is
 *     refused — and one that sends `weekday` alongside a MONTHLY plan is
 *     sending a value nothing reads and the customer never chose.
 *   - **A quarter is not ninety days.** EVERY_N_MONTHS exists precisely so
 *     that a three-monthly delivery stays on the same date rather than
 *     drifting a few days a year into the wrong month.
 */
import { addDays } from '@/lib/calendar-date';
import type { TranslationKey } from '@/i18n/i18n-context';

/**
 * The intervals the storefront offers.
 *
 * The three `CUSTOM_` entries are the cadences the builder offered before the
 * presets existed. They stay because they are real capabilities that shipped
 * and customers are on them — a weekly standing order on a fixed weekday is
 * not expressible as any preset — but they are grouped apart, since almost
 * nobody arrives wanting to nominate a weekday.
 */
export type Cadence =
  | 'DAYS_15'
  | 'MONTHS_1'
  | 'MONTHS_2'
  | 'MONTHS_3'
  | 'MONTHS_6'
  | 'MONTHS_12'
  | 'CUSTOM_DAYS'
  | 'CUSTOM_WEEKLY'
  | 'CUSTOM_MONTHLY';

export const PRESET_CADENCES = [
  { value: 'DAYS_15', labelKey: 'scheduleBuilder.every15Days' },
  { value: 'MONTHS_1', labelKey: 'scheduleBuilder.everyMonth' },
  { value: 'MONTHS_2', labelKey: 'scheduleBuilder.every2Months' },
  { value: 'MONTHS_3', labelKey: 'scheduleBuilder.every3Months' },
  { value: 'MONTHS_6', labelKey: 'scheduleBuilder.every6Months' },
  { value: 'MONTHS_12', labelKey: 'scheduleBuilder.everyYear' },
] as const satisfies readonly { value: Cadence; labelKey: TranslationKey }[];

export const CUSTOM_CADENCES = [
  { value: 'CUSTOM_DAYS', labelKey: 'scheduleBuilder.everySoManyDays' },
  { value: 'CUSTOM_WEEKLY', labelKey: 'scheduleBuilder.weeklyOnAChosenDay' },
  { value: 'CUSTOM_MONTHLY', labelKey: 'scheduleBuilder.monthlyOnAChosenDate' },
] as const satisfies readonly { value: Cadence; labelKey: TranslationKey }[];

export const WEEKDAYS = [
  { value: 1, labelKey: 'scheduleBuilder.monday' },
  { value: 2, labelKey: 'scheduleBuilder.tuesday' },
  { value: 3, labelKey: 'scheduleBuilder.wednesday' },
  { value: 4, labelKey: 'scheduleBuilder.thursday' },
  { value: 5, labelKey: 'scheduleBuilder.friday' },
  { value: 6, labelKey: 'scheduleBuilder.saturday' },
  { value: 7, labelKey: 'scheduleBuilder.sunday' },
] as const satisfies readonly { value: number; labelKey: TranslationKey }[];

/** The day of the month a `YYYY-MM-DD` start date falls on. */
export function dayOfMonthIn(startDate: string): number {
  const day = Number(startDate.slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
}

/** Today in a given timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is what the API expects — and doing
  // it through Intl means "today" is the customer's today, not the server's.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

/**
 * How much notice a first delivery needs when the store has not said.
 *
 * Seven. A standing order is not a same-day courier: the basket is repriced
 * and revalidated before it runs, stock is reserved, and a payment link or a
 * card charge has to clear — and on this catalogue the warehouse is picking
 * sterile consumables against a purchase order. A week is the window the
 * business actually works to, and offering a buyer tomorrow would be offering
 * something nobody can supply.
 *
 * **A fallback, not the rule.** The rule is `SCHEDULE_MIN_NOTICE_DAYS` on the
 * deployment, published to the browser as `config.fulfilment
 * .scheduleMinNoticeDays` — a shop selling from stock in the buyer's own city
 * sets it to zero, and a figure compiled into this bundle is a figure that
 * operator could not change. This number is what the screen draws with before
 * the config request has answered, and if it ever fails.
 *
 * Read it through `noticeDaysFrom` rather than reaching for the constant, so
 * every screen falls back the same way. And note that the server's own refusal
 * (`SCHEDULE_DATE_TOO_SOON`) is the backstop, not this: a value typed past the
 * screen is still checked there.
 */
export const DELIVERY_NOTICE_DAYS = 7;

/**
 * The deployment's notice period, or the fallback above.
 *
 * Takes the whole config block rather than the number so a caller cannot
 * accidentally pass `0` from an absent field: `?? DELIVERY_NOTICE_DAYS` on a
 * value that is legitimately zero would silently restore the week, and zero is
 * a setting an operator may really have chosen.
 */
export function noticeDaysFrom(
  fulfilment: { scheduleMinNoticeDays: number } | undefined,
): number {
  if (fulfilment === undefined) return DELIVERY_NOTICE_DAYS;

  const days = fulfilment.scheduleMinNoticeDays;
  return Number.isInteger(days) && days >= 0 ? days : DELIVERY_NOTICE_DAYS;
}

/**
 * The earliest delivery date a customer may choose, on a given clock.
 *
 * Computed in the schedule's timezone rather than the machine's, because those
 * are different days for a third of the world at any given moment — and the
 * floor a buyer is held to has to be the one their delivery will run against.
 *
 * `noticeDays` is the deployment's setting; it defaults to the fallback so a
 * test or a caller that has no config still gets the documented behaviour
 * rather than tomorrow.
 */
export function earliestDeliveryDate(
  timezone: string,
  noticeDays: number = DELIVERY_NOTICE_DAYS,
): string {
  const today = todayIn(timezone);

  // Date arithmetic on the calendar day, never on a local `Date` — see the
  // header of `lib/calendar-date.ts` for what that avoids.
  return addDays(today, Math.max(0, Math.trunc(noticeDays)));
}

/** The custom fields, for the three cadences that need one. */
export interface CustomCadenceFields {
  intervalDays: number;
  weekday: number;
  monthDay: number;
}

/**
 * The recurrence fields for a cadence.
 *
 * Only the fields that cadence needs are returned — see the CHECK constraint
 * note in the header.
 *
 * The presets take their day from the start date rather than asking for one.
 * A customer who picked the 9th and "every three months" has already said
 * which day; asking again is a second chance to disagree with themselves.
 */
export function recurrenceFor(
  cadence: Cadence,
  startDate: string,
  custom: CustomCadenceFields,
): Record<string, string | number> {
  switch (cadence) {
    case 'DAYS_15':
      // A fortnight is genuinely fifteen days here, not BIWEEKLY — that
      // frequency is anchored to a weekday, and this preset is not about
      // weekdays at all.
      return { frequency: 'EVERY_N_DAYS', intervalDays: 15 };

    case 'MONTHS_1':
      return { frequency: 'MONTHLY', monthDay: dayOfMonthIn(startDate) };

    case 'MONTHS_2':
      return { frequency: 'EVERY_N_MONTHS', intervalMonths: 2 };
    case 'MONTHS_3':
      return { frequency: 'EVERY_N_MONTHS', intervalMonths: 3 };
    case 'MONTHS_6':
      return { frequency: 'EVERY_N_MONTHS', intervalMonths: 6 };
    case 'MONTHS_12':
      return { frequency: 'EVERY_N_MONTHS', intervalMonths: 12 };

    case 'CUSTOM_DAYS':
      return { frequency: 'EVERY_N_DAYS', intervalDays: custom.intervalDays };
    case 'CUSTOM_WEEKLY':
      return { frequency: 'WEEKLY', weekday: custom.weekday };
    case 'CUSTOM_MONTHLY':
      return { frequency: 'MONTHLY', monthDay: custom.monthDay };
  }
}

/** The stored shape this module can read a cadence back out of. */
export interface StoredRecurrence {
  frequency: string;
  intervalDays: number | null;
  intervalMonths: number | null;
  weekday: number | null;
  monthDay: number | null;
}

/**
 * The other direction: which choice a stored plan was made from.
 *
 * The workspace has to open the dropdown on the interval the customer
 * actually picked, and the server stores the *result* of that pick rather than
 * the pick itself. So this reads it back, and where two choices produce the
 * same stored fields it prefers the preset — "every 15 days" and "every so
 * many days, 15" are indistinguishable on the wire, and the preset is the one
 * almost everybody chose.
 *
 * A plan whose fields match no offered interval — a BIWEEKLY one, or an
 * `EVERY_N_MONTHS` with an interval no preset lists — comes back as the
 * nearest custom entry rather than as null, so the control always has a
 * value. `hasExactMatch` says which happened, and the workspace uses it to
 * warn that saving would move the plan onto a cadence it was not on.
 */
export function cadenceOf(recurrence: StoredRecurrence): {
  cadence: Cadence;
  custom: CustomCadenceFields;
  hasExactMatch: boolean;
} {
  const custom: CustomCadenceFields = {
    intervalDays: recurrence.intervalDays ?? 7,
    weekday: recurrence.weekday ?? 1,
    monthDay: recurrence.monthDay ?? 1,
  };

  switch (recurrence.frequency) {
    case 'EVERY_N_DAYS':
      return recurrence.intervalDays === 15
        ? { cadence: 'DAYS_15', custom, hasExactMatch: true }
        : { cadence: 'CUSTOM_DAYS', custom, hasExactMatch: true };

    case 'MONTHLY':
      // MONTHLY on the start date's own day is the "every month" preset; on
      // any other day it is the custom monthly entry, which shows the day.
      return { cadence: 'CUSTOM_MONTHLY', custom, hasExactMatch: true };

    case 'EVERY_N_MONTHS': {
      const months = recurrence.intervalMonths;
      if (months === 2) return { cadence: 'MONTHS_2', custom, hasExactMatch: true };
      if (months === 3) return { cadence: 'MONTHS_3', custom, hasExactMatch: true };
      if (months === 6) return { cadence: 'MONTHS_6', custom, hasExactMatch: true };
      if (months === 12) return { cadence: 'MONTHS_12', custom, hasExactMatch: true };

      // Two-monthly is the nearest thing on offer to an interval nobody can
      // pick here. Flagged, never applied silently.
      return { cadence: 'MONTHS_2', custom, hasExactMatch: false };
    }

    case 'WEEKLY':
      return { cadence: 'CUSTOM_WEEKLY', custom, hasExactMatch: true };

    // BIWEEKLY and ONE_TIME. Neither is an interval this control offers:
    // BIWEEKLY is anchored to a weekday and behaves differently when a
    // delivery is skipped, and ONE_TIME is Buy Later, which is not a cadence
    // at all.
    default:
      return { cadence: 'CUSTOM_WEEKLY', custom, hasExactMatch: false };
  }
}

// ---------------------------------------------------------------------------
// The whole "when" of a schedule, as one editable object
// ---------------------------------------------------------------------------

/**
 * Everything a screen lets somebody change about *when* a plan runs.
 *
 * One object rather than nine `useState` calls, because these fields are
 * edited together, compared against what was loaded to decide whether
 * anything changed, and sent together. Nine separate pieces of state is how a
 * form ends up sending a new start date with the old timezone.
 */
export interface CadenceDraft {
  cadence: Cadence;
  intervalDays: number;
  weekday: number;
  monthDay: number;
  /** Minutes past midnight, in `timezone`. */
  runAtMinute: number;
  timezone: string;
  /** YYYY-MM-DD, a calendar date in `timezone` and never an instant. */
  startDate: string;
  endMode: 'never' | 'date' | 'count';
  endDate: string;
  maxOccurrences: number;
}

/** What a stored plan looks like to this module. */
export interface StoredSchedule extends StoredRecurrence {
  timezone: string;
  runAtMinute: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
}

/** Open a form on the plan as it stands. */
export function cadenceDraftFrom(schedule: StoredSchedule): CadenceDraft {
  const { cadence, custom } = cadenceOf(schedule);

  return {
    cadence,
    ...custom,
    runAtMinute: schedule.runAtMinute,
    timezone: schedule.timezone,
    startDate: schedule.startDate,
    endMode:
      schedule.endDate !== null ? 'date' : schedule.maxOccurrences !== null ? 'count' : 'never',
    endDate: schedule.endDate ?? '',
    maxOccurrences: schedule.maxOccurrences ?? 12,
  };
}

/**
 * A blank draft for a plan that does not exist yet.
 *
 * Monthly, because that is the interval most repeat purchases actually run at.
 * The old default — "every so many days", with 7 in a number box — made a
 * weekly delivery the path of least resistance for consumables that are
 * ordered monthly.
 *
 * The first delivery starts at the earliest date the notice period allows,
 * not at today. Today is a date the picker greys out and the server refuses,
 * and pre-filling a form with a value both of those reject means every new
 * schedule opens already invalid — the buyer's first interaction with the
 * screen is fixing something they did not type.
 */
export function emptyCadenceDraft(
  timezone: string,
  noticeDays: number = DELIVERY_NOTICE_DAYS,
): CadenceDraft {
  return {
    cadence: 'MONTHS_1',
    intervalDays: 7,
    weekday: 1,
    monthDay: 1,
    runAtMinute: 360,
    timezone,
    startDate: earliestDeliveryDate(timezone, noticeDays),
    endMode: 'never',
    endDate: '',
    maxOccurrences: 12,
  };
}

/**
 * The draft as the API's own fields.
 *
 * `forUpdate` is the whole reason this takes an option. On a PATCH, "no end
 * date" has to be sent as an explicit `null` to clear one the plan already
 * has; on a POST there is nothing to clear, and sending nulls into creation
 * would be describing absent fields rather than omitting them.
 */
export function recurrencePayload(
  draft: CadenceDraft,
  options: { forUpdate: boolean },
): Record<string, string | number | null> {
  const ending: Record<string, string | number | null> = options.forUpdate
    ? // Both are always stated, so switching from one kind of ending to the
      // other clears the kind being left behind. Sending only the new one
      // would leave a plan with both an end date and a delivery count, and
      // whichever came first would end it.
      {
        endDate: draft.endMode === 'date' && draft.endDate !== '' ? draft.endDate : null,
        maxOccurrences: draft.endMode === 'count' ? draft.maxOccurrences : null,
      }
    : {
        ...(draft.endMode === 'date' && draft.endDate !== '' ? { endDate: draft.endDate } : {}),
        ...(draft.endMode === 'count' ? { maxOccurrences: draft.maxOccurrences } : {}),
      };

  return {
    // The frequency and its one dependent field, together, from the single
    // choice the customer made — never assembled at a call site, where one of
    // the three conditionals eventually goes missing and the CHECK constraint
    // refuses the write.
    ...recurrenceFor(draft.cadence, draft.startDate, {
      intervalDays: draft.intervalDays,
      weekday: draft.weekday,
      monthDay: draft.monthDay,
    }),
    timezone: draft.timezone,
    runAtMinute: draft.runAtMinute,
    startDate: draft.startDate,
    ...ending,
  };
}

/** Whether two drafts describe the same arrangement. */
export function isSameCadence(a: CadenceDraft, b: CadenceDraft): boolean {
  // Compared through the payload rather than field by field, so the fields a
  // cadence does not use cannot register as a change: somebody who switches
  // from weekly to monthly and back has changed nothing, whatever the weekday
  // box still holds.
  return (
    JSON.stringify(recurrencePayload(a, { forUpdate: true })) ===
    JSON.stringify(recurrencePayload(b, { forUpdate: true }))
  );
}
