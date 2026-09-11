/**
 * When a schedule runs: how often, at what time, on which clock, from when,
 * until when.
 *
 * One component for both screens that ask the question — the workspace, where
 * an existing plan is changed, and the new-schedule panel beside it. The
 * builder's own copy of these controls is left where it is, because that
 * screen asks them as part of a longer flow with its own copy; what is shared
 * between all three is the *mapping*, in `lib/schedule-cadence.ts`, which is
 * the part that must never be written twice.
 *
 * Two things here that the builder does not have, and both are requirements a
 * plan acquires only once it exists:
 *
 *   - **The timezone is editable.** At creation the store's own zone is the
 *     right default and asking is noise. Afterwards it is a real question: a
 *     standing order set up by a buyer in Kolkata and handed to a colleague in
 *     Rotterdam fires at 06:00 in the wrong city, and the fix has to be one
 *     field rather than "cancel it and build another".
 *   - **Changing anything here re-dates the upcoming deliveries**, which the
 *     panel says out loud before the change is applied rather than after.
 *
 * `disabled` is one prop for the whole group and it is passed, not inferred: a
 * plan inside its edit cutoff, being processed, cancelled or finished is
 * read-only, and the screen above knows which. Controls that look editable
 * and then fail on save are worse than controls that say they are locked.
 */
import { useEffect, useId, useMemo } from 'react';
import { useStorefront } from '@/app/storefront-context';
import { DatePicker } from '@/components/DatePicker';
import { Field, Input, Select } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import {
  CUSTOM_CADENCES,
  PRESET_CADENCES,
  WEEKDAYS,
  earliestDeliveryDate,
  noticeDaysFrom,
} from '@/lib/schedule-cadence';
import type { Cadence, CadenceDraft } from '@/lib/schedule-cadence';
import { timezoneLabel, timezoneOptions } from '@/lib/timezones';
import { translateKey, useI18n } from '@/i18n/i18n-context';

