/**
 * A date field that opens a calendar.
 *
 * This replaced `<input type="date">` on the schedule's delivery date, and the
 * reason is the constraint rather than the looks. That field cannot accept any
 * date: a delivery needs a week's notice, so most of the calendar is not
 * available — and a native date input expresses that as a `min` attribute the
 * browser enforces silently. The buyer types the 14th, the field refuses it,
 * and nothing on screen says why. A calendar can grey the unavailable days,
 * mark the earliest one that *is* available, and say the rule in words under
 * the grid.
 *
 * Everything it draws is a `YYYY-MM-DD` string — see `lib/calendar-date.ts`
 * for why a `Date` is never used for a calendar day. A picker that shows one
 * date and sends another is the one bug this component exists to make
 * impossible.
 *
 * **A disclosure, not an ARIA menu**, and the same shell the market and
 * account panels use: outside click and Escape close it, Escape returns focus
 * to the trigger, and below `lg` it is a bottom sheet with a real dismiss
 * button rather than a popover clipped by the bottom of a phone.
 *
 * **The grid is a table**, because that is what it is. Weekday headers are
 * `<th scope="col">` with the full day name for a screen reader and an
 * initial on screen; each day is a button in a `<td>`. Only one day is in the
 * tab order at a time (a roving `tabIndex`), so tabbing past the calendar
 * takes one press rather than thirty-five, and the arrow keys move within it:
 *
 *   - Left/Right by a day, Up/Down by a week
 *   - Home/End to the ends of the week
 *   - PageUp/PageDown by a month
 *   - Enter or Space to choose, Escape to give up
 *
 * The visible month is announced politely as it changes, because paging with
 * PageUp is otherwise a silent change of thirty-five buttons.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
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
} from '@/lib/calendar-date';
import { useI18n } from '@/i18n/i18n-context';

export interface DatePickerProps {
  /** `YYYY-MM-DD`, or empty for no date yet. */
  value: string;
  onChange: (next: string) => void;
  /** The earliest selectable day, inclusive. */
  min?: string;
  /** The latest selectable day, inclusive. */
  max?: string;
  disabled?: boolean;
  /**
   * The field's own label, for the trigger's accessible name.
   *
   * Passed rather than read from the surrounding `<label>`: a `<label for>`
   * does associate with a button, but a button's accessible name comes from
   * its content, so the label alone would leave a screen reader announcing
   * only the date with no idea what it is the date of.
   */
  label: string;
  /** The id the surrounding `Field` minted, so its label points here. */
  id?: string;
  describedBy?: string | undefined;
  /** Shown on the trigger when there is no date yet. */
  placeholder?: string;
}

