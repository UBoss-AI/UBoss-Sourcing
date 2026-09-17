/**
 * The dashboard's controls: the reporting window, and the two buttons.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of console.tsx. Every string
 * arrives translated, so the three copies cannot drift over a catalogue.
 */
import { useId, useRef, type ReactNode } from 'react';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// The reporting window
// ---------------------------------------------------------------------------

/** The named windows, in the order they are offered. */
export type RangeKey = 'today' | '7d' | '30d' | 'custom';

export interface RangeOption {
  key: RangeKey;
  label: string;
}

export interface RangeTabsLabels {
  /** The group's accessible name, e.g. "Reporting period". */
  legend: string;
  from: string;
  to: string;
  apply: string;
}

/**
 * The window picker.
 *
 * A real tab list with a sliding indicator, and the indicator is the only
 * moving part: it is a transform on one absolutely-positioned element, so
 * switching windows costs no layout. Where the tab list is what somebody is
 * reading rather than what they are operating, `prefers-reduced-motion` in
 * index.css stops it sliding and it simply appears in the new place — which
 * loses nothing, because the selected tab also carries `aria-selected` and its
 * own colour.
 *
 * `role="tablist"` with arrow-key navigation, which is what a keyboard user
 * expects of something that looks like this. The custom range is a tab too,
 * and selecting it reveals two date fields below rather than opening a popup:
 * a popup over a dashboard covers the thing you are choosing a window for.
 */