export function CadenceFields({
  draft,
  onChange,
  disabled = false,
  earliest,
}: {
  draft: CadenceDraft;
  onChange: (next: CadenceDraft) => void;
  disabled?: boolean;
  /**
   * The floor the API will enforce, from `GET /delivery-window`.
   *
   * Passed in rather than fetched here because it depends on the delivery
   * address, and this component does not know one - the workspace and the
   * new-schedule panel each own that field. Undefined until the answer
   * arrives, or where the ask failed, and the notice period stands alone
   * then: a calendar greying out nothing is worse than one greying out
   * slightly the wrong fortnight.
   */
  earliest?: string | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  /*
   * The notice period is the deployment's, not this file's.
   *
   * Read here rather than passed in: both screens that render these fields
   * would otherwise have to thread the same number through, and the one that
   * forgot would grey out a different fortnight than the server enforces.
   */
  const noticeDays = noticeDaysFrom(useStorefront().fulfilment);
  // The radio group's name. Generated, because this component renders twice on
  // the workspace — once for the plan being edited and once for a new one —
  // and two groups sharing a name are one group: choosing an ending for the
  // new schedule would clear the ending on the one being edited.
  const endModeName = useId();

  /*
   * The zone list, built once per zone rather than on every keystroke.
   *
   * `timezoneOptions` asks the platform for the whole IANA list - six hundred
   * entries - and this component re-renders on every field in the group. It is
   * cheap to compute and expensive to compute six hundred times.
   */
  const zones = useMemo(() => timezoneOptions(draft.timezone), [draft.timezone]);

  /** Change one field, leaving the rest of the arrangement alone. */
  const set = (patch: Partial<CadenceDraft>): void => {
    onChange({ ...draft, ...patch });
  };

  /*
   * Lift a start date that sits below the floor the server has just named.
   *
   * The floor arrives after the form does — it takes an address and a round
   * trip — and it can be later than the notice period the picker opened with,
   * because the delivery address's own zone or a pinned warehouse's lane says
   * so. Leaving the old date in place would hold an invalid value in a form
   * that looks valid, and the buyer would find that out at save.
   *
   * Only ever forwards. A date further out is the buyer's own choice and this
   * must not drag it back.
   */
  useEffect(() => {
    if (earliest === undefined || disabled) return;
    if (draft.startDate >= earliest) return;

    onChange({ ...draft, startDate: earliest });
  }, [earliest, disabled, draft, onChange]);

  return (
    <div className="space-y-4">
      <Field label={t('scheduleBuilder.repeat')} hint={t('scheduleBuilder.theFirstDeliveryDateSets')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            value={draft.cadence}
            disabled={disabled}
            aria-describedby={describedBy}
            onChange={(event) => {
              set({ cadence: event.target.value as Cadence });
            }}
          >
            {/* Two groups, and the split is doing work rather than decorating:
                the six presets answer "how often" on their own, while each
                custom entry is a promise of a second question. */}
            <optgroup label={t('scheduleBuilder.commonIntervals')}>
              {PRESET_CADENCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {translateKey(t, option.labelKey)}
                </option>
              ))}
            </optgroup>

            <optgroup label={t('scheduleBuilder.somethingElse')}>
              {CUSTOM_CADENCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {translateKey(t, option.labelKey)}
                </option>
              ))}
            </optgroup>
          </Select>
        )}
      </Field>

      {draft.cadence === 'CUSTOM_DAYS' && (
        <Field
          label={t('scheduleBuilder.numberOfDaysBetweenDeliveries')}
          hint={t('scheduleBuilder.7GivesYouAWeekly')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="number"
              min={1}
              max={365}
              className="tabular sm:w-32"
              value={draft.intervalDays}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) set({ intervalDays: parsed });
              }}
              onBlur={() => {
                set({ intervalDays: Math.min(365, Math.max(1, draft.intervalDays)) });
              }}
            />
          )}
        </Field>
      )}

      {draft.cadence === 'CUSTOM_WEEKLY' && (
        <Field label={t('scheduleBuilder.dayOfTheWeek')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={draft.weekday}
              disabled={disabled}
              onChange={(event) => {
                set({ weekday: Number(event.target.value) });
              }}
            >
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {translateKey(t, day.labelKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {draft.cadence === 'CUSTOM_MONTHLY' && (
        <Field
          label={t('scheduleBuilder.dayOfTheMonth')}
          hint={t('scheduleBuilder.aMonthShorterThanThe')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="number"
              min={1}
              max={31}
              className="tabular sm:w-32"
              value={draft.monthDay}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) set({ monthDay: parsed });
              }}
              onBlur={() => {
                set({ monthDay: Math.min(31, Math.max(1, draft.monthDay)) });
              }}
            />
          )}
        </Field>
      )}

      {/*
       * The delivery date, and no time of day.
       *
       * The time control is gone from this screen. It offered five fixed
       * times, all of them the middle of somebody's night somewhere, and the
       * hour a warehouse picks an order is not a decision a buyer has any
       * basis for making — it is the operator's. The plan keeps whatever
       * `runAtMinute` it has (the store's own default for a new one), the API
       * still receives it, and nothing about the recurrence changed. What was
       * removed is a question nobody could answer.
       */}
      <Field label={t('scheduleCart.deliveryDate')} hint={t('scheduleCart.deliveryDateHint')}>
        {({ inputId, describedBy }) => (
          <DatePicker
            id={inputId}
            label={t('scheduleCart.deliveryDate')}
            value={draft.startDate}
            /*
             * A week's notice, counted on the schedule's own clock.
             *
             * Not the machine's: "today" is a different day in Pune and in
             * Los Angeles at the same moment, and the floor a buyer is held to
             * has to be the one their delivery runs against. The server has
             * the final say - it refuses a next run in the past - but a
             * calendar that greys out what will be refused is the difference
             * between a rule and a rejection.
             */
            min={earliest ?? earliestDeliveryDate(draft.timezone, noticeDays)}
            disabled={disabled}
            describedBy={describedBy}
            onChange={(next) => {
              set({ startDate: next });
            }}
          />
        )}
      </Field>

      {/*
       * The offset is named for the CHOSEN zone only, in the hint.
       *
       * It is the part that answers the question somebody is actually asking -
       * "is this the clock I am looking at?" - but resolving one costs an
       * `Intl.DateTimeFormat`, and doing that for every option would build six
       * hundred formatters to render one dropdown.
       */}
      <Field
        label={t('scheduleCart.timezone')}
        hint={`${t('scheduleCart.timezoneHint')} ${timezoneLabel(draft.timezone)}`}
      >
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            value={draft.timezone}
            disabled={disabled}
            aria-describedby={describedBy}
            onChange={(event) => {
              set({ timezone: event.target.value });
            }}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <fieldset disabled={disabled}>
        <legend className="text-sm font-medium text-ink">
          {t('scheduleBuilder.whenShouldItStop')}
        </legend>

        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name={endModeName}
              className="h-4 w-4 border-border-strong text-brand"
              checked={draft.endMode === 'never'}
              onChange={() => {
                set({ endMode: 'never' });
              }}
            />
            {t('scheduleBuilder.keepGoingUntilICancel')}
          </label>

          <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name={endModeName}
              className="h-4 w-4 border-border-strong text-brand"
              checked={draft.endMode === 'date'}
              onChange={() => {
                set({ endMode: 'date' });
              }}
            />
            {t('scheduleBuilder.stopAfter')}
            {/*
             * The width goes on a wrapper, not on the field.
             *
             * `Input` carries `w-full` in its base classes, and `w-full` sorts
             * after a numeric width in Tailwind's own stylesheet - so `w-44`
             * here loses, the date box takes the whole row, and "deliveries"
             * below it lands on a line of its own. Sizing the box that
             * contains it sidesteps the fight entirely.
             */}
            <span className="w-44 shrink-0">
              <Input
                type="date"
                value={draft.endDate}
                min={draft.startDate}
                aria-label={t('scheduleBuilder.stopAfterThisDate')}
                disabled={disabled || draft.endMode !== 'date'}
                onChange={(event) => {
                  set({ endDate: event.target.value });
                }}
              />
            </span>
          </label>

          <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name={endModeName}
              className="h-4 w-4 border-border-strong text-brand"
              checked={draft.endMode === 'count'}
              onChange={() => {
                set({ endMode: 'count' });
              }}
            />
            {t('scheduleBuilder.stopAfter')}
            <span className="w-24 shrink-0">
              <Input
                type="number"
                min={1}
                max={10000}
                className="tabular"
                value={draft.maxOccurrences}
                aria-label={t('scheduleBuilder.numberOfDeliveries')}
                disabled={disabled || draft.endMode !== 'count'}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) set({ maxOccurrences: parsed });
                }}
              />
            </span>
            {t('scheduleCart.deliveries', { count: draft.maxOccurrences, quantity: formatNumber(draft.maxOccurrences) })}
          </label>
        </div>
      </fieldset>
    </div>
  );
}