/** One day in the grid. */
interface DayCell {
  iso: string;
  day: number;
  isCurrentMonth: boolean;
  isSelectable: boolean;
  isSelected: boolean;
  isToday: boolean;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled = false,
  label,
  id,
  describedBy,
  placeholder,
}: DatePickerProps): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const panelId = useId();

  const [isOpen, setIsOpen] = useState(false);

  /**
   * The day the arrow keys are on.
   *
   * Not the same as the selected day: opening the calendar on a plan with no
   * date, or with a date that is no longer selectable, still has to put the
   * keyboard somewhere sensible. Null until the panel opens, so a re-render
   * while closed cannot move it.
   */
  const [focusedIso, setFocusedIso] = useState<string | null>(null);

  const weekStartsOn = useMemo(() => firstDayOfWeek(intlLocale), [intlLocale]);
  const weekdays = useMemo(() => weekdayNames(intlLocale, weekStartsOn), [intlLocale, weekStartsOn]);

  /*
   * Today, on the machine's clock.
   *
   * Only ever used to draw the "today" marker, which is a courtesy rather than
   * a rule — the rule is `min`, and the caller works that out on the
   * schedule's own clock. Being a day out on the marker for a reader in
   * Honolulu is a cosmetic cost; recomputing it here in the wrong zone and
   * then enforcing it would not be.
   */
  const today = useMemo(() => new Intl.DateTimeFormat('en-CA').format(new Date()), []);

  /** Where the calendar is anchored when it opens: the value, else the floor. */
  const anchorIso = value !== '' ? value : (min ?? today);

  const [view, setView] = useState(() => {
    const parsed = parseIsoDate(anchorIso) ?? parseIsoDate(today);
    return { year: parsed?.year ?? 2026, month: parsed?.month ?? 1 };
  });

  const isSelectable = (iso: string): boolean => {
    // `YYYY-MM-DD` compares correctly as a string — see `calendar-date.ts`.
    if (min !== undefined && iso < min) return false;
    if (max !== undefined && iso > max) return false;
    return true;
  };

  const open = (): void => {
    const parsed = parseIsoDate(anchorIso);
    if (parsed !== null) setView({ year: parsed.year, month: parsed.month });

    // Land the keyboard on the value where it can still be chosen, and on the
    // earliest day that can be otherwise. A plan whose start date has since
    // fallen inside the notice period opens on the first day it could move to.
    setFocusedIso(isSelectable(anchorIso) ? anchorIso : (min ?? anchorIso));
    setIsOpen(true);
  };

  const close = (options: { returnFocus: boolean }): void => {
    setIsOpen(false);
    setFocusedIso(null);
    if (options.returnFocus) triggerRef.current?.focus();
  };

  const choose = (iso: string): void => {
    if (!isSelectable(iso)) return;
    onChange(iso);
    close({ returnFocus: true });
  };

  // Outside click and Escape, as everywhere else in this app. Escape gives the
  // trigger its focus back: a keyboard user who escapes a panel and is dropped
  // at the top of the document has lost their place.
  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) {
        close({ returnFocus: false });
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close({ returnFocus: true });
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  /*
   * Keep the DOM focus on the day the arrow keys are on.
   *
   * The grid re-renders on every move, so the focused button is a new element
   * each time and the browser has dropped focus to the body. Without this the
   * first arrow press would be the last one that worked.
   */
  useEffect(() => {
    if (!isOpen || focusedIso === null) return;

    const cell = gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusedIso}"]`);
    cell?.focus();
  }, [isOpen, focusedIso]);

  /** Move the keyboard, bringing the view with it when it leaves the month. */
  const moveFocus = (iso: string): void => {
    const parsed = parseIsoDate(iso);
    if (parsed === null) return;

    setFocusedIso(iso);
    setView({ year: parsed.year, month: parsed.month });
  };

  /**
   * The arrow keys, handled on the day itself rather than on the table.
   *
   * The obvious place for this is the grid container, and it is the wrong
   * one: a `<table>` is not an interactive element, so a key handler on it is
   * a handler on something no keyboard user can reach. The event starts on the
   * focused day button in any case, and taking the day as an argument means
   * this does not have to trust a piece of state to say which one that was.
   */
  const onDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, iso: string): void => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };

    const days = step[event.key];
    if (days !== undefined) {
      event.preventDefault();
      moveFocus(addDays(iso, days));
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();

      // How far into its own week this day sits, in the grid's order — which
      // is not the same as its weekday number wherever the week starts on
      // something other than Sunday.
      const offset = (weekdayOf(iso) - weekStartsOn + 7) % 7;
      moveFocus(addDays(iso, event.key === 'Home' ? -offset : 6 - offset));
      return;
    }

    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      const parsed = parseIsoDate(iso);
      if (parsed === null) return;
      moveFocus(toIsoDate(addMonths(parsed, event.key === 'PageUp' ? -1 : 1)));
    }
  };

  const cells: DayCell[] = monthGrid(view.year, view.month, weekStartsOn).map((iso) => {
    const parsed = parseIsoDate(iso);

    return {
      iso,
      day: parsed?.day ?? 1,
      isCurrentMonth: parsed?.month === view.month,
      isSelectable: isSelectable(iso),
      isSelected: iso === value,
      isToday: iso === today,
    };
  });

  /*
   * Paging past the floor or the ceiling has nowhere to go.
   *
   * The test is whether the neighbouring month holds a selectable day at all,
   * not whether its 1st does: with a floor of the 18th, September is still
   * worth paging back to for the 18th through the 30th.
   */
  const previousMonth = addMonths({ ...view, day: 1 }, -1);
  const nextMonth = addMonths({ ...view, day: 1 }, 1);

  const canGoBack =
    min === undefined ||
    toIsoDate({
      ...previousMonth,
      day: daysInMonth(previousMonth.year, previousMonth.month),
    }) >= min;

  const canGoForward = max === undefined || toIsoDate({ ...nextMonth, day: 1 }) <= max;

  const monthLabel = formatMonthYear(view.year, view.month, intlLocale);
  const formattedValue = value === '' ? null : formatIsoDate(value, intlLocale, { dateStyle: 'full' });

  return (
    <div ref={containerRef} className="relative">
      {/* --- The field ------------------------------------------------------ */}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        aria-describedby={describedBy}
        // The label is not part of a button's accessible name — see the prop's
        // note — so the name is composed here and carries the current value,
        // which is the thing a screen-reader user is checking.
        aria-label={
          formattedValue === null
            ? t('datePicker.emptyLabel', { field: label })
            : t('datePicker.valueLabel', { field: label, date: formattedValue })
        }
        onClick={() => {
          if (isOpen) close({ returnFocus: false });
          else open();
        }}
        className={cx(
          'flex h-10 w-full items-center gap-2.5 rounded-md border px-3 text-left text-sm shadow-card',
          'transition-[background-color,border-color,box-shadow] motion-reduce:transition-none',
          'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-sunken',
          'disabled:text-ink-muted disabled:shadow-none',
          isOpen
            ? 'border-brand bg-surface text-ink ring-1 ring-inset ring-brand'
            : 'border-border-strong bg-surface text-ink hover:border-border-hover',
        )}
      >
        <CalendarIcon
          aria-hidden="true"
          className={cx('h-4 w-4 shrink-0', isOpen ? 'text-brand' : 'text-ink-subtle')}
        />

        <span className={cx('min-w-0 flex-1 truncate', value === '' && 'text-ink-subtle')}>
          {value === ''
            ? (placeholder ?? t('datePicker.choose'))
            : formatIsoDate(value, intlLocale, { dateStyle: 'medium' })}
        </span>

        <ChevronDownIcon
          aria-hidden="true"
          className={cx(
            'h-4 w-4 shrink-0 text-ink-subtle transition-transform motion-reduce:transition-none',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {/* --- The scrim, phones only ----------------------------------------
       *
       * A sheet with the page still tappable behind it is a sheet people
       * dismiss by accident. A `<button>` rather than a `<div onClick>`,
       * because dismissing by tapping outside has to be reachable by
       * something other than a pointer.
       */}
      {isOpen && (
        <button
          type="button"
          onClick={() => {
            close({ returnFocus: false });
          }}
          className="fixed inset-0 z-40 cursor-default bg-ink/30 backdrop-blur-[2px] sm:hidden"
        >
          <span className="sr-only">{t('common.close')}</span>
        </button>
      )}

      {isOpen && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('datePicker.dialogLabel', { field: label })}
          className={cx(
            // A bottom sheet under `sm`, an anchored popover from it. A 20rem
            // panel hanging off a field two thirds down a phone screen is a
            // panel with its last week below the fold.
            'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-border',
            'sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-[calc(100%+0.375rem)]',
            'sm:w-[20.5rem] sm:rounded-xl sm:border',
            'bg-surface-raised shadow-overlay sm:shadow-popover',
            'animate-dialog-in',
          )}
        >
          {/* --- Month navigation ------------------------------------------ */}
          <div className="flex items-center gap-1 rounded-t-2xl border-b border-border-subtle bg-gradient-to-b from-brand-soft/50 to-transparent px-2 py-2 sm:rounded-t-xl">
            <button
              type="button"
              disabled={!canGoBack}
              aria-label={t('datePicker.previousMonth')}
              onClick={() => {
                setView(addMonths({ ...view, day: 1 }, -1));
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-subtle disabled:hover:bg-transparent motion-reduce:transition-none"
            >
              <ChevronRightIcon aria-hidden="true" className="h-4 w-4 rotate-180" />
            </button>

            {/*
             * `aria-live`, because paging is otherwise a silent change of
             * thirty-five buttons. Polite: it waits for a pause rather than
             * interrupting the day being read out.
             */}
            <p
              aria-live="polite"
              className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-ink"
            >
              {monthLabel}
            </p>

            <button
              type="button"
              disabled={!canGoForward}
              aria-label={t('datePicker.nextMonth')}
              onClick={() => {
                setView(addMonths({ ...view, day: 1 }, 1));
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-subtle disabled:hover:bg-transparent motion-reduce:transition-none"
            >
              <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>

          {/* --- The grid --------------------------------------------------- */}
          <table
            ref={gridRef}
            className="w-full table-fixed border-separate border-spacing-0.5 px-2 py-2"
          >
            <thead>
              <tr>
                {weekdays.map((weekday) => (
                  <th key={weekday.long} scope="col" className="pb-1">
                    {/* The initial on screen, the whole name for a screen
                        reader: "M" is not a day of the week. */}
                    <span aria-hidden="true" className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {weekday.short}
                    </span>
                    <span className="sr-only">{weekday.long}</span>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {Array.from({ length: 6 }, (_unused, week) => (
                <tr key={week}>
                  {cells.slice(week * 7, week * 7 + 7).map((cell) => (
                    <td key={cell.iso} className="p-0 text-center">
                      <button
                        type="button"
                        data-iso={cell.iso}
                        disabled={!cell.isSelectable}
                        // Roving: one day in the tab order, so tabbing out of
                        // the calendar is one press and not thirty-five.
                        tabIndex={cell.iso === focusedIso ? 0 : -1}
                        aria-current={cell.isToday ? 'date' : undefined}
                        aria-pressed={cell.isSelected}
                        aria-label={formatIsoDate(cell.iso, intlLocale, { dateStyle: 'full' })}
                        onClick={() => {
                          choose(cell.iso);
                        }}
                        onKeyDown={(event) => {
                          onDayKeyDown(event, cell.iso);
                        }}
                        onFocus={() => {
                          setFocusedIso(cell.iso);
                        }}
                        className={cx(
                          'flex h-9 w-full items-center justify-center rounded-lg text-sm tabular',
                          'transition-[background-color,color,box-shadow] motion-reduce:transition-none',
                          'disabled:cursor-not-allowed',
                          cell.isSelected
                            ? // The one filled cell. White on the brand fill,
                              // which is the pair the contrast audit covers.
                              'bg-brand-fill font-semibold text-white shadow-card hover:bg-brand-fill-hover'
                            : !cell.isSelectable
                              ? // Plainly unavailable, and still readable: a
                                // buyer has to be able to see WHICH days are
                                // out, not just that some are.
                                'text-ink-subtle/60'
                              : cell.isCurrentMonth
                                ? 'text-ink hover:bg-brand-soft hover:text-brand'
                                : // A neighbouring month's day: still real,
                                  // still selectable, visibly not this month.
                                  'text-ink-subtle hover:bg-surface-hover hover:text-ink-muted',
                          /*
                           * Today gets a ring rather than a fill, so it can be
                           * seen at the same time as the selection.
                           *
                           * Only when today is selectable. On this field it
                           * usually is not - a delivery needs a week's notice -
                           * and a ring around a day that cannot be chosen is a
                           * false affordance. The greyed block and the sentence
                           * under the grid already say where the floor is.
                           */
                          cell.isToday &&
                            cell.isSelectable &&
                            !cell.isSelected &&
                            'ring-1 ring-inset ring-brand/40',
                        )}
                      >
                        {cell.day}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {/* --- The rule, in words ----------------------------------------
           *
           * The greyed-out fortnight at the top of the calendar is the
           * *consequence* of a rule nobody has stated. Saying it, and offering
           * the earliest day it allows as one press, is the difference between
           * a calendar that refuses and one that helps.
           */}
          {min !== undefined && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border-subtle px-3 py-2.5">
              <p className="min-w-0 text-xxs leading-relaxed text-ink-muted">
                {t('datePicker.earliestIs', {
                  date: formatIsoDate(min, intlLocale, { dateStyle: 'medium' }),
                })}
              </p>

              <button
                type="button"
                onClick={() => {
                  choose(min);
                }}
                className="shrink-0 rounded text-xxs font-semibold text-brand underline underline-offset-2 hover:no-underline"
              >
                {t('datePicker.chooseEarliest')}
              </button>
            </div>
          )}

          {/* The sheet's own dismiss, phones only: Escape is not available to
              a touch user, and the scrim is not obviously a control. */}
          <div className="border-t border-border-subtle p-2 sm:hidden">
            <button
              type="button"
              onClick={() => {
                close({ returnFocus: true });
              }}
              className="h-10 w-full rounded-md bg-surface-sunken text-sm font-medium text-ink transition-colors hover:bg-surface-hover motion-reduce:transition-none"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