export function RangeTabs({
  options,
  value,
  onChange,
  labels,
  customFrom,
  customTo,
  onCustomChange,
  className,
}: {
  options: readonly RangeOption[];
  value: RangeKey;
  onChange: (key: RangeKey) => void;
  labels: RangeTabsLabels;
  /** ISO date, `yyyy-mm-dd`. Only read when `value` is `custom`. */
  customFrom?: string | undefined;
  customTo?: string | undefined;
  onCustomChange?: ((from: string, to: string) => void) | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const groupId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const index = Math.max(
    0,
    options.findIndex((option) => option.key === value),
  );

  function moveFocus(delta: number): void {
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (option === undefined) return;

    onChange(option.key);
    tabs.current[next]?.focus();
  }

  return (
    <div className={cx('min-w-0', className)}>
      <div
        role="tablist"
        aria-label={labels.legend}
        className="relative inline-flex max-w-full overflow-x-auto rounded-full border border-console-border/80 bg-console-raised/70 p-1 scrollbar-none"
      >
        {/*
          The indicator. One element translated across the group rather than a
          background on each tab, so the selection appears to move between
          them. `aria-hidden` and behind the labels: it is decoration over a
          state that `aria-selected` already carries.
        */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-1 top-1 rounded-full bg-brand-soft transition-transform duration-200"
          style={{
            width: `calc((100% - 0.5rem) / ${String(options.length)})`,
            transform: `translateX(${String(index * 100)}%)`,
          }}
        />

        {options.map((option, position) => {
          const selected = option.key === value;

          return (
            <button
              key={option.key}
              ref={(element) => {
                tabs.current[position] = element;
              }}
              type="button"
              role="tab"
              id={`${groupId}-${option.key}`}
              aria-selected={selected}
              aria-controls={`${groupId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onChange(option.key);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  moveFocus(1);
                } else if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  moveFocus(-1);
                }
              }}
              className={cx(
                'relative z-10 shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors',
                // 44px of target on touch, from the padding plus this.
                'min-h-[2.25rem]',
                selected ? 'text-brand' : 'text-ink-muted hover:text-ink',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {value === 'custom' && onCustomChange !== undefined ? (
        <div
          id={`${groupId}-panel`}
          role="tabpanel"
          aria-labelledby={`${groupId}-custom`}
          className="mt-2 flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xxs font-medium text-ink-subtle">{labels.from}</span>
            <input
              type="date"
              value={customFrom ?? ''}
              max={customTo}
              onChange={(event) => {
                onCustomChange(event.target.value, customTo ?? '');
              }}
              className="rounded-md border border-border-strong bg-console-raised px-2.5 py-1.5 text-xs text-ink"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xxs font-medium text-ink-subtle">{labels.to}</span>
            <input
              type="date"
              value={customTo ?? ''}
              min={customFrom}
              onChange={(event) => {
                onCustomChange(customFrom ?? '', event.target.value);
              }}
              className="rounded-md border border-border-strong bg-console-raised px-2.5 py-1.5 text-xs text-ink"
            />
          </label>
        </div>
      ) : (
        <div id={`${groupId}-panel`} role="tabpanel" hidden />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonState = 'idle' | 'busy' | 'done' | 'failed';

/**
 * A button that reports what it is doing.
 *
 * The state is the caller's — it comes out of a mutation or a query, not out
 * of a timer in here — so the button cannot say "done" while the request is
 * still in flight.
 *
 * **The label changes with the state, not only the icon.** A spinner that
 * replaces a word tells a screen reader nothing has happened; the accessible
 * name changing is what does. `aria-live="polite"` on the label so the change
 * is announced once, and `aria-disabled` rather than `disabled` while busy, so
 * the button keeps its place in the tab order and the announcement is not made
 * to an element the user has just been thrown out of.
 */
export function StatefulButton({
  state,
  labels,
  onClick,
  icon,
  className,
  tone = 'quiet',
}: {
  state: ButtonState;
  labels: { idle: string; busy: string; done: string; failed: string };
  onClick: () => void;
  icon?: ReactNode;
  className?: string | undefined;
  tone?: 'quiet' | 'primary';
}): React.JSX.Element {
  const busy = state === 'busy';

  return (
    <button
      type="button"
      aria-disabled={busy}
      aria-live="polite"
      onClick={() => {
        if (!busy) onClick();
      }}
      className={cx(
        'inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        tone === 'primary'
          ? 'bg-brand-fill text-ink-inverse hover:bg-brand-fill-hover'
          : 'border border-border-strong text-ink hover:border-border-hover hover:bg-surface-hover',
        busy && 'cursor-progress opacity-70',
        state === 'failed' && 'border-danger text-danger',
        className,
      )}
    >
      {busy ? <Spinner /> : state === 'done' ? <TickIcon /> : icon}
      <span>{labels[state]}</span>
    </button>
  );
}

/**
 * The refresh control.
 *
 * Its own component rather than a `StatefulButton` with an icon, because the
 * thing it reports is different: a refresh is not an action with an outcome to
 * announce, it is a request for newer numbers. So the icon turns while a
 * fetch is in flight and the accessible name says whether it is running,
 * and there is no "done" state to sit in afterwards.
 */
export function RefreshButton({
  busy,
  labels,
  onClick,
}: {
  busy: boolean;
  labels: { refresh: string; refreshing: string };
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={busy}
      className="inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-md border border-console-border/80 bg-console-raised/70 px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-border-hover hover:text-ink"
    >
      <svg
        viewBox="0 0 20 20"
        className={cx('h-3.5 w-3.5', busy && 'animate-spin')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" />
        <path d="M16.5 3v3.5H13" />
      </svg>
      <span>{busy ? labels.refreshing : labels.refresh}</span>
    </button>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5 animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" />
    </svg>
  );
}

function TickIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 10 4 4 8-8" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// A small stat tile
// ---------------------------------------------------------------------------

/**
 * One figure, in the bento grid.
 *
 * `to` is optional and is what decides whether the tile is interactive. A tile
 * that leads somewhere gets a hover lift and a chevron; one that does not is
 * flat. The link is rendered by the caller — this component has no router
 * type, so the three copies of it stay identical.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  icon,
  children,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  /** `warning` and `danger` are for a count that wants somebody today. */
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
  icon?: ReactNode;
  /** A sparkline, a delta, a link row. */
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xxs font-medium uppercase tracking-[0.1em] text-ink-subtle">{label}</p>
        {icon === undefined ? null : (
          <span className="shrink-0 text-ink-subtle" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>

      <p
        className={cx(
          'tabular mt-1.5 text-title',
          tone === 'danger'
            ? 'text-danger'
            : tone === 'warning'
              ? 'text-warning'
              : tone === 'success'
                ? 'text-success'
                : 'text-ink',
        )}
      >
        {value}
      </p>

      {sub === undefined ? null : (
        <p className="mt-1 text-xxs leading-snug text-ink-muted">{sub}</p>
      )}

      {children}
    </div>
  );
}
